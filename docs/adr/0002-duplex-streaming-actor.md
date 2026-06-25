# The Actor is a duplex streaming channel, not a request/response call

An Actor drives an Agent run via an xstate `fromCallback` actor: it admits a prompt to the Harness
(`POST /agents/:name/:id`, persisting the **`(agent name, instance id)` + stream offset** in Machine context),
subscribes to the Harness Durable-Streams event stream and maps flue events up into the Machine (`progress`, `done`,
tool-call events, …), and sends Machine events down to the Harness as **follow-up prompts the agent reads at the next
turn boundary**. On a dropped connection it re-attaches by `(name, id)` from the last offset — replay history, then
live-tail.

Note: `awaiting_approval` is **not** a native flue event — it is a j2-derived semantic (a turn-end review signal, or a
recognized tool call), interpreted by the Actor from the raw stream. Don't build #5 expecting flue to emit it.

We rejected the simpler `fromPromise`-over-synchronous-`POST` model because it structurally cannot express
human-in-the-loop: a synchronous call returns exactly once, at the end, so mid-run approval and steering are impossible,
and a held hour-long cross-pod connection is lost on any blip or Orchestrator restart (flue's synchronous `?wait=result`
is best-effort and scoped to the admitting process — its outcome also surfaces as a `submission_settled` stream event).
The duplex stream makes human-in-the-loop and "steering nudges" first-class Machine states (expressed as queued
next-turn prompts — see below) and, via the persisted `(name, id)` + offset plus flue's durable-execution log, lets a
restarted Orchestrator re-attach to an in-flight run instead of restarting it.

**Validated against flue 1.0.0-beta.5 (PoC #4 — `poc/runtime/`, observed not assumed).**

(1) **Confirmed — stream resume.** A run's event stream is resumable, but keyed by `(agent name, instance id)` + a
Durable-Streams offset, not a `dispatchId` (that is flue's _in-process_ async-delivery receipt, explicitly "not a
runId"). A fresh client replays full history from `offset=-1` then live-tails, or resumes strictly-after a checkpoint
offset (at-least-once: it may re-deliver the in-flight batch, never skips). A restarted **Orchestrator** therefore
re-attaches to a still-running **Harness** out of the box. Surviving a **Harness** restart additionally requires a
file-backed persistence adapter (`sqlite()` on the worktree volume, or `@flue/postgres`) — the Node default is in-memory
and returns `stream_not_found` after a process restart. (`emptyDir` survives a container restart and dies with the pod,
which is the right durability boundary: container OOM-restart recovers; pod loss → recreate the Workspace from commits.)

(2) **Amended — the down-channel is enqueue-next-turn only.** flue is "one active operation per session" and exposes
**no HTTP primitive to cancel, approve a gate, or inject a mid-turn message**. A second prompt admitted while one is
running is **queued FIFO and takes effect at the next turn boundary** — it does not interrupt the current turn
(observed: P2 admitted in 4 ms but ran only after P1 settled). A client abort drops only the client; the durable
server-side run runs to completion. So **approve** and **steer** are modeled as follow-up prompts the agent consumes at
its next turn. **Cancel** of an in-flight turn is unavailable — model it as abandoning the Workspace (stop consuming the
stream / drop the Sandbox, which kills the co-located Harness sidecar) plus flue's cooperative
`DurabilityConfig.timeoutMs`, or keep turns short. This narrows what the down-channel can _say_; it does not change the
decision — streaming up + enqueue down + crash-re-attach is exactly what `fromPromise`-over-synchronous-`POST` cannot
express.

## Human-in-the-loop scope: turn-boundary gates only (decided)

Finding (2) collapses two different needs that must not be conflated:

- **Coarse / turn-boundary gates** — the review gate (coder ends its turn → reviewer + human decide out-of-turn →
  Machine enqueues feedback as the next prompt). This maps **natively** onto enqueue-next-turn: no blocking tool, no
  held-open turn, no `timeoutMs` risk. **This is the human-in-the-loop j2 commits to.**
- **Fine / mid-turn approval** — approve a specific action _before_ it runs, without ending the turn. flue has **no
  native mechanism**; it would require a tool that suspends the turn on external state plus a side channel, fighting the
  default 1 h `timeoutMs`. This pattern is **unproven (not probed in #4) and deferred.** Don't build #5 on it; if it's
  ever needed, validate it first (a probe-2b).

## Design principles this forces on #5

- **Short turns are load-bearing**, not a style choice. They bound how stale a queued steer is and make timeout-based
  cancel tolerable. Author Agent prompts so turns end at natural checkpoints rather than running for many minutes.
- **Transitions must be idempotent.** Resume is at-least-once: a reconnect may re-deliver the in-flight batch. The Actor
  dedups by `eventIndex` and Machine transitions must tolerate a replayed event without double-acting.
