# Workflows are authored through `jr2Setup`; vocabulary and agent menus derive from the machine

The jr-parity exercise produced a working model but a bad consumer API: mechanism plumbing (manifests, tool lists,
event-union bookkeeping) dominated the workflow. The redesign grill (2026-07-13/14, full record in
[docs/design/workflow-api/](../design/workflow-api/proposal.md)) settled the split: **the consumer writes pure workflow
— states, transitions, prompts, policy — and jr2 absorbs everything else through convention.** This ADR covers the
authoring surface; [ADR-0016](0016-agent-turn-mechanics-are-internal.md) covers the agent turn;
[ADR-0017](0017-pool-over-a-source-port.md) covers the run loop.

## `jr2Setup`: an xstate `setup()` analog, not a DSL

`jr2Setup({ types, events: [defs], actors, actions, guards })` is statically imported and returns xstate's **public
`SetupReturn`** — `.createMachine()` yields a plain `StateMachine`, Stately-inspectable and `.provide()`-testable, with
no jr2 runtime needed to construct it (proven by compiled experiment against xstate 5.32.2; consumer surface has zero
casts). It:

- injects the mechanism events (`agent.fault`, `workspace.lost`) into the event union and derives the workflow event
  types from the zod defs — hand-written `EventFrom` unions retire;
- pre-registers the jr2 actors (`agentRun`, `gate`) with typed inputs;
- takes the defs **as values**, which lets it validate at `createMachine` time that every event key appearing anywhere
  in the machine maps to a def — closing xstate's nested-`on` typo hole (unknown keys in nested states typecheck
  silently upstream) with a load-time failure;
- attaches the vocabulary to the machine (`vocabularyOf(machine)`, a WeakMap keyed on `machine.config` — the object
  xstate's `.provide()` passes through, so a clone keeps it, and the returned machine stays bit-identical). **The
  `export const events` manifest retires**, and the workflow module contract shrinks to `export const machine` (revising
  [ADR-0011](0011-workflow-defined-events.md)'s named-exports contract): the defs ride the Machine, and the actors that
  need them resolve names off the Machine that INVOKED them (ADR-0011, ADR-0049) — the host copies nothing at
  registration, and the only other reader is the Machine doc the Console renders. ADR-0011's anti-global-registry
  argument is preserved — attribution flows through the machine, per-Machine by construction.

## Agent menus and gate accepts derive from the machine

A state that invokes an Agent slot derives the workflow events its Turn may pick: its own transitions, its ancestors'
(bubbled, per statechart semantics), and the transitions written on the states below it — its **modes**. xstate hands an
event to the deepest active state that handles it, and a false guard there falls through to the parent, so a pick
written on a child is one the Turn can take while that child is active. The descent stops at a child that invokes
another Agent slot (a nested Turn: its picks are its own) or a `gate` (its transitions are the Gate's accepted set), and
leaves out everything below that child; a child that runs anything else stays in. A state that invokes `gate` gets its
accepted set from its own and its ancestors' transitions, with no descent. The consumer names neither; MCP appears
nowhere in workflow code. Mechanics: the **vocabulary** derivation is static, in `jr2Setup.createMachine` — a config
walk wraps each invoke's `input` to append the derived names, so names still ride serializable input and the ADR-0007
restore path and invoke-time validation are unchanged. The same walk unions the derived sets of every state that invokes
an Agent of one name into that Agent's **Menu** — its tools, fixed for a conversation so the provider's prompt cache
survives a change of state. The walk reads transition _keys_ and so cannot see guards, which is why what a Turn may pick
is not static on top of it: `agentSurface` asks the invoking machine's guards, and the Turn is told its **Allowed
picks** — the derived set, less every event that the live snapshot, in its active mode, would not take
([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md) owns the rationale).
Authoring is untouched by the split: a workflow names no tools in either leg. The same walk feeds `jr2 visualize` ("this
state's agent can call X, Y"). Dotted names (`agent.*`, `workspace.lost`, `xstate.*`, `after`) are mechanically
excluded.

**A transition belongs to the party that its state, or the nearest state above it, invokes.** The party is the Agent
slot or the `gate` that state invokes, or both when one state invokes both; root transitions, with no such state above,
belong to both. That is who may send an event whose def leaves `audience` unset
(`defineEvent({ audience?: "agent" | "external" | "any" })`, no default):

| Transition written on                                                                             | Unset audience: who may send                                         |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A state that invokes an Agent, or a mode below it                                                 | That Agent                                                           |
| A state that invokes a Gate                                                                       | The Gate's caller                                                    |
| A state that invokes both                                                                         | Both                                                                 |
| A state that invokes anything else (a child Machine, a wrapper body, any other actor), or nothing | The party of the nearest invoking state above; none above means both |

So child or sibling says only "same Turn or not"
([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): an in-Turn Gate's caller sends the Gate's
events and not the Agent's picks, and a nested Agent does not get the outer Agent's picks. **Write an audience only to
give a pick to the other party, or to hold a root pick back.** An explicit `audience` overrides by kind over the whole
reach: `agent` reaches every Agent whose reach holds a writing of the event, `external` every Gate's, `any` both — so
`submit: "any"` lets an in-Turn Gate's caller send the Agent's pick, and `report_blocked: "agent"` keeps a root pick
from the Gates. The reach itself is unchanged by the rule — own and ancestors, plus the modes for an Agent — and the
rule only filters inside it, so no case widens who can send a pick; a test scans every shipped Machine and fixture for
it. Audience says who may SEND, never which transition runs: xstate runs the deepest active handler, whoever sent the
event. The walk computes every party's seat — per state, who may send what — and the Machine's doc carries it, and
`jr2 up` prints it for every registered Machine and every Machine it composes. An explicit `accepts:` on a Gate's input
remains an escape hatch.

**Load checks on modes and audience.** `createMachine` refuses a registered event that no state handles: it is in no
derived set, so it is on no Menu and no Gate. It warns — the Machine stays legal, and the doc carries the warning and
`jr2 up` prints it — about a mode that nothing enters (not initial, and no transition targets it or a state inside it:
its picks are on the Menu and never allowed); about a Gate above an Agent's state that takes an unset-audience writing
the Agent reaches (the one narrowing of the audience rule an author may not expect); and about one name written for two
parties on one path (whoever sends it, the deepest active handler runs). A child with no `onDone` that strands the Agent
in it — a one-way mode — is legal and silent on purpose.

Considered and rejected for modes: a Menu per mode (the tools block would change inside a conversation and bill its
history again — ADR-0029), and refusing picks written below an Agent's state at build (that shape is a mode).

Considered and rejected for the audience: a default of `any` with a convention to tag the sensitive events (an in-Turn
Gate's caller could then send every pick of the Agent above it unless each was tagged `agent`, and a nested Agent got
the outer Agent's picks); a fixed default of `agent` (every Gate event then needs a tag, and the nested leak stays); and
a knob on the Gate (`accepts: "own"`), which fixes the Gate side only. The rule above reads the transition's position,
not a mark written in it, so it is not the per-transition demarcation rejected below.

Considered and rejected: per-transition demarcation (xstate transitions have no typed metadata slot for it without
inventing jr2-only config inside the transition table — a DSL by the back door) and purely structural
own-transitions-only derivation (breaks ADR-0011's blessed handle-`report_blocked`-once-at-an-ancestor idiom).

## Why there is no injection model (the retired ADR-0003)

jr2's first composability story — "workflows are templates of injected providers": Machines reference their moving parts
as named xstate slots, filled at deployment via `provide({ actors, actions, guards })`, with noop defaults — was tried
and retired (its ADR, 0003, is deleted; this section is its record). It never composed: xstate's `provide()` fills only
the machine it is called on and **cannot reach actors inside child machines**, so host-side injection cannot compose
past one level — and the host has injected nothing since ADR-0011's static-import doctrine ("actor logic is code; live
things are built per-invocation from serializable input"). Workflows author machines against statically-imported
mechanisms. What survives of the idea: the kernel "everything pluggable is an xstate actor", and `.provide()` as the
unit-test seam. The mock-vs-real swap it wanted lives at the wire instead (ADR-0011's stub Harness). CONTEXT.md's
**Template** and **Provider** entries retired with it.
