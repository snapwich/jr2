# xstate capabilities report — for the jr2 workflow-API redesign

Basis: **installed xstate 5.32.2** (`node_modules/.pnpm/xstate@5.32.2`), verified against its `.d.ts` and shipped JS,
plus compiled/executed experiments in `scratchpad/xstate-lab/` (`exp1-jr2setup.ts`, `exp1b/1c`, `exp2-wrapper.ts`,
`exp2b`, `exp3-introspect.ts`, `exp4-inspection.ts`, `exp4b/4c`). Every claim below marked **[verified]** was
typechecked with the repo's tsc 5.9.3 (strict, NodeNext) or executed under Node 24 against the installed package.
TypeScript-level claims are about this exact version; 5.32.2 is well ahead of the `^5.18.0` floor in package.json and
ships several features the redesign can lean on.

**Version note:** 5.32.2 exports things 5.18-era docs don't mention: `SetupReturn` (public), `setup().extend`,
`setup().createStateConfig` / `createAction`, `getNextTransitions`, `xstate.route` routable-state-ID events, and a
**bundled `xstate/graph`** entry (`toDirectedGraph`, `getAdjacencyMap`, `getShortestPaths`, `createTestModel`). No extra
deps needed for graph work.

---

## 1. `jr2.setup` analog (decision 7) — FEASIBLE, proven by typecheck

**How setup() is typed.** `setup()` infers 12 type params from its argument
(`TContext, TEvent, TActors, TChildrenMap, TActions, TGuards, TDelay, TTag, TInput, TOutput, TEmitted, TMeta`) and
returns `SetupReturn<...>` — which in 5.32.2 is a **public export**, so a wrapper can name its return type without
reverse-engineering. `SetupReturn.createMachine` returns a plain `StateMachine` (Stately-inspectable,
`.provide()`-able). `SetupReturn` also carries bound helpers (`assign`, `sendTo`, `raise`, `spawnChild`,
`enqueueActions`, `emit`) plus `extend({actions, guards, delays})` and `createStateConfig` (typed reusable state
fragments).

**The wrapper works** [verified, `exp1-jr2setup.ts` compiles clean]:

```ts
function jr2Setup<TContext, TEvent, TActors = {}, TActions = {}, TGuards = {}, ...>(def)
  : SetupReturn<TContext, TEvent | MechEvent, JR2Actors & TActors, {}, TActions, TGuards, ...>
```

- Mechanism events (`agent.fault`, `workspace.lost`, ...) injected into the union: consumer's
  `on: { "agent.fault": ... }` typechecks, and consumer guards/actions see the full union.
- Pre-registered `agentRun`/`gate` invokable by name with **typed input**; consumer actors merge in.
- `event.output` typed on consumer-actor `onDone`; event narrowing in guards works; guard/action NAMES are checked;
  unregistered invoke `src` rejected.
- Result satisfies `AnyStateMachine`; `.provide({ actors, guards })` works with typed names.
- Implementation needs exactly **one jr2-internal cast** (re-asserting the merged `SetupReturn`); the consumer surface
  has none.

**Bonus surface for the same wrapper:** because jr2Setup takes the event **defs as values** (not just types), it can
validate at `createMachine` time that every event key appearing in the machine maps to a def — see the nested-`on` typo
hole in §6. This is what lets `export const events` die without losing validation: `machine.events` (see §2) is the
runtime vocabulary, defs are the schema source, and the wrapper joins them.

**Prior art.** Stately's own `@statelyai/agent` derives event unions from zod maps
(`EventsFromZodEventMapping<TEventSchemas>` — same shape as GAP(1)'s `EventFrom`) and its newer API is literally
`setupAgent()`/`createMachine()`; however it builds its own `Agent extends Actor` rather than returning `SetupReturn`.
Nobody I found wraps `setup()` returning `SetupReturn` — but exp1 proves it directly against the installed types, which
is stronger than prior art.

**One upstream typing gap to know about** [verified, `exp1b`/`exp1c`]: unknown event **keys** in a **nested state's**
`on` are silently accepted (top-level `on` rejects them; values — guards, narrowing, action names — are still fully
checked at every depth). Consequence for decision 7 in §6.

---

## 2. Machine-definition introspection (decision 4) — EVERYTHING NEEDED EXISTS

All [verified] by running `exp3-introspect.ts`.

**(a) Events a state handles, incl. bubbled ancestors — static.** `machine.getStateNodeById(id)` returns a `StateNode`
with: `transitions: Map<string, TransitionDefinition[]>` (own handlers), `on` (map form), `ownEvents`, `events` (own +
descendants), and `parent`. Walking `node.transitions.keys()` up the `parent` chain yields exactly the right answer —
for `body.working.coding` in a jr-shaped machine: own `request_review`/`report_blocked` + bubbled `agent.fault` (from
`working`) + `workspace.lost` (from root).

Even better, 5.32.2 exports **`getNextTransitions(snapshot)`**: all transitions available from a live state including
ancestors and delayed/always, deterministic order, each a `TransitionDefinition` with `eventType`, **`source` (the
owning StateNode)**, `target`, `guard`, `meta`, `description`. `source` is the disambiguator the brief asks for:
derivation can distinguish "this state's own transition" from "bubbled ancestor handler" mechanically
(`t.source === invokingNode` vs ancestor), so the "bubbled `approve` must not reach the agent" problem has a structural
answer, not just demarcation.

**Demarcation channel exists too:** `TransitionConfig` has `meta?: TMeta` (typed via setup `types.meta`) and
`description?: string`, both preserved on `TransitionDefinition` and readable statically.
`meta: { jr2: { deliver: "human" } }` on gate transitions is fully supported.

**(b) Whole-machine vocabulary.** `machine.events: EventDescriptor[]` — flat list of every event type the machine
handles anywhere ([verified]: returns exactly the five workflow+mechanism types, no noise). The `export const events`
manifest is indeed derivable. Caveat: it contains event _names_ only; schemas must come from the defs (hence jr2Setup
taking defs as values).

**(c) Tools-from-transitions at invoke time — runtime, from inside the actor.** [verified] Invoked actor logic receives
`self`; `self._parent: AnyActorRef` is public-ish API (`ActorRef` interface, types.d.ts:797). From inside `agentRun`:
`self._parent.getSnapshot()._nodes` (active StateNodes) → find the node whose `invoke[].id === self.id` → walk
`transitions` + `parent` chain. exp3's fromCallback agent derived
`[request_review, report_blocked, agent.fault, workspace.lost]` from inside the invocation, at start time, with zero
consumer plumbing. `_nodes` is on the public `MachineSnapshot` interface (underscore-prefixed but typed, not hidden).

Alternative (also viable, fully static): jr2Setup's `createMachine` can rewrite the config before handing it to xstate —
for each state that invokes `agentRun`, compute the derived tool set from the config itself and wrap the consumer's
`input` mapper to append it. Both approaches compose; the static one also feeds `jr2 visualize`.

Note the machine also exposes `getTransitionData(snapshot, event)`, pure `transition()` / `getMicrosteps()` (host-side
replay without executing actions), and `snapshot.can(event)`.

---

## 3. Wrapper / child-machine mechanics (decisions 1, 6)

**Typed wrapper pattern — the coding.ts casts are eliminable, but not the naive way.**

- A _fully generic_ `setup()` call inside `workspace<TBody extends AnyStateMachine>` does **not** typecheck [verified,
  exp2 v1]: the provided-actor union fails to distribute over a generic `TBody`; expected onDone events collapse into an
  impossible intersection (`DoneActorEvent<unknown> & DoneActorEvent<{handles}> & ...`). This is structural
  (`TSpecificActor extends {src: TSrc}` can't resolve against an unresolved generic), not fixable by annotation.
- The working pattern [verified, exp2 v2 compiles clean]: **loosely-typed implementation + precisely-declared public
  signature**:
  `workspace(body: TBody, spec): StateMachine<..., TInput = Omit<InputFrom<TBody>, "workspace">, TOutput = OutputFrom<TBody>, ...>`
  with one jr2-internal `as` at the return. Consumers get: `spec`'s `input` fully typed; `InputFrom<typeof wrapped>` =
  body input _minus_ `workspace` (a `@ts-expect-error` proves the handle can't be passed from outside); `OutputFrom` =
  body output. Inside the impl, `src: body as AnyStateMachine` makes onDone `event.output` be `any` — no casts needed
  internally either (one annotation quirk: the input mapper for an `AnyStateMachine` src loses contextual typing, so
  `({ context }: { context: WsCtx })`).

**Root-output forwarding pain — root cause + cast-free fix.** `MachineConfig.output` is
`Mapper<TContext, DoneStateEvent, TOutput, TEvent>` and `DoneStateEvent.output: unknown` — that's why coding.ts casts.
Machine output MUST be at the root (final-state `output` only rides the done event; confirmed in types and by the
codebase's own GAP(5) note). Cast-free pattern [verified in exp2]: assign the outcome into context on the way into
finals, `output: ({context}) => context.outcome`. jr2Setup can make this the documented idiom (or ship a helper).

**`xstate.done.actor.*` wildcard — casts ARE eliminable** [verified, exp2]: declare `DoneActorEvent<BodyOutput, string>`
in the event union (its `type` is `` `xstate.done.actor.${string}` ``, so it covers dynamic child ids), then
`on: { "xstate.done.actor.*": ... }` narrows via `NormalizeDescriptor`/`ExtractEvent`: `event.output.feature` is fully
typed in `stopChild`, `assign`, guards — **zero casts**. This alone deletes both casts flagged in coding.ts's top
machine.

**The remaining cast source** [verified, exp2b]: `spawnChild`'s option mappers are inconsistently typed upstream —
`id: ({event}) => ...` gets the **narrowed** transition event, but `input: ({event}) => ...` gets the **full machine
union** (`SpawnActionOptions.input` uses `TEvent`, not `TExpressionEvent` — actions/spawnChild.d.ts). Cast-free
workaround: xstate's `assertEvent(event, "claimed")` (runtime-checked narrowing, idiomatic). Or remove hand-written
`spawnChild` from consumer code entirely via a pool primitive (§4) — then the hole lives in jr2 code once.

**spawnChild vs invoke tradeoffs** (all verified against source/behavior):

|                   | `invoke`                                                       | `spawnChild`                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lifecycle         | bound to state; auto-stopped on exit                           | until stopped/machine stops (survives state changes — required for the top loop)                                                                                                                                                        |
| completion        | `onDone`/`onError` sugar, `event.output` typed per-src         | done arrives as `xstate.done.actor.<id>` on the machine; wildcard + `DoneActorEvent<T, string>` types it (above)                                                                                                                        |
| static trace      | first-class: `stateNode.invoke[]`, in `definition`/Stately viz | action object carries `.type === 'xstate.spawnChild'`, `.src`, `.id` on the **live** node's transition actions — machine-doc.ts already reads exactly this; **`toJSON()` strips it**, so viz must walk the live machine, which jr2 does |
| dynamic count/ids | one per state entry, fixed id                                  | N children, computed ids — the pool case                                                                                                                                                                                                |
| restore           | re-executes from persisted input                               | children persist in snapshot `children` map — **only if `src` is a registered string** (§6)                                                                                                                                             |

**Stop-is-synchronous** [verified, exp4]: `actor.stop()` runs invoked-callback cleanups and exit actions synchronously;
an async exit body cannot be awaited (demonstrated: microtask not yet run when `stop()` returns). Also `stopChild`
throws unless the target is the caller's own child ("Cannot stop child actor ... because it is not a child"). ADR-0012's
argument (teardown must be wrapper-owned _states_) is confirmed at the source level; any pool primitive must likewise
own its workers to stop them.

**Encapsulation alternatives for decision 1** the installed version enables:

- **Child-machine wrapper** (status quo): only mechanism that can hold teardown states — required wherever teardown
  exists (workspace). Now typeable cleanly (above).
- **`setup().createStateConfig`** (new in 5.32.x): typed reusable state fragments. jr2 could ship state-config
  _factories_ (e.g. a human-gate state, an agent-turn state) consumers splice into their own machine — no child machine,
  shows in the consumer's own state tree, zero output forwarding. Doesn't cover teardown-on-final, so it complements
  rather than replaces the wrapper.
- **Config rewriting inside jr2Setup.createMachine** (machines are data): inject/augment states or inputs before xstate
  sees the config. Powerful, invisible — use sparingly (viz shows the rewritten truth, which may actually be desirable:
  visualize would show what runs).

---

## 4. Concurrency-pool patterns (decision 6)

**No first-class primitive exists** in xstate v5 or any maintained library I could find (searched; Stately docs only say
"spawn for dynamic numbers of actors"; community articles hand-roll it). The canonical v5 pattern is exactly what
coding.ts does: context counter + guard against cap + `spawnChild` + collect via done events. So a jr2 `pool` would not
be fighting an ecosystem convention — there's a vacuum.

**What xstate gives a pool primitive:**

- Spawn-under-cap: guard on `context.active.length < cap`; re-enter a `claim` state until saturated/dry (coding.ts's
  `discover`), or drive from a source-actor's `onSnapshot`/events.
- **Completion collection typing**: `DoneActorEvent<WorkerOutput, string>` in the pool machine's event union +
  `"xstate.done.actor.*"` — fully typed, no casts [verified]. Worker errors: `xstate.error.actor.*` / `ErrorActorEvent`
  same shape.
- Generalized source: the pool machine invokes a **source actor** (callback/observable logic wrapping a queue,
  generator, or re-queried set — Work Source becomes one adapter) and spawns a **worker** per item. Both `source` and
  `worker` must be **registered string srcs** on the pool machine's setup for durability (§6) — which forces the right
  API anyway: `pool({ worker, source, cap })` as a statically-imported machine factory, exactly like
  `workspace(body, spec)`. Typing: same declared-signature pattern as §3 (`InputFrom<TWorker>`-derived item type,
  `OutputFrom<TWorker>`-typed collection).
- `stopChild` scoping means the pool machine must own its workers (it does, by construction).

**Visualizable: yes.** machine-doc.ts already descends into registered actor machines and reads `xstate.spawnChild`
actions off live transition definitions. A pool machine whose `claim` state has a top-level `spawnChild("worker", ...)`
action leaves precisely the trace `jr2 visualize` reads — and because the pool is jr2-owned and written once, the "keep
spawnChild top-level" comment-enforced footgun moves out of consumer code permanently (the brief's success bar names
this explicitly). The pool's own states (claiming/saturated/settling/idle) become an honest, stable diagram fragment.

---

## 5. Observability (decisions 2, 5)

**Inspection surface** (inspection.d.ts + [verified] exp4/4b/4c): one `ActorSystem` per root tree;
`system.inspect(observer | fn): Subscription` can be attached and detached **at runtime**, and
`createActor(logic, { inspect })` just calls it. Events, all carrying `rootId` + `actorRef`:

- `@xstate.actor` — every actor created, **any depth** (grandchildren included);
- `@xstate.event` — every event delivered to any actor, with `sourceRef` (includes `xstate.done.actor.*` between levels
  — grandchild→child observed at root [verified]);
- `@xstate.snapshot` (committed) and `@xstate.microstep` — the microstep carries `_transitions: TransitionDefinition[]`,
  i.e. _which_ transition fired, statically identified;
- `@xstate.action` — each action execution incl. `xstate.spawnChild` / `xstate.stopChild` / `xstate.emit` with params.

So a host can observe **system-wide, with zero consumer bookkeeping**: iid→offset persistence (decision 2 — jr2 already
rides this stream per GAP(5)), and retry telemetry (decision 5 — each internal re-invoke shows up as `@xstate.actor` +
events; a retry counter is derivable host-side, or jr2's internals can `emit()` and the host `.on()`s refs captured from
`@xstate.actor`).

**Three sharp edges** [all verified]:

1. **Attach timing**: children of the _initial_ state are constructed during `createActor()` itself, not `.start()`
   (exp4c: `@xstate.actor` for spawned+invoked children fire before `start`). A late `system.inspect` misses those
   creations (it still sees all subsequent events/snapshots). Hosts must pass `inspect` at `createActor` — jr2's RunHost
   owns that call, so this is fine but must be honored by design.
2. **`system.getAll()` / `get()`** cover only `systemId`-registered actors, and registration is dropped the moment an
   actor leaves `active` status (done promise → unregistered, exp4c). Not an enumeration API for the tree; the
   inspection stream is.
3. **`emit()` from non-machine logic** (fromCallback/fromPromise scope `emit`) notifies only `.on()` listeners — it does
   NOT produce an inspection event (verified in Actor-constructor source: `actorScope.emit` never calls
   `_sendInspectionEvent`; machine `emit` _actions_ do surface as `@xstate.action`). Retry telemetry from inside
   `agentRun` should therefore ride either machine-level emits, the inspection-visible event flow, or jr2's own host
   channel.

**Static traces for visualize**: covered in §3/§4 — `invoke` is first-class in the definition; `spawnChild` is readable
off live transition actions (`.type/.src/.id`) but lost through `toJSON()`; anything inside an `enqueueActions` closure
is invisible (the closure serializes as `{type: 'xstate.enqueueActions'}`), which is the known blind spot — a pool
primitive (§4) is the structural fix.

---

## 6. Hard limits / reshapers — explicit list

1. **Generic-over-body `setup()` doesn't infer** (exp2 v1). Reshapes decisions 1/6 implementation: every jr2
   machine-factory (workspace, pool) must use declared-public-signature + erased-impl (+1 internal cast each). No
   consumer impact. Not a killer.
2. **Inline (object-src) spawned children cannot be persisted** — runtime throw
   `"An inline child actor cannot be persisted."` (getPersistedSnapshot source; escape hatch
   `__unsafeAllowInlineActors`). Everything durable must be a **registered string src**. This _strengthens_ decision 7:
   jr2Setup's pre-registration is what makes decisions 2/6 durable. Invoked actors get auto-generated referenced srcs,
   so factory-internal `fromPromise`s are fine.
3. **Nested `on` accepts unknown event keys** (TS excess-property hole, exp1b — top-level `on` rejects them; values
   fully checked). With the manifest dead and vocabulary derived from the machine, a typo'd key silently becomes
   vocabulary. Reshapes decision 7: jr2Setup must validate `machine.events` ⊆ (defs ∪ mechanism events) at
   `createMachine` time — cheap, runtime, load-fail-fast. (Worth an upstream issue too.)
4. **`spawnChild.input` mapper is typed with the full event union** (exp2b, upstream d.ts). Kills "zero casts" only for
   hand-written consumer spawns; `assertEvent` or the pool primitive (§4) resolves it.
5. **Machine output only at root; done-event `output` is `unknown` in the root mapper.** Cast-free idiom exists
   (outcome-in-context); should be the documented jr2 pattern, else every consumer final-state machine re-grows the
   coding.ts cast.
6. **Stop is synchronous; no async teardown outside states** (exp4). Confirms ADR-0012's wrapper-with-teardown-states;
   also means a pool draining gracefully needs explicit draining states, and workers must be stopped by their owner
   (`stopChild` scope check).
7. **Inspection misses initial-children creation if attached late; `emit` from callback logic is not in the inspection
   stream; receptionist unregisters on completion** (§5). Constrains how retry telemetry and offsets are collected — all
   compatible with jr2's current host-owned `createActor`.
8. **`enqueueActions` is statically opaque** — permanent; don't design any consumer-facing pattern that requires it (the
   pool absorbs the one legitimate use).

Nothing found kills any brief decision. Decisions 4 and 7 in particular sit on _more_ capability than the brief assumes
(`getNextTransitions` with per-transition `source`, transition `meta` for demarcation, `machine.events`, `SetupReturn`
being public, defs-as-values validation).

## Experiment inventory (reproducible)

All in `scratchpad/xstate-lab/` (symlinked against the repo's installed packages; `tsc --strict --module nodenext`, Node
24):

- `exp1-jr2setup.ts` — jr2Setup wrapper, full consumer surface typed, compiles clean.
- `exp1b/1c` — nested-`on` unknown-key hole isolated; value-checking confirmed intact.
- `exp2-wrapper.ts` — typed workspace factory (declared signature), wildcard done typing, zero consumer casts; `exp2b` —
  spawnChild id-vs-input mapper typing.
- `exp3-introspect.ts` — static + runtime event derivation, ancestor walk, `_parent` introspection from inside an
  invoked actor, spawnChild live-vs-toJSON trace, `toDirectedGraph`.
- `exp4-inspection.ts`, `exp4b/4c` — inspection event catalog, late-attach behavior, creation timing, `getAll`
  semantics, stop synchronicity.
