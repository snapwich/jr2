// `jr2Setup` — the authoring surface (ADR-0015): an xstate `setup()` analog, not a DSL. It returns
// xstate's public `SetupReturn`, so `.createMachine()` yields a plain `StateMachine` — Stately-
// inspectable, `.provide()`-testable, constructible with no jr2 runtime. What the wrapper adds:
//
//   - the MECHANISM events (`agent.fault`, `workspace.lost`, …) are injected into the event
//     union, and the WORKFLOW event types derive from the zod defs — hand-written `EventFrom`
//     unions retire;
//   - the jr2 `gate` actor is pre-registered with typed input (a consumer actor under the same
//     name wins — the unit-test seam), and every Agent SLOT the machine declares
//     (`actors: { coder: agent(def) }` — ADR-0049) gets the same input finalization by brand;
//   - because it takes the defs AS VALUES, `createMachine` validates that every event key
//     appearing anywhere in the machine maps to a def — closing xstate's nested-`on` typo hole
//     (unknown keys in nested states typecheck silently upstream) with a load-time failure;
//   - the vocabulary is attached to the machine object (`vocabularyOf` — vocabulary.ts), which
//     is what lets the `export const events` manifest die (ADR-0011 revised). It is scoped to
//     THIS Machine: `gate` and the Agent slots resolve names against the Machine that invoked
//     them, so a Machine nested by plain `invoke` keeps its own names and this one never sees
//     them (ADR-0049);
//   - an optional `input` on the createMachine config — a zod object — declares what a RUN of
//     this machine is started with (ADR-0033). It rides the machine object beside the vocabulary
//     (`inputSchemaOf`), never the xstate config: the host validates `POST /workflows/:name/runs`
//     bodies against it and serves it as JSON Schema; absent, the door stays permissive.
//
// The typing follows the proven declared-signature pattern (report-xstate §1): the public
// signature is precise, the implementation is loosely typed with ONE jr2-internal cast at the
// return. The consumer surface has none.

import { randomUUID } from "node:crypto";
import {
  setup,
  type ActionFunction,
  type AnyActorRef,
  type AnyStateMachine,
  type DelayConfig,
  type EventObject,
  type GuardPredicate,
  type MachineContext,
  type MetaObject,
  type NonReducibleUnknown,
  type ParameterizedObject,
  type SetupReturn,
  type UnknownActorLogic,
} from "xstate";
import type { z } from "zod";
import { eventMap, type EventDef, type EventFrom, type Sender } from "@jr2/agent-protocol";
import type { AgentRunInput, AgentTurnInput, FaultTelemetry } from "./actor.ts";
import { isAgent } from "./agent.ts";
import { isEffect } from "./effect.ts";
import { effectChecks } from "./effect-checks.ts";
import { gate } from "./gate.ts";
import { partyWarnings, refuseUnknownSentBy, SENT_BY, sentByGuard } from "./party.ts";
import { boundEpoch, boundRunId, continuedIid } from "./registration.ts";
import { attachInputSchema, attachLoadWarnings, attachSeats, attachVocabulary } from "./vocabulary.ts";

/**
 * The events jr2's own mechanism delivers into any workflow machine, injected into every jr2Setup
 * union. Dotted names by construction (`NAME_RE` forbids dots in workflow event names), so they
 * can never collide with a def.
 */
export type MechanismEvent = FaultTelemetry | WorkspaceLost;

/**
 * A Workspace's Continuity broke (ADR-0021): its Sandbox is gone, or Lost. `reason` and `message`
 * say why — the pod's own reason (`Evicted`, `NodeShutdown`, ...) or the operator's (`PodDeleted`,
 * `NodeLost`), or `Deleted` for a Sandbox that is gone — for a body whose policy tells them apart,
 * or only reports them. Optional: the body's policy never needs them to act.
 */
export type WorkspaceLost = { type: "workspace.lost"; reason?: string; message?: string };

/** The full event union a jr2Setup machine sees: the defs' derived types plus the mechanism's. A
 * workflow event a party delivered carries its `sender` (ADR-0015); the Machine's own events
 * (`raise`, `sendTo` itself) carry none. */
export type WorkflowEvent<TDefs extends readonly EventDef[]> =
  | (EventFrom<TDefs[number]> & { readonly sender?: Sender })
  | MechanismEvent;

/** The guard jr2Setup registers for every Machine — `sentBy(id)` (ADR-0015) — in the typed guard
 * map, so `sentBy("coder")` and `and([sentBy("coder"), "ready"])` type-check with no cast. */
type SentByGuards = { [SENT_BY]: { id: string } };

/** The jr2 actor every workflow can invoke by name without listing it (ADR-0015). `gate` is the
 * whole set: an Agent is not pre-registered, because it is not one logic — it is the slot the
 * Machine declares, `actors: { coder: agent(def) }` (ADR-0049). */
const jr2Actors = { gate };
type JR2Actors = typeof jr2Actors;

/** Consumer actors merge OVER the pre-registered set: same name → the consumer's logic wins. */
type MergedActors<TActors extends Record<string, UnknownActorLogic>> = Omit<JR2Actors, keyof TActors> & TActors;

// Local equivalents of xstate's non-exported setup() mapped helpers (setup.d.ts) — same shapes,
// so the declared signature below composes with the public `ActionFunction`/`GuardPredicate`.
type ToParameterizedObject<T extends Record<string, ParameterizedObject["params"] | undefined>> = {
  [K in keyof T & string]: { type: K; params: T[K] };
}[keyof T & string];
type ToProvidedActor<TActors extends Record<string, UnknownActorLogic>> = {
  [K in keyof TActors & string]: { src: K; logic: TActors[K]; id: string | undefined };
}[keyof TActors & string];

/**
 * Author a workflow machine (ADR-0015). Like `setup()`, but `types.events` is gone: the event
 * union derives from `events` (defineEvent defs, taken as values) plus the mechanism events.
 */
export function jr2Setup<
  TContext extends MachineContext = MachineContext,
  const TDefs extends readonly EventDef[] = readonly EventDef[],
  TActors extends Record<string, UnknownActorLogic> = {},
  TActions extends Record<string, ParameterizedObject["params"] | undefined> = {},
  TGuards extends Record<string, ParameterizedObject["params"] | undefined> = {},
  TDelay extends string = never,
  TTag extends string = string,
  TInput = NonReducibleUnknown,
  TOutput extends NonReducibleUnknown = NonReducibleUnknown,
  TEmitted extends EventObject = EventObject,
  TMeta extends MetaObject = MetaObject,
>(def: {
  /** context/input/output/tags/emitted/meta — never `events`; the union is derived. */
  types?: {
    context?: TContext;
    input?: TInput;
    output?: TOutput;
    tags?: TTag;
    emitted?: TEmitted;
    meta?: TMeta;
  };
  /** This Machine's vocabulary, as values — the single source for types, validation, delivery. */
  events: TDefs;
  actors?: TActors;
  actions?: {
    [K in keyof TActions]: ActionFunction<
      TContext,
      WorkflowEvent<TDefs>,
      WorkflowEvent<TDefs>,
      TActions[K],
      ToProvidedActor<MergedActors<TActors>>,
      ToParameterizedObject<TActions>,
      ToParameterizedObject<TGuards>,
      TDelay,
      TEmitted
    >;
  };
  guards?: {
    [K in keyof TGuards]: GuardPredicate<TContext, WorkflowEvent<TDefs>, TGuards[K], ToParameterizedObject<TGuards>>;
  };
  delays?: {
    [K in TDelay]: DelayConfig<
      TContext,
      WorkflowEvent<TDefs>,
      ToParameterizedObject<TActions>["params"],
      WorkflowEvent<TDefs>
    >;
  };
}): SetupReturn<
  TContext,
  WorkflowEvent<TDefs>,
  MergedActors<TActors>,
  {},
  TActions,
  TGuards & SentByGuards,
  TDelay,
  TTag,
  TInput,
  TOutput,
  TEmitted,
  TMeta
> {
  const inner = setup({
    types: def.types,
    actors: { ...jr2Actors, ...(def.actors ?? {}) },
    actions: def.actions,
    // `sentBy(id)` is a named guard with params, so the load walk can READ it (ADR-0015).
    guards: { ...(def.guards ?? {}), [SENT_BY]: sentByGuard },
    delays: def.delays,
  } as never);

  const createMachine = (config: never): AnyStateMachine => {
    // The declared run input (ADR-0033) rides the config under xstate's own word for what a
    // machine receives at creation — and is pulled OFF before xstate sees it: a zod schema is
    // not machine structure, and it must never reach the fingerprint/serialization paths that
    // read `machine.config`. It is attached beside the vocabulary below.
    const { input: inputSchema, ...machineConfig } = config as { input?: z.ZodObject } & Record<string, unknown>;

    // Resolve the defs first (duplicates and reserved semantics fail HERE, naming the machine —
    // the same loud failure `eventMap` gave the manifest, moved to machine-build time)…
    const defs = eventMap((machineConfig as { id?: string }).id ?? "(machine)", def.events);

    // …then rewrite the config (ADR-0015): every Agent-slot/`gate` invoke's input is wrapped to
    // append its DERIVED menu and finalize the mechanism fields. Static — the walk sees the same
    // config the Console will — and the derived names still ride serializable input, so the
    // ADR-0007 restore path and invoke-time `resolveAccepts` validation are unchanged.
    const derived = deriveMenus(machineConfig, defs, def.actors ?? {});
    const machine = (inner.createMachine as unknown as (c: never) => AnyStateMachine)(derived.config as never);

    // Close the nested-`on` typo hole (ADR-0015): with the manifest dead, a typo'd key would
    // silently become vocabulary — so every non-dotted key the machine handles anywhere must map
    // to a def. Walk every node's `transitions` map, not `machine.events` (which filters out
    // targetless/actionless transitions — exactly where a typo'd key would hide). Dotted names
    // (`agent.*`, `workspace.*`, `xstate.*`, delayed transitions) are mechanically jr2's/xstate's;
    // `*` is the wildcard descriptor.
    const handled = new Set<string>();
    const walk = (node: AnyStateMachine["root"]): void => {
      for (const descriptor of node.transitions.keys()) {
        if (descriptor === "*" || descriptor.includes(".")) continue;
        if (!defs.has(descriptor)) {
          throw new Error(
            `machine "${machine.id}" handles event "${descriptor}", which no def in jr2Setup({ events }) ` +
              `declares (declared: ${[...defs.keys()].join(", ") || "none"}) — a typo, or a missing defineEvent`,
          );
        }
        handled.add(descriptor);
      }
      for (const child of Object.values(node.states)) walk(child);
    };
    walk(machine.root);

    // The other direction (ADR-0015): a def no state handles is in no derived set, so it is on no
    // Menu and no Gate — a pick nothing can send and nothing would take.
    const dead = [...defs.keys()].filter((name) => !handled.has(name));
    if (dead.length) {
      throw new Error(
        `machine "${machine.id}" declares ${dead.map((name) => `"${name}"`).join(", ")}, which no state handles — ` +
          `a pick no state takes is on no Menu and no Gate: handle it, or drop it from jr2Setup({ events })`,
      );
    }

    refuseParallelBelowAgents(machine, def.actors ?? {});
    refuseUnknownSentBy(machine);
    // Before the Effect checks: they ask who may send a writing (`mayTake`), which reads its audience.
    attachVocabulary(machine, defs);
    // The Effect checks (ADR-0067): a pick param nothing reads, a `fill` that overwrites one, a
    // `fromPick` of another pick — refused; a mapper the probe cannot run — warned.
    const effects = effectChecks(machine, def.actors ?? {}, defs);
    if (effects.errors.length) throw new Error(`machine "${machine.id}": ${effects.errors.join("; ")}`);

    const idOf = (path: readonly string[]): string => stateAt(machine, path).id;
    attachSeats(
      machine,
      derived.seats.map(({ path, ...seat }) => ({ state: idOf(path), ...seat })),
    );
    attachLoadWarnings(machine, [
      ...unenteredModes(machine, def.actors ?? {}),
      ...restWarnings(machine, def.actors ?? {}),
      ...effects.warnings,
      ...derived.warnings.map((warning) => warning(idOf)),
      ...partyWarnings(machine, derived.derivedGateIds),
    ]);
    if (inputSchema) attachInputSchema(machine, inputSchema);
    return machine;
  };

  // The one jr2-internal cast (report-xstate §1): re-assert the merged SetupReturn over the
  // loosely-built implementation. The consumer-facing types are the declared signature's.
  return { ...inner, createMachine } as unknown as SetupReturn<
    TContext,
    WorkflowEvent<TDefs>,
    MergedActors<TActors>,
    {},
    TActions,
    TGuards & SentByGuards,
    TDelay,
    TTag,
    TInput,
    TOutput,
    TEmitted,
    TMeta
  >;
}

// --- Menu derivation (ADR-0015, ADR-0029) --------------------------------------------------------
// A state that invokes an AGENT SLOT derives the workflow events the Turn may pick: its own
// transitions, its ancestors' (bubbled, per statechart semantics), and those written on the states
// below it — its MODES (`modePicks`) — filtered to the names that Agent may send (the audience
// rule, on `deriveMenus`). That is its derived set, before its guards narrow it to the Allowed
// picks; the Allowed picks are read off the live snapshot, so they follow the active mode. The
// Agent's MENU — its tools block — is the union of those sets over every state that invokes it,
// fixed for the conversation. A `gate` derives its own and its ancestors' transitions, and those
// written on its plain children (the same descent, stopping at a child that invokes a party),
// filtered to the names its caller may send. An explicit `accepts:` on a gate's input remains an
// escape hatch.
//
// An agent invoke is identified by its LOGIC, not by a reserved src name: the walk looks the
// invoke's `src` up in the setup's own `actors` map and asks `isAgent` (ADR-0049). That is also
// where the Agent's NAME comes from — the slot key, injected into the wrapped input, so nothing
// downstream (the iid, the Harness route, the markers) has to be authored twice.
//
// The walk also NAMES unnamed gate invokes with their state key path (ADR-0011):
// the gate actor derives its default id from its own actor path, so the invoke id is the leaf
// segment of a caller-facing name — `humanReview` beats xstate's `0.task-with-review.humanReview`.
// Naming here is id QUALITY only; uniqueness comes from the path mechanism in gate.ts.

type LooseInvoke = { src?: unknown; input?: unknown; [k: string]: unknown };
type LooseState = {
  on?: Record<string, unknown>;
  invoke?: LooseInvoke | LooseInvoke[];
  states?: Record<string, LooseState>;
  [k: string]: unknown;
};
type InputArgs = { context: unknown; event: unknown; self: AnyActorRef };

/**
 * One party's seat on one state: who may send what there (ADR-0015). `path` is the state's key
 * path below the Machine's root; `names` is the derived set — for an Agent, what its Turn may pick
 * before the guards narrow it; for a Gate, its accepted set unless its input names `accepts:`.
 */
export type Seat = { path: readonly string[]; party: "agent" | "gate"; agent?: string; names: string[] };

/** Each name in reach, with the OWNER mark of every writing of it in reach (see below). */
type Reach = Map<string, Set<string>>;
/** Each name written on the path from the root: where, and the owner mark of each writing. */
type Writings = Map<string, Array<{ path: readonly string[]; owner: string }>>;
/** A load warning, rendered once the built Machine can turn a key path into a state id. */
type Warning = (idOf: (path: readonly string[]) => string) => string;

/** The owner mark of a writing no party answers for — at or above it, no state invokes an Agent
 * slot or a `gate` — so both kinds may send it. */
const NOBODY = "";
/** The owner mark of the state at `path`: the party it invokes answers for the writings below it.
 * `#` keeps the root's mark apart from {@link NOBODY}. */
const ownerMark = (path: readonly string[]): string => `#${path.join(".")}`;

/** Rewrite a machine config, wrapping every Agent-slot/`gate` invoke input (immutably).
 *
 * The same walk derives each Agent name's MENU (ADR-0029): the union of the derived sets of every
 * state that invokes an Agent of that name in this Machine — the scope of its continued
 * conversation's id (ADR-0057) — sorted, so it is byte-stable for every Turn of the conversation
 * and for every fresh one. The wrapped inputs read it at invoke time, when the walk is long done.
 *
 * WHO may send a name (the audience rule, ADR-0015). A writing — an `on` key on a state —
 * belongs to the party that its state, or the nearest state above it, invokes: an Agent slot, a
 * `gate`, or both when one state invokes both. With no such state above, it belongs to both. An
 * event whose def leaves `audience` unset follows that rule; an explicit `audience` overrides it
 * BY KIND over the whole reach (`agent`: every Agent whose reach holds a writing of it; `external`:
 * every Gate's; `any`: both). The REACH never changes — own + ancestors, plus the states below
 * with no party-invoking state between (an Agent's modes, a Gate's plain children) — and the rule
 * only filters inside it, so it cannot widen who may send a name. */
function deriveMenus(
  config: unknown,
  defs: Map<string, EventDef>,
  actors: Record<string, UnknownActorLogic>,
): { config: unknown; seats: Seat[]; warnings: Warning[]; derivedGateIds: Set<string> } {
  const pick = (reach: Reach, kind: "agent" | "external", self: string): string[] =>
    [...reach]
      .filter(([name, owners]) => {
        const d = defs.get(name);
        if (!d) return false;
        if (d.audience !== undefined) return d.audience === kind || d.audience === "any";
        return owners.has(self) || owners.has(NOBODY);
      })
      .map(([name]) => name);
  const menus = new Map<string, Set<string>>();
  const menuOf = (agentName: string): string[] => [...(menus.get(agentName) ?? [])].sort();
  const seats: Seat[] = [];
  // The load warnings this walk can see (ADR-0015), each rendered once the states have ids. Keyed,
  // so a writing seen from two paths is one warning.
  const warnings = new Map<string, Warning>();
  // Which parties each owner mark's state invokes — what the Gate-above warning reads.
  const parties = new Map<string, { agents: string[]; gate: boolean }>();
  // The Gate invoke ids this walk names: a party warning says how to name one instead.
  const derivedGateIds = new Set<string>();

  const walk = (
    node: LooseState,
    inherited: Reach,
    writtenAbove: Writings,
    path: readonly string[],
    ownerAbove: string,
  ): LooseState => {
    const owner = invokesParty(node, actors) ? ownerMark(path) : ownerAbove;
    if (owner !== ownerAbove) parties.set(owner, partiesOf(node, actors));
    const names: Reach = new Map([...inherited].map(([name, owners]) => [name, new Set(owners)]));
    const written: Writings = new Map([...writtenAbove].map(([name, at]) => [name, [...at]]));
    for (const name of ownPicks(node)) {
      names.set(name, (names.get(name) ?? new Set<string>()).add(owner));
      written.set(name, [...(written.get(name) ?? []), { path, owner }]);
    }

    let out = node;
    if (node.invoke) {
      const invokes = Array.isArray(node.invoke) ? node.invoke : [node.invoke];
      // >1 unnamed gate in one state would collide on the state-key id; suffix ONLY then, so
      // the common case (one gate per state) keeps the clean name.
      const unnamedGates = invokes.filter((inv) => inv?.src === "gate" && inv.id == null).length;
      let ordinal = 0;
      const wrapOne = (inv: LooseInvoke): LooseInvoke => {
        // The slot key IS the Agent name (ADR-0049) — read off the declaration, never authored.
        if (typeof inv?.src === "string" && isAgent(actors[inv.src])) {
          // A mode's writings are this state's by construction: the descent stops at any child
          // that invokes a party, so none answers between them and this one.
          const reach: Reach = new Map([...names].map(([name, owners]) => [name, new Set(owners)]));
          for (const name of modePicks(node, actors))
            reach.set(name, (reach.get(name) ?? new Set<string>()).add(owner));
          const derived = pick(reach, "agent", owner);
          // A Gate above that takes a writing from this Agent: the Gate's caller owns it, so the
          // Agent below — which reaches it — cannot send it. Legal, and the one narrowing of the
          // audience rule an author may not expect.
          const agent = inv.src;
          for (const [name, owners] of reach) {
            if (derived.includes(name) || defs.get(name)?.audience !== undefined) continue;
            for (const at of written.get(name) ?? []) {
              if (!owners.has(at.owner) || at.owner === owner || !parties.get(at.owner)?.gate) continue;
              warnings.set(
                `gate:${agent}:${path.join(".")}:${name}:${at.path.join(".")}`,
                (idOf) =>
                  `Agent "${agent}" on "${idOf(path)}" cannot send "${name}": it is written on "${idOf(at.path)}", ` +
                  `whose Gate's caller owns it — give the def \`audience: "any"\` for both to send it`,
              );
            }
          }
          const menu = menus.get(inv.src) ?? new Set<string>();
          for (const name of derived) menu.add(name);
          menus.set(inv.src, menu);
          seats.push({ path, party: "agent", agent: inv.src, names: [...derived].sort() });
          return { ...inv, input: wrapAgentInput(inv.input, derived, inv.src, menuOf) };
        }
        if (inv?.src === "gate") {
          // A Gate's plain children — below it, with no party-invoking state between — are its own
          // by position, as an Agent's modes are its (ADR-0015).
          const reach: Reach = new Map([...names].map(([name, owners]) => [name, new Set(owners)]));
          for (const name of modePicks(node, actors))
            reach.set(name, (reach.get(name) ?? new Set<string>()).add(owner));
          const accepts = pick(reach, "external", owner);
          seats.push({ path, party: "gate", names: [...accepts].sort() });
          const wrapped: LooseInvoke = { ...inv, input: wrapGateInput(inv.input, accepts) };
          // A machine-root gate (empty path) is left to xstate's default id: a `""` id would be
          // worse than a noisy one, and the derived gate id still works.
          if (inv.id == null && path.length) {
            const key = path.join(".");
            wrapped.id = unnamedGates > 1 ? `${key}.${ordinal++}` : key;
            derivedGateIds.add(wrapped.id as string);
          }
          return wrapped;
        }
        return inv;
      };
      out = { ...node, invoke: Array.isArray(node.invoke) ? node.invoke.map(wrapOne) : wrapOne(node.invoke) };
    }
    if (node.states) {
      const states: Record<string, LooseState> = {};
      for (const [key, child] of Object.entries(node.states))
        states[key] = walk(child, names, written, [...path, key], owner);
      out = { ...(out === node ? node : out), states };
    }
    return out;
  };

  const out = walk(config as LooseState, new Map(), new Map(), [], NOBODY);
  return { config: out, seats, warnings: [...warnings.values()], derivedGateIds };
}

/**
 * A mode that nothing enters (ADR-0015): a state below an Agent's state with no invoke that the
 * Machine can never enter. Its picks are on the Menu and never allowed. A warning, not a refusal: the
 * Machine is legal, and a mode left unwired is often work in progress. A state below an Agent's state
 * that INVOKES something and that nothing enters is refused (ADR-0067): what it invokes never runs,
 * which is never work in progress. Both look below a state that invokes an Effect or a child Machine;
 * neither looks below one that invokes another Agent or a Gate.
 *
 * "Can enter" is reachability from the root, to a fixed point. A state is entered when its parent is
 * entered and it is the parent's initial state or a region of a parallel parent, or when a transition
 * whose SOURCE can be entered targets it or a state inside it (entering a state enters its
 * ancestors). So a compound mode's own `initial` does not enter it, and neither does a transition
 * written on the mode into itself: neither runs unless the mode is already active.
 *
 * A transition into a history state enters what that history state restores. The walk follows its
 * DEFAULT target — shallow or deep, what xstate enters when nothing is recorded yet — or, with none
 * written, its parent's initial state, which entering the parent already covers. A recorded history
 * restores only states that were entered another way. A default target the walk cannot resolve is a
 * warning of its own: the modes behind it may read as unentered when they are not, and a state that
 * invokes below that history state's parent is warned about, never refused — the walk refuses only
 * what it knows nothing enters. A history state is no mode.
 */
function unenteredModes(machine: AnyStateMachine, actors: Record<string, UnknownActorLogic>): string[] {
  type Node = AnyStateMachine["root"];
  const all: Node[] = [];
  const collect = (node: Node): void => {
    all.push(node);
    for (const child of Object.values(node.states)) collect(child);
  };
  collect(machine.root);

  const out: string[] = [];
  const entered = new Set<Node>([machine.root]);
  const enter = (node: Node): boolean => {
    let added = false;
    for (let n: Node | undefined = node; n !== undefined && !entered.has(n); n = n.parent) {
      entered.add(n);
      added = true;
    }
    if (node.type === "history") for (const target of historyDefault(node)) added = enter(target) || added;
    return added;
  };
  /** A history state's default target, resolved the way xstate resolves it: a path from its parent,
   * or a `#id`. Unresolvable: warned once, and nothing is followed. */
  const unresolved = new Set<Node>();
  const historyDefault = (node: Node): Node[] => {
    const written = (node.config as { target?: unknown }).target;
    if (written === undefined) return [];
    const targets = (Array.isArray(written) ? written : [written]) as unknown[];
    const resolved: Node[] = [];
    for (const target of targets) {
      const found = typeof target === "string" ? resolvePath(node.parent!, target) : undefined;
      if (found !== undefined) {
        resolved.push(found);
        continue;
      }
      if (unresolved.has(node)) continue;
      unresolved.add(node);
      out.push(
        `history state "${node.id}" has a default target the load walk cannot follow (${JSON.stringify(target)}) — ` +
          `a mode entered only through it is reported as unentered, and a state that invokes is warned, not refused`,
      );
    }
    return resolved;
  };
  const resolvePath = (parent: Node, target: string): Node | undefined => {
    if (target.startsWith("#")) {
      try {
        return machine.getStateNodeById(target.slice(1)) as Node;
      } catch {
        return undefined;
      }
    }
    let at: Node | undefined = parent;
    for (const key of target.split(".")) at = at?.states[key];
    return at;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of all) {
      const parent = node.parent;
      if (parent === undefined || entered.has(node) || !entered.has(parent)) continue;
      if (parent.type === "parallel" || (parent.type === "compound" && parent.initial.target.includes(node)))
        changed = enter(node) || changed;
    }
    for (const node of all) {
      if (!entered.has(node)) continue;
      const transitions = [...node.transitions.values()].flat().concat(node.always ?? []);
      for (const t of transitions) for (const target of t.target ?? []) changed = enter(target) || changed;
    }
  }
  const invokedAgent = (node: Node): string | undefined =>
    node.invoke.find((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))?.src as string | undefined;
  const isBelow = (node: Node, ancestor: Node): boolean => {
    for (let n = node.parent; n !== undefined; n = n.parent) if (n === ancestor) return true;
    return false;
  };

  const refused: string[] = [];
  for (const node of all) {
    const agent = invokedAgent(node);
    // An Agent's state the Machine never enters is a larger defect than its modes, and not this check.
    if (agent === undefined || !entered.has(node)) continue;
    // Every state below the Agent's state belongs to its Turn, down to a child that invokes another
    // party (an Agent or a Gate): that child is checked, and below it is that party's. A state below
    // an unentered one is not reported again.
    const descend = (parent: Node): void => {
      for (const child of Object.values(parent.states)) {
        if (child.type === "history") continue;
        if (child.invoke.length > 0) {
          // A child that invokes something and that nothing enters (ADR-0067): what it invokes never
          // runs — a refusal, where a mode nothing enters is only a warning.
          if (!entered.has(child)) {
            const what = child.invoke.map((inv) => (typeof inv.src === "string" ? inv.src : inv.id)).join(", ");
            // Where a history default the walk cannot follow may enter it, the walk does not know: a
            // warning, never a refusal of a Machine that may be legal.
            const unsure = [...unresolved].find((h) => isBelow(child, h.parent!));
            if (unsure !== undefined) {
              out.push(
                `state "${child.id}" below Agent "${agent}"'s state "${node.id}" may be entered by nothing, so what ` +
                  `it invokes (${what}) may never run — the walk cannot follow history state "${unsure.id}"'s ` +
                  `default target, which may enter it`,
              );
            } else {
              refused.push(
                `state "${child.id}" below Agent "${agent}"'s state "${node.id}" is entered by nothing, so what it ` +
                  `invokes (${what}) never runs — target it from a pick or a route, or delete it`,
              );
            }
            continue;
          }
          const party = child.invoke.some(
            (inv) => inv.src === "gate" || (typeof inv.src === "string" && isAgent(actors[inv.src])),
          );
          if (!party) descend(child);
          continue;
        }
        if (!entered.has(child)) {
          const picks = [...child.transitions.keys()].filter((key) => !key.includes(".") && key !== "*");
          out.push(
            `mode "${child.id}" of Agent "${agent}"'s state "${node.id}" — nothing enters it: it is not ` +
              `initial and no state the Machine can enter has a transition into it, so its picks` +
              `${picks.length ? ` (${picks.join(", ")})` : ""} are on the Menu and never allowed`,
          );
          continue;
        }
        descend(child);
      }
    };
    descend(node);
  }
  if (refused.length) throw new Error(`machine "${machine.id}": ${refused.join("; ")}`);
  return out;
}

/**
 * Does this logic settle on its own — a promise, the one plain xstate actor that ends without being
 * stopped? Asked of its own transition: a promise logic's initial snapshot, sent xstate's resolve
 * event, is `done`. That event name is an xstate internal (5.32.2); a bump that renamed it would
 * make every promise read long-lived, and setup.test.ts pins it against the real constructors.
 */
function settlesOnItsOwn(logic: unknown): boolean {
  const l = logic as {
    getInitialSnapshot?: (scope: unknown, input: unknown) => unknown;
    transition?: (snapshot: unknown, event: unknown, scope: unknown) => { status?: string } | undefined;
  };
  if (typeof l?.getInitialSnapshot !== "function" || typeof l.transition !== "function") return false;
  try {
    const scope = { self: {}, defer: () => {}, emit: () => {} };
    const snapshot = l.getInitialSnapshot(scope, undefined);
    return l.transition(snapshot, { type: "xstate.promise.resolve", data: undefined }, scope)?.status === "done";
  } catch {
    return false;
  }
}

/**
 * The load walk's Rest warnings (ADR-0024): shapes below an Agent's state that keep it from Rest, so
 * every pick of the Agent is refused for longer than the author likely meant. Warnings, never
 * refusals: each can be intended.
 *
 * - **A Gate whose answer has no target.** The Gate stays open after its answer, and the Agent's
 *   state is not at Rest again until the Gate's state exits.
 * - **A long-lived invoke** — an actor that runs until its state exits: not a promise or an Effect (each settles),
 *   a Gate, an Agent or a child Machine. While it runs, the Agent's state is never at Rest.
 *
 * The descent below an Agent's state stops at a child that invokes another Agent: below it is that
 * Agent's state, read for that Agent.
 */
function restWarnings(machine: AnyStateMachine, actors: Record<string, UnknownActorLogic>): string[] {
  type Node = AnyStateMachine["root"];
  const implementations = machine.implementations.actors as Record<string, unknown>;
  const logicOf = (src: unknown): unknown => (typeof src === "string" ? (actors[src] ?? implementations[src]) : src);
  const agentOf = (node: Node): string | undefined =>
    node.invoke.find((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))?.src as string | undefined;
  const out: string[] = [];
  const visit = (node: Node): void => {
    const agent = agentOf(node);
    if (agent !== undefined) {
      const descend = (parent: Node): void => {
        for (const child of Object.values(parent.states)) {
          if (agentOf(child) !== undefined) continue;
          for (const inv of child.invoke) {
            const logic = logicOf(inv.src);
            const name = typeof inv.src === "string" ? inv.src : inv.id;
            if (inv.src === "gate") {
              for (const [event, candidates] of child.transitions) {
                if (event.includes(".") || event === "*") continue;
                if (candidates.some((t) => (t.target ?? []).length > 0)) continue;
                out.push(
                  `Gate "${inv.id}" at "${child.id}", below Agent "${agent}"'s state "${node.id}": its answer "${event}" ` +
                    `has no target, so the Gate stays open after it — the Agent's state is not at rest again until ` +
                    `"${child.id}" exits, and every pick of the Agent is refused until then; give the answer a target`,
                );
              }
              continue;
            }
            if (isAgent(logic) || isEffect(logic) || (logic as { root?: unknown } | undefined)?.root !== undefined)
              continue;
            if (settlesOnItsOwn(logic)) continue;
            out.push(
              `"${child.id}", below Agent "${agent}"'s state "${node.id}", invokes "${name}", which runs until its ` +
                `state exits (not a promise, an Effect, a Gate, an Agent or a child Machine): while it runs the Agent's state ` +
                `is never at rest, so it blocks every pick of the Agent — invoke it above the Agent's state`,
            );
          }
          descend(child);
        }
      };
      descend(node);
    }
    for (const child of Object.values(node.states)) visit(child);
  };
  visit(machine.root);
  return out;
}

/**
 * A parallel region below a state that invokes an Agent is refused (ADR-0015). The shape is
 * reserved for picks the Agent does not wait for, which jr2 does not build; a Turn takes one pick
 * at a time. The Agent's state itself being parallel counts: its regions are below it. A
 * background task goes above the Agent's state.
 */
function refuseParallelBelowAgents(machine: AnyStateMachine, actors: Record<string, UnknownActorLogic>): void {
  type Node = AnyStateMachine["root"];
  const firstParallel = (node: Node): Node | undefined => {
    if (node.type === "parallel") return node;
    for (const child of Object.values(node.states)) {
      const found = firstParallel(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const visit = (node: Node): void => {
    const agent = node.invoke.find((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))?.src;
    const parallel = agent === undefined ? undefined : firstParallel(node);
    if (parallel !== undefined) {
      throw new Error(
        `machine "${machine.id}": state "${parallel.id}" is parallel, at or below Agent "${String(agent)}"'s state ` +
          `"${node.id}" — a parallel region below an Agent's state is reserved for picks the Agent does not wait ` +
          `for, which jr2 does not build; a background task goes above the Agent's state`,
      );
    }
    for (const child of Object.values(node.states)) visit(child);
  };
  visit(machine.root);
}

/** The built state node at a key path below the root — what turns a walk's path into a state id. */
function stateAt(machine: AnyStateMachine, path: readonly string[]): AnyStateMachine["root"] {
  let node = machine.root;
  for (const key of path) node = node.states[key]!;
  return node;
}

/** A state's own workflow-event keys: dotted names are jr2's or xstate's, `*` is the wildcard. */
function ownPicks(node: LooseState): string[] {
  return Object.keys(node.on ?? {}).filter((key) => !key.includes(".") && key !== "*");
}

/** The parties a state invokes: its Agent slots by name, and whether it invokes a `gate`. */
function partiesOf(node: LooseState, actors: Record<string, UnknownActorLogic>): { agents: string[]; gate: boolean } {
  const invokes = node.invoke ? (Array.isArray(node.invoke) ? node.invoke : [node.invoke]) : [];
  return {
    agents: invokes.flatMap((inv) => (typeof inv?.src === "string" && isAgent(actors[inv.src]) ? [inv.src] : [])),
    gate: invokes.some((inv) => inv?.src === "gate"),
  };
}

/** Does this state invoke a party that sends this Machine's workflow events — an Agent slot or a
 * `gate`? An Effect, a child Machine, a `workspace()`/`pool()` body: none of them sends them. */
function invokesParty(node: LooseState, actors: Record<string, UnknownActorLogic>): boolean {
  const { agents, gate } = partiesOf(node, actors);
  return gate || agents.length > 0;
}

/**
 * The picks written on the states BELOW an Agent's state — its modes (ADR-0015). xstate hands an
 * event to the deepest active state that handles it, and a false guard there falls through to the
 * parent, so a child's `on` keys are picks the Turn can be allowed while that child is active — and
 * `can()` on the live snapshot already answers for the active child (ADR-0029).
 *
 * The descent STOPS at a child that invokes another party — an Agent slot (a nested Turn: its picks
 * are its own) or a `gate` (its `on` keys are the Gate's accepted set) — and leaves out everything
 * below it. A child that runs an Effect, a child Machine or a timer is no stop: its `on` keys are
 * this Turn's.
 */
function modePicks(node: LooseState, actors: Record<string, UnknownActorLogic>): Set<string> {
  return new Set(modeWritings(node, [], actors).map((w) => w.name));
}

/** Each writing {@link modePicks} reads, with the key path of the mode it is written on. */
function modeWritings(
  node: LooseState,
  path: readonly string[],
  actors: Record<string, UnknownActorLogic>,
): Array<{ name: string; path: readonly string[] }> {
  const out: Array<{ name: string; path: readonly string[] }> = [];
  const descend = (n: LooseState, at: readonly string[]): void => {
    for (const [key, child] of Object.entries(n.states ?? {})) {
      if (invokesParty(child, actors)) continue;
      const childPath = [...at, key];
      for (const name of ownPicks(child)) out.push({ name, path: childPath });
      descend(child, childPath);
    }
  };
  descend(node, path);
  return out;
}

const resolveInput = (orig: unknown, args: InputArgs): Record<string, unknown> =>
  (typeof orig === "function" ? (orig as (a: InputArgs) => unknown)(args) : (orig ?? {})) as Record<string, unknown>;

/**
 * Every key a Turn's input may carry (ADR-0057): the Frame (`prompt`, `cwd`), the Dials (`model`,
 * `thinkingLevel`), `continue`, and the Placement seat the stub tier states (`endpoint`,
 * `sandbox`). Anything else is refused at RUNTIME, because no type can catch it: an invoke's input
 * is a function returning a union, and the conditional spreads authors write inside it defeat
 * excess-property checking — so a misspelled `continue` or a key from some other surface would
 * compile and then silently take a fresh conversation every Turn, the class of quiet wrong
 * behavior ADR-0057 was written to end.
 */
const TURN_INPUT_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "cwd",
  "continue",
  "model",
  "thinkingLevel",
  "endpoint",
  "sandbox",
]);

/** Refuse a Turn whose input carries a key a Turn has no use for, before anything is minted or
 * admitted. The message names the slot, the keys found, and the whole surface (ADR-0057). */
function refuseUnknownKeys(consumer: object, agentName: string): void {
  const unknown = Object.keys(consumer).filter((key) => !TURN_INPUT_KEYS.has(key));
  if (unknown.length === 0) return;
  throw new Error(
    `agent "${agentName}": the Turn's input carries ${unknown.map((k) => `\`${k}\``).join(", ")}, which a ` +
      `Turn has no use for — its input is its Frame (\`prompt\`, \`cwd\`), its Dials (\`model\`, ` +
      `\`thinkingLevel\`), and \`continue\` (ADR-0057)`,
  );
}

/** Wrap an Agent slot's invoke input: name the Agent (the slot key), append the state's derived set
 * and the Agent's Menu, and finalize the mechanism fields. */
function wrapAgentInput(orig: unknown, derived: string[], agentName: string, menuOf: (agentName: string) => string[]) {
  return (args: InputArgs): AgentRunInput => {
    const consumer = resolveInput(orig, args) as Partial<AgentTurnInput & AgentRunInput>;
    refuseUnknownKeys(consumer, agentName);
    return {
      agentName,
      // jr2 mints every id (ADR-0016, ADR-0057): the Turn's input carries no id to honor, so
      // nothing a Machine writes can address a conversation jr2 did not derive.
      instanceId: mintIid(consumer, agentName, args.self),
      endpoint: consumer.endpoint,
      sandbox: consumer.sandbox,
      prompt: consumer.prompt,
      // The Frame's other half (ADR-0057) — WHERE this Turn works. Passed through as written; the
      // actor resolves an ABSENT one against the enclosing Workspace, which only it can see.
      cwd: consumer.cwd,
      // This turn's dials (ADR-0018) — passed straight through; the Harness layers
      // them over the definition when the Submission starts.
      model: consumer.model,
      thinkingLevel: consumer.thinkingLevel,
      // ADR-0035's reroll gate: closed to `continue: true`, which names an EXISTING conversation
      // while the runaway's one recovery is a fresh one — exactly what it opted out of.
      ...(consumer.continue === true ? { continuation: true } : {}),
      // The state's derived set (ADR-0015): always the derived one, since ADR-0057 retired the
      // override. What delivery validates against, and what the Allowed picks narrow.
      tools: derived,
      // The Menu (ADR-0029): every pick any state invoking this Agent derives — the tools block.
      menu: menuOf(agentName),
    };
  };
}

/** Wrap a gate invoke input: append the derived accepted set. */
function wrapGateInput(orig: unknown, derived: string[]) {
  return (args: InputArgs): Record<string, unknown> => {
    const consumer = resolveInput(orig, args);
    return { ...consumer, accepts: (consumer.accepts as readonly string[] | undefined) ?? derived };
  };
}

/**
 * Mint the instance id (ADR-0016, ADR-0057). It is minted in the INPUT MAPPER — not the actor —
 * because the input is the persistence vehicle: restore re-spawns from the persisted input
 * without re-running the mapper (same conversation), while a fresh transition re-runs it.
 *
 * Both spellings are built on {@link continuedIid}, `<runId>/<machine actor path>/<agent>` — the
 * Agent's ONE conversation in this Machine instance. The machine actor path excludes the root
 * actor (its id is generated per process) and the invoke's own leaf id (states of one Machine
 * share the conversation, ADR-0057), so two Pool children — whose ids are their items' — can
 * never meet.
 *
 * - Default (FRESH, jr's lossy handoff): a new conversation per invocation — that id plus a
 *   random suffix.
 * - `continue: true`: that id exactly, at epoch 0 — the author writes a boolean, because in a
 *   state machine the identity (the run, the Machine instance, the Agent slot) is already on the
 *   page. Once jr2 has faulted the conversation, the ledger's epoch suffixes it (`<id>/1`,
 *   `<id>/2`, …): a virgin conversation, since no fault leaves one worth continuing (ADR-0035).
 *   **Epoch 0 is never spelled** — the unsuffixed id IS the first conversation, which keeps the
 *   common case readable on the Harness route, in the ledger and in the logs. Invoking a live
 *   continued id fails loudly at the registration table (one live surface per address).
 */
function mintIid(consumer: { continue?: true }, agentName: string, self: AnyActorRef): string {
  const runId = boundRunId(self.system) ?? "local";
  const conversation = continuedIid(self, runId, agentName);
  if (!consumer.continue) return `${conversation}/${randomUUID().slice(0, 8)}`;
  const epoch = boundEpoch(self.system, conversation);
  return epoch === 0 ? conversation : `${conversation}/${epoch}`;
}
