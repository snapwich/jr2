# The agent actor is a duplex channel; its control plane is MCP tool calls

The `agentRun` actor drives an Agent run as a long-lived duplex channel, not a request/response call: it admits the run
with `POST /agents/:name/:id`, persists the durable handle host-side, receives the Agent's decisions as events, and can
feed later turns down to the same conversation. We rejected the simpler `fromPromise`-over-synchronous-`POST` model
because a synchronous call returns exactly once, at the end — it cannot express human-in-the-loop (mid-run approval,
steering), and a held hour-long cross-pod connection is lost on any blip or Orchestrator restart.

## Control plane: MCP tool calls, not stream interpretation

The Agent emits the domain events the Machine cares about by **calling MCP tools** — its menu, derived from the invoking
state's transitions (ADR-0015) and served by the Sandbox's Adapter (ADR-0013). Events are Agent-authored and semantic
rather than inferred from a generic event stream. This was proven end-to-end against real flue + vLLM (PoC #5): the
Agent called its tool, the Machine transitioned, and a gated action observably occurred only post-approval.

The split-channel model:

| Direction | Kind                                                      | Mechanism                             |
| --------- | --------------------------------------------------------- | ------------------------------------- |
| up        | control / decision (the workflow's events, ADR-0011)      | MCP tool call → Adapter → delivery    |
| up        | progress / telemetry (tokens, attempts, "still working")  | flue stream (lossy, observation-only) |
| down      | the next turn's prompt (feedback, steering at a boundary) | a new submission on the same iid      |
| down      | interrupts (deliberate terminal cancel)                   | `client.agents.abort()`               |

The residual hard case is **unsolicited mid-turn steering**: tool calls are Agent-initiated, so the Machine can only
speak when the Agent has asked or the turn has ended. That remains unsolved — but it is the only behavior in that
bucket, not a dependency of the whole control plane.

## Durability: the admission is the handle

flue's `send()` returns an **admission** — `{ streamUrl, offset, submissionId }` — and that is the durable handle: the
host persists an `iid → admission` ledger beside the run snapshot in the same save (ADR-0016), never in Machine context.
`agents.wait(admission)` reconnects from the offset, which is how a restarted Orchestrator re-attaches to an in-flight
turn instead of restarting it (proven by dropping the actor mid-run and re-attaching; the run completed).

**Stopping the actor is a local abandon, deliberately.** flue ≥ 1.0.0-beta.8 ships `agents.abort()`
(`POST /agents/:name/:id/abort`) as a first-class terminal outcome, but actor STOP does not call it: a host shutdown
stops every actor, and those runs must stay alive server-side for restore to re-attach. Remote abort is reserved for a
deliberate terminal act, not a stop side effect.

## A held tool result is bounded by the MCP client's per-request timeout

flue's `connectMcpServer` uses the MCP SDK default of **60 s**, and an unanswered tool call surfaces to the Agent as a
tool error at that bound (measured; the Agent did **not** perform the gated action on timeout — the gate held). This is
the one real constraint on ADR-0013's reserved `deferred` semantics: when a Machine-answered tool result lands, it will
be poll-with-progress, not a socket held open for minutes.
