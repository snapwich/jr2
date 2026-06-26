# The Actor is a duplex channel; its control plane is MCP tool calls

An Actor drives an Agent run via an xstate `fromCallback` actor: it `dispatch()`es the run (persisting the `dispatchId`
in Machine context), receives events from the Agent and maps them up into the Machine, and accepts Machine events
flowing down to the Agent. The Actor also owns a per-run callback endpoint (keyed by `dispatchId`/run id) so events
route to the correct Actor invocation. We rejected the simpler `fromPromise`-over-synchronous-`POST` model because a
synchronous call returns exactly once, at the end — it cannot express human-in-the-loop (mid-run approval, steering),
and a held hour-long cross-pod connection is lost on any blip or Orchestrator restart.

## Control plane: MCP tool calls, not stream interpretation

The Machine exposes a **callback toolset** over MCP that the Agent calls to emit the domain events the Machine cares
about — `done`, `request_review`, `request_approval`, `report_blocked`. Events are Agent-authored and semantic rather
than inferred from a generic event stream, and MCP is a first-class flue tool source, so this avoids depending on flue's
internal stream being resumable-by-`dispatchId` or on an undocumented mid-run message-injection API. Crucially,
`request_approval` is an ordinary tool call: the Agent **blocks on the tool result**, which is flue's native
pause-for-approval mechanism — so the down-channel for _solicited_ input is just the tool result, no extra machinery.

## Split-channel model

| Direction | Kind                                                              | Mechanism                         |
| --------- | ----------------------------------------------------------------- | --------------------------------- |
| up        | control / decision (`done`, `request_review`, `request_approval`) | MCP tool call → Actor             |
| down      | _solicited_ input (approval, steer-at-checkpoint)                 | MCP tool result                   |
| up        | progress / telemetry (tokens, "still working")                    | flue SSE stream (optional, lossy) |
| down      | interrupts (cancel, hard-steer)                                   | infra abort / `check_inbox` poll  |

The residual hard case is **unsolicited mid-turn steering**: tool calls are Agent-initiated, so the Machine can only
answer when the Agent has asked. Cancel is handled by infra-level run abort; cooperative steering by the Agent polling a
`check_inbox` tool at its own checkpoints; true mid-turn unsolicited steering remains unsolved — but it is now the only
behavior in that bucket, not a dependency of the whole control plane.

## Consequences

The Actor hosts the MCP callback endpoint, `sendBack`s incoming tool calls as xstate events, and returns tool results
for solicited input; its `receive` (down) side shrinks to interrupts only. This adds a **Sandbox → Orchestrator
ingress** requirement (the reverse of the Actor→Harness path) to wire up over a Kubernetes Service. The persisted
`dispatchId` plus flue's durable-execution log still let a restarted Orchestrator re-attach to an in-flight run rather
than restarting it.
