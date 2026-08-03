# Workflows are authored through `j2Setup`; vocabulary and agent menus derive from the machine

The jr-parity exercise (`examples/coding/`) produced a working model but a bad consumer API: mechanism plumbing
(manifests, tool lists, event-union bookkeeping) dominated the workflow. The redesign grill (2026-07-13/14, full record
in [docs/design/workflow-api/](../design/workflow-api/proposal.md)) settled the split: **the consumer writes pure
workflow — states, transitions, prompts, policy — and j2 absorbs everything else through convention.** This ADR covers
the authoring surface; [ADR-0016](0016-agent-turn-mechanics-are-internal.md) covers the agent turn;
[ADR-0017](0017-pool-over-a-source-port.md) covers the run loop.

## `j2Setup`: an xstate `setup()` analog, not a DSL

`j2Setup({ types, events: [defs], actors, actions, guards })` is statically imported and returns xstate's **public
`SetupReturn`** — `.createMachine()` yields a plain `StateMachine`, Stately-inspectable and `.provide()`-testable, with
no j2 runtime needed to construct it (proven by compiled experiment against xstate 5.32.2; consumer surface has zero
casts). It:

- injects the mechanism events (`agent.fault`, `workspace.lost`) into the event union and derives the workflow event
  types from the zod defs — hand-written `EventFrom` unions retire;
- pre-registers the j2 actors (`agentRun`, `gate`) with typed inputs;
- takes the defs **as values**, which lets it validate at `createMachine` time that every event key appearing anywhere
  in the machine maps to a def — closing xstate's nested-`on` typo hole (unknown keys in nested states typecheck
  silently upstream) with a load-time failure;
- attaches the vocabulary to the machine object (`vocabularyOf(machine)`, a WeakMap — the returned machine stays
  bit-identical). Discovery reads it there: **the `export const events` manifest retires**, and the workflow module
  contract shrinks to `export const machine` (revising [ADR-0011](0011-workflow-defined-events.md)'s named-exports
  contract). ADR-0011's anti-global-registry argument is preserved — attribution flows through the machine object,
  per-workflow by construction.

## Agent menus and gate accepts derive from the machine

A state that invokes `agentRun` gets, as its Agent's tool menu, the workflow events its transitions handle (own +
bubbled ancestors, per statechart semantics); a state that invokes `gate` gets its accepted set the same way. The
consumer names neither; MCP appears nowhere in workflow code. Mechanics: the **vocabulary** derivation is static, in
`j2Setup.createMachine` — a config walk wraps each invoke's `input` to append the derived names, so names still ride
serializable input and the ADR-0007 restore path and invoke-time validation are unchanged. The walk reads transition
_keys_ and so cannot see guards, which is why the **surface** is not static on top of it: `agentSurface` asks the
invoking machine's guards before listing, so an event whose every transition is guarded false is never offered — the
menu offers only what the machine will accept
([ADR-0029](0029-a-menu-offers-what-the-machine-will-accept-and-a-pick-that-moves-nothing-says-so.md) owns the
rationale). Authoring is untouched by the split: a workflow names no tools in either leg. The same walk feeds
`j2 visualize` ("this state's agent can call X, Y"). Dotted names (`agent.*`, `workspace.lost`, `xstate.*`, `after`) are
mechanically excluded.

**The invoking actor kind is the primary router; `audience` on the def is an optional restriction.**
`defineEvent({ audience?: "agent" | "external" | "any" })`, default `"any"`: an `agentRun` menu draws audience ∈ {agent,
any}, a `gate` draws {external, any}. Simple workflows need zero tags — the rewritten coding workflow derives every menu
and accept-set untagged. Cross-contamination is only possible when an event is handled at a shared ancestor while both
actor kinds are invoked beneath it; the convention is to **tag the security-sensitive events** (`approve: "external"`
guarantees no agent state can ever offer it) and leave the rest alone. Explicit `tools:`/`accepts:` on an invoke input
remain as escape hatches.

Considered and rejected: per-transition demarcation (xstate transitions have no typed metadata slot for it without
inventing j2-only config inside the transition table — a DSL by the back door) and purely structural
own-transitions-only derivation (breaks ADR-0011's blessed handle-`report_blocked`-once-at-an-ancestor idiom).

## Why there is no injection model (the retired ADR-0003)

j2's first composability story — "workflows are templates of injected providers": Machines reference their moving parts
as named xstate slots, filled at deployment via `provide({ actors, actions, guards })`, with noop defaults — was tried
and retired (its ADR, 0003, is deleted; this section is its record). It never composed: xstate's `provide()` fills only
the machine it is called on and **cannot reach actors inside child machines**, so host-side injection cannot compose
past one level — and the host has injected nothing since ADR-0011's static-import doctrine ("actor logic is code; live
things are built per-invocation from serializable input"). Workflows author machines against statically-imported
mechanisms. What survives of the idea: the kernel "everything pluggable is an xstate actor", and `.provide()` as the
unit-test seam. The mock-vs-real swap it wanted lives at the wire instead (ADR-0011's stub Harness). CONTEXT.md's
**Template** and **Provider** entries retired with it.
