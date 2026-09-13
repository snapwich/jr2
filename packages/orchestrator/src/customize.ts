// `customize(machine, parts)` (ADR-0049, ADR-0051): RETUNE what a Machine carries, without
// editing the module that exports it. A package exports a Machine and nothing beside it — the
// door, the vocabulary, the Agents, the Sandbox Image and the Repo Slots all ride the exported
// object — so the only thing a consumer can be handed is the Machine, and the only honest way to
// say "same workflow, my model, my repository" is a function over it.
//
// It is a plain function in the family of `workspace()` and `pool()`, returning a plain
// `StateMachine`: no j2-owned machine type over xstate's, nothing to survive a later
// `.provide()`, nothing to learn (ADR-0015's rule, restated by ADR-0049 — a `.with()` method and
// a callable-machine hybrid were both rejected there).
//
// Three moves, and each is the smallest one that works:
//
//   - An AGENT override is xstate's own `provide`: `machine.provide({ actors: { coder:
//     agent({ ...stock, ...override }) } })`. The slot already IS the Agent (ADR-0049), so
//     retuning one is substituting a slot's logic, which is what `provide` is for.
//   - A CHILD override is the same call one level down, recursing. Each level is exactly the
//     one-level reach ADR-0015 found `provide` has — held by the composer who owns the child
//     object, never host-side injection into somebody else's Machine.
//   - The IMAGE and the REPOS are the parts `provide` cannot carry: xstate copies implementations
//     and passes the CONFIG through by reference, and every part a Machine carries is keyed on
//     that config (parts.ts, vocabulary.ts). A new image or a bound slot therefore needs a new key
//     — so those fields clone the wrapper's config and rebuild it with the same implementations,
//     re-attaching what the original carried.
//
// j2's wrappers are TRANSPARENT: `agents`/`actors` route through `workspace()`'s `body` and
// `pool()`'s `worker`, so a consumer customizing a Workspace-rooted workflow never writes `body`
// and never has to know that j2 wrapped anything. `image`/`user`/`repos` travel the same chain in
// the other direction — down to the `workspace()` that owns the seats and the slots.
//
// Both halves route on the wrapper's own RECORD of being one, never on a slot's spelling: the
// runtime reads `wrapperBodyOf` and the types read `J2Wrapper` (parts.ts), which the wrappers
// stamp and state together. That is what keeps the compiler's answer and the runtime's the same
// answer for a Machine whose author happened to name a slot `body`.
//
// Only DECLARED parts can be customized; none can be added. A consumer who needs a third Agent
// composes a new Machine — which is the same act, spelled honestly.

import { StateMachine, type AnyStateMachine, type InputFrom, type ProvidedActor } from "xstate";
import type { AgentLogic } from "./actor.ts";
import { isAgent, type AgentDefinition } from "./agent.ts";
import { agent } from "./harness-client.ts";
import {
  asMachine,
  assertRepoSlot,
  attachSandboxParts,
  attachWrapperBody,
  composesSandbox,
  sandboxPartsOf,
  wrapperBodyOf,
  type J2Repos,
  type J2Wrapper,
  type RepoSlot,
  type SandboxParts,
} from "./parts.ts";
import { attachInputSchema, attachVocabulary, inputSchemaOf, vocabularyOf } from "./vocabulary.ts";

// --- What a Machine declares, read at the TYPE level ---------------------------------------------
// Everything below reads xstate's own `TActor` parameter — the `{ src, logic, id }` union
// `setup({ actors })` derives and `provide()` is checked against. Nothing is registered, declared
// twice, or inferred from a name: the slots a Machine carries ARE its type, so a `customize()` of
// an Agent the Machine does not carry is a compile error (ADR-0050) and `j2 up`'s typecheck gate
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

/** The logic a Machine declares under one slot key. */
type LogicAt<M extends AnyStateMachine, K extends string> = Extract<SlotsOf<M>, { src: K }>["logic"];

/** The Agent slots — told from every other slot by their logic, which no other actor kind has. */
type AgentSlots<M extends AnyStateMachine> = Extract<SlotsOf<M>, { logic: AgentLogic }>["src"];

/** The child-Machine slots: the slots composition reaches (ADR-0049 — a nested Machine is an
 * ordinary `invoke` of an ordinary slot). */
type ChildSlots<M extends AnyStateMachine> = Extract<SlotsOf<M>, { logic: AnyStateMachine }>["src"];

/** The child Machine under one slot key, constrained so `Customize` may recurse into it. */
type ChildAt<M extends AnyStateMachine, K extends string> = Extract<LogicAt<M, K>, AnyStateMachine>;

/**
 * The Machine a `customize()` actually reaches: j2's wrappers are transparent to their body, so
 * this is the first Machine an AUTHOR wrote. It mirrors `bodyOf`'s runtime walk, and reads the
 * SAME record — `J2Wrapper` is the type half of the stamp `attachWrapperBody` writes — so both
 * stop at the same Machine and what the compiler offers is what the call retunes. Recursive in
 * tail position, as the runtime walk is unbounded: however many wrappers a composer stacks, the
 * compiler and the call answer alike.
 */
// Each step is taken on the wrapper's MARKER (`J2Wrapper`, parts.ts), never on a slot's spelling —
// an author is free to name a slot `body` or `worker`, and routing through it because of the name
// would offer the Agents of a Machine the composer never named.
type Reached<M extends AnyStateMachine> = M extends J2Wrapper<infer TBody> ? Reached<TBody> : M;

/**
 * The `workspace()` a `customize()` reaches for its SEATS and SLOTS — the other direction from
 * {@link Reached}: down through the wrappers to the first Machine that composes a Sandbox, which
 * is the one whose `J2Repos` marker says which slots exist (ADR-0051). `never` when no wrapper on
 * the chain composes one, which is what makes `repos` unavailable there rather than `{}`.
 */
type WorkspaceOf<M extends AnyStateMachine> =
  M extends J2Repos<any> ? M : M extends J2Wrapper<infer TBody> ? WorkspaceOf<TBody> : never;

/** The Repo Slot keys the reached `workspace()` declared. The `never` case is tested by itself,
 * because `never extends J2Repos<infer TSlots>` is true with nothing to infer from — and an
 * uninferred `TSlots` widens to `string`, which would offer every key exactly where there are none. */
type RepoSlotsOf<M extends AnyStateMachine> = [WorkspaceOf<M>] extends [never]
  ? never
  : WorkspaceOf<M> extends J2Repos<infer TSlots>
    ? TSlots
    : never;

/**
 * What may be retuned on one Machine, mirroring the DECLARATION's own shape and recursively
 * partial (ADR-0049): every key optional, every Agent override a partial definition, every child
 * a `Customize` of that child.
 *
 * `image`/`user` are the `workspace()` options (ADR-0037, ADR-0005) and apply to the wrapper the
 * chain reaches; a Machine that composes no Sandbox refuses them at build time, because there is
 * nothing for them to name.
 */
export type Customize<M extends AnyStateMachine> = {
  /** Retune an Agent this Machine carries: the override is layered over the stock definition, so
   * `{ model }` alone keeps the instructions the author wrote. A Machine carrying no Agent takes
   * `never` rather than `{}`: an empty object type accepts any literal, which would make the one
   * case with nothing to name the one case with nothing checked. */
  agents?: [AgentSlots<Reached<M>>] extends [never]
    ? never
    : { [K in AgentSlots<Reached<M>>]?: Partial<AgentDefinition> };
  /** Retune a Machine this one composes — the same shape, one level down. */
  actors?: [ChildSlots<Reached<M>>] extends [never]
    ? never
    : { [K in ChildSlots<Reached<M>>]?: Customize<ChildAt<Reached<M>, K>> };
  /** The Sandbox Image (ADR-0037): a `file:` URL to a docker context this module ships, or a
   * registry ref. */
  image?: string;
  /** The User Container's image (ADR-0005), in the same two shapes. */
  user?: string;
  /** Bind the Repo Slots the reached `workspace()` declared (ADR-0051) — an open slot to a url,
   * or a bound or per-run one to a different Binding; any of the three forms, so a consumer can
   * also bind a mapper over the wrapper's door. A slot the Machine does not declare is a compile
   * error, and a Machine that composes no Sandbox takes `never`, as `agents` does. */
  repos?: [RepoSlotsOf<M>] extends [never] ? never : { [K in RepoSlotsOf<M>]?: RepoSlot<InputFrom<WorkspaceOf<M>>> };
};

/** The same shape with the types erased — what the implementation walks. */
type LooseParts = {
  agents?: Record<string, Partial<AgentDefinition> | undefined>;
  actors?: Record<string, LooseParts | undefined>;
  image?: string;
  user?: string;
  repos?: Record<string, RepoSlot | undefined>;
};

/**
 * Retune the parts a Machine carries, returning a NEW Machine of the same type — the original is
 * untouched, so two customizations of one import are two independent Machines (ADR-0049's
 * `deep`/`quick`), and a run of either carries what it was given.
 */
export function customize<M extends AnyStateMachine>(machine: M, parts: Customize<M>): M {
  const { agents, actors, image, user, repos } = parts as LooseParts;
  let out: AnyStateMachine = machine;
  // Order matters in one direction only: the Sandbox seats and slots REBUILD the wrapper, so they
  // go last and carry the retuned implementations with them.
  if (agents || actors) out = retune(out, { agents, actors });
  const seats: Seats = {
    ...(image !== undefined ? { image } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(repos !== undefined ? { repos } : {}),
  };
  if (seats.image !== undefined || seats.user !== undefined || seats.repos !== undefined) out = reseat(out, seats);
  return out as M;
}

/** What `reseat` carries down the chain: the two image seats and the slot overrides, each present
 * only when the composer named it. */
type Seats = { image?: string; user?: string; repos?: Record<string, RepoSlot | undefined> };

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
    // The override is layered OVER the stock definition, never merged into it: `{ model }` alone
    // keeps the author's instructions, and the result is one whole definition the Turn carries.
    actors[name] = agent({ ...logic.definition, ...override });
  }
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
  return substitute(machine, actors);
}

/** The Sandbox seats and slots, applied to the `workspace()` the chain reaches. */
function reseat(machine: AnyStateMachine, seats: Seats): AnyStateMachine {
  if (composesSandbox(machine)) {
    const { repos: override, ...images } = seats;
    const parts = sandboxPartsOf(machine);
    const repos = { ...parts.repos };
    // Only DECLARED slots can be bound (ADR-0051): the Machine's own word for each Repo is the
    // key, and a key it never declared would attach a repository the body has no handle for.
    // Binding a per-run slot with a static url is legal — it becomes bound; which slots a
    // consumer may fix is the package author's call, expressed by the slot's state.
    for (const [slot, value] of Object.entries(override ?? {})) {
      if (value === undefined) continue;
      if (!(slot in parts.repos)) {
        throw new Error(
          `customize(): machine "${machine.id}" declares no Repo Slot "${slot}" — its slots are: ` +
            `${listed(Object.keys(parts.repos))} (ADR-0051)`,
        );
      }
      assertRepoSlot("customize()", slot, value);
      repos[slot] = value;
    }
    return rebuild(machine, { ...parts, ...images, repos });
  }
  const inner = bodyOf(machine);
  if (!inner) {
    const named = seats.repos !== undefined ? "`repos`" : "`image`/`user`";
    throw new Error(
      `customize(): ${named} say what a SANDBOX is made of and which Repos it attaches, and machine ` +
        `"${machine.id}" composes none — only a workspace() wrapper carries those seats and slots ` +
        "(ADR-0049, ADR-0037, ADR-0051).",
    );
  }
  return substitute(machine, { [inner.slot]: reseat(inner.body, seats) });
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
  const clone = new StateMachine({ ...machine.config }, machine.implementations) as AnyStateMachine;
  const vocabulary = vocabularyOf(machine);
  if (vocabulary) attachVocabulary(clone, vocabulary);
  const door = inputSchemaOf(machine);
  if (door) attachInputSchema(clone, door);
  const slot = wrapperBodyOf(machine);
  if (slot) attachWrapperBody(clone, slot);
  attachSandboxParts(clone, seats);
  return clone;
}
