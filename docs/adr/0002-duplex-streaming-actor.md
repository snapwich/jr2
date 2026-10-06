# The agent actor is a duplex channel; its control plane is Menu tool calls

The `agentRun` actor drives an Agent run as a long-lived duplex channel, not a request/response call: it admits the run
with `POST /agents/:name/:id`, persists the durable handle host-side, receives the Agent's decisions as events, and can
feed later turns down to the same conversation. We rejected the simpler `fromPromise`-over-synchronous-`POST` model
because a synchronous call returns exactly once, at the end — it cannot express human-in-the-loop (mid-run approval,
steering), and a held hour-long cross-pod connection is lost on any blip or Orchestrator restart.

## Control plane: Menu tool calls, not stream interpretation

The Agent emits the domain events the Machine cares about by **calling tools** — its Menu, derived from the invoking
state's transitions (ADR-0015), read by the Harness through the pod's Custodian and presented to the model as tools
(ADR-0013). Events are Agent-authored and semantic rather than inferred from a generic event stream. This was proven
end-to-end against a real Harness + vLLM (PoC #5): the Agent called its tool, the Machine transitioned, and a gated
action observably occurred only post-approval.

The split-channel model:

| Direction | Kind                                                      | Mechanism                                |
| --------- | --------------------------------------------------------- | ---------------------------------------- |
| up        | control / decision (the workflow's events, ADR-0011)      | Menu tool call → Custodian → delivery    |
| up        | progress / telemetry (tokens, attempts, "still working")  | Harness stream (lossy, observation-only) |
| down      | the next turn's prompt (feedback, steering at a boundary) | a new submission on the same iid         |
| down      | the Turn part, restated (the Allowed picks changed)       | the Harness's read at each step boundary |
| down      | interrupts (deliberate terminal cancel)                   | `abort` on the wire                      |

Tool calls are Agent-initiated, so the Machine speaks inside a Turn only as an answer. The one exception is the
**restated Turn part**: when something other than the Agent's own pick changes its Allowed picks — a Gate's answer, an
outside event — the Harness learns it by reading the surface at each step boundary and appends the new list
([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). It is a pull, not a push:
nothing new reaches the Harness, and what is restated is fixed text plus Menu names. The residual hard case is
**unsolicited mid-turn steering** — free text from the Machine to an Agent that has not asked. That remains unsolved,
and it is the only behavior in that bucket, not a dependency of the whole control plane.

## Durability: the admission is the handle

`send` returns an **admission** — `{ streamUrl, offset, submissionId }` — and that is the durable handle: the host
persists an `iid → admission` ledger beside the run snapshot in the same save (ADR-0016), never in Machine context.
`wait(admission)` reconnects from the offset, which is how a restarted Orchestrator re-attaches to an in-flight turn
instead of restarting it (proven by dropping the actor mid-run and re-attaching; the run completed).

**Stopping the actor is a local abandon, deliberately.** The wire's `abort` (`POST /agents/:name/:id/abort`) is a
first-class terminal outcome, but actor STOP does not call it: a host shutdown stops every actor, and those runs must
stay alive server-side for restore to re-attach. Remote abort is reserved for a deliberate terminal act, not a stop side
effect.

## A held tool result is a poll, never a held socket

A pick that moves the workflow to work inside the Agent's state is answered when the workflow is back at Rest there
([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)) — seconds or hours later. One request cannot
carry that wait: the Harness's HTTP client (Node's undici) cuts a request at 300 s with no response headers, and at 300
s between body chunks, and its error then told the Agent "the pick never reached the Orchestrator — try it again" for a
pick that WAS delivered (measured: cut at 302 s, both timers, and through the real turn loop at 301 s). An Orchestrator
restart mid-request is a reset after the request was sent, which the Custodian rightly does not retry and which read as
"the Custodian could not reach it". A model told either goes round again.

So the answer is **poll-with-progress**. The pick's `POST` answers at once: `outstanding`, with a delivery id. Inside
the one tool call, the Harness long-polls `GET /agents/:iid/deliveries/:id` (ADR-0013), about 25 s per request — the
same register as the Harness's own stream long-poll — until the answer comes. Every timer on the path sees short
requests; a GET is safe to repeat, so a reset, a 503 from a stopping Orchestrator and a park cost a retry, never the
pick; and an Orchestrator restart is a longer wait in the same Turn, because the hold is saved with the snapshot and the
restored host answers the same poll. There is no default time bound on the wait: pi awaits a tool's `execute` with no
timer of its own, and the Runaway guard counts calls, not time
([ADR-0035](0035-a-runaway-turn-is-ended-rerolled-once-then-a-fault.md)).
