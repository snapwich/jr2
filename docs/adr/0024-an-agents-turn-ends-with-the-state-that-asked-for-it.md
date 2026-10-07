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
finished. So it calls again — and the retry does not even reach a tool. The Menu's server was rebuilt per request, so a
call after the state moved on failed at `GET /agents/:iid/surface` and came back as **HTTP 404 on the tool's transport**
(verified against the running pod: `{"error":"no live surface for agent ..."}`). A connection failure is the most
retry-inviting thing available, and the model retries, trimming its answer each time.

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
- **Same Turn or not is the target's position, and nothing else.** A pick whose target is inside the state that invokes
  the Agent — a mode, a child that runs something, a Gate, another Agent — keeps the Turn; a pick that leaves that state
  ends it, and the next prompt carries the result. A pick with no target keeps the Turn open. So a Turn may hold many
  picks, and the one that leaves the state ends it. What the child does changes nothing: there is no second mechanism.
  Child or sibling says only this — same Turn or not — and never who may send what: that is the audience rule's, by the
  party each state invokes (ADR-0015).
- **A pick that moves the workflow inside the Agent's state is answered at Rest.** Rest: no state below the Agent's
  state is running something — an invoked child that is still active (a Gate, another Agent, a child Machine, a promise)
  — and no pending timer will move the workflow to another state inside the Agent's state. A timer counts the same
  whatever wrote it (`after`, a named delay, a delayed `raise`, a delayed `sendTo` back to the Machine): it holds Rest
  when an active state at or below the Agent's state handles its event with a target inside it; a timer that leaves the
  Agent's state (a Turn timeout) holds nothing. A settled child with no `onDone` is Rest, and a state named `rest` means
  nothing to jr2, so a forgotten route cannot hang a Turn. Rest is read from the Machine, never kept: the snapshot and
  the timer table (ADR-0007), after the mailbox drains (`rest.ts`), so a restored run gives the same answer as before
  the restart. It is computed over the SET of active states below the Agent's state; nothing assumes the set has one
  member. Known limit: a delayed `sendTo` to a child whose reply then moves the Machine is not counted.
- **While a pick is outstanding — delivered and not yet answered — every other pick is refused**, `finish` included, and
  nothing is delivered; so is every pick while the Agent's state is busy with work it started in. xstate itself would
  take the pick, and one the Agent's state handles would exit the child state and stop the work running there, so the
  refusal is jr2's. The Orchestrator decides it from the Machine (Rest) and the run's saved holds, so it holds after a
  restart, and answers `409 { refused: "outstanding", outstanding?, allowed: [] }`. The Allowed picks are empty while
  the Agent's state is not at Rest (ADR-0029): the Rest rule and the payload-blind selection give one list. The Harness
  also claims one pick at a time in MESSAGE order — pi starts one message's calls in that order, each up to its first
  `await` — because a socket race does not keep it (measured: `finish` arrived first in 1 of 50).
- **The answer, in order:** the work settles, the Machine's route runs (guards, assign), then the Agent is answered with
  the Allowed picks read AFTER the route. The answer is the last reply since the pick from below the Agent's state — a
  Gate's event and payload, another Agent's pick, a child's output — and the Harness writes the words. A reply comes
  from a child invoked on an active state below the Agent's state, or from a party whose Gate invoke id or Agent slot is
  invoked there (its sender, ADR-0015). The events the Machine sent itself (a `raise`, a `sendTo(self)`, a timer) are no
  reply, and neither is an event from outside that set (a Gate in a sibling region, a root Gate, an outside send); with
  none, the pick moved the workflow and nothing ran. The pick's `POST` answers at once with `outstanding` and a delivery
  id, and the Harness long-polls the answer inside the one tool call (ADR-0002, ADR-0013). A child that settles inside
  the pick's own send — a decision Machine that is final as it starts — replies before the `POST` answers: when that
  reply leaves the workflow at Rest, or out of the Agent's state, the `POST` itself is the answer, with `answered` and
  nothing to poll. So is a guard straight back: a pick that enters a state and leaves it again inside its own send (an
  `always` back), with no reply, leaves the state value as it was, and is answered "it moved, and nothing ran". A pick
  that changes the state value moved to a mode, and gets the plain receipt with its Allowed picks; a pick with no target
  went nowhere, and gets the same. A route that leaves the Agent's state ends the Turn like any other: the poll reads
  `turnComplete`, the next state's prompt is the author's, and the answer is a `pick-answer` notice to the Agent that
  picked: the next Turn of the conversation the picking Turn continued (`continue: true`, ADR-0062). A FRESH picking
  Turn's conversation is never heard again, and a later continued Turn of the same slot never made the pick, so its
  answer goes nowhere: the ledger keeps no notice for it. There is no default time bound on a held Turn; the Console
  shows each outstanding pick "held since".
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
  rather than what was hoped; for an outstanding pick it is read at Rest, on the answer. `deliveryId` addresses that
  answer ([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)). **This is the hint, not
  the guarantee**, and it is named for the Agent's frame rather than the wire's: the Agent has no submissions, it has a
  Turn (CONTEXT.md).
- **The Harness renders the receipt as prose**, because a model reads the tool result's text: the pick was delivered,
  the workflow consumed it, the turn is over.
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
- **Take the Menu's tools away when the surface goes.** Rejected: nothing pushes to the Harness by design (ADR-0013 — it
  asks per turn, and the answer is the turn), and a tool disappearing does not stop a model already generating.
- **Make the event `deferred` and hold the call open** as the way to END a Turn. Rejected: it solves a different problem
  — giving the Agent an _answer_ — where this one is about giving it an _end_. The answer is now given, by Rest and the
  poll above, to every pick that runs work inside the Agent's state, with no per-event declaration.
- **Answer an outstanding pick from the POST itself, held open.** Rejected: undici cuts it at 300 s and its error then
  says the delivered pick never arrived; an Orchestrator restart mid-request reads as unreachable (ADR-0002).
- **A per-pick footprint as the Rest rule** (Rest when what THIS pick started has settled), or explicit `rest`-tagged
  states. Rejected for the one-path shape jr2 builds: the footprint needs a per-pick record that a restore must carry,
  and a tag makes a forgotten mark hang the Turn. A footprint is the natural rule for the shape jr2 reserves — picks the
  Agent does not wait for, in parallel regions (ADR-0015) — if that is ever built.
- **Let the Orchestrator alone refuse a second pick.** Rejected as the only refusal: it sees arrival order, and two
  calls of one message race over two sockets. The Orchestrator's refusal is the authority; the Harness's claim is what
  makes the result the same every time.

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
- **The nudge (ADR-0016) answers the opposite failure** — a model that stops while its Turn is still open with picks
  left. It reads the Allowed picks after the Submission settles — or, if none are left then, the first time they open
  while the state is active (the wake) — so a pick that kept the Turn open can be followed by a nudge, and a pick that
  ended it never is: the abort and the nudge cannot fire against each other.
- **A Machine author can hold a Turn for long by accident.** A Gate below the Agent's state whose answer has no target
  stays open after it, and a long-lived invoke below it (not a promise, a Gate, an Agent or a child Machine) never
  settles: either keeps the Agent's state from Rest, and every pick of the Agent waits. The load walk warns on both
  (ADR-0015's walk); neither is refused, because either can be meant.
- **Rest reads xstate internals**: the timer table (`system.getSnapshot()._scheduledEvents`, as ADR-0007's re-arm does)
  and the seat lookup's active nodes. The raw-xstate tests are the canary for a bump.
- **Non-determinism dictates how this is tested.** "Did it stop calling?" proves nothing when a well-behaved agent stops
  on its own. The `@kind` tier asserts the **settlement outcome**: after a settling delivery the submission must settle
  `aborted`, and a `continue` re-invocation must settle `completed` rather than being swallowed by its predecessor's
  abort.
