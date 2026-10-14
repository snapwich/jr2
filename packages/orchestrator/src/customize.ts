// `customize(machine, parts)` (ADR-0049, ADR-0051): RETUNE what a Machine carries, without
// editing the module that exports it. A package exports a Machine and nothing beside it — the
// door, the vocabulary, the Agents, the Sandbox Image and the Repo Slots all ride the exported
// object — so the only thing a consumer can be handed is the Machine, and the only honest way to
// say "same workflow, my model, my repository" is a function over it.
//
// It is a plain function in the family of `workspace()` and `pool()`, returning a plain
// `StateMachine`: no jr2-owned machine type over xstate's, nothing to survive a later
// `.provide()`, nothing to learn (ADR-0015's rule, restated by ADR-0049 — a `.with()` method and
// a callable-machine hybrid were both rejected there).
//
// Four moves, and each is the smallest one that works:
//
//   - An AGENT override is xstate's own `provide`: `machine.provide({ actors: { coder:
//     agent({ ...stock, ...override }) } })`. The slot already IS the Agent (ADR-0049), so
//     retuning one is substituting a slot's logic, which is what `provide` is for.
//   - An EFFECT binding is the same substitution (ADR-0054): an Effect whose url or argv the
//     package left `open`, or whose auth, header or env names `secret(open)`, carries a binder,
//     which builds the Effect again with the composer's parts, so the bound slot is checked as a
//     written one is. Once — a bound part is fixed from then on.
//   - A CHILD override is the same call one level down, recursing. Each level is exactly the
//     one-level reach ADR-0015 found `provide` has — held by the composer who owns the child
//     object, never host-side injection into somebody else's Machine.
//   - The IMAGE, the REPOS and the SIZE are the parts `provide` cannot carry: xstate copies implementations
//     and passes the CONFIG through by reference, and every part a Machine carries is keyed on
//     that config (parts.ts, vocabulary.ts). A new image or a bound slot therefore needs a new key
//     — so those fields clone the wrapper's config and rebuild it with the same implementations,
//     re-attaching what the original carried. The load warnings of a bound argv are the same
//     kind of part: the Machine the author wrote is rebuilt the same way, carrying the rechecked
//     warnings in place of the Open Machine's.
//
// jr2's wrappers are TRANSPARENT: `agents`/`actors` route through `workspace()`'s `body` and
// `pool()`'s `worker`, so a consumer customizing a Workspace-rooted workflow never writes `body`
// and never has to know that jr2 wrapped anything. `image`/`user`/`repos`/`resources` travel the same
// chain in the other direction — down to the `workspace()` that owns the seats, the slots and the
// Size.
//
// Both halves route on the wrapper's own RECORD of being one, never on a slot's spelling: the
// runtime reads `wrapperBodyOf` and the types read `JR2Wrapper` (parts.ts), which the wrappers
// stamp and state together. That is what keeps the compiler's answer and the runtime's the same
// answer for a Machine whose author happened to name a slot `body`.
//
// Only DECLARED parts can be customized; none can be added. A consumer who needs a third Agent
// composes a new Machine — which is the same act, spelled honestly. A `workspace()` that declared
// its slot MAP Open (`repos: open`, ADR-0051) declared exactly this: every slot is the composer's
// to name, so the map they write is the declaration, not an addition to one.

import { StateMachine, type AnyStateMachine, type InputFrom, type ProvidedActor, type UnknownActorLogic } from "xstate";
import type { AgentLogic } from "./actor.ts";
import { isAgent, type AgentDefinition } from "./agent.ts";
import { agent } from "./harness-client.ts";
import {
  asMachine,
  assertRepoSlot,
  attachSandboxParts,
  attachWrapperBody,
  composesSandbox,
  open,
  sandboxPartsOf,
  wrapperBodyOf,
  type JR2Repos,
  type JR2Wrapper,
  type RepoSlot,
  type SandboxParts,
} from "./parts.ts";
import { assertSize, assertUserSeat, layerSize, type Size, type UserContainer } from "./size.ts";
import {
  attachInputSchema,
  attachLoadWarnings,
  attachSeats,
  attachVocabulary,
  inputSchemaOf,
  loadWarningsOf,
  seatsOf,
  vocabularyOf,
} from "./vocabulary.ts";
import { isEffect, type Arg } from "./effect.ts";
import { attachLent, copyOpenBody, lentIn, openBodiesOf, openBodyDeclarationOf } from "./open-body.ts";
import { effectChecks } from "./effect-checks.ts";
import type { NamedSecret, Text } from "./http-effect.ts";
import {
  binderOf,
  effectBindingShape,
  openPartsOf,
  openPartsText,
  type EffectBinding,
  type OpenEffect,
  type OpenEffectPart,
} from "./open-effect.ts";

// --- What a Machine declares, read at the TYPE level ---------------------------------------------
// Everything below reads xstate's own `TActor` parameter — the `{ src, logic, id }` union
// `setup({ actors })` derives and `provide()` is checked against. Nothing is registered, declared
// twice, or inferred from a name: the slots a Machine carries ARE its type, so a `customize()` of
// an Agent the Machine does not carry is a compile error (ADR-0050) and `jr2 up`'s typecheck gate
// is where it stops.

/** The actor slots a Machine declares. */
type SlotsOf<M extends AnyStateMachine> =
  M extends StateMachine<
    any,
    any,
    any,
    infer TActor extends ProvidedActor,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >
    ? TActor
    : never;

/**
 * The logic a Machine declares under one slot key.
 *
 * @internal
 */
type LogicAt<M extends AnyStateMachine, K extends string> = Extract<SlotsOf<M>, { src: K }>["logic"];

/**
 * The Agent slots — told from every other slot by their logic, which no other actor kind has.
 *
 * @internal
 */
type AgentSlots<M extends AnyStateMachine> = Extract<SlotsOf<M>, { logic: AgentLogic }>["src"];

/** The Effect slots with an Open part — told by the phantom `OpenEffect` their constructor's
 * overload states for an `open` url or argv, or a `secret(open)` (open-effect.ts).
 *
 * @internal
 */
type OpenEffectSlots<M extends AnyStateMachine> = Extract<SlotsOf<M>, { logic: OpenEffect<OpenEffectPart> }>["src"];

/** What one Open part binds to: a url, an argv, a secret's name, a dispatch's target — another
 * Orchestrator's origin and the secret that holds its Instance token, together (ADR-0071). */
type PartBinding<P> = P extends "url"
  ? { url: string | Text }
  : P extends "argv"
    ? { argv: readonly (string | Arg)[] }
    : P extends "secret"
      ? { secret: string }
      : P extends "target"
        ? { target: { url: string; token: NamedSecret } }
        : never;

/** A union of object types as their intersection: one binding object with every key. */
type Intersected<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** What one Open Effect binds to: its url, its argv or its secret — for an Effect with two Open
 * parts, one object with both keys, the intersection of their bindings (ADR-0054).
 *
 * @internal
 */
type BindingOf<L> = L extends OpenEffect<infer P> ? Intersected<PartBinding<P>> : never;

/** The child-Machine slots: the slots composition reaches (ADR-0049 — a nested Machine is an
 * ordinary `invoke` of an ordinary slot).
 *
 * @internal
 */
type ChildSlots<M extends AnyStateMachine> = Extract<SlotsOf<M>, { logic: AnyStateMachine }>["src"];

/**
 * The child Machine under one slot key, constrained so `Customize` may recurse into it.
 *
 * @internal
 */
type ChildAt<M extends AnyStateMachine, K extends string> = Extract<LogicAt<M, K>, AnyStateMachine>;

/**
 * The Machine a `customize()` actually reaches: jr2's wrappers are transparent to their body, so
 * this is the first Machine an AUTHOR wrote. It mirrors `bodyOf`'s runtime walk, and reads the
 * SAME record — `JR2Wrapper` is the type half of the stamp `attachWrapperBody` writes — so both
 * stop at the same Machine and what the compiler offers is what the call retunes. Recursive in
 * tail position, as the runtime walk is unbounded: however many wrappers a composer stacks, the
 * compiler and the call answer alike.
 */
// Each step is taken on the wrapper's MARKER (`JR2Wrapper`, parts.ts), never on a slot's spelling —
// an author is free to name a slot `body` or `worker`, and routing through it because of the name
// would offer the Agents of a Machine the composer never named.
/** @internal */
type Reached<M extends AnyStateMachine> = M extends JR2Wrapper<infer TBody> ? Reached<TBody> : M;

/**
 * The `workspace()` a `customize()` reaches for its SEATS and SLOTS — the other direction from
 * {@link Reached}: down through the wrappers to the first Machine that composes a Sandbox, which
 * is the one whose `JR2Repos` marker says which slots exist (ADR-0051). `never` when no wrapper on
 * the chain composes one, which is what makes `repos` unavailable there rather than `{}`.
 *
 * @internal
 */
type WorkspaceOf<M extends AnyStateMachine> =
  M extends JR2Repos<any> ? M : M extends JR2Wrapper<infer TBody> ? WorkspaceOf<TBody> : never;

/** The Repo Slot keys the reached `workspace()` declared. The `never` case is tested by itself,
 * because `never extends JR2Repos<infer TSlots>` is true with nothing to infer from — and an
 * uninferred `TSlots` widens to `string`, which would offer every key exactly where there are none.
 *
 * @internal
 */
type RepoSlotsOf<M extends AnyStateMachine> = [WorkspaceOf<M>] extends [never]
  ? never
  : WorkspaceOf<M> extends JR2Repos<infer TSlots>
    ? TSlots
    : never;

// What may be retuned on one Machine, mirroring the DECLARATION's own shape and recursively
// partial (ADR-0049): every key optional, every Agent override a partial definition, every child a
// `Customize` of that child. `image`/`user` are the `workspace()` options (ADR-0037, ADR-0005) and
// apply to the wrapper the chain reaches; a Machine that composes no Sandbox refuses them at build
// time, because there is nothing for them to name.
/**
 * The parts of one Machine that `customize()` can retune: its Agents, its Open Effects, the
 * Machines it composes, and the Sandbox of its `workspace()`. The type comes from the Machine
 * itself, so it offers only the parts that the Machine declares. A key for a part the Machine does
 * not declare does not compile. The `agents`, `effects`, `actors` and `repos` keys take no value
 * when the Machine has no such part. `image`, `user` and `resources` compile on every Machine, and
 * `customize()` refuses them when the Machine composes no `workspace()`.
 *
 * Every key is optional. Write only what you change.
 *
 * @example
 * ```ts
 * import { customize, type Customize } from "@jr2/orchestrator";
 * import { task } from "@jr2/machines";
 *
 * const parts: Customize<typeof task> = {
 *   repos: { app: { url: "https://github.com/you/app.git", ref: "main" } },
 *   agents: { coder: { model: "anthropic/claude-sonnet-5-5", thinkingLevel: "high" } },
 * };
 *
 * export const machine = customize(task, parts);
 * ```
 *
 * @see docs/guides/bind-open-parts.md
 * @see docs/concepts/composition.md
 * @see docs/reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md
 */
export type Customize<M extends AnyStateMachine> = {
  // `{ model }` alone BINDS the model when the author left it Open (ADR-0054), which is the common
  // consumer line for a packaged Machine. The override is a `Partial<AgentDefinition>`, never a
  // declaration: a composer binds, and binding to `open` again is not a thing anyone means
  // (ADR-0054). A Machine carrying no Agent takes `never` rather than `{}`: an empty object type
  // accepts any literal, which would make the one case with nothing to name the one case with
  // nothing checked.
  /** Retune the Agents that this Machine carries, by slot name: `{ coder: { model } }`. Each
   * override goes over the definition that the author wrote, field by field, so `{ model }` alone
   * keeps the author's instructions. When the author left the model Open, this is where you bind
   * it. Allowed fields: the fields of an `agent()` definition. At run time, `customize()` refuses a
   * slot that holds no Agent: `customize(): machine "<id>" carries no Agent slot "<slot>" — its
   * Agents are: <slots>`. */
  agents?: [AgentSlots<Reached<M>>] extends [never]
    ? never
    : { [K in AgentSlots<Reached<M>>]?: Partial<AgentDefinition> };
  // `{ url }` is for an http Effect whatever its body (ADR-0054); `{ target }` binds a dispatch's
  // url and token as one (ADR-0071). Bound once, here — a value, never a mapper over the door, so
  // the host is fixed before any run (ADR-0054). Only an Effect with an Open part is offered: a
  // part its author fixed stays fixed. A Machine with none takes `never`, as `agents` does.
  /** Bind the Open parts of this Machine's Effects, by slot name: `{ url }` for an `http` Effect
   * whose url is Open, `{ argv }` for a `command` whose argv is Open, `{ secret }` for an Effect
   * that names `secret(open)`, `{ target: { url, token: secret("<name>") } }` for a `dispatch`
   * whose target is Open. For an Effect with two Open parts, one object holds both keys, and
   * a binding that leaves one out does not compile. Only Effects with an Open part are offered.
   * See {@link EffectBinding} for the values and the refusals. */
  effects?: [OpenEffectSlots<Reached<M>>] extends [never]
    ? never
    : { [K in OpenEffectSlots<Reached<M>>]?: BindingOf<LogicAt<Reached<M>, K>> };
  /** Retune a Machine that this Machine composes, by slot name. The value has the same shape as
   * these parts, one level down. At run time, `customize()` refuses a slot that holds no Machine:
   * `customize(): machine "<id>" composes no Machine under "<slot>"`. */
  actors?: [ChildSlots<Reached<M>>] extends [never]
    ? never
    : { [K in ChildSlots<Reached<M>>]?: Customize<ChildAt<Reached<M>, K>> };
  // The Sandbox Image (ADR-0037).
  /** The Sandbox Image: a `file:` URL to a docker context that your module ships
   * (`import.meta.resolve("./image")`), which `jr2 up` builds, or a registry ref. It replaces the
   * image of the `workspace()`. When the Machine composes no `workspace()`, `customize()` refuses it
   * at run time. */
  image?: string;
  // The User Container (ADR-0005), in the same two shapes, or `{ image, resources }` with its split
  // of the Size (ADR-0060). Replaces the seat whole — split included.
  /** The User Container: its image, as a `file:` URL or a registry ref, or a
   * {@link UserContainer} that also gives its part of the Size. It replaces the whole User
   * Container, its part of the Size included. When the Machine composes no `workspace()`,
   * `customize()` refuses it at run time. */
  user?: string | UserContainer;
  // The Size (ADR-0060), layered over the `workspace()`'s own: the composer's Repo may be bigger
  // than the author's.
  /** The Size, layered field by field over the Size of the `workspace()`: `{ limits: { memory } }`
   * keeps the author's cpu. Only `limits.memory` and `limits.cpu`. See {@link Size}. Only for a
   * Machine that composes a `workspace()`. */
  resources?: Size;
  // Any of the three slot forms, so a consumer can also bind a mapper over the wrapper's door
  // (ADR-0051). A Machine that composes no Sandbox takes `never`, as `agents` does. A
  // `workspace()` that declared its map Open takes any keys — they are the composer's words, in the
  // order the Machine documents — and at least one, checked at the call.
  /** Bind the Repo Slots of the `workspace()`, by slot name. Each value is one of these:
   *
   * - a url
   * - a Binding `{ url, ref? }`
   * - a function `({ input }) => url | { url, ref? }` over the run input
   * - `open`, to leave the slot for the next composer to bind
   *
   * You can bind an Open slot, or give a bound or per-run slot a different Binding. A slot that
   * the Machine does not declare does not compile. Some Machines, such as `task`, leave their
   * whole slot map Open. Then you name every slot, and at least one. The keys are your names for
   * the Repos, and the Machine says what their order means. */
  repos?: [RepoSlotsOf<M>] extends [never] ? never : { [K in RepoSlotsOf<M>]?: RepoSlot<InputFrom<WorkspaceOf<M>>> };
};

/** The same shape with the types erased — what the implementation walks. */
type LooseParts = {
  agents?: Record<string, Partial<AgentDefinition> | undefined>;
  effects?: Record<string, EffectBinding | undefined>;
  actors?: Record<string, LooseParts | undefined>;
  image?: string;
  user?: string | UserContainer;
  repos?: Record<string, RepoSlot | undefined>;
  resources?: Size;
};

// Returns a NEW Machine of the same type — the original is untouched, so two customizations of one
// import are two independent Machines (ADR-0049's `deep`/`quick`), and a run of either carries what
// it was given.
/**
 * Retune the parts that a Machine carries, without a change to the module that exports it. Use it
 * where you register a Machine as a Workflow. It binds the parts that a packaged Machine leaves
 * Open: its Repo Slots, an Agent's model, or an Effect's url, argv or secret. It also changes the
 * parts that its author fixed: an Agent's instructions, the Sandbox Image, or the Size.
 *
 * It gives back a new Machine of the same type. The original does not change, so two
 * `customize()` calls on one import give two Machines. Only the parts the Machine declares can be
 * retuned. You cannot add a part: a Machine that needs another Agent is a new Machine. The types
 * refuse most mistakes when you compile. At run time, `customize()` also throws:
 *
 * - `customize(): machine "<id>" carries no Agent slot "<slot>" — its Agents are: <slots>`
 * - `customize(): machine "<id>" composes no Machine under "<slot>" — the Machines it composes are: <slots>`
 * - `customize(): machine "<id>" carries no Effect slot "<slot>" — its Effects are: <slots>`
 * - `customize(): machine "<id>" declares no Repo Slot "<slot>" — its slots are: <slots>`
 * - `customize(): machine "<id>" declares its Repo Slots open as a map — name at least one`
 * - `` customize(): `repos` say what a SANDBOX is made of, how big it is and which Repos it
 *   attaches, and machine "<id>" composes none `` (for `resources`, the text starts
 *   `` customize(): `resources` ``; for `image` or `user`, it starts `` customize(): `image`/`user` ``)
 * - `customize(): machine "<id>": <errors>`, when an Effect argv that you bind fails the checks
 *   that the Machine passed when it was built
 * - the refusals of {@link EffectBinding}, {@link RepoSlot}, {@link Size} and
 *   {@link UserContainer}, which start with `customize()`
 *
 * @param machine - The Machine to retune: one you import from a package, or one you wrote. When
 * its root is a `workspace()` or a `pool()`, `customize()` reaches through to the Machine inside,
 * so you never name the wrapper's own slot.
 * @param parts - The parts to change. See {@link Customize}.
 * @returns A new Machine of the same type, with the parts changed.
 *
 * @example
 * ```ts
 * import { customize } from "@jr2/orchestrator";
 * import { task } from "@jr2/machines";
 *
 * export const machine = customize(task, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   agents: { coder: { model: "anthropic/claude-sonnet-5-5" } },
 *   resources: { limits: { memory: "4Gi" } },
 * });
 * ```
 *
 * @see docs/guides/bind-open-parts.md
 * @see docs/concepts/composition.md
 * @see docs/reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function customize<M extends AnyStateMachine>(machine: M, parts: Customize<M>): M {
  const { agents, effects, actors, image, user, repos, resources } = parts as LooseParts;
  let out: AnyStateMachine = machine;
  // Order matters in one direction only: the Sandbox seats and slots REBUILD the wrapper, so they
  // go last and carry the retuned implementations with them.
  if (agents || effects || actors) out = retune(out, { agents, effects, actors });
  const seats: Seats = {
    ...(image !== undefined ? { image } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(repos !== undefined ? { repos } : {}),
    ...(resources !== undefined ? { resources } : {}),
  };
  // Refused where the composer wrote them, by field (ADR-0060), before any wrapper is rebuilt.
  if (seats.user !== undefined) assertUserSeat("customize()", seats.user);
  if (seats.resources !== undefined) assertSize("customize(): resources", seats.resources);
  if (Object.keys(seats).length > 0) out = reseat(out, seats);
  return out as M;
}

/** What `reseat` carries down the chain: the two image seats, the slot overrides and the Size, each
 * present only when the composer named it. */
type Seats = {
  image?: string;
  user?: string | UserContainer;
  repos?: Record<string, RepoSlot | undefined>;
  resources?: Size;
};

/** The slot keys whose logic answers `pred` — what an error names, so the message is the
 * Machine's own declaration rather than advice. */
function slotsWhere(machine: AnyStateMachine, pred: (logic: unknown) => boolean): string[] {
  return Object.entries(machine.implementations.actors as Record<string, unknown>)
    .filter(([, logic]) => pred(logic))
    .map(([name]) => name);
}

const listed = (names: string[]): string => names.join(", ") || "none";

/** The Machine a wrapper is transparent to, or undefined for a Machine an author wrote. */
function bodyOf(machine: AnyStateMachine): { slot: string; body: AnyStateMachine } | undefined {
  const slot = wrapperBodyOf(machine);
  if (!slot) return undefined;
  const body = asMachine((machine.implementations.actors as Record<string, unknown>)[slot]);
  return body ? { slot, body } : undefined;
}

/** Substitute one slot's logic — the one move every level of this module makes. */
function substitute(machine: AnyStateMachine, actors: Record<string, unknown>): AnyStateMachine {
  return machine.provide({ actors } as Parameters<AnyStateMachine["provide"]>[0]);
}

/** Agents and children, resolved against the first Machine an author wrote. */
function retune(machine: AnyStateMachine, parts: LooseParts): AnyStateMachine {
  const inner = bodyOf(machine);
  if (inner) return substitute(machine, { [inner.slot]: retune(inner.body, parts) });

  const actors: Record<string, unknown> = {};
  for (const [name, override] of Object.entries(parts.agents ?? {})) {
    if (!override) continue;
    const logic = (machine.implementations.actors as Record<string, unknown>)[name];
    if (!isAgent(logic)) {
      throw new Error(
        `customize(): machine "${machine.id}" carries no Agent slot "${name}" — its Agents are: ` +
          `${listed(slotsWhere(machine, isAgent))} (ADR-0049). Only declared parts can be retuned; ` +
          "a Machine that needs another Agent is a new Machine.",
      );
    }
    // The override is layered OVER the stock declaration, never merged into it: `{ model }` alone
    // keeps the author's instructions, and the result is one whole declaration the slot carries —
    // bound, if the model was Open and this override named one; still Open if it did not, and the
    // walk reports it again (ADR-0054).
    actors[name] = agent({ ...logic.definition, ...override });
  }
  const bound = Object.entries(parts.effects ?? {}).filter(([, b]) => b !== undefined);
  for (const [name, binding] of bound) actors[name] = bindEffect(machine, name, binding!);
  for (const [name, childParts] of Object.entries(parts.actors ?? {})) {
    if (!childParts) continue;
    const child = asMachine((machine.implementations.actors as Record<string, unknown>)[name]);
    if (!child) {
      throw new Error(
        `customize(): machine "${machine.id}" composes no Machine under "${name}" — the Machines ` +
          `it composes are: ${listed(slotsWhere(machine, (logic) => !!asMachine(logic)))} (ADR-0049).`,
      );
    }
    actors[name] = customize(child, childParts as Customize<AnyStateMachine>);
  }
  // An Open body lends by slot name (ADR-0070), and its stamped lent set must be the retuned slots,
  // not the import's: each body is copied (the import keeps its own stamp) and stamped again over
  // the retuned actors.
  if (Object.keys(actors).length > 0) {
    const impl = machine.implementations as Parameters<typeof lentIn>[0];
    const merged = { ...impl, actors: { ...(impl.actors ?? {}), ...actors } };
    for (const { slot, logic } of openBodiesOf(machine)) {
      const copy = copyOpenBody(logic);
      attachLent(copy, lentIn(merged, openBodyDeclarationOf(logic)));
      actors[slot] = copy;
    }
  }
  const out = substitute(machine, actors);
  if (bound.length === 0) return out;
  // The bound Machine's warnings differ from the Open one's, and `provide` kept the Open one's
  // config, which is what every attachment keys on (ADR-0049) — so it gets a config of its own,
  // carrying what the original carried and the rechecked warnings, and any later `provide()` of
  // it (a run's, ADR-0015) keeps them.
  const warnings = recheck(machine, out);
  const rebuilt = cloneConfig(out);
  attachLoadWarnings(rebuilt, warnings);
  return rebuilt;
}

/**
 * Bind one Effect's Open parts (ADR-0054): the slot must be an Effect, each key of the binding one
 * of its Open parts, and each value the value that part takes — a url (a string, or a `text` with a
 * secret in its path), an argv, a secret's name, or a dispatch's target (ADR-0071). A key left out leaves that part Open. The binder
 * builds the Effect again, whole, so the bound one meets every check its constructor runs: the url's
 * literal host, the argv's entries, the secret's name. The compiler's check of the
 * invoke's input against the argv's slots does not reach it (an Open argv's input is one string per
 * key): a slot the invoke does not supply faults when the Effect starts (ADR-0054).
 */
function bindEffect(machine: AnyStateMachine, name: string, binding: EffectBinding): unknown {
  const logic = (machine.implementations.actors as Record<string, unknown>)[name];
  if (!isEffect(logic)) {
    throw new Error(
      `customize(): machine "${machine.id}" carries no Effect slot "${name}" — its Effects are: ` +
        `${listed(slotsWhere(machine, isEffect))} (ADR-0067). Only declared parts can be bound.`,
    );
  }
  const parts = openPartsOf(logic.effect);
  const binder = binderOf(logic);
  if (parts.length === 0 || binder === undefined) {
    throw new Error(
      `customize(): the ${logic.effect.kind} Effect "${name}" of machine "${machine.id}" leaves nothing Open — its ` +
        "parts are fixed in its definition, and only a part a package left `open` is bound, once (ADR-0054).",
    );
  }
  // One object binds them, each key an Open part; a key it leaves out leaves that part Open, and
  // the walk reports it again (ADR-0054).
  const given = typeof binding === "object" && binding !== null ? (binding as Record<string, unknown>) : {};
  const keys = Object.keys(given).filter((k) => given[k] !== undefined);
  if (keys.length === 0 || keys.some((k) => !parts.includes(k as OpenEffectPart))) {
    throw new Error(
      `customize(): the ${logic.effect.kind} Effect "${name}" leaves its ${openPartsText(parts)} Open — bind it ` +
        `with ${effectBindingShape(parts)} (ADR-0054)`,
    );
  }
  for (const part of keys) {
    const value = given[part];
    if (value === open || typeof value === "function") {
      throw new Error(
        `customize(): the ${logic.effect.kind} Effect "${name}"'s ${part} is bound once, to a value — not ` +
          `${value === open ? "`open` again" : "a function of the run"}: no run chooses an Effect's ${part} (ADR-0054)`,
      );
    }
    if (part === "target") {
      // The whole target is the Open part (ADR-0071): an origin and a named secret, bound together.
      // The dispatch's own constructor checks the url and the name when the binder rebuilds it.
      const target = value as { url?: unknown; token?: unknown } | null;
      if (typeof target !== "object" || target === null || typeof target.url !== "string" || !isSecret(target.token)) {
        throw new Error(
          `customize(): the dispatch Effect "${name}"'s target is bound to another Orchestrator's origin and the ` +
            `secret that holds its Instance token: ${effectBindingShape("target")} (ADR-0071)`,
        );
      }
    }
    if (part === "secret" && typeof value !== "string") {
      throw new Error(
        `customize(): the ${logic.effect.kind} Effect "${name}"'s secret is bound to a secret's name, a string — ` +
          `the file the Effector reads it from: { secret: "<name>" } (ADR-0054, ADR-0068)`,
      );
    }
  }
  return binder(binding);
}

const isSecret = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { secret?: unknown }).secret === "string";

/**
 * The load walk's Effect checks (ADR-0067), again, on a Machine whose Open argv this `customize()`
 * bound: at build its argv slots were unknown and every pick param counted as read; now the bound
 * argv names them. A param it does not read is refused as at build, and a warning the walk gives
 * for the bound argv (a param only an action the probe does not run may read) replaces the
 * findings it gave for the Open one: the result is the warnings the same Machine written with that
 * argv carries, which the caller attaches to the bound Machine's own config.
 */
function recheck(before: AnyStateMachine, machine: AnyStateMachine): string[] {
  const defs = vocabularyOf(machine);
  if (!defs) return loadWarningsOf(before);
  const checks = (m: AnyStateMachine) =>
    effectChecks(m, m.implementations.actors as Record<string, UnknownActorLogic>, defs);
  const { errors, warnings } = checks(machine);
  if (errors.length) throw new Error(`customize(): machine "${machine.id}": ${errors.join("; ")}`);
  const unbound = new Set(checks(before).warnings);
  const kept = loadWarningsOf(before).filter((warning) => !unbound.has(warning));
  return [...new Set([...kept, ...warnings])];
}

/** The Sandbox seats and slots, applied to the `workspace()` the chain reaches. */
function reseat(machine: AnyStateMachine, seats: Seats): AnyStateMachine {
  if (composesSandbox(machine)) {
    const { repos: override, resources, ...images } = seats;
    const parts = sandboxPartsOf(machine);
    // The Size layers over the author's, field by field — a composer who raises memory keeps the
    // author's cpu (ADR-0060).
    const size = layerSize(parts.resources, resources);
    const sized = size !== undefined ? { resources: size } : {};
    if (parts.repos === open)
      return rebuild(machine, { ...parts, ...images, ...sized, repos: nameSlots(machine, override) });
    const repos = { ...parts.repos };
    // Only DECLARED slots can be bound (ADR-0051): the Machine's own word for each Repo is the
    // key, and a key it never declared would attach a repository the body has no handle for.
    // The check is on the declaration's OWN keys — `in` would also answer yes for `constructor`
    // and every other prototype key, and this runtime twin of the compile-time check must give
    // the compiler's answer for the calls the compiler never sees (an untyped call, a widened
    // key). Binding a per-run slot with a static url is legal — it becomes bound; which slots a
    // consumer may fix is the package author's call, expressed by the slot's state.
    for (const [slot, value] of Object.entries(override ?? {})) {
      if (value === undefined) continue;
      if (!Object.hasOwn(parts.repos, slot)) {
        throw new Error(
          `customize(): machine "${machine.id}" declares no Repo Slot "${slot}" — its slots are: ` +
            `${listed(Object.keys(parts.repos))} (ADR-0051)`,
        );
      }
      assertRepoSlot("customize()", slot, value);
      repos[slot] = value;
    }
    return rebuild(machine, { ...parts, ...images, ...sized, repos });
  }
  const inner = bodyOf(machine);
  if (!inner) {
    const named =
      seats.repos !== undefined ? "`repos`" : seats.resources !== undefined ? "`resources`" : "`image`/`user`";
    throw new Error(
      `customize(): ${named} say what a SANDBOX is made of, how big it is and which Repos it attaches, and ` +
        `machine "${machine.id}" composes none — only a workspace() wrapper carries those seats, that Size ` +
        "and those slots (ADR-0049, ADR-0037, ADR-0051, ADR-0060).",
    );
  }
  return substitute(machine, { [inner.slot]: reseat(inner.body, seats) });
}

/**
 * The composer's half of an Open slot MAP (ADR-0051): the Machine said `repos: open`, so the map
 * written here IS the declaration — every key is the composer's word for a Repo, the order is
 * kept for the body, and each value is any of the three slot forms (a composer building a further
 * package may leave one `open` for the next composer). Held to the same checks `workspace()` runs
 * on a declared map, because it is the same map one call later: a directory-shaped key, a valid
 * binding, and at least one slot. A `customize` that names no `repos` leaves the map Open, and
 * the walk reports it again.
 */
function nameSlots(machine: AnyStateMachine, override: Seats["repos"]): SandboxParts["repos"] {
  if (override === undefined) return open;
  const repos: Record<string, RepoSlot> = {};
  for (const [slot, value] of Object.entries(override)) {
    if (value === undefined) continue;
    assertRepoSlot("customize()", slot, value);
    repos[slot] = value;
  }
  if (Object.keys(repos).length === 0) {
    throw new Error(
      `customize(): machine "${machine.id}" declares its Repo Slots open as a map — name at least one: ` +
        '`repos: { app: "https://…" }` (ADR-0051).',
    );
  }
  return repos;
}

/**
 * Rebuild a wrapper around a NEW config object, carrying everything the original carried.
 *
 * `provide()` cannot do this: it passes `this.config` through by reference, and the parts a
 * Machine carries are keyed on exactly that object — so writing new Sandbox seats under it would
 * retune the ORIGINAL too, and `deep`/`quick` would be one Machine wearing the last image
 * assigned. The clone is shallow because only the object's IDENTITY changes: the states, the
 * transitions and the invokes are the same values, so the Machine shape — and therefore the
 * fingerprint a restore compares (ADR-0030) — is bit-identical to the original's.
 */
function rebuild(machine: AnyStateMachine, seats: SandboxParts): AnyStateMachine {
  const clone = cloneConfig(machine);
  attachSandboxParts(clone, seats);
  return clone;
}

/**
 * The Machine around a NEW config object — a shallow clone, so the shape and the fingerprint are
 * the original's — with the same implementations, and every attachment the original carried
 * re-attached under the new key (ADR-0049): the vocabulary, the door, the seats, the load
 * warnings and a wrapper's body. What the caller attaches after is the clone's alone.
 */
function cloneConfig(machine: AnyStateMachine): AnyStateMachine {
  const clone = new StateMachine({ ...machine.config }, machine.implementations) as AnyStateMachine;
  const vocabulary = vocabularyOf(machine);
  if (vocabulary) attachVocabulary(clone, vocabulary);
  const door = inputSchemaOf(machine);
  if (door) attachInputSchema(clone, door);
  const seats = seatsOf(machine);
  if (seats.length > 0) attachSeats(clone, seats);
  const warnings = loadWarningsOf(machine);
  if (warnings.length > 0) attachLoadWarnings(clone, warnings);
  const slot = wrapperBodyOf(machine);
  if (slot) attachWrapperBody(clone, slot);
  return clone;
}
