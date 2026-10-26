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
  swept — `abort` on the wire (`POST /agents/:name/:id/abort`). `agentRun` is an **invoke**: leaving the state _means_
  "I am no longer interested in this answer", and nothing in the kit offers a detached Agent.
- **The Orchestrator is the one judge of how a Turn ended, and the sweep says it.** A Submission settles one of four
  outcomes ([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)). `ended` and `aborted` are
  the ends of a Turn. `completed` is a Turn that is still open, and `failed` is a fault. `ended` means that the Turn's
  own pick ended the Turn. The pick may be from this Submission or from an earlier Submission of the same Turn: a nudge
  or a wake starts a new Submission in the same Turn. For example, Submission 1 picks, and its route arms a timer.
  Submission 1 completes, and the nudge admits Submission 2. Then the timer leaves the state: Submission 2 settles
  `ended`. So the sweep carries no Submission of the pick's own. It names the running Submission:

  | cause                                                                                                                    | outcome     |
  | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
  | the Turn's own pick ended the Turn, and the sweep says `cause: "pick"`                                                   | `ended`     |
  | something else ended it: a timer, an outside event, another party's event, the run's CANCEL                              | `aborted`   |
  | the Turn's own pick routed to a state that invokes `fail`, and the Failure ended a Machine on the way up                 | `ended`     |
  | a throw in the Machine, or a defect that no state catches                                                                | `aborted`   |
  | a pick found the Turn over, and no sweep came within the Harness's wait for it (10 s)                                    | `aborted`   |
  | it was over before it started: the surface read answered 404 ([ADR-0026](0026-a-turn-that-is-over-is-never-prompted.md)) | `aborted`   |
  | it was queued behind a swept Submission, so it never ran                                                                 | `aborted`   |
  | the run returned, and the Turn is still open (the nudge or the wake follows, ADR-0016)                                   | `completed` |
  | the run threw: a provider failure after the retries, a Menu that cannot be read, a Runaway (ADR-0035)                    | `failed`    |

  **The Harness does not judge.** A pick can find the Turn over: a receipt with `turnComplete`, or a 404 on a pick or a
  poll. Then the Harness ends the run at the step boundary. It sends no other model request, and it blocks every later
  call of that model answer (below). Then the Submission waits for the sweep. The sweep's body says the cause and names
  the Submission: `{ "cause": "pick", "submissionId": … }`. When it names the running Submission, that Submission
  settles `ended`. Every other body settles it `aborted`: no body, a body that does not parse, an unknown cause, or a
  `submissionId` of another Submission (or none). A sweep that lands while the run still runs settles it in the same
  way. A Submission queued behind the running one never ran, so it settles `aborted` for every cause. So the order in
  which the sweep and the Harness's own end land changes nothing. Only the Orchestrator's word decides.

  **The wait is bounded: 10 s.** The Orchestrator sends the sweep in the macrostep that ends the Turn. That is before
  the pick's own receipt answers, so the sweep lands within one round trip, in milliseconds. 10 s is far above that, and
  above a slow hop or a pause of the Orchestrator's process. It is below every drain window
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)), so a stopping Harness still settles it. While the
  Submission waits, its run has ended and its Agent's actor has stopped. The next Turn on the conversation is admitted
  only after the sweep (the ordered abort, below). So a lost sweep holds two things for up to 10 s: a next Submission
  that is queued on the conversation, and a drain. When no sweep comes, the Submission settles `aborted` with a message
  that says so. The Harness records that the run ended so, and a rebuild after a restart settles it in the same way.

  **The Orchestrator attributes the exit to its cause.** The Agent's Actor asks the run host what ended the Turn
  (`turnEndedByPick`). It asks as its invocation stops, before its registration goes. The answer is yes exactly when the
  transition that stopped the invocation came from this Agent's own pick. The host reads this off xstate's inspection
  stream and the actor system's scheduler (`cause.ts`). It reads what the Machines did, and never the pick's answer:
  "was the pick's work stopped" (`stopped`) is another question. It keeps two facts:
  - **The cause of each relay.** A cause is a set of Agents' picks. It rides each relay of an event, never the event
    object: xstate relays one object each time a config action with an object literal runs. A relay comes from an
    Agent's pick in four ways:
    1. It is the pick, in its own send.
    2. The Machine that invokes the Agent takes it from the work below the Agent's state while the pick is out. These
       are the sources of a reply or of a child's error: a child's output or error, a Gate's answer, a nested Agent's
       pick. A nested Agent's pick is then the cause for both Agents.
    3. An actor sent it while it took a relay that came from the pick. Examples: a `sendTo(self)`, a `sendParent` from a
       child Machine where the route runs, and a child that answers the route at once. A `raise` is part of the
       macrostep that raised it.
    4. It is a timer that its Machine armed while it took a relay that came from the pick. A timer that the pick's own
       route armed is the work's own progress. Examples: an `after` of a state that the pick's route entered, and a
       delayed `raise` or `sendTo` of the pick's transition or route. So inline work and the same work as a child
       Machine give one outcome. Each timer keeps its own cause, on its own `setTimeout` of the run's clock. So two
       timers of one id, armed by two relays with no cancel between, each keep the cause of the relay that armed it.

    Nothing else has a cause. A timer armed before the pick has none, for example a Turn timeout on the Agent's state.
    An outside event, a root Gate's answer, another Agent's pick and a CANCEL have none. A child that the pick's route
    spawns is not the work below: Rest counts invoked children only. So its answer comes from the pick only by rules 3
    and 4: when it answers in the route's own send, or by a timer it armed while it took a relay from the pick (a
    spawned child Machine's own `after`, armed during its init relay). A spawned callback's own `setTimeout` is not a
    timer of the actor system, so its later answer has no cause.

  - **The exit.** The first microstep that stops the Agent's invocation names the cause of its macrostep. After that
    microstep, one of these is true. The Agent's actor is no longer the child of the Machine that invokes it (the state
    exited, or was re-entered). A child Machine on the way up is no longer the child of the Machine above it. Or a
    Machine on the way up is done: it reached its final state, so xstate stops every child. xstate inspects a microstep
    only after its actions ran. So a microstep that throws is never the exit, and a fault is never the pick's. When a
    Machine above catches the fault of a Machine on the way up, that catch is the exit, and it has no cause, also when
    the pick's route caused the fault. The stop of a run is no event of the Machine's.
  - **A Failure is no fault.** A Failure is the end that a state chose
    ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)). When a Failure ends a
    Machine on the way up from the Agent, that Machine's error event is the exit, with the cause of that relay. So a
    pick whose route invokes `fail` ends its Turn `ended`, when a Machine above catches the Failure and when the run
    ends `failed`. xstate does not stop the children of a Machine that ends `error`, so the host stops the children of a
    Machine that a Failure ended, after its parent takes the error event. The Agent there then gets its sweep.

  Which relay an actor takes now is read from the relay order. xstate relays an event to the actor's mailbox
  (`@xstate.event`). The mailbox takes events one at a time, in that order. xstate inspects `@xstate.snapshot` with the
  event when the actor has taken it. An actor's own done or error event is the last relay that it makes with a cause: it
  takes the cause of the relay the actor took then. After it, the actor is finished. A finished actor has no cause, and
  a relay to it, or to a stopped actor, is not queued: xstate drops it. Status alone does not say it. A done Machine
  makes its last deferred sends with status `done`, and a Machine done at start is `done` before its init relay. And
  xstate never stops an errored callback, so its own later sends still reach its parent with no cause. Receipts, poll
  answers, Allowed picks and refusals do not change: the model reads what it read before.

- **Same Turn or not is the target's position, and nothing else.** A pick whose target is inside the state that invokes
  the Agent — a mode, a child that runs something, a Gate, another Agent — keeps the Turn; a pick that leaves that state
  ends it, and the next prompt carries the result. A pick with no target keeps the Turn open. So a Turn may hold many
  picks, and the one that leaves the state ends it. What the child does changes nothing: there is no second mechanism.
  Child or sibling says only this — same Turn or not — and never who may send what: that is the audience rule's, by the
  party each state invokes (ADR-0015).
- **A pick that moves the workflow inside the Agent's state is answered at Rest.** Rest: no state below the Agent's
  state is running something — an invoked child that is still active (an Effect, a Gate, another Agent, a child Machine,
  a promise) — and no pending timer will move the workflow to another state inside the Agent's state. A timer counts the
  same whatever wrote it (`after`, a named delay, a delayed `raise`, a delayed `sendTo` back to the Machine): it holds
  Rest when an active state at or below the Agent's state handles its event with a target inside it; a timer that leaves
  the Agent's state (a Turn timeout) holds nothing. A settled child with no `onDone` is Rest, and a state named `rest`
  means nothing to jr2, so a forgotten route cannot hang a Turn. Rest is read from the Machine, never kept: the snapshot
  and the timer table (ADR-0007), after the mailbox drains (`rest.ts`), so a restored run gives the same answer as
  before the restart. It is computed over the SET of active states below the Agent's state; nothing assumes the set has
  one member. Known limit: a delayed `sendTo` to a child whose reply then moves the Machine is not counted.
- **While a pick is outstanding — delivered and not yet answered — every other pick is refused**, `finish` included, and
  nothing is delivered; so is every pick while the Agent's state is busy with work it started in. xstate itself would
  take the pick, and one the Agent's state handles would exit the child state and stop the work running there, so the
  refusal is jr2's. The Orchestrator decides it from the Machine (Rest) and the run's saved holds, so it holds after a
  restart, and answers `409 { refused: "outstanding", outstanding?, allowed: [] }`. The Allowed picks are empty while
  the Agent's state is not at Rest (ADR-0029): the Rest rule and the payload-blind selection give one list. The engine
  runs a model answer's calls one at a time, in the model's order
  ([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)). Only the FIRST pick of a model
  answer runs. A later pick of the same model answer does not run, whatever its name. The model reads "This pick did not
  run: you sent it before you read the answer to `<first pick>`." The model wrote that pick before it read the first
  pick's answer, so it is stale by construction. The first pick is the first pick of the model answer that the engine
  asks `beforeToolCall` about. The engine reports each model answer before it asks about its calls, and it asks them in
  the model's order (ADR-0027). It asks only about a call of a tool the run has, with valid arguments, so a call of an
  unknown tool, or with invalid arguments, is never the first pick. So the Harness keeps no claim and has no race. The
  blocked pick is still a step for the Runaway watch
  ([ADR-0035](0035-a-runaway-turn-is-ended-rerolled-once-then-a-fault.md)). A call after a pick whose answer ended the
  Turn (`turnComplete`, or a 404) does not run either, a Working-tool call or a pick. The Harness blocks it, and the
  model reads "This call did not run: a pick before it in your answer ended your turn." Under `continue: true`, the next
  state registers the same address, so such a pick would reach the NEXT Turn. The run then ends at the step boundary
  (`endsRun`). The Harness sends no further model request for a Turn that is over, whether or not the Orchestrator's
  abort has landed. So the model reads that text, and the Turn-ending receipt, only in the NEXT Turn of a continued
  conversation. They give no order to stop, because that order is false in a later Turn. The Harness does not settle
  that Submission: it waits for the sweep (above). An `ended` Settlement carries no error object and no message. Nothing
  went wrong, and the outcome itself names the cause. An `aborted` one that the sweep settles has no message. One whose
  wait for the sweep ran out says so ("… no sweep came from the Orchestrator …").
- **The answer, in order:** the work settles, the Machine's route runs (guards, assign), then the Agent is answered with
  the Allowed picks read AFTER the route. The answer is the last reply since the pick from below the Agent's state — a
  Gate's event and payload, another Agent's pick, a child's output — and the Harness writes the words. With an `answer`
  action the author shapes it instead (ADR-0067): the action reads the CHAIN, every reply since the pick, oldest first,
  and its value is the answer; the last call wins. One written below an Agent's state — on a state's entry or exit, or
  on a transition, at or below that Agent's state — shapes only that Agent's pick, whatever event ran it. On a
  transition below no Agent's state (the root, or a parent of two Agents' regions) it shapes the pick of the Agent whose
  event took the transition: the sender of a pick, or the Agent whose pick started the child whose done or error event
  it is. The run records which Agent started each live child, and the invoke of the Agent's state its pick was made at —
  those a pick's own send started; those started while the Machine took an event that is already that Agent's (a done or
  error event of a child it started, or its own pick); and those a timer or another event that names no Agent started on
  a state below the Agent's state while its pick is outstanding, which the Rest rule makes that pick's work (below two
  Agents' states, one inside the other, the nearer one's) — so the work a pick began stays its Agent's, whether the pick
  is still outstanding, was answered while the child ran, or was answered on its own `POST`, and the record holds
  through a restore. The record keys each child by the chain of invoke ids from the root down to it, since an invoke id
  is local to its Machine: two Machines of one tree, and the workers of a pool, which run one body, may each have a
  child of one id, and one never reads or changes the other's entry. A child started on an event that names no Agent
  anywhere else is no Agent's. The other Agent's pick keeps its default answer, and when the Agent the event names has
  no pick being answered, it sets nothing. When one Agent slot is invoked in two regions, it shapes the pick at the same
  invoke as the pick that sent the event or started the child, and nothing otherwise: with both regions' picks being
  answered, the done event of a child shapes the pick whose invoke started it; a pick in its own send is shaped while
  the slot's other pick is outstanding; and the done event of a child that one region's pick started after that pick's
  Turn ended (its child runs on) shapes no pick, while the other region's pick keeps its default answer. When the event
  names no Agent (a timer, a Gate's answer, an outside send, the done event of a child no Agent's pick started), it
  shapes the pick in its own send; outside one, it shapes the one such pick outstanding only while one Agent's state is
  active. Outside a pick's own send, while two Agents' states are active, it sets nothing, whatever is outstanding: the
  event cannot say whose pick it is. On an entry or an exit below no Agent's state it sets nothing, whatever is
  outstanding, and the load walk warns, naming the Agent states it could be moved under: an entry or exit there is no
  transition an Agent's event takes. One action object written in two places runs from each by that place's rule alone,
  never by their sum: written below two Agents' states, from A's state it shapes only A's pick and from B's only B's;
  written below A's state and on a transition below none, from A's state it shapes only A's pick and from the transition
  the pick of the Agent the event names; written on an entry or exit below no Agent's state as well, it sets nothing as
  that entry or exit. An `answer` that an `enqueueActions` enqueues, at any depth, runs from the place the enqueuing
  action is written, by that place's rule: enqueued on an entry or exit below no Agent's state it sets nothing, and
  enqueued below an Agent's state it shapes only that Agent's pick. The load walk cannot see inside an `enqueueActions`,
  so it does not warn on one enqueued on an entry or exit below no Agent's state. An `answer` that runs while no pick of
  that Agent is being answered (a state's first entry, a later Turn's re-entry, another Agent's region of a parallel
  state) sets nothing. A reply comes from a child invoked on an active state below the Agent's state, or from a party
  whose Gate invoke id or Agent slot is invoked there (its sender, ADR-0015). The events the Machine sent itself (a
  `raise`, a `sendTo(self)`, a timer) are no reply, and neither is an event from outside that set (a Gate in a sibling
  region, a root Gate, an outside send), nor a child's error: every outcome of work is its output, and an error is a jr2
  or config defect, so by default its message never reaches the model. The operator reads it: while a pick is
  outstanding, an error from a child below the Agent's state goes on the run's feed (`child-error`: the Agent, its pick,
  the child and the message; Instance-token band, as `fault` is), and `jr2 run` and `jr2 logs` print it. An author who
  wants the Agent told passes it explicitly: `answer(...)` on the `onError` route (ADR-0067), or an `onError` route to a
  state whose prompt carries it. With none, the answer carries no reply, and its words say only that ("No reply came
  back for it"): never that nothing ran, because a timer or an outside event may have stopped work that did run. The
  pick's `POST` answers at once with `outstanding` and a delivery id, and the Harness long-polls the answer inside the
  one tool call (ADR-0002, ADR-0013). A child that settles inside the pick's own send — a decision Machine that is final
  as it starts — replies before the `POST` answers: when that reply leaves the workflow at Rest, or out of the Agent's
  state, the `POST` itself is the answer, with `answered` and nothing to poll. So is a guard straight back: a pick that
  enters a state and leaves it again inside its own send (an `always` back), with no reply, leaves the state value as it
  was, and is answered with `straightBack` — the one answer that says "it moved the workflow, and nothing ran". An
  outstanding pick's answer never carries it. A pick that changes the state value moved to a mode, and gets the plain
  receipt with its Allowed picks; a pick with no target went nowhere, and gets the same, as does a pick whose target is
  the state it was taken in (it enters nothing it leaves). Every receipt that leaves the Turn open (the plain receipt, a
  guard straight back, and an answered pick back at Rest) ends its state part with the same words, "Your turn is not
  over.": the plain receipt once said "the workflow is still in the state that asked for this turn, so it is not over
  yet", and real Haiku 5.5 runs stopped after it, because "it" can be the workflow or the Turn. The refusals and the
  notices of a cut or unsent pick keep their own words. A route that leaves the Agent's state ends the Turn like any
  other: the poll reads `turnComplete`, the next state's prompt is the author's, and the answer is a `pick-answer`
  notice to the Agent that picked: the next Turn of the conversation the picking Turn continued (`continue: true`,
  ADR-0062). A FRESH picking Turn's conversation is never heard again, and a later continued Turn of the same slot never
  made the pick, so its answer goes nowhere: the ledger keeps no notice for it. The route of a reply includes the events
  the Machine sends itself AT ONCE while it runs (a `raise`, or a `sendTo(self)` with no delay, in `onDone` or in the
  next state's entry): a reply whose route leaves the Agent's state that way is the answer, never stopped. Something
  other than the route can leave the Agent's state while the pick's work still runs below it — a timer the Machine set
  (a Turn timeout `after`, a named delay, a delayed `raise` or `sendTo(self)`), an event from outside the states below,
  a Gate's event, the Agent's own end. The exit stops that work (an invoke is stopped when its state exits), and the
  answer says so (`stopped`): the poll reads "The workflow left the state that asked for this turn while it ran your
  pick, and that stopped the pick's work before it finished: your turn is over.", and the next continued Turn's notice
  reads "Your pick `X` did not finish: the workflow left the state that asked for your last turn while it ran, and that
  stopped it." Both keep the last reply an earlier link gave, if any, and state it: an earlier link's reply is never
  dropped because a later link was stopped. The run host tells a fired timer from an event sent at once by the
  scheduler's own table: it watches what the actor system arms, cancels and fires (`timers.ts`, the same xstate
  internals as the timer table, ADR-0007). Back at Rest INSIDE the Agent's state — a per-step timeout `after` on the
  child state that exits the work — the answer is the last reply since the pick, with the Allowed picks; with no reply
  since the pick, the answer carries none. A restored hold is the Turn of the first registration of its address in the
  restored tree: a restore that ends that Turn and starts another at the same address before anything settles answers
  the pick with `turnComplete`. There is no default time bound on a held Turn; the Console shows each outstanding pick
  "held since".
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
  `{"outcome":"completed"}`. The run was untouched: still active, still parked, no transition and no `agent.fault`. That
  sweep said no cause, because the field did not exist yet. The reviewer's own pick had ended its Turn. So today the
  sweep says `cause: "pick"`, and the Submission settles `ended`.

- **jr2 never observes that settlement, and the ADR does not pretend otherwise.** By construction the actor is already
  stopped when the abort fires — being stopped is the trigger — so `settle`'s rejection was swallowed by
  `if (stopped) return` before the remote outcome existed. The wire's distinct `ended` and `aborted` outcomes are worth
  having for **observability**: `history` reads `ended` or `aborted`, not `failed`. They are not what suppresses a
  spurious fault. Nothing suppresses it, because nothing is listening. The wire client's `wait` resolves on `completed`
  alone. So a stopped actor drops an `ended` as it drops every rejection. No path reads it as a run that returned with
  the Turn open.
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
  Turn (GLOSSARY.md).
- **The Harness renders the receipt as prose**, because a model reads the tool result's text: the pick was delivered,
  the workflow consumed it, the turn is over.
- **The Agent instructions gain the stop half.** "You MUST finish by calling `review_verdict`" is half a contract — it
  says how to finish and never that finishing is finished. The Agent definitions a Machine carries (an Agent is a slot
  on the Machine that carries it — ADR-0049) say to call it **once**, then stop. The receipt of a pick that ends the
  Turn says that the turn is over and gives no order: the run ends at that step boundary, so the model reads the receipt
  only in a later Turn of a continued conversation (ADR-0027).

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
- **A Harness claim beside the Orchestrator's refusal.** The first pick of a model answer held it. The Harness refused
  every other pick of that model answer while the first was out. It was needed while pi started the calls of one model
  answer at the same time. Two sockets did not keep the model's order (measured: `finish` arrived first in 1 of 50).
  Rejected: it is state that a race decides. Since the engine runs the calls one at a time (ADR-0027), the Harness finds
  the first pick from the model answer instead.
- **Deliver a second pick of one model answer after the first is answered, and let the Orchestrator judge it** by the
  Allowed picks after the first pick's route. Rejected: the model wrote the second pick before it read the first pick's
  answer, so the pick is stale by construction. An Allowed pick can still be the wrong one, for example `finish` after a
  `run_tests` whose answer is a failure.
- **End a Turn that is over with pi's `terminate` flag on the pick's result**, not with `endsRun`. Rejected: pi stops
  only when every result of the batch sets it, so a model answer `[bash, pick]` would go on to another request.
- **`aborted` for every end of a Turn**, the Turn its pick ended included. Rejected: one word had three meanings. The
  Turn's own pick ended it (a success), something else stopped it, or it was over before it started. A reader takes
  `aborted` as "something stopped it".
- **`completed` for a Turn its pick ended.** Rejected: `completed` would then hold two opposite cases. One is a Turn
  that reached the end its workflow asked for. The other is a model that stopped early in a Turn that is still open,
  which the Agent's Actor nudges. `ended` is GLOSSARY.md's own verb: a Turn "ends when that state stops waiting", by
  "the pick that ends it".
- **`answered` as the name.** Rejected: "answer" already means a pick's answer, a model answer, and the `answered`
  `@model` claim.
- **Let the outcome follow whichever end lands first:** `ended` when the Harness ends the run before the sweep lands,
  and `aborted` when the sweep is first. Rejected: the outcome would follow a race. The `@kind` tier counts exact
  `ended` settlements (see Consequences).
- **Let each end judge, and make the two judgments agree.** The Harness would read the pick's answer (`turnComplete`
  with no `stopped`), and the Orchestrator the same facts. Rejected after it was built: the two read different signals.
  "Was the pick's work stopped" is not "what left the state". Three verifications each found ends where they disagreed.
  One was a timer while the pick waited on a timer below. Others were a fault caught above, a CANCEL during an
  outstanding pick, and an exit in the same tick as a Rest. One judge cannot disagree with itself.
- **Read the Rest before the Machine takes an event, to answer a pick early.** Rejected: `rest.ts` forbids it. It also
  gave the model wrong answers: another Agent's pick answered with no reply, and a pick answered at a Rest that a queued
  event ended.
- **Keep the cause on the event object.** Rejected: xstate relays one object each time a config action with an object
  literal runs. So an object that the pick's route sent once kept that cause when a timer sent it later.

## Consequences

- **The primary win is correctness**: a Workspace stops carrying Agents the Machine does not know are running. Tokens
  and wall-clock are the secondary benefit, and they are large — the tail of an ended turn is currently unbounded.
- **`continue: true` becomes usable for the first time.** Before this ADR no workflow exercised continuation, which is
  why the queue semantics went unnoticed; `task` (ADR-0054) exercises it now.
- **A failed abort is not reportable.** The actor is stopped, so there is no `agent.fault` to raise, and the run's
  telemetry channel carries only `RetryTelemetry`. The call is fire-and-forget. An Agent whose sweep is lost still 404s
  on every tool call and ends its run. It settles `aborted` when its wait for the sweep runs out. Widening telemetry is
  a separate decision.
- **`turnComplete` fails conservatively.** It is read after `deliver` returns and depends on `sendBack` being
  synchronous. Should that stop holding, it reads `false` — today's behavior, never a false claim. The guarantee no
  longer depends on it at all. `turnEndedByPick` rests on the same fact and fails the same way. The pick's send would
  not stop the invocation, and the sweep would say no cause. The Turn would then settle `aborted`, never a false
  `ended`.
- **The limits of the one judge.** Each can give `aborted` (or, for a restart, `failed`) to a Turn that its own pick
  ended. None gives `ended` to a Turn that something else ended:
  - **An Orchestrator that is down when the Turn ends** sends no sweep. So the Submission settles `aborted` when the
    Harness's wait runs out. So does an Orchestrator whose sweep fails on the way: the sweep is fire-and-forget (above).
  - **Version skew.** An Orchestrator from before `cause` sends no body, so its Turns settle `aborted`, every time. A
    Harness from before `cause` ignores the body, and settles every sweep `aborted`.
  - **A restored run.** A timer's cause is kept in memory, on its `setTimeout` of the run's clock. A timer that a
    restore arms again has no cause, so its exit sends a sweep with no cause.
  - **A Machine above the Agent's Machine faults, and a Machine above it catches the fault.** xstate does not stop the
    errored Machine's children, so the Agent's Machine runs on. The run took the Agent's state away when it caught the
    fault, so that is the exit, and it has no cause, also when the pick's route sent the event that caused the fault. A
    later route of the Agent's Machine that stops the Agent sends a sweep with no cause, and the Submission settles
    `aborted`.
  - **The Agent's own Machine faults, and a Machine above it catches the fault.** xstate does not stop that Machine's
    children, so the Agent's actor is never stopped. Its surface stays live, and no sweep is sent. A pick of that Agent
    finds no end of the Turn, so its Harness does not wait for a sweep, and nothing settles the Submission. This orphan
    is older than this rule, and it is a separate defect.
  - **An exit while the next admission is in flight.** A nudge, a wake or a re-admission is ledgered only when the
    Harness answers it. A Turn that its own pick ends in that window names the Submission before it. The Harness no
    longer runs that one, so the running Submission settles `aborted`. This is conservative, and no wait is added for
    it.
  - **A Harness that restarts while it waits for the sweep** settles the Submission `aborted`, with the message that no
    sweep came. It recorded that the run ended because its Turn was over. A Harness that restarts while the run still
    runs settles it `failed`, as for every Submission that a restart cut (ADR-0031).
- **The nudge (ADR-0016) answers the opposite failure** — a model that stops while its Turn is still open with picks
  left. It reads the Allowed picks after the Submission settles — or, if none are left then, the first time they open
  while the state is active (the wake) — so a pick that kept the Turn open can be followed by a nudge, and a pick that
  ended it never is: the abort and the nudge cannot fire against each other.
- **A Machine author can hold a Turn for long by accident.** A Gate below the Agent's state whose answer has no target
  stays open after it, and a long-lived invoke below it (not a promise, an Effect, a Gate, an Agent or a child Machine)
  never settles: either keeps the Agent's state from Rest, and every pick of the Agent waits. The load walk warns on
  both (ADR-0015's walk); neither is refused, because either can be meant.
- **Rest reads xstate internals**: the timer table (`system.getSnapshot()._scheduledEvents`, as ADR-0007's re-arm does)
  and the seat lookup's active nodes. The raw-xstate tests are the canary for a bump.
- **Non-determinism dictates how this is tested.** "Did it stop calling?" proves nothing when a well-behaved agent stops
  on its own. The `@kind` tier asserts the **settlement outcome**, in two scenarios. In the `handoff` scenario, the
  Agent's pick ends its Turn, and that Turn settles `ended`, whichever end lands first. The next `continue` Turn, which
  `shipping` asked for, is not swept: the count of `ended` settlements stays 1 while `shipping` is active. In the
  `interrupted` scenario, a Gate's answer, not a pick, ends the Turn while the scripted model holds its request. That
  Turn settles `aborted` through the sweep, with no message, and the abort cuts the model's request.
