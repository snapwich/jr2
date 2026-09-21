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
import { eventMap, type EventDef, type EventFrom } from "@jr2/agent-protocol";
import type { AgentRunInput, AgentTurnInput, FaultTelemetry } from "./actor.ts";
import { isAgent } from "./agent.ts";
import { gate } from "./gate.ts";
import { boundEpoch, boundRunId, continuedIid } from "./registration.ts";
import { attachInputSchema, attachVocabulary } from "./vocabulary.ts";

/**
 * The events jr2's own mechanism delivers into any workflow machine, injected into every jr2Setup
 * union. Dotted names by construction (`NAME_RE` forbids dots in workflow event names), so they
 * can never collide with a def.
 */
export type MechanismEvent = FaultTelemetry | { type: "workspace.lost" };

/** The full event union a jr2Setup machine sees: the defs' derived types plus the mechanism's. */
export type WorkflowEvent<TDefs extends readonly EventDef[]> = EventFrom<TDefs[number]> | MechanismEvent;

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
    actors: { ...jr2Actors, ...(def.actors ?? {}) },
    actions: def.actions,
    guards: def.guards,
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
    const machine = (inner.createMachine as unknown as (c: never) => AnyStateMachine)(
      deriveMenus(machineConfig, defs, def.actors ?? {}) as never,
    );

    // Close the nested-`on` typo hole (ADR-0015): with the manifest dead, a typo'd key would
    // silently become vocabulary — so every non-dotted key the machine handles anywhere must map
    // to a def. Walk every node's `transitions` map, not `machine.events` (which filters out
    // targetless/actionless transitions — exactly where a typo'd key would hide). Dotted names
    // (`agent.*`, `workspace.*`, `xstate.*`, delayed transitions) are mechanically jr2's/xstate's;
    // `*` is the wildcard descriptor.
    const walk = (node: AnyStateMachine["root"]): void => {
      for (const descriptor of node.transitions.keys()) {
        if (descriptor === "*" || descriptor.includes(".")) continue;
        if (!defs.has(descriptor)) {
          throw new Error(
            `machine "${machine.id}" handles event "${descriptor}", which no def in jr2Setup({ events }) ` +
              `declares (declared: ${[...defs.keys()].join(", ") || "none"}) — a typo, or a missing defineEvent`,
          );
        }
      }
      for (const child of Object.values(node.states)) walk(child);
    };
    walk(machine.root);

    attachVocabulary(machine, defs);
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
// A state that invokes an AGENT SLOT gets, as its Agent's tool menu, the workflow events its
// transitions handle — own + bubbled ancestors, per statechart semantics — filtered to audience
// ∈ {agent, any}; a `gate` gets the same set filtered to {external, any}. The invoking actor
// kind is the primary router; `audience` on the def exists to RESTRICT (tag the security-
// sensitive events). Explicit `tools:`/`accepts:` on the invoke input remain as escape hatches.
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

/** Rewrite a machine config, wrapping every Agent-slot/`gate` invoke input (immutably). */
function deriveMenus(config: unknown, defs: Map<string, EventDef>, actors: Record<string, UnknownActorLogic>): unknown {
  const pick = (names: Set<string>, kind: "agent" | "external"): string[] =>
    [...names].filter((name) => {
      const d = defs.get(name);
      return !!d && (d.audience === kind || d.audience === "any");
    });

  const walk = (node: LooseState, inherited: Set<string>, path: readonly string[]): LooseState => {
    const names = new Set(inherited);
    for (const key of Object.keys(node.on ?? {})) {
      if (!key.includes(".") && key !== "*") names.add(key);
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
          const derived = pick(names, "agent");
          if (derived.length === 0) refuseBuriedPicks(node, inv.src, path, pick);
          return { ...inv, input: wrapAgentInput(inv.input, derived, inv.src) };
        }
        if (inv?.src === "gate") {
          const wrapped: LooseInvoke = { ...inv, input: wrapGateInput(inv.input, pick(names, "external")) };
          // A machine-root gate (empty path) is left to xstate's default id: a `""` id would be
          // worse than a noisy one, and the derived gate id still works.
          if (inv.id == null && path.length) {
            const key = path.join(".");
            wrapped.id = unnamedGates > 1 ? `${key}.${ordinal++}` : key;
          }
          return wrapped;
        }
        return inv;
      };
      out = { ...node, invoke: Array.isArray(node.invoke) ? node.invoke.map(wrapOne) : wrapOne(node.invoke) };
    }
    if (node.states) {
      const states: Record<string, LooseState> = {};
      for (const [key, child] of Object.entries(node.states)) states[key] = walk(child, names, [...path, key]);
      out = { ...(out === node ? node : out), states };
    }
    return out;
  };

  return walk(config as LooseState, new Set(), []);
}

/**
 * Refuse the one shape that LOOKS like a Menu and is not one (ADR-0015, ADR-0057): an Agent
 * invoked on a state whose picks are written in its SUBSTATES.
 *
 * A Menu derives from the invoking state's own + ANCESTOR transitions, per statechart semantics,
 * so a pick written below that state is one the Turn is never offered — the model is handed a
 * Menu it cannot end its turn with, and the actor reads an empty Menu as a Turn that ended as
 * intended, so nothing nudges and nothing faults: the run parks. Until ADR-0057 the `tools:`
 * override papered over it; with the override gone the kit says it here, at build, where `jr2 up`
 * walks every registered Machine.
 *
 * An EMPTY Menu is not itself wrong — a state moved by a Gate or a timer asks its Agent for text
 * and nothing else — so only the contradiction is refused: no Menu here, and picks below.
 */
function refuseBuriedPicks(
  node: LooseState,
  agentName: string,
  path: readonly string[],
  pick: (names: Set<string>, kind: "agent" | "external") => string[],
): void {
  const below = new Set<string>();
  const descend = (n: LooseState): void => {
    for (const key of Object.keys(n.on ?? {})) if (!key.includes(".") && key !== "*") below.add(key);
    for (const child of Object.values(n.states ?? {})) descend(child);
  };
  for (const child of Object.values(node.states ?? {})) descend(child);

  const buried = pick(below, "agent");
  if (buried.length === 0) return;
  const state = path.length ? path.join(".") : "(the machine root)";
  throw new Error(
    `agent "${agentName}" is invoked on state "${state}", which derives an EMPTY Menu while the ` +
      `states BELOW it handle ${buried.join(", ")} — a Menu is the invoking state's own plus its ` +
      `ancestors' transitions (ADR-0015), so a pick written below is one the Turn can never be ` +
      `offered, and a Turn with no Menu ends with no pick at all. Move it onto "${state}" (guard ` +
      `it if it must not always be offered — ADR-0029), or, if this Turn is deliberately ` +
      `menu-less, the pick belongs to another invoke.`,
  );
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

/** Wrap an Agent slot's invoke input: name the Agent (the slot key), append the derived menu, and
 * finalize the mechanism fields. */
function wrapAgentInput(orig: unknown, derived: string[], agentName: string) {
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
      // The Menu (ADR-0015): always the derived one, since ADR-0057 retired the override.
      tools: derived,
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
