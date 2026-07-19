# The agent picks from a Machine-defined, schema-backed menu; it does not drive the workflow

The control plane is MCP tool calls (ADR-0002), but **which** events an Agent may emit is scoped to the current Machine
state and defined by the Machine, not an open set the Agent invents. The menu derives from the invoking state's
transitions (ADR-0015 — the consumer authors no tool lists), is served to the Agent by the Sandbox's Adapter (ADR-0013),
and the Agent **chooses one** (controlled agency); the Machine owns the transition table. The Agent never steers the
workflow — it answers within a frame the Machine set — and because its only control-plane peer is the Adapter (which
holds no credential it can read), that frame is _enforced_, not advertised. Menus only change at turn boundaries, and
flue re-runs the `defineAgent` initializer (re-listing MCP tools) on every submission, so no `list_changed` push channel
is needed.

There is no j2-blessed event vocabulary: every menu entry is a workflow-defined event (ADR-0011).

## Encode flat

A named event schema must compile to a flat tagged object (an `enum` discriminator + each option's params as optionals

- a validation `check`), **never a top-level `oneOf`/`anyOf`**. Measured (PoC #5b): a strict variant (→ `oneOf`/`const`
  tool schema) is unsatisfiable for Qwen3-Coder — it serializes the tool args as a JSON string, validation fails, and
  flue re-nudges 33× then throws. A flat object is satisfied first try. A conditional contract ("`notes` required iff
  `request_changes`") is enforced by j2 after the pick, not by the tool schema.

## The hard constraint: the agent path and the workflow path do not share a session

flue exposes two HTTP surfaces with **disjoint** capabilities (verified against flue source, re-verified 2026-07-13):

| Surface                              | Continuing memory                            | Force a structured result                                                                     |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Agent** `POST /agents/:name/:id`   | ✅ resumable by `(name, instance id)+offset` | ❌ executor runs `withCallOverrides({ tools: [], model: undefined })` — no result tools, ever |
| **Workflow** `POST /workflows/:name` | ❌ session keyed by a fresh per-run `runId`  | ✅ `session.prompt(msg, { result })` → native `finish`, durable `GET /runs/:runId`            |

They **cannot be combined** — the root cause is the session storage key (a workflow's first component is a
server-generated `runId`), so "workflows on named sessions as the per-turn building block of a Machine" is not viable.
Consequences:

- **All continuing, multi-turn work lives on the agent path**, driven by `agentRun` (ADR-0016).
- **A turn that settles without a valid pick is re-prompted by j2** — the budgeted no-signal nudge _inside_ `agentRun`
  (ADR-0016), replicating flue's own `finish` nudge client-side, since native `finish` is structurally unavailable on
  the agent path. The workflow sees one terminal `agent.fault` on exhaustion.
- **Workflow-`finish` is reserved for self-contained, single-shot decisions** where the Machine ships _all_ context in
  the workflow input (an LLM-judge / classifier / "given this diff + this rubric, return a verdict"). Never for anything
  that needs accumulated session memory.

## Residual

Unsolicited mid-turn steering remains the hard case (ADR-0002): the menu only opens when the Agent reaches a checkpoint
or a turn boundary. Evidence for the findings above: `poc/actor/POC-5B-FINDINGS.md`, `poc/actor/POC-5C-FINDINGS.md`
(`poc/` is gitignored; conclusions live here).
