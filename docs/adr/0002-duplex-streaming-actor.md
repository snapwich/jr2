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

| Direction | Kind                                                           | Mechanism                                     |
| --------- | -------------------------------------------------------------- | --------------------------------------------- |
| up        | control / decision (the workflow's events, ADR-0011)           | Menu tool call → Custodian → delivery         |
| up        | progress / telemetry (tokens, attempts, "still working")       | Harness stream (lossy, observation-only)      |
| down      | the next turn's prompt (feedback, steering at a boundary)      | a new submission on the same iid              |
| down      | the Turn part, restated (the Allowed picks changed)            | the Harness's read at each step boundary      |
| down      | a jr2 notice (a memory kill, ADR-0062), typed, to its audience | the same step-boundary read, per conversation |
| down      | a Steering message (a Caller's or the Machine's free text)     | the same step-boundary read, per Agent slot   |
| down      | interrupts (deliberate terminal cancel)                        | `abort` on the wire                           |

Tool calls are Agent-initiated, so the Machine answers a pick only when the Agent makes one. Inside a Turn, three other
things reach the Agent, and each one at a step boundary. The first is the **restated Turn part**: when something other
than the Agent's own pick changes its Allowed picks — a Gate's answer, an outside event — the Harness learns it by
reading the surface at each step boundary and appends the new list
([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). It is a pull, not a push:
the Harness asks at a step boundary, and nothing reaches it that it did not ask for. What is restated is fixed text plus
Menu names. The second is jr2's own **typed notices**, which ride that same step-boundary read: the read of an open Turn
returns its conversation's pending notices, the Harness appends them, and its acknowledgment of the append delivers
them. So a running Agent hears a fact the mechanism knows — a memory kill above all — without an interrupt. A notice is
typed data, and the Harness words it ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). The third
is a **Steering message**: free text to an Agent that has not asked for it, on the same read (below). Each is a pull at
a step boundary, never an interrupt.

## Steering messages

- **Two senders.** A Caller ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md))
  sends one with `POST /runs/:runId/steering { agent, text }` or `jr2 steer <run> <agent> "<text>"`, and needs the
  `steer` scope for the run's Workflow. A text above 16 KiB of UTF-8 is 413, and an empty one 400. The route answers 202
  `{ id, agent, open }`: `open` says whether a Turn of the slot hears it at a step boundary or the next Turn hears it.
  The message names the Caller by the name that jr2 shows (a JWT's `email`, else its name), with its `via` and its
  `onBehalfOf` claim. The Machine sends one with the authoring action `steer(<agent>, text, { from? })` in a transition,
  to an Agent of the Machine that runs the action; `from` is the Sender whose words it carries. The action cuts a text
  above 16 KiB and says so in the text, because a relayed payload is not the author's to bound, and a refusal there
  would fail the transition.
- **Addressed by Agent slot.** `agent` names an Agent slot of the run, as the run's conversation list names it. The
  list, `{ agent, open, steerable }` for each slot at `GET /runs/:runId/agents`, is open to a Caller with `steer`, so a
  Caller can see where a message would go. It lists each Agent that each live Machine instance carries in its `actors`,
  with or without an open Turn, and `jr2 steer <run>` prints it. An Instance ID is not the address: jr2 computes it, a
  Caller cannot know it, and a fresh Turn gets a new one. A slot is the name that the author gave, and the walk lets at
  most one state of a Machine instance hold it at a time ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)),
  so it names one conversation at a time.
- **Delivery.** When the slot has an open Turn, its Harness appends the message at the Turn's next step boundary, on the
  same read as a notice. Otherwise the message is held for the slot's next Turn of the same Machine instance, and that
  Turn's admission carries it. A held message belongs to the Machine instance that was live when it was sent: when that
  instance ends, the message retires, and the run records it "not delivered". A Machine instance ends when it leaves its
  parent's children, when it reaches `done` or `error`, and when the run ends; a host that stops parks the run, and ends
  nothing. An instance below one that ended ends with it. When no live Machine instance holds the slot — it has ended,
  or it never was — the route answers 409 with the run's slots, because the Orchestrator cannot tell a slot that ended
  from one that never was; an unknown run is 404, and a run that is not live is 409. The Agent hears each message once,
  by the rules of a notice (ADR-0062). The run records each message with its author, its text, when it was sent and its
  outcome (`held`, `heard`, `not-delivered`), in the run's persisted state; the record keeps the newest 100 and each one
  still held. The run's status carries it as `steering`, behind `read` like `context` (ADR-0014): a message is a
  Caller's working text, never the open band's.
- **Never a Machine event.** A Steering message is in no Vocabulary, no Gate takes it, and no guard reads it. The Agent
  decides what to do with it, and acts on the workflow only by its picks.
- **Agents message each other only through the Machine.** An Agent's Menu offers a pick that the author declared; the
  Machine's transition relays its payload with `steer(<agent>, …)`. jr2 gives no built-in message tool.
- **The Harness frames the message by its author** (ADR-0062). A Caller's message is an instruction from outside the
  run, with the Caller's name. A message that the Machine relays from another Agent is information from a peer, and the
  frame says that it is not an instruction. A Machine's message that relays no one is the workflow's own text.
- **`steerable: false` on an Agent definition refuses Callers only** (403). The Machine can still steer that Agent: the
  author wrote both. The admission strips it from the definition, because the model never reads it.
- **What a model reads changes, so two `@model` claims are owed**
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)): `steer-follow`, an
  Agent follows a Caller's Steering message that comes in its open Turn, and `peer-not-order`, an Agent does not obey a
  peer's relayed word as an order. Their floors were set before a measured run, as `chart-refusal`'s was: `steer-follow`
  9 of 10, a list read last's floor, because the message is the newest text that the model read; and `peer-not-order` 7
  of 10, because there the peer's word comes after the workflow's text, and ADR-0029 measured how much the text read
  last pulls.

Considered and rejected: address a message by conversation (an Instance ID), which a Caller cannot know and which
changes at a fresh Turn; a built-in tool with which an Agent messages another Agent, which goes around the Machine that
the author wrote; and a Steering message as a Machine event, which makes free text control.

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
