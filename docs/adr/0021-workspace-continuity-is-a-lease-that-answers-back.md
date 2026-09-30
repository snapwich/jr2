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

The chaos tests (2026-09-27) found the other ways to lose a workspace. A node-pressure eviction leaves the pod object in
place, `Failed`, with the same UID — no deletion, no replacement, so neither presence nor identity changed, and the run
hung. A Harness that crash-looped under a live pod only ever refused connections, so a Turn's `wait` reconnected without
end. And a restarted Harness answered a `continue` with no memory of the conversation and no fault.

## Decision

- **The unit of reconciliation is _continuity_, not existence**: is the workspace I am keeping alive still the one the
  body attached to? Every way to lose it collapses into the one `workspace.lost` event, and the body's policy decides,
  unchanged.
- **A Sandbox has one pod for its life.** The operator creates the pod once. When that pod is gone (deleted, its node
  lost) or terminal (`Failed` after a node-pressure eviction, `Succeeded` or `Failed` after a node shutdown), the
  Sandbox goes to the terminal phase **`Lost`**, with the pod's own reason and message (for a deleted pod, the last it
  saw). It never returns to `Pending` and is never given a second pod: `work` is an `emptyDir`, so a new pod could
  continue nothing, and it would hold a whole Size for nobody while hiding the loss. The CR stays, so `jr2 status` can
  say why, until teardown or the idle GC.
- **The operator judges identity, because it knows which pod it created.** It still publishes `status.podUID`; the
  Orchestrator reads `Lost`, not a UID comparison.
- **The watch answers; the lease asserts.** The Orchestrator watches its Sandboxes
  ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)). A Sandbox gone or `Lost` is `workspace.lost` within
  seconds, carrying the reason — or a provision fault, if the Workspace was still `placing` or `provisioning`
  ([ADR-0064](0064-a-workspace-waits-for-capacity.md)). The lease renewal is a write only — one merge patch every 5
  minutes, ±20% jitter — the assertion that keeps the operator from reaping (ADR-0001). A dropped watch is unknown,
  never loss: fabricating loss would settle live runs holding real work the first time the API server hiccuped, so the
  loop re-lists and reconciles instead.
- **A Harness restart ends its Turns, not its Workspace and not its conversations.** When the watch sees the Harness
  container's restart count pass its value at a Turn's admission, every Turn waiting on that Harness fails at once:
  `memory limit` if the last end was `OOMKilled` (ADR-0061), otherwise
  `Turn lost (Harness restarted: <reason>, exit <code>)`. The pod, `/work` and the conversations' directory survive, so
  the Workspace is not lost and the Agent's next Turn continues its conversation (ADR-0031); a conversation the rebuilt
  Harness cannot read gets a `conversation-new` notice (ADR-0062), and a Harness that never comes back faults that
  admission inside its bounded window, with the kubelet's reason. `wait` keeps reconnecting without a deadline — every
  real end now has a watch signal, so a timer would only be a guess at how long a slow Turn may take.
- **The lease is an invoked actor**, one per workspace, owning both halves: it renews, and it subscribes to the watch
  for its Sandbox. Renewal covers the Sandbox from its write to its teardown, `placing` included, so a Sandbox that
  waits for capacity is never reaped as abandoned (ADR-0064); Continuity is judged from `running`, once there is an
  attached pod. Its lifetime is the state's lifetime, which xstate already manages: it re-invokes on snapshot restore,
  so restore-reconcile stops being a special case and becomes the first tick of the normal loop; and it stops on every
  exit — body final, run stopped, run faulted.

That last point deletes machinery rather than adding it. Three mechanisms with three different owners and lifetimes —
the process-global heartbeat map, the one-shot probe, and `release(runId)` (which label-queried the cluster to stop
timers the in-process map had lost track of, wired into `RunHost`'s error channel) — collapse into one actor. A faulted
run now stops its lease because it stops its actors; the abandoned pod stays inspectable and ages out of the operator's
idle timeout on its own. A cancelled run's Workspaces are destroyed by the cancel unless it says `keep` (ADR-0025). The
behavior `release()` was written to produce is emergent.

## Considered options

- **The renewal answers back** (the first form of this decision): `kubectl annotate --overwrite -o json` returned the
  patched object, so asserting and learning cost one round trip. Replaced: detection then ran only at the lease interval
  (an eviction or drain surfaced 4.6–4.7 minutes late in the chaos tests), and it rode a `kubectl` process the
  Orchestrator no longer starts (ADR-0063).
- **Keep the probe, just run it on a timer.** Simplest diff: the probe is already a `fromCallback` with teardown, so it
  is a `.then` → `setInterval`. Rejected because it leaves the heartbeat map, `release()`, and the write/read split all
  standing, and doubles the API traffic against the same object — the debt, untouched, plus a timer.
- **The operator recreates a lost pod, and the Orchestrator compares `podUID`** (this ADR's first form). Rejected: a pod
  that ends in place keeps its UID, so eviction was missed; and the recreated pod was empty, held a Size, and served
  nothing.
- **A deadline on `wait`.** Rejected: any number either ends a slow Turn or leaves a dead Harness hanging for that long;
  the Harness's restart count is the exact signal.
- **Treat a Harness restart as a lost Workspace.** Rejected: `/work` survives, and a human or the next Turn can use it.
- **A deletion tombstone** so a client can tell "reaped" from "never existed". Unnecessary once continuity is the
  question: both answers are `{present: false}`, and the body's policy is the same either way.

## Consequences

- Detection latency for a lost workspace is the watch's: milliseconds (ADR-0063). The lease interval (default 5m, well
  inside the 30m idle timeout) now bounds only how long an orphan waits to be reaped.
- A run that faults after its Sandbox was placed stops its lease; the operator reaps the CR one `idleTimeout` after the
  last renewal. A Sandbox that was never placed is deleted at once (ADR-0064).
- A Menu-only Agent's Turn on the Instance Harness is outside the watch: its Deployment recreates the pod, and the new
  process answers 404, which is "conversation lost". An Instance Harness that crash-loops without end still leaves such
  a Turn waiting.
- The lease is per-workspace, not per-run: a workflow with concurrent workspaces gets one actor each, and each is lost
  independently. This falls out of invoking it beside the body rather than owning it at the host.
- `SandboxPort` has no optional method: `renew` is a write, `continuity` is a subscription to the watch, and
  `memoryFault` (ADR-0061) answers undefined from a backend that cannot see the container. The `jr2.dev/run` label
  survives for `jr2 ls` and as the watch's selector, no longer load-bearing for lease bookkeeping.
