# The agent picks from a Machine-defined, schema-backed menu; it does not drive the workflow

This refines [ADR-0002](0002-duplex-streaming-actor.md). The control plane is still MCP tool calls, but **which** events
an Agent may emit is **scoped to the current Machine state and defined by the Machine**, not an open set the Agent
invents. Each state declares its allowed agent-events; the Actor exposes exactly those; the Agent **chooses one**
(controlled agency); the Machine owns the transition table. "Events are Agent-authored" (ADR-0002) becomes "the Agent
authors one event _from the menu this state allows_" — the Agent never steers the workflow, it answers within a frame
the Machine set.

## Two call kinds: per-turn vs final

> **Two corrections from [ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)** (verified against flue's source): the
> per-turn menu is **not** Orchestrator-hosted — the MCP server runs in the Sandbox's **Adapter**, and the Orchestrator
> speaks no MCP at all; and `list_changed` is **unnecessary**, because flue re-runs a `defineAgent` initializer (and so
> re-lists its MCP tools) on **every submission**, while a j2 menu only changes at turn boundaries. The decision below —
> a Machine-defined, state-scoped, schema-backed menu — is unchanged, and is now _enforced_ rather than advertised: the
> Agent's only control-plane peer is the Adapter, and it holds no credential the Agent can read.

- **per-turn calls** — MCP tools the Agent may call _during_ a turn. Dynamic and Orchestrator-owned: the Actor
  advertises only the current state's tools (`tools/list`, refreshed with `list_changed` on transition). A call is a
  **command** (no return the Agent consumes → non-blocking) or a **query** (returns a value the Agent uses → either an
  in-turn deferred result, e.g. `request_approval` per ADR-0002, or answered next turn). Whether a call blocks is
  **inferred from its shape** (does it return something the turn needs), not a separate flag.
- **final pick** — ends the turn and drives a Machine transition.

## Schemas referenced by name (extends the provider pattern)

Event and output schemas are **named and resolved from a shared registry**, exactly as xstate references
`actors`/`actions`/`guards` by name and fills them via `provide()` (ADR-0003). The Machine references a schema by name
to map a result back to an event; the Harness resolves the **same name** to build the tool / result contract. The wire
carries a **name (+ runtime params), not a serialized schema** — which removes the serialization fragility PoC #5b hit
when it rebuilt valibot from JSON on the fly. One registry — the Actor↔Harness contract package (now
`@j2/agent-protocol`) — feeds **both** the per-turn MCP menu and any forced final pick.

**Encode flat.** A named schema must compile to a flat tagged object (an `enum` discriminator + each option's params as
optionals + a validation `check`), **never a top-level `oneOf`/`anyOf`**. PoC #5b: a strict `v.variant` (→ `oneOf`/
`const` tool schema) is unsatisfiable for Qwen3-Coder — it serializes the tool args as a JSON string, validation fails,
and flue re-nudges 33× then throws. A flat object is satisfied first try. The conditional contract ("`notes` required
iff `request_changes`") is enforced by j2 after the pick, not by the tool schema.

## The hard constraint: the agent path and the workflow path do not share a session

flue exposes two HTTP surfaces with **disjoint** capabilities (PoC #5b, #5c — verified against the runtime source):

| Surface                              | Continuing memory                            | Force a structured result                                                                     |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Agent** `POST /agents/:name/:id`   | ✅ resumable by `(name, instance id)+offset` | ❌ executor runs `withCallOverrides({ tools: [], model: undefined })` — no result tools, ever |
| **Workflow** `POST /workflows/:name` | ❌ session keyed by a fresh per-run `runId`  | ✅ `session.prompt(msg, { result })` → native `finish`, durable `GET /runs/:runId`            |

They **cannot be combined**. Continuing conversation lives only on the agent path (which cannot force a result); the
forced structured result lives only on the workflow path (which keeps no memory across runs and is not addressable by
name or by an agent instance). The root cause is the session storage key `[instanceId, harness, session]`: a workflow's
first component is a **server-generated `runId`** (the invocation query accepts only `wait`), so a named
`harness.session("X")` resolves to a fresh, empty session on every run. `sqlite()` durability does not change this — the
blocker is key _composition_, not the store. So **"workflows on named sessions as the per-turn building block of a
Machine" is not viable.**

## Decision

- **The Actor is agent + instance id** (the duplex Actor of ADR-0002). All continuing, multi-turn work and the per-turn
  MCP menu live here.
- **Forced final pick = a Machine-level re-prompt on the agent path.** If a turn settles without a valid pick, the Actor
  enqueues a "you must choose one of …" follow-up — flue's own 33× `finish` nudge, replicated client-side over the
  proven next-turn 2nd-POST channel. Default, one surface, Machine stays in charge.
- **Workflow-`finish` is reserved for self-contained, single-shot decisions** where the Machine ships _all_ context in
  the workflow input (an LLM-judge / classifier / "given this diff + this rubric, return a verdict"). Never for anything
  that needs accumulated session memory.
- **Schemas are named, flat, and resolved from the shared contract registry**, feeding the MCP menu and any single-shot
  workflow pick alike.

## Direction: control events are user-definable providers (`defineAgentEvent`)

The events a state offers are **not** a fixed j2 set — they are declared and bound by the **workflow author**, and j2's
built-ins (`done`, `request_review`, `request_approval`, `report_blocked`, `check_inbox`) are a **standard library**
built on the same primitive. The fixed part is the _mechanism_; the events are pluggable, mirroring the provider model
(ADR-0003).

- **Mechanism (fixed, in `@j2/agent-protocol`):** a tool call → validate its payload against the named schema → emit a
  typed xstate event → drive the state's transition; plus `/mcp/:instanceId` addressing and the `ack`/`deferred`/`poll`
  semantics.
- **Events (pluggable, per-workflow):** `defineAgentEvent({ name, input, output?, semantics })` produces one event; a
  state binds a set of them as its control surface (its menu). Emitting one is how the Agent drives the Machine, and a
  user's custom event + schema is authored exactly like a built-in — so it is first-class, not a second-tier extension.

This is how "the Agent drives the Machine within a frame the Machine set" becomes user-extensible: the **frame** (which
events, what schemas, which state) is workflow configuration, not hardcoded protocol. The binding
(tool→event→transition) lands with the orchestrator slice — where the MCP server is built and `sendBack` happens —
against a real consumer, not speculatively. Today's `CALLBACK_TOOLS` and `Menu`/`assertInMenu` in `@j2/agent-protocol`
are the first cut of the standard set and the binding guard; `defineAgentEvent` generalizes them.

**Decided by [ADR-0011](0011-workflow-defined-events.md)**, with two changes of emphasis: there is no j2 "standard
library" of events at all — `CALLBACK_TOOLS` demotes to an _example_ set built on `defineEvent`, and every event name is
the workflow's own; and the binding is **invoke-scoped registration** (the agent actor registers its iid's toolset with
handlers closing over its `sendBack`), which makes the state-scoped `tools/list` above fall out of the registration
lifecycle and extends the same primitive to every external caller — humans, webhooks, CI — via addressable `gate`
resources (`POST /runs/:runId/gates/:gate/events`). The `Menu`/`assertInMenu` guard retires with the fixed set.

## Consequences

- The Actor↔Harness protocol crystallizes into a shared **contract package** (`@j2/agent-protocol`: named schemas +
  result→event mapping) that both the orchestrator engine and the Harness depend on.
- "Forced structured result" is **not** a free upgrade to the duplex Actor — it is a separate, memoryless RPC surface,
  used only where context is passed in, not remembered.
- Unsolicited mid-turn steering remains the residual hard case (unchanged from ADR-0002): the menu still only opens when
  the Agent reaches a checkpoint or a turn boundary.

Evidence (on disk; `poc/` is gitignored, conclusions live here): `poc/actor/POC-5B-FINDINGS.md`,
`poc/actor/POC-5C-FINDINGS.md`.
