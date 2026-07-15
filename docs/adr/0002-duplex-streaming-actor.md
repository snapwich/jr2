# The Actor is a duplex channel; its control plane is MCP tool calls

An Actor drives an Agent run via an xstate `fromCallback` actor: it admits the run with `POST /agents/:name/:id`
(persisting the durable handle — `(agent name, instance id) + stream offset` — in Machine context), receives events from
the Agent and maps them up into the Machine, and accepts Machine events flowing down to the Agent. The Actor also owns a
per-run callback endpoint (keyed by **Instance ID**) so events route to the correct Actor invocation. We rejected the
simpler `fromPromise`-over-synchronous-`POST` model because a synchronous call returns exactly once, at the end — it
cannot express human-in-the-loop (mid-run approval, steering), and a held hour-long cross-pod connection is lost on any
blip or Orchestrator restart.

## Control plane: MCP tool calls, not stream interpretation

The Machine exposes a **callback toolset** over MCP that the Agent calls to emit the domain events the Machine cares
about — `done`, `request_review`, `request_approval`, `report_blocked`. Events are Agent-authored and semantic rather
than inferred from a generic event stream, and MCP is a first-class flue tool source, so this avoids depending on flue's
internal stream being resumable-by-`(name, instance id) + offset` or on an undocumented mid-run message-injection API.
Crucially, `request_approval` is an ordinary tool call: the Agent **blocks on the tool result**, which is flue's native
pause-for-approval mechanism — so the down-channel for _solicited_ input is just the tool result, no extra machinery.
PoC #5 ([poc/actor](../../poc/actor/)) proved this end-to-end against real flue + vLLM: the Agent blocked on
`request_approval`, the Machine drove into `waitingForApproval`, answered the deferred result, and the Agent resumed —
with the gated action observably occurring only post-approval.

## Split-channel model

| Direction | Kind                                                              | Mechanism                                  |
| --------- | ----------------------------------------------------------------- | ------------------------------------------ |
| up        | control / decision (`done`, `request_review`, `request_approval`) | MCP tool call → Actor                      |
| down      | _solicited_ input (approval, steer-at-checkpoint)                 | MCP tool result                            |
| up        | progress / telemetry (tokens, "still working")                    | flue SSE stream (optional, lossy)          |
| down      | interrupts (cancel, hard-steer)                                   | abandon + `timeoutMs` / `check_inbox` poll |

The residual hard case is **unsolicited mid-turn steering**: tool calls are Agent-initiated, so the Machine can only
answer when the Agent has asked. Cancel is handled by infra-level run abort; cooperative steering by the Agent polling a
`check_inbox` tool at its own checkpoints; true mid-turn unsolicited steering remains unsolved — but it is now the only
behavior in that bucket, not a dependency of the whole control plane.

## Consequences

The Actor hosts the MCP callback endpoint, `sendBack`s incoming tool calls as xstate events, and returns tool results
for solicited input; its `receive` (down) side shrinks to interrupts only. This adds a **Sandbox → Orchestrator
ingress** requirement (the reverse of the Actor→Harness path) to wire up over a Kubernetes Service. The persisted
`(name, instance id) + offset` plus flue's durable-execution log still let a restarted Orchestrator re-attach to an
in-flight run rather than restarting it (PoC #5 dropped the Actor mid-run and re-attached by handle; the run completed).

**A held approval is bounded by the MCP client's per-request timeout** — the one real constraint the deferred-result
model imposes. flue's `connectMcpServer` uses the MCP SDK default of **60 s**; PoC #5 measured that an unanswered
`request_approval` surfaces to the Agent as a tool error at that bound (and, importantly, the Agent did **not** perform
the gated action on timeout — the gate held). Raising `timeoutMs` (PoC #5 used 600 s) lets an approval block for minutes
of human-in-the-loop latency; a 3-minute hold resumed and completed cleanly. So the in-turn approval model is sound, but
the Actor must set `timeoutMs` to the longest decision it will wait for (and/or emit MCP progress notifications with
`resetTimeoutOnProgress`) rather than rely on the 60 s default. **Cancel** stays an abandon — drop the Actor / stop
consuming and let `DurabilityConfig.timeoutMs` reap the durable run; flue exposes no cancel primitive (PoC #4 Finding
2).

**Refined by [ADR-0006](0006-agent-control-surface.md):** which events the Agent may emit is scoped to the current
Machine state and resolved from a shared, named, _flat_ schema registry (the Agent picks from a Machine-defined menu, it
does not drive the workflow). PoC #5b/#5c also bound this control plane to the **agent path**: flue's two HTTP surfaces
do not share a session — the agent path carries continuing memory but cannot force a structured result (`finish`), and
the workflow path can force a result but keeps no memory across runs. So forced final picks are a Machine-level
re-prompt on the agent path; native `finish` is reserved for self-contained single-shot decisions.

## Refined: multi-run instance wiring (ADR-0008/0009)

This ADR says "the Actor hosts the MCP callback endpoint," written when a process drove **one** run. Under the
[ADR-0008](0008-orchestrator-as-deployed-app.md) instance model, one process (`replicas: 1`) hosts **many** runs behind
**one** HTTP app, so the endpoint moves to a shared, host-owned surface — the run still **logically owns its endpoint by
`instanceId`**, it just no longer runs a private server. The Machine **host** (`@j2/orchestrator` `RunHost`) is the seam
that wires the control plane, the Actor, and durable snapshots together:

- **Host-owned MCP mux.** The host owns one `ControlPlane`; each run's tool server (`controlPlane.server(instanceId)`)
  is mounted on `/mcp/:instanceId` of the shared app (the hono slice). A tool call → `ControlPlane.onEvent(event)`
  (carrying `instanceId`) → the host routes by `instanceId` into the owning Machine (`actor.send`). Misrouted/settled
  instances are dropped at the host — the one catch point.
- **Channel split made concrete.** **MCP = domain events** (`done`/`request_review`/`request_approval`/`report_blocked`,
  the canonical up-channel). **flue stream = lifecycle + offset telemetry** — the Actor surfaces an `agent.offset` event
  the Machine `assign`s into context so the `(agentName, instanceId)+offset` durable handle rides in the snapshot. (The
  Actor's earlier flue-stream-derived _domain_ mapping is thus superseded by the MCP up-channel and slated to be
  trimmed.)
- **Approvals answered centrally.** A held `request_approval` (deferred tool result) is released by the host:
  `answer(runId, decision)` → `controlPlane.resolveApproval(instanceId, decision)`. This is the seam the
  [ADR-0009](0009-cli-and-instance-interface.md) `POST /runs/:runId/events` (`APPROVE`) sits on.
- **Infra injected, never persisted.** Live ports (the FlueClient-backed `agentRun` actor) are injected via xstate
  `.provide()` at start **and** restore
  ([ADR-0003](0003-templates-with-injected-providers.md)/[ADR-0007](0007-durable-machine-state.md)), so the snapshot
  stays JSON-safe and restore re-attaches by rewriting the child's persisted input (drop `prompt`, set `attachOffset`)
  after reconciling against the live world.

**Amended by [ADR-0016](0016-agent-turn-mechanics-are-internal.md):** the `agent.offset` context leg is retired —
offsets persist in a host-side `iid → offset` ledger beside the snapshot, never in Machine context. And "flue exposes no
cancel primitive" is stale: flue ≥ 1.0.0-beta.8 ships `client.agents.abort()` (`POST /agents/:name/:id/abort`) as a
first-class terminal outcome; the abandon-and-reap cancel retires once the SDK pin moves past beta.5.

**Superseded in part by [ADR-0011](0011-workflow-defined-events.md):** the mux's _routing_ (tool call →
`ControlPlane.onEvent` → look up the owning run by `instanceId` → `actor.send` into its **root**) is replaced by
invoke-scoped registration — the agent actor registers its iid's toolset with handlers closing over its own `sendBack`,
so calls land on the state that invoked the agent, at any nesting depth. The shared `/mcp/:instanceId` mount survives as
pure transport demux (path → live closure); deferred approvals still resolve centrally; the `.provide()` injection above
is likewise retired for the static-import doctrine (actor logic is code; live things are built per-invocation from
serializable input such as `endpoint`).
