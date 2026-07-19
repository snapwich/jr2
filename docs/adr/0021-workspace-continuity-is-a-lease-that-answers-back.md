# Workspace continuity is a lease that answers back

Two Sandboxes were deleted by hand under a live Orchestrator (2026-07-19); `j2 runs` and the visualizer both kept
reporting the runs as active, parked on their gates, indefinitely. The gap was structural rather than a bug: the
Orchestrator's two conversations with the cluster ran in opposite directions and on opposite triggers. The keepalive
lease (ADR-0001) was **level-triggered and write-only** — a `setInterval` per owned Sandbox, in a process-global map,
stamping `j2.dev/keepalive` forever. The restore-reconcile probe (ADR-0012) was **edge-triggered and read-only** — one
`exists()` per entry into `running`. So the Orchestrator asserted liveness continuously and learned the truth almost
never, and the state most likely to outlive its Sandbox — a body parked on a Gate for hours — is precisely the one that
never re-enters `running` to ask again.

Worse, `exists()` asked the wrong question. A run does not depend on a Sandbox CR existing; it depends on **the pod it
attached to still being that pod**. `work` is an `emptyDir`, so an eviction or a node loss takes the clones, the
worktrees, and every unpushed commit — while the operator recreates the Pod under the same name, leaving the CR present,
the Service DNS resolving, and every path in `handles` still valid. Presence answers "yes" to a workspace whose contents
are gone. That divergence was undetectable at any point in the run's life, restore included — the exact "resume into an
inconsistent world" ADR-0012 exists to prevent.

## Decision

- **The unit of reconciliation is _continuity_, not existence**: is the workspace I am keeping alive still the one the
  body attached to? Two failures — reaped and replaced — collapse into the one existing `workspace.lost` event, and the
  body's policy decides, unchanged.
- **Identity, not address.** The operator publishes `status.podUID`; the workspace captures it at provision and persists
  it in context (plain serializable data — ADR-0007). Every address a run holds is deterministic and therefore survives
  replacement; only the UID changes when the filesystem does.
- **`SandboxPort.exists()` becomes `renew()`**, returning `Continuity = {present: false} | {present: true, identity?}`.
  It stamps the lease and reports what it found in **one call** — `kubectl annotate --overwrite -o json` returns the
  patched object with status included, so asserting liveness and learning the truth cost one round trip, not two. A
  renewal that _fails_ rejects; it never resolves `{present: false}`. Unknown is not loss, and fabricating loss would
  settle live runs holding real work the first time the API server hiccuped.
- **The lease is an invoked actor in `running`**, one per workspace, owning the whole exchange. Its lifetime is the
  state's lifetime, which xstate already manages: it re-invokes on snapshot restore, so restore-reconcile stops being a
  special case and becomes the first tick of the normal loop; and it stops on every exit — body final, run stopped, run
  faulted.

That last point deletes machinery rather than adding it. Three mechanisms with three different owners and lifetimes —
the process-global heartbeat map, the one-shot probe, and `release(runId)` (which label-queried the cluster to stop
timers the in-process map had lost track of, wired into `RunHost`'s error channel) — collapse into one actor. A faulted
run now stops its lease because it stops its actors; the abandoned pod stays inspectable and ages out of the operator's
idle timeout on its own. The behavior `release()` was written to produce is emergent.

## Considered options

- **Watch Sandboxes.** The orchestrator's Role already grants it, and it would cut detection latency from a lease
  interval to seconds. Rejected for now: it needs a real Kubernetes client (the port is a `kubectl` shell-out), plus
  relist/reconnect handling, and it would be a _second_ channel alongside the lease the operator still requires. The
  poll is not extra work — it is the lease, which has to happen anyway. Revisit if something needs sub-minute loss
  detection.
- **Keep the probe, just run it on a timer.** Simplest diff: the probe is already a `fromCallback` with teardown, so it
  is a `.then` → `setInterval`. Rejected because it leaves the heartbeat map, `release()`, and the write/read split all
  standing, and doubles the API traffic against the same object — the debt, untouched, plus a timer.
- **An incarnation counter instead of the pod UID.** Rejected: a counter is bookkeeping the operator must maintain and
  can get wrong (status loss, restore). The UID is read straight off the observed Pod — no state, no drift.
- **A deletion tombstone** so a client can tell "reaped" from "never existed". Unnecessary once continuity is the
  question: both answers are `{present: false}`, and the body's policy is the same either way.

## Consequences

- Detection latency for a lost workspace is the lease interval (default 5m, well inside the 30m idle timeout). Tunable
  per backend via `leaseIntervalMs`; the tests drive it at 5ms.
- **Nothing stamps between provision and `running`.** A run that faults during attach never leases its CR at all, so the
  operator reaps it at creation + `idleTimeout` — `lastKeepalive` is `max(creation, annotation)`, so creation is the
  initial lease. This is correct and needs no code, but it means attach must stay well inside the idle timeout.
- A backend that cannot report identity (or an operator too old to publish `podUID`) degrades to presence-only
  continuity — the pre-0021 behavior, minus the edge-triggering.
- The lease is per-workspace, not per-run: a workflow with concurrent workspaces gets one actor each, and each is lost
  independently. This falls out of invoking it beside the body rather than owning it at the host.
- `SandboxPort` drops from five operations to four, and the optional-method wart is gone. The `j2.dev/run` label
  survives for `j2 ls`, no longer load-bearing for lease bookkeeping.
