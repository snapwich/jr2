# An unrouted mechanism event is refused at load and faults the run

jr2 sends `agent.fault` to the Machine that invoked an Agent when the Agent's Turn cannot go on
([ADR-0016](0016-agent-turn-mechanics-are-internal.md)), and `workspace()` sends `workspace.lost` to its body when the
Sandbox is gone ([ADR-0012](0012-workspace-wrapper-machine.md)). Both go by `sendBack`, and xstate drops an event that
no active state handles. So a Machine that does not route `agent.fault` waits for ever in the Agent's state with a dead
Agent, and a body that does not route `workspace.lost` shows healthy on the feed with no Sandbox
([ADR-0022](0022-observation-is-a-level-triggered-feed.md)). Six of the 12 trials of an eval in which an Assistant
writes jr2 Workflows did not route `agent.fault`. Each of those Machines loaded, and each could wait for ever.

## Decision

- **The walk refuses a Machine with no route for a mechanism event.** It refuses a state that invokes an Agent when that
  state and all its ancestors have no `agent.fault` route, and a state of a `workspace()` body that the body can stay in
  when that state and all its ancestors have no `workspace.lost` route. The states that a body can stay in are each leaf
  that is not final, and each compound state whose nested final state has no `onDone` on the compound state: the body
  then stays in the compound state. An event goes to the active leaves first, so a route on each leaf, or above it, is a
  route for the compound state above them. A final state of the root ends the body, and a final state of a parallel
  region leaves the other regions active, so neither is judged. One route on the root satisfies each rule. The
  `agent.fault` refusal is in `jr2Setup().createMachine`, beside the lost-output refusal, so `jr2 check`, `jr2 up` and
  the Orchestrator's load all show it. The `workspace.lost` refusal is in `workspace()`, which is the one place that
  knows that a Machine is a body.
- **At runtime, a mechanism event that no transition took faults the run `error`.** The run host sees it in the
  inspection stream: a microstep for `agent.fault` or `workspace.lost` with no transitions, in the Machine that got the
  event (for `workspace.lost`, the body, because the wrapper always takes its own transition to forward it). `fault`
  names the event, the state and the event's `reason`. This catches the route that the walk cannot judge: a guard that
  is false when the event comes.
- **In a Chart, the `agent.fault` route is optional.** An `agent.fault` that no transition of the Chart takes ends the
  Chart as an error at the Open body's invoke ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)). The Machine
  that lends the Chart catches it with an `onError` on its Open body state. With no `onError` there, the error goes up
  as any error does, and the run ends `error`. So the Chart door does not refuse a Chart state with no route, and
  `jr2Setup().createMachine` does not refuse the Machine that a Chart compiles to. Under an Open body that lends no
  `fail`, a Chart has no correct state for the route: a final state means `done`, and a state that waits holds the run
  until the wall clock. The wrapper, which is TypeScript and checked by the walk, decides.
- **Routed means that the runtime took a transition.** A route with actions only counts, because it can be a deliberate
  `reenter: true` that invokes the Agent again. jr2 does not judge what a route does.
- **An unrouted mechanism event ends the run `error`, never `failed`.** The Machine did not choose that end, so it is a
  fault and not a Failure ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)),
  and its Sandbox stays as evidence.

## Considered options

- **Drop the event, as before.** Rejected: the run waits for ever and looks live, and nothing tells a person why.
- **Only the walk.** Rejected: a guarded route that is false at runtime still drops the event.
- **Only the runtime.** Rejected: half of the trials would load and then fault on the first Agent fault, when the walk
  can tell the author before the first run.
- **Make `agent.fault` the Agent actor's error**, so that xstate faults the parent when no `onError` handles it.
  Rejected: ADR-0016 and the Chart vocabulary route the event by name, and `onError` already carries defects and
  Failures; an Agent's fault would be a third thing on it. In a Chart the fault does get to an `onError`, but as the
  Open body's error and only when the Chart did not route it, so the wrapper's `onError` is the route that the Chart did
  not write.
- **Require the route in a Chart too**, with a line of the Chart door. Rejected: under an Open body that lends no
  `fail`, the planner can write no correct target, and the trials of the `chart-refusal` claim wrote a `faulted` final
  state, which ends the run `done`. A route the planner must write also adds a rule to the text that a model reads.

## Consequences

- The text "When no state routes it, xstate drops the event, and the run stays in the Agent's state" in the
  `FaultTelemetry` TSDoc (`actor.ts`) and in `mechanism-events.md` changes to this rule.
- A Machine in the docs, the templates or the fixtures that does not route a mechanism event gets a route, or the walk
  refuses it.
- A Chart needs no route, so the Chart fixtures and the Charts of the docs keep none that they do not use, and the Chart
  briefing and the grammar's fragment do not show one.
- An Assistant learns the rule from the refusal line of `jr2 check`, so the line names the state, the event and the
  route to write.
