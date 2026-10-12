// The PARTS a Machine carries (ADR-0049, ADR-0051): its Agents, and — on a `workspace()` wrapper
// — the Sandbox Image the pod runs and the Repo Slots it attaches. A Machine carries everything it
// depends on and composes by invoke, so what a deployment must know about a workflow is neither a
// folder nor a config block: it is an attachment on the machine object plus a walk over it.
//
// Two halves, one file, because they are one idea:
//
//   - The ATTACHMENT. `workspace()` stamps its static options here, keyed on `machine.config` —
//     the raw object xstate's `.provide()` passes through unchanged, exactly as the vocabulary is
//     keyed (vocabulary.ts). That is ADR-0049's one rule: parts resolve at invoke time through the
//     LIVE actor's logic, never a build-time closure, so a `provide()` clone and a `customize()`
//     retune both find the part the actor was actually invoked as. The image is therefore never
//     persisted — the provisioning state re-reads it off the Machine on restore.
//   - The WALK. Its callers are the converge and the boot (ADR-0018/0019/0031/0037/0051): the
//     custom-provider preflight probes the models the registered Machines actually name, the
//     Instance Harness converges when any of them declares `workspace: "none"`, every `file:`
//     image context a Machine ships is built and content-tagged, every BOUND Repo is known before
//     a run can ask for it, an OPEN part — a Repo Slot with no url, an Agent with no model
//     (ADR-0054) — is refused before anything is built, every Size a `workspace()` states is split
//     and held to the Harness floor (ADR-0060), and whether any registered Machine composes a
//     Sandbox at all is the data-plane switch. None of these can read
//     an invoke's `input` (it is a function — dials are not statically recoverable), and none
//     needs to: identity lives in the definition, the image and the slots are options, and all are
//     values ON the Machine. A per-run slot is a function too, and the walk reports nothing for
//     it: which Repo it binds is the run's business, and the fence at attach is its check.
//
// The walk is STRUCTURAL, and it descends by the same two mechanisms composition uses:
//
//   - `implementations.actors` — every slot a `setup()`/`jr2Setup()` machine declares, whether or
//     not a state invokes it. An Agent slot is recognized by its brand (`isAgent`), a child
//     Machine by having a state tree. That covers an imported Machine invoked as a child,
//     `workspace()`'s `body`, and `pool()`'s `worker` — all named slots since ADR-0049.
//   - inline invoked machines — a machine object written straight onto an `invoke.src`, which
//     xstate rewrites to a generated key and keeps only on the raw config node. Nothing jr2 owns
//     arrives this way any more; the walk keeps it because an AUTHOR may still write one.
//
// A PART written inline is refused, not walked (`refuseInlineParts`): an `agent()`, an Effect
// (ADR-0067) or a `workspace()` on an `invoke.src` has no author-written name. xstate's generated
// key (`xstate.invoke.<n>.<state id>`) moves when a state is renamed, so the ledger, the Console doc
// and `jr2 up`'s report would name it by a number, and `customize()` — xstate's `provide`, keyed on
// `actors` — could not reach it at all. A slot key is the one name every reader shares (ADR-0049),
// so a Part is a key of `actors`, and the refusal says how to write it.
//
// Deliberately NOT a `provide()`-aware read: the walk runs on the registered Machine, which is the
// object the run will start, so a `customize()` clone is walked as itself and a test seam's fake
// (unbranded) contributes nothing.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyActorRef, AnyStateMachine, StateNode, UnknownActorLogic } from "xstate";
import { isAgent, isOpenAgent, type AgentDeclaration } from "./agent.ts";
import { argvText, isEffect, placementOf, type EffectParts, type Placement } from "./effect.ts";
import { effectBindingLine, type OpenEffectPart } from "./open-effect.ts";
import { isImageContext } from "./images.ts";
import { open } from "./open.ts";
import { repoIdentity } from "./repo-identity.ts";
import { userSeatOf, type Size, type UserContainer } from "./size.ts";

// --- Repo Slots (ADR-0051) ---------------------------------------------------------------------
// A `workspace()` names each Repo it attaches under a SLOT — the Machine's own word for it, the
// key of the body's `workspace.repos` handles, and the directory under `/work`. The slot's VALUE
// is one of three states, and the walk tells them apart without evaluating anything. A Machine
// whose body names no slot — it enumerates whatever is attached — declares the whole MAP Open
// instead (`repos: open`): the composer names every slot, in an order the Machine may give a
// meaning to. Open at the map is the same word as Open at a slot, one level up (CONTEXT.md).

// The sentinel itself lives in open.ts, a module with nothing else in it: since ADR-0054 it marks
// an Agent's model too, and agent.ts must read it without importing this file (the walk imports
// agent.ts, not the other way round). Re-exported here because a Repo Slot is where a composer
// meets it first, and `import { open } from "@jr2/orchestrator"` is the only spelling anyone writes.
export { open } from "./open.ts";

/** What a Repo Slot resolves to (CONTEXT.md "Binding"): the url, and the base the branch
 * Worktree is cut from — absent, the Repo's own default branch. */
export type Binding = { url: string; ref?: string };

/**
 * One Repo Slot's value: BOUND (a url, or `{ url, ref? }`), OPEN (the {@link open} sentinel —
 * someone downstream binds it), or PER-RUN (a mapper over the wrapper's door, so a run input — a
 * ticket field — decides). Bound and open are what `jr2 up` can see; per-run is the run's business,
 * fenced at attach by `git.credentials` (ADR-0051).
 */
export type RepoSlot<TInput = unknown> =
  | typeof open
  | string
  | Binding
  | ((args: { input: TInput }) => string | Binding);

/** The three states, read off a slot's value. */
export type RepoSlotState =
  | { kind: "open" }
  | { kind: "bound"; binding: Binding }
  | { kind: "per-run"; mapper: (args: { input: unknown }) => string | Binding };

/** Classify one slot's value. Assumes the value passed {@link assertRepoSlot}. */
export function repoSlotState(value: RepoSlot<any>): RepoSlotState {
  if (value === open) return { kind: "open" };
  if (typeof value === "function") return { kind: "per-run", mapper: value };
  return { kind: "bound", binding: typeof value === "string" ? { url: value } : value };
}

/** A slot key becomes a directory name under `/work`, so it is held to what a path segment can
 * carry — and to what a prompt can name without quoting. It starts with a LETTER: the handles
 * keep declaration order, which a Machine may give a meaning to (`task`: the first slot is the
 * one the coder edits), and JS puts an integer-like key such as `"1"` ahead of every other key in
 * `Object.keys`, wherever the author wrote it. */
export const REPO_SLOT_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Refuse a malformed slot value BY NAME, at build time — the same derives-from-a-typo class the
 * spec guard catches for the branch, one build earlier. A bound url is also parsed here: an
 * identity the walk cannot derive (a relative path, an unknown scheme) is refused where the
 * author wrote it rather than at the converge that walks it. `where` names the caller
 * (`workspace()`, `customize()`).
 */
export function assertRepoSlot(where: string, slot: string, value: unknown): asserts value is RepoSlot<any> {
  if (!REPO_SLOT_KEY.test(slot)) {
    throw new Error(
      `${where}: Repo Slot key ${JSON.stringify(slot)} is not a directory name — a slot becomes ` +
        "`/work/<slot>` and its order matters, so it starts with a letter and matches " +
        "/^[A-Za-z][A-Za-z0-9._-]*$/ (ADR-0051).",
    );
  }
  if (value === open || typeof value === "function") return;
  const binding = typeof value === "string" ? { url: value } : (value as Partial<Binding> | null | undefined);
  const bad = (what: string) =>
    new Error(
      `${where}: Repo Slot "${slot}" is ${what} — a slot is \`open\`, a url, \`{ url, ref? }\`, or a mapper ` +
        "`({ input }) => url | { url, ref? }` over the door (ADR-0051).",
    );
  if (typeof binding !== "object" || binding === null) throw bad(`not a binding (got ${JSON.stringify(value)})`);
  if (typeof binding.url !== "string" || !binding.url)
    throw bad(`bound to an empty url (got ${JSON.stringify(value)})`);
  if (binding.ref !== undefined && (typeof binding.ref !== "string" || !binding.ref))
    throw bad(`bound with an empty ref (got ${JSON.stringify(value)})`);
  try {
    repoIdentity(binding.url);
  } catch (err) {
    throw new Error(
      `${where}: Repo Slot "${slot}" binds ${JSON.stringify(binding.url)}, which names no Repo — ` +
        `${err instanceof Error ? err.message : err} (ADR-0051).`,
    );
  }
}

/**
 * The static parts a `workspace()` wrapper carries (ADR-0049, ADR-0037, ADR-0051): what the
 * Sandbox is MADE of and which Repos it attaches. The images are NAMES in ADR-0037's two shapes — a
 * `file:` URL to a docker context the Machine's module ships, or a registry ref — and both resolve
 * to a concrete ref on the port's side, which is what keeps the Machine cluster-agnostic. The
 * Repos are Slots, each bound, open, or per-run.
 *
 * They are options rather than `WorkspaceSpec` fields because they are STATIC: `jr2 up` must find
 * them by walking the Machine, and a per-run spec is a function of run input that no walk can
 * evaluate.
 */
export type SandboxParts = {
  /** The Sandbox Image. Absent → the Instance's `images/default`, then the stock Harness. */
  image?: string;
  /** The User Container (ADR-0005): its image, or `{ image, resources }` when the Machine states
   * its split of the Size (ADR-0060). Absent → the pod has no third container. */
  user?: string | UserContainer;
  /** The Repo Slots, in declaration order — which the handles keep (ADR-0051) — or
   * {@link open} for a map the composer fills whole. */
  repos: Record<string, RepoSlot> | typeof open;
  /** The Size the Machine states (ADR-0060) — the `workspace()`'s, with any `customize()` layered
   * over it. Absent → the Instance's `sandbox.resources`, then the kit default. */
  resources?: Size;
  /** The Held secrets this Workspace's pod gets beside its Agents' model keys (ADR-0059): names of
   * the `secrets` list. Naming is placement — no other pod gets a name for being listed here. */
  secrets?: string[];
  /** The Sandbox Effector's image (ADR-0068). Absent → the Sandbox Image. */
  effector?: { image: string };
};

// The stamps below are written ON `machine.config` under `Symbol.for` keys, never held in a
// module-local WeakMap, for the reason `open` and `asMachine` give: an Instance resolves its OWN
// `@jr2/orchestrator`, and the installed CLI walks with ITS copy (ADR-0043) — a WeakMap the
// Instance's `workspace()` filled is one the CLI's `partsOf` never sees, and the walk then reports
// a Machine that composes no Sandbox: no Sandbox Image built, no cache agent converged, and a
// provision that parks on a mount nothing serves. `machine.config` is the key either way, because
// a `.provide()` clone shares it (ADR-0011) and a `customize()` clone re-stamps. A symbol property
// is invisible to `JSON.stringify` and `Object.keys`, so xstate and the fingerprint read past it.
const SANDBOX_PARTS: unique symbol = Symbol.for("jr2.sandbox.parts");
const WRAPPER_BODY: unique symbol = Symbol.for("jr2.wrapper.body");
type Stamped = { [SANDBOX_PARTS]?: SandboxParts; [WRAPPER_BODY]?: string };

/** Attach a wrapper's static Sandbox parts. jr2-internal: `workspace()` calls it. */
export function attachSandboxParts(machine: AnyStateMachine, parts: SandboxParts): void {
  (machine.config as Stamped)[SANDBOX_PARTS] = parts;
}

/** The Sandbox parts a Machine carries — no images and no slots for any Machine that is not a
 * `workspace()` wrapper, which is the honest answer: it composes no Sandbox. */
export function sandboxPartsOf(machine: AnyStateMachine | undefined): SandboxParts {
  return (machine?.config as Stamped | undefined)?.[SANDBOX_PARTS] ?? { repos: {} };
}

/** Does this Machine COMPOSE a Sandbox — i.e. is it a `workspace()` wrapper? Distinct from
 * `sandboxPartsOf(m)` naming no image: a wrapper that names neither image still owns the two
 * seats, which is what `customize({ image })` retunes (ADR-0049) — and it always carries at least
 * one Repo Slot (ADR-0051). Also the data-plane switch, read off the walk: an Instance needs
 * Sandboxes exactly when a registered Machine composes one. A logic with no `config` (an Effect's,
 * ADR-0067) composes none. */
export function composesSandbox(machine: AnyStateMachine): boolean {
  return (machine.config as Stamped | undefined)?.[SANDBOX_PARTS] !== undefined;
}

// The slot a jr2 WRAPPER is transparent to (ADR-0049): `workspace()`'s `body`, `pool()`'s
// `worker`. A wrapper owns Sandbox lifecycle or Source scheduling and carries no Agents of its
// own, so a composer who writes `customize(research, { agents: { researcher } })` means the
// Machine inside — and never has to know that jr2 wrapped it, or spell `body`.
//
// Recorded, not inferred: a slot named `body` is a name any author may choose, and routing a
// customize through it because of its spelling would retune a different Machine than the
// composer named. The wrappers stamp this the same way they stamp everything else a Machine
// carries — on `machine.config`, so a `provide()` clone and a `customize()` retune keep it, and
// under a `Symbol.for` key, so a second module copy reads it (see `SANDBOX_PARTS`).

/** Mark this Machine a jr2 wrapper over `slot`. jr2-internal: `workspace()`/`pool()` call it. */
export function attachWrapperBody(machine: AnyStateMachine, slot: string): void {
  (machine.config as Stamped)[WRAPPER_BODY] = slot;
}

/** The slot a jr2 wrapper is transparent to — undefined for every Machine an author wrote, which
 * is where a `customize()` stops descending and starts resolving. */
export function wrapperBodyOf(machine: AnyStateMachine): string | undefined {
  return (machine.config as Stamped)[WRAPPER_BODY];
}

declare const wrapperBody: unique symbol;

/**
 * The TYPE half of {@link attachWrapperBody}'s stamp: a jr2 wrapper's machine type SAYS which
 * Machine it is transparent to, so `customize()`'s types read the same record its runtime walk
 * reads (`wrapperBodyOf`) and the compiler's answer and the runtime's are one answer.
 *
 * Recorded here too, for the reason the runtime records it: a slot named `body` or `worker` is a
 * name any author may choose, so a type that routed a `customize()` through a slot's SPELLING
 * would offer the composer the Agents of a Machine they never named — and would deny the Agents
 * of the one they did, since the reach stops at a Machine that is not a wrapper. Only a wrapper
 * carries this marker, and only `workspace()` and `pool()` write it.
 *
 * Phantom: the property exists in the type alone. A wrapper's implementation returns a plain
 * machine and its overloads state this, exactly as the runtime stamp lives beside the object
 * rather than on it.
 */
export type JR2Wrapper<TBody extends AnyStateMachine> = { readonly [wrapperBody]: TBody };

declare const repoSlots: unique symbol;

/**
 * The TYPE half of a wrapper's Repo Slots (ADR-0051): a `workspace()`'s machine type SAYS which
 * slots it declared, so `customize()`'s `repos` offers exactly those keys and a slot the Machine
 * never declared is a compile error — read through `pool()`'s `worker` and `workspace()`'s
 * `body` the way the image seats are. Phantom, like {@link JR2Wrapper}: the property exists in the
 * type alone, and the runtime reads the same record off `sandboxPartsOf`.
 */
export type JR2Repos<TSlots extends string> = { readonly [repoSlots]: TSlots };

/**
 * The actor-slot union a jr2 wrapper declares, in xstate's own `ProvidedActor` shape. `workspace()`
 * and `pool()` name it in their return types beside {@link JR2Wrapper}, so the body's own slots are
 * readable THROUGH the wrapper and `customize()` can offer the composer the Agents of the Machine
 * inside (customize.ts) — the compile-time twin of the walk above.
 *
 * The mechanism actors ride along as `UnknownActorLogic`: they are named slots (Stately shows
 * `provision`, not `inline`) but nothing outside the wrapper substitutes them, so their logic
 * types buy nothing and would drag the port contracts into every consumer's inference.
 */
export type WrapperActors<TSlot extends string, TBody extends AnyStateMachine, TMechanism extends string> =
  | { src: TSlot; logic: TBody; id: string | undefined }
  | { src: TMechanism; logic: UnknownActorLogic; id: string | undefined };

/** One Agent a Machine carries: the SLOT KEY it is declared under (its name everywhere — the
 * Harness route, the minted iid, the markers) and the declaration that slot runs — Open model and
 * all (ADR-0054), because a converge that could not see an unbound Agent could not refuse it. */
export type CarriedAgent = { name: string; definition: AgentDeclaration };

/**
 * One docker context a Machine ships (ADR-0037's built origin) — a `file:` URL a module named with
 * `import.meta.resolve`, which is the only way an ES module can name a folder it owns.
 *
 * `dir` is that URL as a path, which is what `docker build` takes and what the content digest
 * covers. `name` is the directory's basename and is DECORATION — it rides the image tag so a human
 * reading `docker images` sees something better than a hash. The identity is the digest.
 */
export type CarriedImage = { url: string; dir: string; name: string };

/**
 * One Repo a Machine BINDS (ADR-0051) — the Binding as written, plus the identity every spelling
 * of one repository normalizes to and the key the cluster addresses its cache by (repo-identity.ts).
 * Deduped by identity: two Machines spelling one repository two ways are one Repo, and the first
 * spelling in walk order is the one the CR is created with.
 */
export type CarriedRepo = { url: string; ref?: string; identity: string; key: string };

/**
 * A part left OPEN on a registered Machine — a Repo Slot with no url (ADR-0051), an Agent with no
 * model (ADR-0054) — and what `jr2 up` refuses, before anything is built, naming the Machine, the
 * slot, and the `customize` line that binds it. One shape for both, because a composer fixes both
 * the same way and the walk locates both the same way.
 *
 * The Machine is named by WHERE it sits, not by its xstate id: `path` is the chain of actor-slot
 * keys a `customize()` of the registered root walks to reach the `workspace()` that declares the
 * slot — `[]` when the root is that wrapper, `["review"]` for a Machine composed under `actors:
 * { review }`. It is exactly the `actors:` nesting of the fix line ({@link customizeLine}), so
 * jr2's transparent wrappers (`workspace()`'s `body`, `pool()`'s `worker`) are omitted from it as
 * `customize()` omits them. `undefined` when the wrapper was reached through a Machine invoked
 * INLINE (a machine object written straight onto `invoke.src`): an actor with no slot key is one
 * no `customize()` can name, so no line binds that slot — declaring it under `setup({ actors })`
 * does.
 *
 * `slot` is `undefined` for a `workspace()` that declared its whole map Open (`repos: open`,
 * ADR-0051): there is no slot to name, because naming the slots is what the composer does.
 */
export type OpenSlot = { slot: string | undefined; path: readonly string[] | undefined };

/**
 * One hop of a placement route (ADR-0059, ADR-0068): the `actors` slot key a child is invoked by,
 * or — for a plain child Machine written INLINE on a state's invoke — xstate's generated invoke
 * src for that hop (`xstate.invoke.<index>.<state id>`), which the static walk computes from the
 * state node and the run reads off the live child. An inline hop is an object, so it can never
 * equal a slot key.
 */
export type RouteHop = string | { readonly inline: string };

/**
 * Where a placement sits: the chain of hops from the registered root down to it, a wrapper's
 * transparent body skipped as {@link OpenSlot}'s `path` skips it. Unlike `path`, a route goes on
 * past an inline Machine, so every placement — a Workspace's pod, an Effect — has a route of its
 * own, and the pod keys of two Workspaces never collide. Where `path` is defined the route is that
 * same list of slot keys, so a pod key reached by slot keys alone is what it was.
 */
export type PlacementRoute = readonly RouteHop[];

/** The hop xstate gives the `index`-th invoke of state node `stateId` when its `src` is inline. */
export const inlineHop = (index: number, stateId: string): RouteHop => ({
  inline: `xstate.invoke.${index}.${stateId}`,
});

/** A route as a human reads it, for a label: ` → "review"`, ` → invoked inline in state "w.a"`. */
export function routeText(route: PlacementRoute): string {
  return route
    .map((hop) =>
      typeof hop === "string"
        ? ` → "${hop}"`
        : ` → invoked inline in state "${hop.inline.replace(/^xstate\.invoke\.\d+\./, "")}"`,
    )
    .join("");
}

/** Which kind of Open part a fix line binds — a Repo Slot (`repos`, ADR-0051), an Agent's model
 * (`agents`, ADR-0054), or an Effect's url or argv (`effects`, ADR-0054). */
export type OpenPart = "repo" | "agent" | OpenEffectPart;

/**
 * The `customize` line that binds an Open part, given the identifier the composer holds the
 * registered Machine by: `customize(codeReview, { repos: { target: "<url>" } })` for a part on the
 * root, nested through `actors` for one on a composed Machine —
 * `customize(top, { actors: { review: { repos: { target: "<url>" } } } })`. The same nesting
 * `customize()` accepts, so the line pastes.
 *
 * An Agent binds through `agents` instead, and the placeholder is the model spelling ADR-0018
 * demands — `<provider>/<model>`, not a bare model id, since the prefix is what picks the
 * endpoint. An Effect binds through `effects`: its url, or its argv (open-effect.ts). `repo` is the
 * default because a Repo Slot was the first Open part and reads as the
 * unmarked case. An Open MAP has no slot to print (`slot` undefined): the placeholder `<slot>`
 * stands where the composer's own word goes, since choosing it is the composer's half of the line.
 */
export function customizeLine(
  machine: string,
  path: readonly string[],
  slot: string | undefined,
  part: OpenPart = "repo",
): string {
  const binds =
    part === "agent"
      ? `{ agents: { ${slot}: { model: "<provider>/<model>" } } }`
      : part === "url" || part === "argv"
        ? effectBindingLine(slot ?? "<slot>", part)
        : `{ repos: { ${slot ?? "<slot>"}: "<url>" } }`;
  const inner = path.reduceRight((parts, key) => `{ actors: { ${key}: ${parts} } }`, binds);
  return `customize(${machine}, ${inner})`;
}

/**
 * The runtime twin of the walk's `path`: the actor-slot chain from a run's root actor down to
 * `actor` (its own `src` included), read off the live actor tree — each `src` is the slot key it
 * was invoked or spawned as, and a wrapper's transparent body is skipped by the same record
 * ({@link wrapperBodyOf}) the walk skips it by. `undefined` past an inline-invoked actor, as the
 * walk's `path` is: such an actor names no slot. xstate gives an inline `invoke.src` a generated
 * string (`xstate.invoke.<n>.<state id>`) that is no key of its parent's `actors`, so the test is
 * that registry, not the type of `src`; inline logic passed to `spawn` keeps the logic as `src`.
 */
export function actorSlotPath(actor: AnyActorRef | undefined): string[] | undefined {
  const path: string[] = [];
  for (let node = actor; node?._parent; node = node._parent) {
    const src = (node as { src?: unknown }).src;
    if (typeof src !== "string") return undefined;
    const parent = asMachine((node._parent as { logic?: unknown }).logic);
    if (parent && !Object.hasOwn(parent.implementations.actors, src)) return undefined;
    if (!parent || wrapperBodyOf(parent) !== src) path.unshift(src);
  }
  return path;
}

/**
 * The runtime twin of the walk's `route` (ADR-0059): the placement route from a run's root actor
 * down to `actor`, read off the live actor tree. A child invoked by a slot key adds that key, as
 * {@link actorSlotPath} does; a plain Machine invoked inline adds xstate's generated src as an
 * inline hop, which the walk computes from the state node — so `jr2 up` and the provision derive
 * one pod key. Never undefined: an actor the walk cannot see — a Machine object handed to
 * `spawnChild`, whose `src` is the logic itself — is refused with the slot form.
 */
export function actorRoute(actor: AnyActorRef | undefined): RouteHop[] {
  const route: RouteHop[] = [];
  for (let node = actor; node?._parent; node = node._parent) {
    const src = (node as { src?: unknown }).src;
    const parent = asMachine((node._parent as { logic?: unknown }).logic);
    if (typeof src === "string" && (!parent || Object.hasOwn(parent.implementations.actors, src))) {
      if (!parent || wrapperBodyOf(parent) !== src) route.unshift(src);
    } else if (typeof src === "string" && /^xstate\.invoke\.\d+\./.test(src)) {
      route.unshift({ inline: src });
    } else {
      throw new Error(
        `actor "${node.id}" was spawned from a logic object, which no walk can see, so jr2 up placed nothing ` +
          "for what it composes — a Part is reached through keys of actors, so it has a name that the ledger, " +
          'the report and customize() share: actors: { <name>: <machine> }, then spawnChild("<name>") (ADR-0059)',
      );
    }
  }
  return route;
}

/**
 * One `workspace()` a Machine composes, and the Size it states (ADR-0060) — what `jr2 up` resolves
 * against the Instance default and splits, so a split that leaves the Harness below its floor is
 * refused at the converge rather than at the first provision, and a Size no Sandbox node could hold
 * is warned about. Located like an {@link OpenSlot}: `path` is the `customize()` route to it.
 */
export type CarriedSize = {
  path: readonly string[] | undefined;
  /** The placement route to it (ADR-0059). */
  route: PlacementRoute;
  /** The Machine's Size, as stated; absent when it states none. */
  resources?: Size;
  /** The User Container's split, as stated; absent when it states none. */
  user?: Size;
};

/** One Effect slot a Machine carries (ADR-0067), by its slot key and the `customize()` route to its
 * Machine, with the plain data `jr2 up` prints: the kind, where it runs, a command's argv (an argv
 * slot reads `<name>`), its timeout, and the Repo Slot whose Worktree is its cwd, when it names one.
 * `open` names the part a package left Open (ADR-0054) — an http or upload url, which then has no
 * target yet, or a command's argv, which reads `<open>` — and the walk reports it for `jr2 up` to
 * refuse; once `customize()` binds it, the slot carries the bound Effect and `open` is absent. */
export type CarriedEffect = {
  name: string;
  path: readonly string[] | undefined;
  /** The placement route to its Machine (ADR-0068): what its placement key reads, never `path`. */
  route: PlacementRoute;
  placement: Placement;
  timeoutMs: number;
} &
  /** A command; one whose env names a secret runs in the Sandbox Effector (ADR-0067). */
  (| { kind: "command"; argv: string[]; slot?: string; secrets?: string[]; pin?: true; open?: "argv" }
    /** An http Effect (ADR-0068): its method, its fixed target, and the secrets it names — what
     * places each secret, and what its Effector's config allows. `file`: its body is a Worktree
     * file (ADR-0067), so it runs in its Workspace's Sandbox Effector, on Repo Slot `slot` when named.
     * An Open url has no target, and names only the secrets its headers and auth name. */
    | {
        kind: "http";
        method: string;
        target?: { scheme: "http" | "https"; host: string; port: number };
        secrets: string[];
        idempotent: boolean;
        file?: true;
        slot?: string;
        open?: "url";
      }
    /** A push (ADR-0067, ADR-0051): the Workspace's branch to its Repo Slot's Binding. It names no
     * secret: `jr2 up` resolves its credential through `git.credentials`. */
    | { kind: "push"; slot?: string; sign: boolean; squash: boolean; force: boolean; pin: boolean; secrets: string[] }
  );

/** Everything the registered Machines carry that a converge or a boot must act on. */
export type CarriedParts = {
  agents: CarriedAgent[];
  /** Every Effect slot, in walk order — one per Machine and slot key, at the first route the walk
   * reached its Machine by. The placement reads {@link placedEffectsOf}: one per route. */
  effects: CarriedEffect[];
  images: CarriedImage[];
  /** Every bound Repo, deduped by identity, in walk order. */
  repos: CarriedRepo[];
  /** Every open Repo Slot, in walk order — non-empty is a converge refusal. An Open MAP
   * (`repos: open`) is one entry with no `slot`. */
  openSlots: OpenSlot[];
  /** Every Agent whose model is still Open (ADR-0054), in walk order — the same refusal, by the
   * same route, and the reason these are two lists rather than one: the fix lines differ. */
  openAgents: OpenSlot[];
  /** Every Effect whose url or argv is still Open (ADR-0054), in walk order — the same refusal, by
   * the same route; `part` says which line binds it. */
  openEffects: Array<OpenSlot & { part: OpenEffectPart }>;
  /** Every `workspace()` reached, with the Size it states, in walk order (ADR-0060). */
  sizes: CarriedSize[];
  /** Whether any Machine reached, at any depth, composes a Sandbox — the data-plane switch. */
  composesSandbox: boolean;
};

/** A machine actor, told apart from a promise/callback/observable one by having a state tree.
 * Structural on purpose: an Instance resolves its OWN `@jr2/orchestrator`, so the CLI's walk and a
 * workflow's machines may come from two module instances and no `instanceof` can hold. */
export function asMachine(logic: unknown): AnyStateMachine | undefined {
  return (logic as AnyStateMachine | undefined)?.root ? (logic as AnyStateMachine) : undefined;
}

/** Every machine object written INLINE on one state's invokes, with the hop xstate gives it (its
 * generated src, from the invoke's index on the state). A named `src` resolves through
 * `implementations.actors` instead and is walked there. */
function inlineMachines(node: StateNode<any, any>): Array<{ machine: AnyStateMachine; hop: RouteHop }> {
  const config = [node.config.invoke ?? []].flat() as Array<{ src?: unknown }>;
  return config.flatMap((inv, index) => {
    const machine = asMachine(inv?.src);
    return machine ? [{ machine, hop: inlineHop(index, node.id) }] : [];
  });
}

/**
 * Refuse a Part written inline on an `invoke.src` — an `agent()`, an Effect or a `workspace()` that
 * is no key of the Machine's `actors` (see the module comment). Thrown at build by
 * `jr2Setup.createMachine` and at load by {@link partsOf}, so a Machine built with xstate's own
 * `createMachine` is refused where `jr2 up` and the Orchestrator read it. A plain child Machine
 * written inline is not a Part: it stays walked, with no `customize()` route (its `path` is
 * `undefined`).
 */
export function refuseInlineParts(machine: AnyStateMachine): void {
  const partOf = (src: unknown): { part: string; written: string } | undefined => {
    if (isAgent(src)) return { part: "an Agent", written: "agent(...)" };
    if (isEffect(src)) return { part: "an Effect", written: `${src.effect.kind}(...)` };
    const child = asMachine(src);
    if (child && composesSandbox(child)) return { part: "a Workspace", written: "workspace(...)" };
    return undefined;
  };
  const visit = (node: StateNode<any, any>): void => {
    for (const inv of [node.config.invoke ?? []].flat() as Array<{ src?: unknown }>) {
      const found = partOf(inv?.src);
      if (found === undefined) continue;
      throw new Error(
        `machine "${machine.id}": state "${node.id}" invokes ${found.part} inline — a Part is a key of actors, so ` +
          `it has a name that the ledger, the report and customize() share: actors: { <name>: ${found.written} }, ` +
          `then invoke: { src: "<name>" }`,
      );
    }
    for (const child of Object.values(node.states as Record<string, StateNode<any, any>>)) visit(child);
  };
  visit(machine.root);
}

/** `JSON.stringify` with object keys sorted at every depth — a value's identity, not its spelling.
 * Symbols are spelled out rather than dropped: `JSON.stringify` silently omits a symbol-valued
 * key, which would make an Open Agent (ADR-0054) collapse into a bound one that differs in nothing
 * but its model. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "symbol"
      ? v.toString()
      : v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, (v as Record<string, unknown>)[k]]),
          )
        : v,
  );
}

/**
 * Everything the given Machines carry, themselves and through the Machines they compose — deduped,
 * in walk order.
 *
 * Two Machines in one instance may each carry a `coder`, and if their definitions differ BOTH are
 * reported: they are two Agents that share a slot key, which is exactly what ADR-0049 made legal
 * and what a flat roster could not hold. Identical ones collapse, so a definition value shared by
 * three Machines is preflighted once — and so is one docker context two Workspaces name.
 */
export function partsOf(machines: Iterable<AnyStateMachine>): CarriedParts {
  const agents: CarriedAgent[] = [];
  const effects: CarriedEffect[] = [];
  const images: CarriedImage[] = [];
  const repos: CarriedRepo[] = [];
  const openSlots: OpenSlot[] = [];
  const openAgents: OpenSlot[] = [];
  const openEffects: CarriedParts["openEffects"] = [];
  const sizes: CarriedSize[] = [];
  let sandboxed = false;
  const seen = new Set<string>();
  // Cycle guard AND work saver: a Machine reached twice carries the same parts both times, and a
  // Machine that composes itself is legal (a recursive pool worker) but not walkable twice.
  const walked = new Set<AnyStateMachine>();

  const collectAgent = (path: OpenSlot["path"], name: string, definition: AgentDeclaration): void => {
    // Keyed on the PAIR, serialized whole: a separator character inside a template literal is
    // either ambiguous (a slot key may contain it) or, if chosen for being impossible, a control
    // byte that makes this module binary to git — invisible to diff, blame and grep, forever.
    // Serialized CANONICALLY (keys sorted at every depth): two structurally equal definitions
    // written in a different key order are one Agent, and must collapse to one preflight.
    const key = canonical(["agent", name, definition]);
    if (seen.has(key)) return;
    seen.add(key);
    agents.push({ name, definition });
    // Reported, not withheld: the Agent is still carried (a `workspace: "none"` one still
    // converges the Instance Harness), and it is the converge's job to refuse it by name —
    // `jr2 up`'s preflight simply has no model to probe for it (ADR-0054).
    if (isOpenAgent(definition)) openAgents.push({ slot: name, path });
  };

  // Only the BUILT origin is collected: a registry ref is deployed-never-built, so there is
  // nothing for a converge to do with it (ADR-0037/0039 — what jr2 did not stamp, jr2 does not
  // touch). Both image seats ride the same rule, because ADR-0005 gives the User Container the
  // same two origins and the same resolution.
  const collectImage = (url: string | undefined): void => {
    if (url === undefined || !isImageContext(url)) return;
    const key = canonical(["image", url]);
    if (seen.has(key)) return;
    seen.add(key);
    const dir = fileURLToPath(url);
    images.push({ url, dir, name: basename(dir) });
  };

  // Keyed on the IDENTITY, not the spelling (ADR-0051): `git@github.com:acme/app.git` and
  // `https://github.com/acme/app` are one Repo and one cache, so they collapse to one entry — the
  // first spelling wins, and it is the url the CR is created with. A per-run slot contributes
  // nothing, and an open one is reported for the converge to refuse — as is an Open map, which
  // has no slot to report and is refused by the same route.
  const collectRepos = (path: OpenSlot["path"], slots: SandboxParts["repos"]): void => {
    if (slots === open) {
      openSlots.push({ slot: undefined, path });
      return;
    }
    for (const [slot, value] of Object.entries(slots)) {
      const state = repoSlotState(value);
      if (state.kind === "open") openSlots.push({ slot, path });
      if (state.kind !== "bound") continue;
      const { identity, key } = repoIdentity(state.binding.url);
      const dedupe = canonical(["repo", identity]);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      repos.push({ ...state.binding, identity, key });
    }
  };

  // `path` is the `customize()` route from the registered root to `machine` (see `OpenSlot`):
  // a named child slot extends it, a wrapper's transparent body does not, and an inline invoke
  // ends it — nothing downstream of an actor without a slot key can be named by a composer.
  // `route` is the placement route, which an inline invoke extends by its hop (`PlacementRoute`).
  const walk = (machine: AnyStateMachine, path: OpenSlot["path"], route: PlacementRoute): void => {
    if (walked.has(machine)) return;
    walked.add(machine);
    refuseInlineParts(machine);
    const parts = sandboxPartsOf(machine);
    const user = userSeatOf(parts.user);
    collectImage(parts.image);
    collectImage(user.image);
    collectImage(parts.effector?.image);
    if (composesSandbox(machine)) {
      sandboxed = true;
      collectRepos(path, parts.repos);
      sizes.push({
        path,
        route,
        ...(parts.resources !== undefined ? { resources: parts.resources } : {}),
        ...(user.resources !== undefined ? { user: user.resources } : {}),
      });
    }
    const body = wrapperBodyOf(machine);
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      if (isAgent(logic)) collectAgent(path, name, logic.definition);
      else if (isEffect(logic)) {
        const effect = carriedEffectOf(name, path, route, logic.effect);
        effects.push(effect);
        if (effect.kind !== "push" && effect.open !== undefined)
          openEffects.push({ slot: name, path, part: effect.open });
      } else {
        const child = asMachine(logic);
        if (child) walk(child, slotPath(path, name, body), name === body ? route : [...route, name]);
      }
    }
    walkStates(machine.root, (inline, hop) => walk(inline, undefined, [...route, hop]));
  };

  for (const machine of machines) walk(machine, [], []);
  return { agents, effects, images, repos, openSlots, openAgents, openEffects, sizes, composesSandbox: sandboxed };
}

/** The `customize()` route to a child of slot `name`: a wrapper's body does not extend it. */
function slotPath(path: OpenSlot["path"], name: string, body: string | undefined): OpenSlot["path"] {
  return path === undefined ? undefined : name === body ? path : [...path, name];
}

/**
 * Every Effect the registered Machine `root` places, at every route it is reached by — one entry
 * per route, as {@link workspacePodsOf} lists pods: a Machine invoked under two slot keys places
 * its Effects twice, and each is checked where it is. What the placement walk reads (ADR-0068),
 * never {@link partsOf}'s list, which holds one entry per Machine. A cycle (a recursive pool
 * worker) stops at the Machine on its own route.
 */
export function placedEffectsOf(root: AnyStateMachine): CarriedEffect[] {
  const effects: CarriedEffect[] = [];
  const walk = (
    machine: AnyStateMachine,
    path: OpenSlot["path"],
    route: PlacementRoute,
    on: Set<AnyStateMachine>,
  ): void => {
    if (on.has(machine)) return;
    on.add(machine);
    const body = wrapperBodyOf(machine);
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      if (isAgent(logic)) continue;
      if (isEffect(logic)) {
        effects.push(carriedEffectOf(name, path, route, logic.effect));
        continue;
      }
      const child = asMachine(logic);
      if (child) walk(child, slotPath(path, name, body), name === body ? route : [...route, name], on);
    }
    walkStates(machine.root, (inline, hop) => walk(inline, undefined, [...route, hop], on));
    on.delete(machine);
  };
  walk(root, [], [], new Set());
  return effects;
}

/** One Effect slot's plain data, as `jr2 up` and the placement read it. */
export function carriedEffectOf(
  name: string,
  path: OpenSlot["path"],
  route: PlacementRoute,
  parts: EffectParts,
): CarriedEffect {
  const placement = placementOf(parts);
  if (parts.kind === "http") {
    return {
      name,
      path,
      route,
      kind: "http",
      placement,
      method: parts.method,
      ...(parts.target === open ? { open: "url" as const } : { target: { ...parts.target } }),
      secrets: [...parts.secrets],
      idempotent: parts.idempotent,
      timeoutMs: parts.timeoutMs,
      ...(parts.file ? { file: true as const } : {}),
      ...(parts.file?.slot !== undefined ? { slot: parts.file.slot } : {}),
    };
  }
  if (parts.kind === "push") {
    const { sign, squash, force, pin, timeoutMs, slot } = parts;
    return {
      name,
      path,
      route,
      kind: "push",
      placement,
      sign,
      squash,
      force,
      pin,
      secrets: [],
      timeoutMs,
      ...(slot !== undefined ? { slot } : {}),
    };
  }
  const { argv, timeoutMs, slot, secrets, pin } = parts;
  return {
    name,
    path,
    route,
    kind: "command",
    placement,
    argv: argvText(argv),
    timeoutMs,
    ...(slot !== undefined ? { slot } : {}),
    ...(secrets?.length ? { secrets: [...secrets] } : {}),
    ...(pin ? { pin } : {}),
    ...(argv === open ? { open: "argv" as const } : {}),
  };
}

/**
 * One Workspace a Machine composes, as its pod's Held secrets are placed (ADR-0059): what the pod
 * names. Located like a {@link CarriedSize} — `path` is the `customize()` route to its
 * `workspace()`, and `route` its placement route, the same route the run host reads off the live
 * actor at provision (`actorRoute`), so `jr2 up` and the provision name one pod alike.
 */
export type WorkspacePod = {
  path: readonly string[] | undefined;
  /** The pod's placement route: what its pod key reads (`workspaceHeldPod`). */
  route: PlacementRoute;
  /** The `workspace()`'s own `secrets: [...]`, as written. */
  secrets: string[];
  /** The model of every bound Agent whose Turn runs in this pod: each Agent below the
   * `workspace()` that is not `workspace: "none"` (those run at the Instance Harness, ADR-0031),
   * down to the next `workspace()`, which is a pod of its own. Sorted, deduped. */
  models: string[];
  /** The Effects placed in this pod's Sandbox Effector (ADR-0068): every `push`, file-body `http` and
   * credentialed `command` slot below the `workspace()`, down to the next `workspace()` — read off
   * their plain data, statically. Empty → the pod gets no Sandbox Effector and no Secret. */
  effects: CarriedEffect[];
  /** The `workspace()`'s `effector: { image }`, as written. Absent → the Sandbox Image. */
  effector?: { image: string };
  /** The `workspace()`'s own `image`, as written — its Sandbox Image. Absent → `images/default`,
   * then the stock Harness (ADR-0037). */
  image?: string;
  /** Each Repo Slot's Binding url as the Machine binds it, by slot, in order; undefined for an open
   * or per-run slot, whose url `jr2 up` cannot read. A push resolves its credential through it. */
  bindings: Record<string, string | undefined>;
};

/**
 * Every Workspace a Machine composes, at every route it is reached by — one entry per route, so a
 * `workspace()` composed under two slot keys is two pods. Not deduped like {@link partsOf}: a pod
 * is a route, not a Machine. A cycle (a recursive pool worker) stops at the Machine on its own
 * route.
 */
export function workspacePodsOf(root: AnyStateMachine): WorkspacePod[] {
  const pods: WorkspacePod[] = [];
  /** The bound models of the Agents in `machine` and the Machines it composes, short of a
   * `workspace()`. */
  const modelsIn = (
    machine: AnyStateMachine,
    models: Set<string>,
    on: Set<AnyStateMachine>,
    effects: Map<string, CarriedEffect>,
    path: OpenSlot["path"],
    route: PlacementRoute,
  ): void => {
    if (on.has(machine)) return;
    on.add(machine);
    const body = wrapperBodyOf(machine);
    const visit = (child: AnyStateMachine, at: OpenSlot["path"], to: PlacementRoute) => {
      if (!composesSandbox(child)) modelsIn(child, models, on, effects, at, to);
    };
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      if (isAgent(logic)) {
        const { model, workspace } = logic.definition;
        if (workspace !== "none" && typeof model === "string") models.add(model);
        continue;
      }
      if (isEffect(logic)) {
        const effect = carriedEffectOf(name, path, route, logic.effect);
        if (effect.placement === "sandbox") effects.set(JSON.stringify([route, name]), effect);
        continue;
      }
      const child = asMachine(logic);
      if (child) visit(child, slotPath(path, name, body), name === body ? route : [...route, name]);
    }
    walkStates(machine.root, (inline, hop) => visit(inline, undefined, [...route, hop]));
    on.delete(machine);
  };
  const walk = (
    machine: AnyStateMachine,
    path: OpenSlot["path"],
    route: PlacementRoute,
    on: Set<AnyStateMachine>,
  ): void => {
    if (on.has(machine)) return;
    on.add(machine);
    if (composesSandbox(machine)) {
      const models = new Set<string>();
      const effects = new Map<string, CarriedEffect>();
      modelsIn(machine, models, new Set(), effects, path, route);
      const parts = sandboxPartsOf(machine);
      const bindings: Record<string, string | undefined> = {};
      if (parts.repos !== open) {
        for (const [slot, value] of Object.entries(parts.repos)) {
          const state = repoSlotState(value);
          bindings[slot] = state.kind === "bound" ? state.binding.url : undefined;
        }
      }
      pods.push({
        path,
        route,
        secrets: [...(parts.secrets ?? [])],
        models: [...models].sort(),
        effects: [...effects.values()],
        ...(parts.effector ? { effector: { ...parts.effector } } : {}),
        ...(parts.image !== undefined ? { image: parts.image } : {}),
        bindings,
      });
    }
    const body = wrapperBodyOf(machine);
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      const child = isAgent(logic) || isEffect(logic) ? undefined : asMachine(logic);
      if (child) walk(child, slotPath(path, name, body), name === body ? route : [...route, name], on);
    }
    walkStates(machine.root, (inline, hop) => walk(inline, undefined, [...route, hop], on));
    on.delete(machine);
  };
  walk(root, [], [], new Set());
  return pods;
}

/** Every machine object written inline below `node`, at any depth of its state tree, with its hop. */
function walkStates(node: StateNode<any, any>, visit: (machine: AnyStateMachine, hop: RouteHop) => void): void {
  for (const { machine, hop } of inlineMachines(node)) visit(machine, hop);
  for (const child of Object.values(node.states as Record<string, StateNode<any, any>>)) walkStates(child, visit);
}
