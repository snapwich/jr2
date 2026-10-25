# Workflows are authored through `jr2Setup`; vocabulary and agent menus derive from the machine

The jr-parity exercise produced a working model but a bad consumer API: mechanism plumbing (manifests, tool lists,
event-union bookkeeping) dominated the workflow. The redesign grill (2026-07-13/14, full record in
[docs/design/workflow-api/](https://github.com/snapwich/jr2/blob/71ebe36/docs/design/workflow-api/proposal.md)) settled
the split: **the consumer writes pure workflow — states, transitions, prompts, policy — and jr2 absorbs everything else
through convention.** This ADR covers the Authoring surface; [ADR-0016](0016-agent-turn-mechanics-are-internal.md)
covers the agent turn; [ADR-0017](0017-pool-over-a-source-port.md) covers the run loop.

## The root of `@jr2/orchestrator` is the Authoring surface

A workflow authors against one package: `jr2Setup`, `defineEvent`, `agent`, `workspace`, the Effects, `customize` and
`defineConfig` all import from `@jr2/orchestrator`. Its root exports the Authoring surface (GLOSSARY.md) and nothing
else.

- **The rule.** A name is on the surface when an author writes it in a workflow module or in `jr2.config.ts`. No other
  name is. A name that an author only gets by inference stays off the surface: the event union that `jr2Setup` derives,
  a Gate's input, an Agent's Frame. The `gate` actor is off the surface too. `jr2Setup` registers it, and a state
  invokes it as `src: "gate"`, so no author writes the value. A type is on the surface when an author must write its
  name, for example `Workspaced`, `HostInjectedInput`, `AgentDefinition`, and the types of the parts that `customize()`
  takes. `JR2Config` is on the surface too: the `jr2.config.ts` Reference documents its fields, and an author names it
  to type a config that is built outside `defineConfig()`.
- **Named exports only.** `src/index.ts` names each export (`export { a } from …`, `export type { T } from …`), in
  groups by topic, and has no `export *`. Thus an Assistant that reads the file sees the full surface, and each change
  to the surface is a line in a diff.
- **A test pins it.** `test/authoring-surface.test.ts` makes sure that `index.ts` has no `export *`, that the root's
  runtime values are equal to a sorted list in the test, and that the type names in the `export` lists of `index.ts` are
  equal to a second sorted list. A name that is added or removed fails the test until the list changes. The same test
  makes sure that `@jr2/machines` and each Instance-shaped folder import the root only.
- **The kit's own packages import `@jr2/orchestrator/internal`.** It holds the surface and all that the kit shares: the
  run host, the HTTP API, the Harness wire, the Custodian, the Effector wire, the cluster names. It is not for authors,
  and it has no stability promise: any name in it can change in any release. A Machine that the kit ships
  (`@jr2/machines`) and each Instance-shaped folder in the repo import the root only. The `exports` map has `.`,
  `./internal` and `./tsconfig.instance.json`, and nothing else. Thus an Instance that imports a deep path, such as
  `@jr2/orchestrator/src/run-host.ts`, does not resolve it, in `tsc` or in Node.

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

`events` is optional, and so is the whole argument: a Machine with no Vocabulary leaves `events` out, or calls
`jr2Setup()`, and its event type is the Mechanism events alone. Such a Machine still uses `jr2Setup` when it declares a
door ([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)), because xstate's `setup()` does not read the
`input` of `createMachine`. An empty Vocabulary is the default, not `readonly EventDef[]`, so the type of `event` does
not widen to every event name. A required `events` was considered and rejected: `events: []` tells the reader nothing,
and the compiler gave a missing `events` as a large structural diff of `SetupReturn`, not as the name of the missing
key.

## Agent menus and gate accepts derive from the machine

A state that invokes an Agent slot derives the workflow events its Turn may pick: its own transitions, its ancestors'
(bubbled, per statechart semantics), and the transitions written on the states below it — its **modes**. xstate hands an
event to the deepest active state that handles it, and a false guard there falls through to the parent, so a pick
written on a child is one the Turn can take while that child is active. The descent stops at a child that invokes
another Agent slot (a nested Turn: its picks are its own) or a `gate` (its transitions are the Gate's accepted set), and
leaves out everything below that child; a child that runs anything else stays in. A state that invokes `gate` gets its
accepted set from its own and its ancestors' transitions and those written on its plain children, by the same descent:
position gives a Gate the writings below it that no other party answers for, as it gives an Agent its modes (the Pool's
wake Gate, on its root, takes the writing on `parked`). The consumer names neither; MCP appears nowhere in workflow
code. Mechanics: the **vocabulary** derivation is static, in `jr2Setup.createMachine` — a config walk wraps each
invoke's `input` to append the derived names, so names still ride serializable input and the ADR-0007 restore path and
invoke-time validation are unchanged. The same walk unions the derived sets of every state that invokes an Agent of one
name into that Agent's **Menu** — its tools, fixed for a conversation so the provider's prompt cache survives a change
of state. The walk reads transition _keys_ and so cannot see guards, which is why what a Turn may pick is not static on
top of it: `agentSurface` asks the invoking machine's guards, and the Turn is told its **Allowed picks** — the derived
set, less every event that the live snapshot, in its active mode, would not take
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
from the Gates. A def means one thing: its description must be true at every writing its party can reach, and two
meanings are two defs. The reach itself is unchanged by the rule — own and ancestors, plus the states below with no
party-invoking state between (an Agent's modes, a Gate's plain children) — and the rule only filters inside it, so no
case widens who can send a pick; a test scans every shipped Machine and fixture for it, both the derived names and the
writings each party may take at run time. The walk computes every party's seat — per state, who may send what — and the
Machine's doc carries it; `jr2 up` prints it for every registered Machine and every Machine it composes, and the Console
shows the same lines, folded beside the workflow's diagram (structure, so tokenless too). An explicit `accepts:` on a
Gate's input remains an escape hatch.

**`sentBy(id)`: a writing that declines other senders.** Every event a party delivers carries its sender (ADR-0011):
`sender: { party, id }`, the Agent's slot or the Gate's invoke id. `jr2Setup` registers one guard, `jr2.sentBy`, and the
author writes it on a writing as `guard: sentBy("coder")` — a named guard with params, alone or inside `and([...])`. It
is true for an event whose `sender.id` is `id` and for an event with no sender (the Machine's own: `raise`, `sendTo`
itself, a child's `sendParent`), and false otherwise, so xstate's own selection moves outward to the next writing of the
name. It can only make a writing decline; it never gives a writing to a party — position does. `id` is an Agent slot or
a Gate's invoke id of this Machine, and a `sentBy` that names neither is refused at load, like an unknown event key.
Under `or()` or `not()`, or in an author's own guard that reads `event.sender`, it works at run time but the walk cannot
read it. A `.provide()` test sends as a party by writing the field: `{ type, sender: { party, id } }`.

**A delivery never runs another party's writing.** Audience says who may send a name; xstate selects which writing runs,
deepest active first, whoever sent it. So at delivery the real event — its payload and its sender — goes through
xstate's own selection (`getTransitionData`) before the Machine sees it, and if a writing selected is one the sender may
not take by the position rule above, the event is refused: an Agent's pick is answered `moved: false` and not delivered
(ADR-0029), a Gate's caller gets 409 with what the Gate takes now (ADR-0013). The lists ask the same question the same
way, payload-blind: an Agent's Allowed picks and a Gate's `acceptsNow` are the names whose selection, for an event that
carries the sender and with every guard that reads the payload counted as passing, moves something and holds only
writings the sender may take. A guard that reads the payload is unknown there and passes the party question; it is never
the fail-open of a party check skipped, because delivery asks again with the real payload. The payload-blind selection
is a copy of xstate 5.32.2's (`transitionNode`, `StateNode.next`, `evaluateGuard`, the members of `and`/`or`/`not`),
pinned against `getTransitionData` in the default test run — the canary for an xstate bump. Without a `sentBy`, nothing
misroutes: the shallower party is refused while the deeper writing is active, and the walk warns (below). When the
deeper party runs BELOW an Agent's state — a Gate, a nested Agent — the Agent's state is not at Rest, so the Agent's
picks are refused before the selection is asked
([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)); the selection decides the Gate's caller's
sends there, and every case with the Agent's state at Rest.

**Load checks on modes and audience.** `createMachine` refuses a registered event that no state handles: it is in no
derived set, so it is on no Menu and no Gate. It refuses a parallel region below a state that invokes an Agent — the
Agent's state itself being parallel included, since its regions are below it: the shape is reserved for picks the Agent
does not wait for, which jr2 does not build, and background work goes above the Agent's state. It warns — the Machine
stays legal; the doc carries the warning, `jr2 up` prints it and the Console shows it with the seats — about a mode that
nothing enters (not initial, and no state the Machine can enter has a transition into it or a state inside it — so
neither the mode's own `initial` nor its transition into itself counts: its picks are on the Menu and never allowed; a
transition into a history state enters that history state's default target, shallow or deep, or its parent's initial
state when it names none, and a default target the walk cannot resolve is its own warning); about a Gate above an
Agent's state that takes an unset-audience writing the Agent reaches (the one narrowing of the audience rule an author
may not expect); about two parties' writings of one name that can be active together; about one party's writings of one
name that mean two things; and about two shapes below an Agent's state that keep it from Rest, so every pick of the
Agent waits (ADR-0024): a Gate whose answer has no target (the Gate stays open after it), and a long-lived invoke — one
that runs until its state exits, not a promise, an Effect, a Gate, an Agent or a child Machine. A child with no `onDone`
that strands the Agent in it — a one-way mode — is legal and silent on purpose, an Effect child included.

**Load checks on Effects** (ADR-0067). `createMachine` refuses a state below an Agent's state that invokes something and
that nothing enters: what it invokes never runs (a mode nothing enters is only the warning above). Both checks read one
reachability walk, history defaults included; where a history default the walk cannot resolve may enter such a state,
the walk does not know, and it warns instead of refusing. Both checks look below a state that invokes an Effect or a
child Machine, and stop at one that invokes another Agent or a Gate. Where a pick enters a state that invokes an Effect,
every param of the pick must be read by something — the check is per state, not per invoke — by the input of any invoke
of that state, an Effect's or not, so a second invoke beside the state's work counts (`fromPick` reads each param that
is a key of the Effect's input, a command's argv slots, and each one its `fill` reads; on an invoke that is no Effect it
reads every param, and on a command whose argv is Open it reads every param too, since the argv's slots are the
composer's — `customize()` runs this check again when it binds the argv and refuses there a param the bound argv does
not read, and gives the bound Machine the warnings the walk gives for that argv
([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)); a plain mapper is probed with
a recording event), by the entering transition's guard (inline, named, or inside `and`/`or`/`not`), or by an `assign` on
the entering transition or on the entry of a state it enters — else the Agent supplies it and nothing uses it: refused.
A pick enters what xstate enters: its target, the target's ancestors below the transition's domain, and their initial
descendants — and what an eventless `always` on a state it entered enters next, in the same macrostep with the same
event, whose guard and actions count as the entering transition's. So a pick that targets a compound state enters the
child that invokes, a pick that targets a child enters the ancestor that invokes, a pick that targets a state whose
`always` moves on enters where it moves, and a transition inside the invoking state does not enter it. A pick is a
writing an Agent may send (the position rule above); a Gate's event is a human's, and its params are not checked. The
walk does not carry a pick's params across a timer: where an `after` on a state the pick entered moves on to a state
that invokes an Effect, the Effect's input and every guard and action from the timer on read the timer's event, so only
a guard or `assign` before the timer reads them — a param that must cross is stored with `assign` on the pick's
transition, and one nothing stores is refused. A pick that targets a history state enters what was last active, which
the walk cannot know: where that may be a state that invokes an Effect, the pick's params there are unchecked, and it
warns. A guard and an assign are pure by contract, so the probe runs them; it runs no other action. TypeScript does not
catch a `fromPick` param that is no key of the input: it accepts an extra key on a spread. It refuses a `fill` that sets
a key that is also a param (the Machine's value would drop the Agent's), and a `fromPick` of a pick other than the event
that enters the state. Code the probe cannot or does not run may read a param, so it gives a warning, never a refusal: a
mapper, guard or assign that throws in the probe, and — where a param is left unread — any other action on the entering
transition or on the entry of a state it enters, named in the warning. Its params are unchecked. It warns where an
Agent's state answers on a mode's entry (`answer`) and an Effect below it has no `onDone`: the Effect settles in place,
that mode is not entered again, and the Agent reads the Effect's output, not the answer. A pick that enters no Effect,
directly or across a timer, is not checked for its params.

- **Two parties' writings of one name that can be active together** — one above the other on one path, or in parallel
  regions — where the deeper writing (each other region's, for parallel regions) does not decline the other sender with
  a `sentBy` the walk can read. xstate would select it for the other party's event, so delivery refuses that event while
  both are active. The warning names both writings and shows the corrected line, with the guard on the DEEPER writing,
  because xstate selects deepest first and only a declining deeper writing lets selection move outward:

  ```
  "approve" on "s2.release" (Gate "review-1") and on "s2.release.work.draft" (Agent "coder") can be active together;
  Gate "review-1"'s "approve" would run Agent "coder"'s writing, so jr2 refuses it while both are active. Make the
  deeper writing decline other senders:
    draft: { on: { approve: { guard: sentBy("coder"), target: "#s2.doneB" } } }
  ```

  A root writing is both parties', so the root-writing shape — a root `cancel`, a Gate below it, the Agent's `cancel` in
  a mode — is the same case: the line goes on the mode's writing, and the Gate's caller's `cancel` then runs the root
  writing. The Agent's writing above a party seated BELOW the Agent's state — a Gate, a nested Agent — is not the case:
  while that party runs, the Agent's state is not at Rest, so every pick of the Agent is refused whatever its guard, and
  a `sentBy` on the deeper writing would change nothing; the walk does not warn there. Siblings (a mode and a Gate's or
  another Agent's sibling state) are not the case: neither writing is ever selected for the other, and delivery answers
  a send there like any pick the state does not take. A Gate whose invoke id the walk derived is named so in the line;
  giving its invoke an `id` names it. A `sentBy` under `or()` or `not()` leaves the warning in place.

- **One def, one meaning.** One party's writings of one name on one path with different targets: its sender reads one
  description for both, and only the deepest active writing runs. The warning says to make the def's description true at
  each writing or to give them distinct names. xstate's own transition `description` rides the Machine doc beside each
  writing.

Known limits, not built: two states on one path that invoke one Agent slot share one sender id, so `sentBy` cannot tell
their Turns apart; and a child Machine that forwards a party's event to its parent (`sendParent`) hands it the child's
sender, whose id names a slot or Gate of the child — if the parent has one of that name, `sentBy` matches it. Only
author code forwards an event.

Considered and rejected for modes: a Menu per mode (the tools block would change inside a conversation and bill its
history again — ADR-0029), and refusing picks written below an Agent's state at build (that shape is a mode).

Considered and rejected for the audience: a default of `any` with a convention to tag the sensitive events (an in-Turn
Gate's caller could then send every pick of the Agent above it unless each was tagged `agent`, and a nested Agent got
the outer Agent's picks); a fixed default of `agent` (every Gate event then needs a tag, and the nested leak stays); and
a knob on the Gate (`accepts: "own"`), which fixes the Gate side only. The rule above reads the transition's position,
not a mark written in it, so it is not the per-transition demarcation rejected below.

Considered and rejected: per-transition demarcation (xstate transitions have no typed metadata slot for it without
inventing jr2-only config inside the transition table — a DSL by the back door) and purely structural
own-transitions-only derivation (breaks ADR-0011's blessed handle-`report_blocked`-once-at-an-ancestor idiom). Position
stays the default and the owner of every writing. `sentBy` is not demarcation: it is an ordinary xstate guard, written
only where a writing must decline other senders, and it cannot give a writing to anyone.

## Why there is no injection model (the retired ADR-0003)

jr2's first composability story — "workflows are templates of injected providers": Machines reference their moving parts
as named xstate slots, filled at deployment via `provide({ actors, actions, guards })`, with noop defaults — was tried
and retired (its ADR, 0003, is deleted; this section is its record). It never composed: xstate's `provide()` fills only
the machine it is called on and **cannot reach actors inside child machines**, so host-side injection cannot compose
past one level — and the host has injected nothing since ADR-0011's static-import doctrine ("actor logic is code; live
things are built per-invocation from serializable input"). Workflows author machines against statically-imported
mechanisms. What survives of the idea: the kernel "everything pluggable is an xstate actor", and `.provide()` as the
unit-test seam. The mock-vs-real swap it wanted lives at the wire instead (ADR-0011's stub Harness). GLOSSARY.md's
**Template** and **Provider** entries retired with it.
