# Workspace continuity is watched; the lease asserts

Two Sandboxes were deleted by hand under a live Orchestrator (2026-07-19); `jr2 runs` and the visualizer both kept
reporting the runs as active, parked on their gates, indefinitely. The gap was structural rather than a bug: the
Orchestrator's two conversations with the cluster ran in opposite directions and on opposite triggers. The keepalive
lease (ADR-0001) was **level-triggered and write-only** — a `setInterval` per owned Sandbox, in a process-global map,
stamping `jr2.dev/keepalive` forever. The restore-reconcile probe (ADR-0012) was **edge-triggered and read-only** — one
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
- **The watch answers; the lease asserts.** The Orchestrator watches its Sandboxes
  ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)), and Continuity is read from that watch: a Sandbox gone, or
  a `podUID` that is not the one the body attached to, is `workspace.lost` within seconds. The lease renewal is a write
  only — one merge patch every 5 minutes, ±20% jitter — the assertion that keeps the operator from reaping (ADR-0001). A
  dropped watch is unknown, never loss: fabricating loss would settle live runs holding real work the first time the API
  server hiccuped, so the loop re-lists and reconciles instead.
- **The lease is an invoked actor in `running`**, one per workspace, owning both halves: it renews, and it subscribes to
  the watch for its Sandbox. Its lifetime is the state's lifetime, which xstate already manages: it re-invokes on
  snapshot restore, so restore-reconcile stops being a special case and becomes the first tick of the normal loop; and
  it stops on every exit — body final, run stopped, run faulted.

That last point deletes machinery rather than adding it. Three mechanisms with three different owners and lifetimes —
the process-global heartbeat map, the one-shot probe, and `release(runId)` (which label-queried the cluster to stop
timers the in-process map had lost track of, wired into `RunHost`'s error channel) — collapse into one actor. A faulted
run now stops its lease because it stops its actors; the abandoned pod stays inspectable and ages out of the operator's
idle timeout on its own. The behavior `release()` was written to produce is emergent.

## Considered options

- **The renewal answers back** (the first form of this decision): `kubectl annotate --overwrite -o json` returned the
  patched object, so asserting and learning cost one round trip. Replaced: detection then ran only at the lease interval
  (an eviction or drain surfaced 4.6–4.7 minutes late in the chaos tests), and it rode a `kubectl` process the
  Orchestrator no longer starts (ADR-0063).
- **Keep the probe, just run it on a timer.** Simplest diff: the probe is already a `fromCallback` with teardown, so it
  is a `.then` → `setInterval`. Rejected because it leaves the heartbeat map, `release()`, and the write/read split all
  standing, and doubles the API traffic against the same object — the debt, untouched, plus a timer.
- **An incarnation counter instead of the pod UID.** Rejected: a counter is bookkeeping the operator must maintain and
  can get wrong (status loss, restore). The UID is read straight off the observed Pod — no state, no drift.
- **A deletion tombstone** so a client can tell "reaped" from "never existed". Unnecessary once continuity is the
  question: both answers are `{present: false}`, and the body's policy is the same either way.

## Consequences

- Detection latency for a lost workspace is the watch's: milliseconds (ADR-0063). The lease interval (default 5m, well
  inside the 30m idle timeout) now bounds only how long an orphan waits to be reaped.
- **Nothing stamps between provision and `running`.** A run that faults during attach never leases its CR at all, so the
  operator reaps it at creation + `idleTimeout` — `lastKeepalive` is `max(creation, annotation)`, so creation is the
  initial lease. This is correct and needs no code, but it means attach must stay well inside the idle timeout.
- A backend that cannot report identity (or an operator too old to publish `podUID`) degrades to presence-only
  continuity — the pre-0021 behavior, minus the edge-triggering.
- The lease is per-workspace, not per-run: a workflow with concurrent workspaces gets one actor each, and each is lost
  independently. This falls out of invoking it beside the body rather than owning it at the host.
- `SandboxPort` drops from five operations to four, and the optional-method wart is gone. The `jr2.dev/run` label
  survives for `jr2 ls`, no longer load-bearing for lease bookkeeping.
