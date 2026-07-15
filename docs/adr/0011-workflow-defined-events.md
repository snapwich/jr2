# Control events are workflow-defined and delivered by closure, not routed

This lands [ADR-0006](0006-agent-control-surface.md)'s "direction" section as the decided model and supersedes the
delivery half of [ADR-0002](0002-duplex-streaming-actor.md)'s multi-run refinement. It came out of the jr-parity design
exercise (`examples/coding/` — modeling an existing user workflow as a j2 Machine to validate that j2 can express it).
Two decisions: **j2 ships the event mechanism and zero events**, and **an event binds to a Machine state through the
actor that exposes it** — delivery is a closure created at invoke time, so no routing layer exists anywhere.

> **Amended by [ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md) /
> [ADR-0016](0016-agent-turn-mechanics-are-internal.md).** The `export const events` manifest and explicit
> `tools: [names]` retire: vocabulary rides the machine object (`j2Setup` attaches it; module contract shrinks to
> `export const machine`) and menus/accepts derive from the invoking state's transitions, audience-filtered. "Reusing an
> iid across turns continues the flue conversation" stays true as _mechanism_ but is no longer the default policy — new
> invocations are **fresh sessions** unless `session: "continue"` (jr's lossy handoff is the deliberate default), and
> iids are computed by j2, not the workflow. Offsets accumulate in a host ledger, not nested contexts. Everything else
> here stands: closure delivery, the registration table, gate-as-resource, per-workflow scoping, static imports,
> invoke-time failure.

## `defineEvent`: mechanism, not policy

`defineEvent({ name, input, semantics? })` produces a pure-data definition: a name, a zod input schema (flat tagged
objects, never `oneOf` — the ADR-0006 encoding rule stands), and an optional semantics tag (`ack` | `deferred` |
`poll`). It is a **pure factory — no import-time side effects, no global registry**. Because actor **inputs are
serializable** (ADR-0007) they carry event _names_, so resolution needs a name→def scope; that scope is
**per-workflow**: each workflow module declares its vocabulary in a manifest export (`export const events = [...]`),
discovery collects it, and actors resolve names against their run's workflow set (run identity reaches every
registration mechanically — the host maps the xstate actor `system`, which callback actors receive, to the run). Names
are local to their workflow: `coding`'s `approve` and `release`'s `approve` may differ. An unlisted name fails at invoke
time with an error naming the workflow and its declared set. We rejected a global name registry (import = registration,
zero manifest): it couples every workflow in an instance — and any future npm-distributed one — through one namespace,
and "prefix your names" is policy pushed onto users; attribution can't be inferred at import time (a shared events
module executes once, under whichever workflow loads first), so the manifest is the honest cost of local vocabularies.

`defineEvent` also carries the TypeScript side: an `EventFrom<typeof def>` helper (`{ type: name } & z.infer<input>`) so
a machine's `setup` event union derives from the defs instead of being hand-written next to them — one source of truth,
no schema/type drift, and the machine stays fully typed for xstate tooling.

There is no j2-blessed event vocabulary. `request_review`, `review_verdict`, `approve` are the _coding workflow's_
words; another workflow defines others. `@j2/agent-protocol`'s `CALLBACK_TOOLS` demotes from "the protocol" to an
example set built on `defineEvent`; ADR-0006's "standard library" framing is retired. j2 owns only definition,
transport, validation, and delivery.

## Agent side: invoke-scoped registration, delivery via `sendBack`

The agent actor is invoked with `tools: [names]`. On start it registers, for its instance id, an MCP toolset whose
handlers **close over that invocation's `sendBack`**; on stop it deregisters. A tool call → validate against the named
schema → `sendBack` a typed event → the event lands on **the state that invoked the agent** (bubbling to ancestor states
per statechart semantics — a machine can handle `report_blocked` once at its root). The binding _is_ the closure.

What this replaces and buys:

- **No routing.** ADR-0002-refined's `byInstance → root actor` table and any workflow-side forwarding boilerplate are
  gone; delivery works at any nesting depth (workspace wrappers, spawned children) with zero authored code.
- **State-scoped `tools/list` for free.** The MCP server for an iid serves exactly the live registration; a transition
  swaps actors, which swaps registrations (`list_changed`). ADR-0006's dynamic advertisement falls out of the
  registration lifecycle instead of needing host-side snapshot inspection.
- **One catch point remains.** A call for an unregistered iid (settled run, exited state) is rejected at the demux.

The shared HTTP listener is **transport, not semantics**: Sandbox pods need a stable URL to call back, and
per-invocation ports are impractical (Service/NetworkPolicy churn), so each registration gets a _path_ — `/mcp/<iid>` —
on the one listener, and the demux table maps path → live closure. A module-level demux is safe despite in-process
multi-instance use (the unit tests boot several hosts per process) because iids embed the run's UUID and cannot collide.

> **Superseded in transport by [ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md).** The registration table, the
> closure binding, and the `/…/<iid>` addressing all stand — but the listener that speaks MCP is **not** the
> Orchestrator's. An Agent that can reach the Orchestrator's delivery surface can deliver to any registration in its run
> (including its own human-review Gate), so the MCP server moves into the Sandbox's **Adapter** sidecar: the Agent's
> only control-plane peer is `localhost`, and the Orchestrator serves `/agents/:iid/surface` + `/agents/:iid/events`
> under a Sandbox-scoped bearer token instead of hosting MCP itself.

## External side: the same primitive over HTTP (`gate`), and each gate is a resource

`gate` is the symmetric actor for **every non-agent caller** — humans (`j2 send`, a UI), webhook translators, CI, other
systems. "Human" is policy, not mechanism, so the actor is not named for one caller. Each invocation is an addressable
**gate**: input is `{ gate, accepts: [names], meta? }` — `gate` a workflow-derived id (e.g. the feature id), `meta`
serializable caller/integration context (PR URL, title). Registration is per-gate: `GET /runs/:runId` lists open gates
(`{ gate, accepts (names + schemas), meta }`), `POST /runs/:runId/gates/:gate/events` validates the body against the
named schema and delivers via `sendBack` into the gated state, and leaving the state destroys the gate. Gate ids are
**run-scoped by mechanism** (the same `system`→run mapping that scopes event resolution), so `gate: "F-12"` in two
concurrent runs of one workflow cannot collide and `GET /runs/:runId` lists only that run's gates.

Gate-as-resource is forced by concurrency: several children park simultaneously (three features in `humanReview` is the
_normal_ case, not an edge), all accepting `approve` — a run-level POST is ambiguous. And every real external surface
already thinks in gates: a CLI listing shows pending decisions and acts on one; a UI inbox renders one card per gate
(schemas drive the forms, `meta` drives the copy); a forge webhook translator finds its gate by matching `meta` (e.g.
`prUrl`), which is why `meta` exists. Generalizing beyond humans also closes a hole the coding example exposed: with
hard-coded event types gone, a push seam like "a work-source webhook wakes discovery" has no delivery path _unless_ the
idle state holds a gate accepting `work_ready`. A cross-run inbox (`GET /gates`) is the obvious later addition;
deferred.

The full symmetry: **agents deliver events over MCP (per-iid registration); everything else delivers over HTTP (per-gate
registration).** Two transports, one primitive, zero routing. Internally that is literal structure: one registration
table (`address → { accepted event defs, deliver closure, meta }`) that `agentRun` and `gate` register into, with MCP
and the gates HTTP API as dialect adapters over it — lookup, schema validation, delivery, discovery, and lifecycle are
implemented once, and a future caller class (a Slack bridge, an email reply) is another adapter, not a third mechanism.
The table is implementation structure, not vocabulary — workflows speak only `defineEvent` / `agentRun` / `gate`.

This replaces ADR-0009's hard-coded `APPROVE`/`STEER` event types; `CANCEL` stays reserved as the run-level infra
interrupt, and `APPROVE` survives only as the answer path for a held `deferred` tool result. jr's "exit 3 and let the
human drive the bash script" becomes "park in a durable state that advertises its human surface."

## Instance ids are derived, never minted or registered

Iids are hierarchical data built from context — `<runIid>/<featureId>/<scope>/<role>` — so a workflow computes them with
string concatenation and the host learns them only when a registration appears. Reusing an iid across turns continues
the flue conversation (`(agentName, instanceId)` continuity), which replaces jr's session-resume machinery outright.

## Static imports; live objects constructed per-invocation from input

Everything above is reachable by plain `import`. We rejected two alternatives:

- **Injected closures / a `defineWorkflow(kit)` wrapper** — xstate's `provide()` fills only the machine it is called on;
  it cannot reach actors inside child machines, so host-side injection cannot compose past one level. The kit wrapper
  solved that at the cost of a new module contract; it is unnecessary once nothing needs injecting.
- **Adapter singletons** — a module-global "current adapters" holder cross-contaminates in-process multi-instance use
  and turns mocking into global state. (The demux registry above is not this: it is rendezvous keyed by globally unique
  ids, not a swappable adapter.)

The doctrine that makes static import work, sharpening ADR-0007: **actor logic is code; everything live is constructed
per-invocation from serializable input** — the flue client from `input.endpoint`, the k8s client from ambient config.
The agent actor's input gains `endpoint` (which Sandbox), which also rides the persisted child input so restore
re-attaches to the right Harness. The workflow module contract moves to **all named exports** (revising ADR-0009's
default export): `export const machine` + `export const events` — the manifest is a peer of the machine, not an
afterthought, and the module's named surface is the workflow's declared interface. Tests mock by `machine.provide()` at
the layer under test.

## Consequences

- `RunHost`/`ControlPlane` rework: the `byInstance` routing and `Menu`/`assertInMenu` guard are replaced by the
  registration demux; the ControlPlane keeps deferred-result holding and inboxes, keyed by iid as today.
- `@j2/agent-protocol` carries `defineEvent` + `EventFrom` (pure, no registry); discovery collects each workflow's
  `events` export; `CALLBACK_TOOLS` becomes an example set.
- Durable handles (`offsets`) now accumulate in whichever machine invoked the agent — nested contexts. ADR-0007's
  restore must fold offsets and rewrite `agentRun` child inputs **recursively**, and reconcile per workspace. Open work,
  tracked as `examples/coding` GAP(5).
- **Dev stubbing happens at the wire, not in the actor.** `j2 dev` hosts a wire-compatible stub Harness on localhost
  (admits the agent, holds the stream open, never acts — `stubAgentRunClient` semantics behind real HTTP). An endpoint
  is just a URL, so `agentRun` keeps a single code path and cannot tell it is talking to a fake; the in-process stub
  port retires. Scope: **workspace-less test workflows only**, which pass `endpoint` directly in run input — e2e drives
  their Machines by playing the agent against `/mcp/<iid>` with no cluster. Workflows that invoke `workspace()` always
  get real Sandboxes (the data plane is never faked — ADR-0009); their e2e tier requires kind. The stub can later grow
  scriptable behavior or be swapped for a real local Harness without touching actor code — it's only a different URL.
- Unsolicited mid-turn steering remains the residual hard case (unchanged from ADR-0002/0006).
