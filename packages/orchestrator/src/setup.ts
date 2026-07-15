// `j2Setup` — the authoring surface (ADR-0015): an xstate `setup()` analog, not a DSL. It returns
// xstate's public `SetupReturn`, so `.createMachine()` yields a plain `StateMachine` — Stately-
// inspectable, `.provide()`-testable, constructible with no j2 runtime. What the wrapper adds:
//
//   - the MECHANISM events (`agent.fault`, `workspace.lost`, …) are injected into the event
//     union, and the WORKFLOW event types derive from the zod defs — hand-written `EventFrom`
//     unions retire;
//   - the j2 actors (`agentRun`, `gate`) are pre-registered with typed inputs (a consumer actor
//     under the same name wins — the unit-test seam);
//   - because it takes the defs AS VALUES, `createMachine` validates that every event key
//     appearing anywhere in the machine maps to a def — closing xstate's nested-`on` typo hole
//     (unknown keys in nested states typecheck silently upstream) with a load-time failure;
//   - the vocabulary is attached to the machine object (`vocabularyOf` — vocabulary.ts), which
//     is what lets the `export const events` manifest die (ADR-0011 revised).
//
// The typing follows the proven declared-signature pattern (report-xstate §1): the public
// signature is precise, the implementation is loosely typed with ONE j2-internal cast at the
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
import { eventMap, type EventDef, type EventFrom } from "@j2/agent-protocol";
import type { AgentRunInput, AgentTurnInput, FaultTelemetry } from "./actor.ts";
import { agentRun } from "./flue-client.ts";
import { gate } from "./gate.ts";
import { boundRunId } from "./registration.ts";
import { attachVocabulary } from "./vocabulary.ts";

/**
 * The events j2's own mechanism delivers into any workflow machine, injected into every j2Setup
 * union. Dotted names by construction (`NAME_RE` forbids dots in workflow event names), so they
 * can never collide with a def.
 */
export type MechanismEvent = FaultTelemetry | { type: "workspace.lost" };

/** The full event union a j2Setup machine sees: the defs' derived types plus the mechanism's. */
export type WorkflowEvent<TDefs extends readonly EventDef[]> = EventFrom<TDefs[number]> | MechanismEvent;

/** The j2 actors every workflow can invoke by name without listing them (ADR-0015). */
const j2Actors = { agentRun, gate };
type J2Actors = typeof j2Actors;

/** Consumer actors merge OVER the pre-registered set: same name → the consumer's logic wins. */
type MergedActors<TActors extends Record<string, UnknownActorLogic>> = Omit<J2Actors, keyof TActors> & TActors;

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
export function j2Setup<
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
  /** The workflow's vocabulary, as values — the single source for types, validation, delivery. */
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
  TGuards,
  TDelay,
  TTag,
  TInput,
  TOutput,
  TEmitted,
  TMeta
> {
  const inner = setup({
    types: def.types,
    actors: { ...j2Actors, ...(def.actors ?? {}) },
    actions: def.actions,
    guards: def.guards,
    delays: def.delays,
  } as never);

  const createMachine = (config: never): AnyStateMachine => {
    // Resolve the defs first (duplicates and reserved semantics fail HERE, naming the machine —
    // the same loud failure `eventMap` gave the manifest, moved to machine-build time)…
    const defs = eventMap((config as { id?: string }).id ?? "(machine)", def.events);

    // …then rewrite the config (ADR-0015): every `agentRun`/`gate` invoke's input is wrapped to
    // append its DERIVED menu and finalize the mechanism fields. Static — the walk sees the same
    // config `j2 visualize` will — and the derived names still ride serializable input, so the
    // ADR-0007 restore path and invoke-time `resolveAccepts` validation are unchanged.
    const machine = (inner.createMachine as unknown as (c: never) => AnyStateMachine)(
      deriveMenus(config, defs) as never,
    );

    // Close the nested-`on` typo hole (ADR-0015): with the manifest dead, a typo'd key would
    // silently become vocabulary — so every non-dotted key the machine handles anywhere must map
    // to a def. Walk every node's `transitions` map, not `machine.events` (which filters out
    // targetless/actionless transitions — exactly where a typo'd key would hide). Dotted names
    // (`agent.*`, `workspace.*`, `xstate.*`, delayed transitions) are mechanically j2's/xstate's;
    // `*` is the wildcard descriptor.
    const walk = (node: AnyStateMachine["root"]): void => {
      for (const descriptor of node.transitions.keys()) {
        if (descriptor === "*" || descriptor.includes(".")) continue;
        if (!defs.has(descriptor)) {
          throw new Error(
            `machine "${machine.id}" handles event "${descriptor}", which no def in j2Setup({ events }) ` +
              `declares (declared: ${[...defs.keys()].join(", ") || "none"}) — a typo, or a missing defineEvent`,
          );
        }
      }
      for (const child of Object.values(node.states)) walk(child);
    };
    walk(machine.root);

    attachVocabulary(machine, defs);
    return machine;
  };

  // The one j2-internal cast (report-xstate §1): re-assert the merged SetupReturn over the
  // loosely-built implementation. The consumer-facing types are the declared signature's.
  return { ...inner, createMachine } as unknown as SetupReturn<
    TContext,
    WorkflowEvent<TDefs>,
    MergedActors<TActors>,
    {},
    TActions,
    TGuards,
    TDelay,
    TTag,
    TInput,
    TOutput,
    TEmitted,
    TMeta
  >;
}

// --- Menu derivation (ADR-0015) ------------------------------------------------------------------
// A state that invokes `agentRun` gets, as its Agent's tool menu, the workflow events its
// transitions handle — own + bubbled ancestors, per statechart semantics — filtered to audience
// ∈ {agent, any}; a `gate` gets the same set filtered to {external, any}. The invoking actor
// kind is the primary router; `audience` on the def exists to RESTRICT (tag the security-
// sensitive events). Explicit `tools:`/`accepts:` on the invoke input remain as escape hatches.

type LooseInvoke = { src?: unknown; input?: unknown; [k: string]: unknown };
type LooseState = {
  on?: Record<string, unknown>;
  invoke?: LooseInvoke | LooseInvoke[];
  states?: Record<string, LooseState>;
  [k: string]: unknown;
};
type InputArgs = { context: unknown; event: unknown; self: AnyActorRef };

/** Rewrite a machine config, wrapping every `agentRun`/`gate` invoke input (immutably). */
function deriveMenus(config: unknown, defs: Map<string, EventDef>): unknown {
  const pick = (names: Set<string>, kind: "agent" | "external"): string[] =>
    [...names].filter((name) => {
      const d = defs.get(name);
      return !!d && (d.audience === kind || d.audience === "any");
    });

  const walk = (node: LooseState, inherited: Set<string>): LooseState => {
    const names = new Set(inherited);
    for (const key of Object.keys(node.on ?? {})) {
      if (!key.includes(".") && key !== "*") names.add(key);
    }

    let out = node;
    if (node.invoke) {
      const wrapOne = (inv: LooseInvoke): LooseInvoke => {
        if (inv?.src === "agentRun") return { ...inv, input: wrapAgentInput(inv.input, pick(names, "agent")) };
        if (inv?.src === "gate") return { ...inv, input: wrapGateInput(inv.input, pick(names, "external")) };
        return inv;
      };
      out = { ...node, invoke: Array.isArray(node.invoke) ? node.invoke.map(wrapOne) : wrapOne(node.invoke) };
    }
    if (node.states) {
      const states: Record<string, LooseState> = {};
      for (const [key, child] of Object.entries(node.states)) states[key] = walk(child, names);
      out = { ...(out === node ? node : out), states };
    }
    return out;
  };

  return walk(config as LooseState, new Set());
}

const resolveInput = (orig: unknown, args: InputArgs): Record<string, unknown> =>
  (typeof orig === "function" ? (orig as (a: InputArgs) => unknown)(args) : (orig ?? {})) as Record<string, unknown>;

/** Wrap an agentRun invoke input: append the derived menu and finalize the mechanism fields. */
function wrapAgentInput(orig: unknown, derived: string[]) {
  return (args: InputArgs): AgentRunInput => {
    const consumer = resolveInput(orig, args) as Partial<AgentTurnInput & AgentRunInput>;
    const agentName = consumer.agentName ?? consumer.agent;
    if (!agentName) throw new Error(`agentRun input needs \`agent\` (the flue agent to admit)`);
    return {
      agentName,
      instanceId: consumer.instanceId ?? mintIid(consumer, agentName, args.self),
      endpoint: consumer.endpoint,
      sandbox: consumer.sandbox,
      prompt: consumer.prompt,
      tools: consumer.tools ?? derived,
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
 * Mint the instance id (ADR-0016). It is minted in the INPUT MAPPER — not the actor — because
 * the input is the persistence vehicle: restore re-spawns from the persisted input without
 * re-running the mapper (same conversation), while a fresh transition re-runs it (new one).
 *
 * - Default (fresh session, jr's lossy handoff): a new conversation per invocation — a random
 *   suffix under a readable `<runId>/<actor-path>/<agent>` prefix.
 * - `session: "continue"` (+ optional `scope`): the iid derives deterministically from
 *   `(run, actor path, agent, scope)`, so re-invocations continue ONE flue conversation. The
 *   actor path excludes the root actor (its id is generated per process — everything below it
 *   is author-named and stable across restore). Invoking a continue iid that is already live
 *   fails loudly at the registration table (one live surface per address).
 */
function mintIid(consumer: { session?: "continue"; scope?: string }, agentName: string, self: AnyActorRef): string {
  const runId = boundRunId(self.system) ?? "local";
  const segments: string[] = [];
  for (let ref: AnyActorRef | undefined = self; ref?._parent; ref = ref._parent) segments.unshift(ref.id);
  const path = segments.join(".") || "root";
  const scope = consumer.scope ? `/${consumer.scope}` : "";
  if (consumer.session === "continue") return `${runId}/${path}/${agentName}${scope}`;
  return `${runId}/${path}/${agentName}${scope}/${randomUUID().slice(0, 8)}`;
}
