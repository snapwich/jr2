# An Agent's turn ends with the state that asked for it

An Agent that picks from its menu does not stop. Observed live twice (2026-07-27, `task-with-review` against vLLM). The
reviewer delivered `review_verdict`, the Machine parked on `humanReview` — and the reviewer went on calling
`review_verdict` **41 times**, 20 of them inside one 40-second window, its `notes` degrading from a paragraph to
`"Approved."`. Eleven minutes after the run had stopped listening, both Agents were still generating.

Nothing in jr2 ends the submission. `agentRun` awaits `client.settle` — `wait(admission)` — which resolves only when the
model stops. The delivery transitions the Machine, xstate stops the invocation, and its cleanup runs `abandon()`: the
registration is destroyed and **local** consumption is aborted. That is deliberate — a host shutdown stops every actor,
and [ADR-0007](0007-durable-machine-state.md)'s restore needs those durable runs alive to re-attach — but the Harness is
never told. The surface does not outlive its state ([ADR-0011](0011-workflow-defined-events.md)); the submission does.

The Agent has no way to know. This is the receipt, verbatim as the model received it:

```
Structured content:
{ "deliveryId": "058b1208-5fc9-43db-9057-eda10f871856" }

{"deliveryId":"058b1208-5fc9-43db-9057-eda10f871856"}
```

A UUID, printed twice, against instructions that say it MUST finish by calling the tool and never say when finishing is
finished. So it calls again — and the retry does not even reach a tool. `serverForTurn` rebuilds the turn's server per
request, so a call after the state moved on fails at `GET /agents/:iid/surface` and the Adapter answers **HTTP 404 to
the MCP transport** (verified against the running pod: `{"error":"no live surface for agent ..."}`). A connection
failure is the most retry-inviting thing available, and the model retries, trimming its answer each time.

**It is a coin flip, which is what rules out fixing this with words.** In the second run the coder called once and
settled `completed`, while the reviewer ran away; in the first, both ran away. The same prompt, the same model, the same
state. A prompt fix cannot be relied on and cannot even be shown to have worked.

**And the cost is not only tokens.** [ADR-0012](0012-workspace-wrapper-machine.md) puts coder and reviewer in one
Workspace; the Machine's states are sequential, but the Agents are not. Throughout `reviewing`, the orphaned coder was
still live in the worktree the reviewer was reviewing — and still live at `humanReview`, the park that deliberately
retains the Sandbox so a human can exec in and inspect the diff. In the runs we watched, the orphan only read. Nothing
prevented it writing. An un-ended turn is an unaccounted-for concurrent writer in a Workspace the Machine believes is
single-threaded.

## Decision

- **A turn ends when the state that asked for it stops waiting.** When an `agentRun` invocation ends, its submission is
  aborted — `abort` on the wire (`POST /agents/:name/:id/abort`). `agentRun` is an **invoke**: leaving the state _means_
  "I am no longer interested in this answer", and nothing in the kit offers a detached Agent.
- **The one exception is the Orchestrator ending it for its own reasons**, which is ADR-0007's requirement and exactly
  one place: `RunHost.stop()`. Process shutdown never stops actors at all (`instance.ts` calls `host.close()`, which
  ends observation feeds and nothing else), and restore is a fresh process. So "the host did this" is a flag it sets,
  not a fact to be inferred.
- **The rule is invocation-end, not "the Agent's own pick settled the state".** The narrower rule was tempting and is
  wrong twice over: it rests on `sendBack` being synchronous — true in xstate 5.32.2, verified, but an internal that a
  version bump could turn off _silently_ — and it misses every other ending while a submission lives: an `after:`
  timeout on an agent state, an ancestor or sibling transition, a Pool cancelling a child. Several of those are
  self-limiting because the Sandbox dies with them; the dangerous ones are the endings where the Sandbox deliberately
  survives, and `humanReview` is precisely that. One rule, no library internal beneath the guarantee.
- **Abort interrupts a submission mid-tool-loop.** Measured against the live pod, aborting the runaway reviewer:

  | window            | reviewer log lines | `review_verdict` calls |
  | ----------------- | ------------------ | ---------------------- |
  | 40 s before abort | +20                | **+20**                |
  | 60 s after        | +0                 | **0**                  |
  | +45 s further     | +0                 | **0**                  |

  `{"aborted": true}`, settling to `{"outcome":"aborted","error":{"type":"submission_aborted"}}` beside the coder's
  `{"outcome":"completed"}`. The run was untouched: still active, still parked, no transition and no `agent.fault`.

- **jr2 never observes that settlement, and the ADR does not pretend otherwise.** By construction the actor is already
  stopped when the abort fires — being stopped is the trigger — so `settle`'s rejection was swallowed by
  `if (stopped) return` before the remote outcome existed. The wire's distinct `aborted` outcome is worth having for
  **observability** (`history` reads `aborted`, not `failed`); it is not what suppresses a spurious fault. Nothing
  suppresses it, because nothing is listening.
- **`AgentRunPort` gains `abort(agentName, instanceId)`**, so the port stays the injectable seam and a unit test can
  assert the abort without a live Harness — the same shape as `admit`/`settle`.
- **An abort is ordered before the next `send` on the same instance id.** The run binding keeps `iid → pending abort`,
  and `agentRun` awaits it before `admit`. This is `continue: true`-scoped by construction: a fresh session mints a
  random suffix and cannot collide. Without it the feature loses turns **silently** — see below.
- **The receipt becomes self-describing**: `POST /agents/:iid/events` answers
  `{ delivered: true, event: "review_verdict", turnComplete: true, deliveryId }`. `turnComplete` is read off the same
  table the guarantee uses — whether the registration just delivered to is still live — so it reports what happened
  rather than what was hoped. `deliveryId` is unchanged ([ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md) keeps
  it as the room a deferred result will need). **This is the hint, not the guarantee**, and it is named for the Agent's
  frame rather than the wire's: the Agent has no submissions, it has a Turn (CONTEXT.md).
- **The Adapter renders the receipt as prose**, because a model reads text before `structuredContent`: the pick was
  delivered, the workflow consumed it, the turn is over.
- **The Agent instructions gain the stop half.** "You MUST finish by calling `review_verdict`" is half a contract — it
  says how to finish and never that finishing is finished. The Agent definitions a Machine carries (an Agent is a slot
  on the Machine that carries it — ADR-0049) say to call it **once**, then stop.

## The Harness queues, and the queue is load-bearing here

Invoking a `continue` iid that is already live does **not** fail loudly — the Harness **queues**: prompts for one
instance enter one per-instance queue in admission order, and a Submission is promoted only when it is the first
unsettled one for its conversation ([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)
asserts these semantics as jr2's own; they were first discovered, mid-incident, as the behavior of the since-retired
harness runtime — the original ADR-0016 assumed the opposite, a loud per-iid fence). That cuts both ways, and both
matter:

- **`continue: true` was unusable before this ADR, not merely fragile.** A runaway submission does not fail the next
  state's `send` — it makes it queue behind work that may never finish, and the state hangs with no error.
- **Ordering is mandatory, not hygiene.** Abort sweeps the running Submission and everything queued behind it
  (ADR-0027). An abort that loses the race to the next `send` therefore kills the new turn **before it runs at all** —
  no error, no fault, the Agent simply never speaks. Silent turn loss is the worst failure mode available, which is why
  the ordering ships with the decision rather than after it.

## Considered options

- **The receipt and the instructions alone.** The cheap half, and it is in the decision — as a hint. Rejected as the
  guarantee by the coin-flip evidence: the model already had instructions and answered failure by degrading, not
  stopping.
- **Let the 404 do the work** (today). Rejected: it is the mechanism that produced 41 calls. A transport error reads as
  "try again".
- **Keep a tombstone so a call after the turn answers "already delivered" instead of 404-ing.** Genuinely tempting while
  the 404 was the only signal. Rejected once abort exists: the submission is dead within a round trip, so the tombstone
  buys a nicer message for a window in which almost no call can occur, in exchange for unbounded server state.
- **`defineEvent({ endsTurn: true })` — let the author declare it.** Explicit, no inference. Rejected: it pushes
  mechanism back onto the author, the exact direction [ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md) spent
  a whole decision reversing. Invoke semantics already answer the question.
- **Abort on actor stop, unconditionally.** Rejected: it breaks ADR-0007's restore, which is the reason `abandon()`
  abandons locally in the first place.
- **Abort from the host, in `sendToAgent`.** Rejected three ways: it puts a data-plane client in the delivery path
  (ADR-0013 answers deliveries from the registration table alone), it makes a delivery await a remote call before
  answering, and it only ever covers endings caused by deliveries — the narrow rule again, wearing a different hat.
- **Have the Adapter close the MCP transport when the surface goes.** Rejected: the Adapter has no push channel by
  design (ADR-0013 — it asks per connection, and the answer is the turn), and a tool server disappearing does not stop a
  model already generating.
- **Make the event `deferred` and hold the call open.** Rejected: reserved-not-built (ADR-0013), and the MCP client's 60
  s per-request timeout means the answer would be poll-with-progress anyway. It also solves a different problem — giving
  the Agent an _answer_ — where this one is about giving it an _end_.

## Consequences

- **The primary win is correctness**: a Workspace stops carrying Agents the Machine does not know are running. Tokens
  and wall-clock are the secondary benefit, and they are large — the tail of an ended turn is currently unbounded.
- **`continue: true` becomes usable for the first time.** Before this ADR no workflow exercised continuation, which is
  why the queue semantics went unnoticed; `task` (ADR-0054) exercises it now.
- **A failed abort is not reportable.** The actor is stopped, so there is no `agent.fault` to raise, and the run's
  telemetry channel carries only `RetryTelemetry`. The call is fire-and-forget; an orphan still 404s on every tool call
  and settles on its own. Widening telemetry is a separate decision.
- **`turnComplete` fails conservatively.** It is read after `deliver` returns and depends on `sendBack` being
  synchronous. Should that stop holding, it reads `false` — today's behavior, never a false claim. The guarantee no
  longer depends on it at all.
- **The no-signal nudge (ADR-0016) is untouched.** It answers the opposite failure — a turn ending without a pick — and
  neither path can fire against the other.
- **Non-determinism dictates how this is tested.** "Did it stop calling?" proves nothing when a well-behaved agent stops
  on its own. The `@kind` tier asserts the **settlement outcome**: after a settling delivery the submission must settle
  `aborted`, and a `continue` re-invocation must settle `completed` rather than being swallowed by its predecessor's
  abort.
