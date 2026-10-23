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

The same rule holds for the `POST` itself. The Harness says "never reached" only when it knows that the Orchestrator did
not take the pick. A pick that leaves the Agent's state ends the Turn. The Orchestrator's abort of that Turn can land
before the pick's receipt does, and the abort then cuts a request that the Orchestrator already took. Real models showed
this on 2026-10-22 (Haiku 5.5 and Qwen, the `@model` claim `noticed`). The run moved on the pick, and the model read
"the pick never reached the Orchestrator (This operation was aborted) — try it again". In its next Turn, the model said
that the call failed.

So a pick's `POST` has three cases when it gets no receipt. They give five texts: one for the first case, and two for
each of the others. The Harness returns the second and the third case as the call's answer, not as an error, because an
error reads as a failed pick and invites a second one:

- **The request never left the Harness.** Then the call fails, and the error is "the pick never reached the Orchestrator
  (<detail>) — try it again". Two kinds of failure prove this. The first kind is a transport failure in which no
  connection was made, so no byte of the request was written. These are a refused connection (`ECONNREFUSED`), a failed
  name lookup (`ENOTFOUND`, `EAI_AGAIN`), undici's connect timeout (`UND_ERR_CONNECT_TIMEOUT`), and an unreachable
  network or host (`ENETUNREACH`, `EHOSTUNREACH`) from the `connect` call. The second kind is the Custodian's 502 with
  `x-jr2-custodian: unreachable`, when all of its Envoy response flags say that it did not forward the request: `UF`,
  `UH`, `DF` or `URX` ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). `URX`, the retry
  limit, is in this set for one reason only. The `events` route retries only on `reset-before-request,connect-failure`,
  so its last attempt failed before the request was sent. A test of `custodian.ts` holds that route to those two
  conditions. The Custodian's text for these is "the Custodian could not reach it (<detail>)", in the place of
  `<detail>`. After an abort of the call, no failure proves this, because the call was the Turn's and the Turn is over.
- **The Harness does not know whether the Orchestrator took the pick.** Every other failure can come after the request
  left: a reset, a socket that the other side closed, a headers timeout, an abort of the call, or a Custodian 502 with
  another flag. These flags are an upstream connection that closed (`UC`), a stream reset (`UMSDR`), an upstream
  protocol error (`UPE`), a remote or a local reset (`UR`, `LR`), and a downstream protocol error (`DPE`). A `DPE` means
  that the Custodian did not forward a whole request, but a body framing error can come after the headers went upstream.
  The Custodian says `UPE`, `UR` and `LR` as its 502 too, so that Envoy's own 503 for them does not read as a stopping
  Orchestrator's 503. After an abort of the call, the answer is "It is not known whether this pick reached the workflow:
  your turn ended while the call to `<pick>` waited for the workflow's answer (<detail>). A pick that the workflow takes
  can end the turn in this way. Do not call `<pick>` again before you read the next message: it tells you where the
  workflow is now." Otherwise the Turn goes on, and the answer is "It is not known whether this pick reached the
  workflow: the call to `<pick>` failed before the workflow answered (<detail>). A second call to `<pick>` can run the
  pick twice." It gives no order to call again, because a pick with no target runs again when it is sent again. And it
  does not say how the model can find out: a guard back, a self-transition and an unchanged list of Allowed picks all
  look the same as a pick that did not arrive.
- **The Orchestrator took the pick, and its answer was not read.** This is an outstanding pick whose poll an abort of
  the call cuts, or a 2xx whose body did not arrive. A 2xx is the Orchestrator's own word that it took the pick. The
  answer is "This pick reached the workflow, and your turn ended before you read its answer. Do not call `<pick>` again
  before you read the next message: it tells you where the workflow is now." When the call's own abort was not the
  cause, "your turn ended before you read its answer" is "its answer did not reach you (<detail>)".

Each other answer of the Orchestrator keeps its own text, because it is a receipt or a refusal and not a lost request: a
503 from a stopping Orchestrator (the pick was not taken — try it again, ADR-0042), a 409 while a pick is outstanding
(ADR-0024), and a 404 when the Turn is over (ADR-0026).
