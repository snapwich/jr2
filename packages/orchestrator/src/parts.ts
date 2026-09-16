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
//     (ADR-0054) — is refused before anything is built, and whether any registered Machine
//     composes a Sandbox at all is the data-plane switch. None of these can read
//     an invoke's `input` (it is a function — dials are not statically recoverable), and none
//     needs to: identity lives in the definition, the image and the slots are options, and all are
//     values ON the Machine. A per-run slot is a function too, and the walk reports nothing for
//     it: which Repo it binds is the run's business, and the fence at attach is its check.
//
// The walk is STRUCTURAL, and it descends by the same two mechanisms composition uses:
//
//   - `implementations.actors` — every slot a `setup()`/`j2Setup()` machine declares, whether or
//     not a state invokes it. An Agent slot is recognized by its brand (`isAgent`), a child
//     Machine by having a state tree. That covers an imported Machine invoked as a child,
//     `workspace()`'s `body`, and `pool()`'s `worker` — all named slots since ADR-0049.
//   - inline invoked machines — a machine object written straight onto an `invoke.src`, which
//     xstate rewrites to a generated key and keeps only on the raw config node. Nothing j2 owns
//     arrives this way any more; the walk keeps it because an AUTHOR may still write one.
//
// Deliberately NOT a `provide()`-aware read: the walk runs on the registered Machine, which is the
// object the run will start, so a `customize()` clone is walked as itself and a test seam's fake
// (unbranded) contributes nothing.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyActorRef, AnyStateMachine, StateNode, UnknownActorLogic } from "xstate";
import { isAgent, isOpenAgent, type AgentDeclaration } from "./agent.ts";
import { isImageContext } from "./images.ts";
import { open } from "./open.ts";
import { repoIdentity } from "./repo-identity.ts";

// --- Repo Slots (ADR-0051) ---------------------------------------------------------------------
// A `workspace()` names each Repo it attaches under a SLOT — the Machine's own word for it, the
// key of the body's `workspace.repos` handles, and the directory under `/work`. The slot's VALUE
// is one of three states, and the walk tells them apart without evaluating anything. A Machine
// whose body names no slot — it works in `workdir` and reads whatever else is attached — declares
// the whole MAP Open instead (`repos: open`): the composer names every slot, and the first is the
// workdir. Open at the map is the same word as Open at a slot, one level up (CONTEXT.md).

// The sentinel itself lives in open.ts, a module with nothing else in it: since ADR-0054 it marks
// an Agent's model too, and agent.ts must read it without importing this file (the walk imports
// agent.ts, not the other way round). Re-exported here because a Repo Slot is where a composer
// meets it first, and `import { open } from "@j2/orchestrator"` is the only spelling anyone writes.
export { open } from "./open.ts";

/** What a Repo Slot resolves to (CONTEXT.md "Binding"): the url, and the base the branch
 * Worktree is cut from — absent, the Repo's own default branch. */
export type Binding = { url: string; ref?: string };

/**
 * One Repo Slot's value: BOUND (a url, or `{ url, ref? }`), OPEN (the {@link open} sentinel —
 * someone downstream binds it), or PER-RUN (a mapper over the wrapper's door, so a run input — a
 * ticket field — decides). Bound and open are what `j2 up` can see; per-run is the run's business,
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
 * carry — and to what a prompt can name without quoting. It starts with a LETTER: the slots are
 * read in declaration order (the first is the body's `workdir`), and JS puts an integer-like key
 * such as `"1"` ahead of every other key in `Object.keys`, wherever the author wrote it. */
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
 * They are options rather than `WorkspaceSpec` fields because they are STATIC: `j2 up` must find
 * them by walking the Machine, and a per-run spec is a function of run input that no walk can
 * evaluate.
 */
export type SandboxParts = {
  /** The Sandbox Image. Absent → the Instance's `images/default`, then the stock Harness. */
  image?: string;
  /** The User Container's image (ADR-0005). Absent → the pod has no third container. */
  user?: string;
  /** The Repo Slots, in declaration order — the first is the body's `workdir` (ADR-0051) — or
   * {@link open} for a map the composer fills whole. */
  repos: Record<string, RepoSlot> | typeof open;
};

// The stamps below are written ON `machine.config` under `Symbol.for` keys, never held in a
// module-local WeakMap, for the reason `open` and `asMachine` give: an Instance resolves its OWN
// `@j2/orchestrator`, and the installed CLI walks with ITS copy (ADR-0043) — a WeakMap the
// Instance's `workspace()` filled is one the CLI's `partsOf` never sees, and the walk then reports
// a Machine that composes no Sandbox: no Sandbox Image built, no cache agent converged, and a
// provision that parks on a mount nothing serves. `machine.config` is the key either way, because
// a `.provide()` clone shares it (ADR-0011) and a `customize()` clone re-stamps. A symbol property
// is invisible to `JSON.stringify` and `Object.keys`, so xstate and the fingerprint read past it.
const SANDBOX_PARTS: unique symbol = Symbol.for("j2.sandbox.parts");
const WRAPPER_BODY: unique symbol = Symbol.for("j2.wrapper.body");
type Stamped = { [SANDBOX_PARTS]?: SandboxParts; [WRAPPER_BODY]?: string };

/** Attach a wrapper's static Sandbox parts. j2-internal: `workspace()` calls it. */
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
 * Sandboxes exactly when a registered Machine composes one. */
export function composesSandbox(machine: AnyStateMachine): boolean {
  return (machine.config as Stamped)[SANDBOX_PARTS] !== undefined;
}

// The slot a j2 WRAPPER is transparent to (ADR-0049): `workspace()`'s `body`, `pool()`'s
// `worker`. A wrapper owns Sandbox lifecycle or Source scheduling and carries no Agents of its
// own, so a composer who writes `customize(research, { agents: { researcher } })` means the
// Machine inside — and never has to know that j2 wrapped it, or spell `body`.
//
// Recorded, not inferred: a slot named `body` is a name any author may choose, and routing a
// customize through it because of its spelling would retune a different Machine than the
// composer named. The wrappers stamp this the same way they stamp everything else a Machine
// carries — on `machine.config`, so a `provide()` clone and a `customize()` retune keep it, and
// under a `Symbol.for` key, so a second module copy reads it (see `SANDBOX_PARTS`).

/** Mark this Machine a j2 wrapper over `slot`. j2-internal: `workspace()`/`pool()` call it. */
export function attachWrapperBody(machine: AnyStateMachine, slot: string): void {
  (machine.config as Stamped)[WRAPPER_BODY] = slot;
}

/** The slot a j2 wrapper is transparent to — undefined for every Machine an author wrote, which
 * is where a `customize()` stops descending and starts resolving. */
export function wrapperBodyOf(machine: AnyStateMachine): string | undefined {
  return (machine.config as Stamped)[WRAPPER_BODY];
}

declare const wrapperBody: unique symbol;

/**
 * The TYPE half of {@link attachWrapperBody}'s stamp: a j2 wrapper's machine type SAYS which
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
export type J2Wrapper<TBody extends AnyStateMachine> = { readonly [wrapperBody]: TBody };

declare const repoSlots: unique symbol;

/**
 * The TYPE half of a wrapper's Repo Slots (ADR-0051): a `workspace()`'s machine type SAYS which
 * slots it declared, so `customize()`'s `repos` offers exactly those keys and a slot the Machine
 * never declared is a compile error — read through `pool()`'s `worker` and `workspace()`'s
 * `body` the way the image seats are. Phantom, like {@link J2Wrapper}: the property exists in the
 * type alone, and the runtime reads the same record off `sandboxPartsOf`.
 */
export type J2Repos<TSlots extends string> = { readonly [repoSlots]: TSlots };

/**
 * The actor-slot union a j2 wrapper declares, in xstate's own `ProvidedActor` shape. `workspace()`
 * and `pool()` name it in their return types beside {@link J2Wrapper}, so the body's own slots are
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
 * model (ADR-0054) — and what `j2 up` refuses, before anything is built, naming the Machine, the
 * slot, and the `customize` line that binds it. One shape for both, because a composer fixes both
 * the same way and the walk locates both the same way.
 *
 * The Machine is named by WHERE it sits, not by its xstate id: `path` is the chain of actor-slot
 * keys a `customize()` of the registered root walks to reach the `workspace()` that declares the
 * slot — `[]` when the root is that wrapper, `["review"]` for a Machine composed under `actors:
 * { review }`. It is exactly the `actors:` nesting of the fix line ({@link customizeLine}), so
 * j2's transparent wrappers (`workspace()`'s `body`, `pool()`'s `worker`) are omitted from it as
 * `customize()` omits them. `undefined` when the wrapper was reached through a Machine invoked
 * INLINE (a machine object written straight onto `invoke.src`): an actor with no slot key is one
 * no `customize()` can name, so no line binds that slot — declaring it under `setup({ actors })`
 * does.
 *
 * `slot` is `undefined` for a `workspace()` that declared its whole map Open (`repos: open`,
 * ADR-0051): there is no slot to name, because naming the slots is what the composer does.
 */
export type OpenSlot = { slot: string | undefined; path: readonly string[] | undefined };

/** Which kind of Open part a fix line binds — the two `customize()` keys (ADR-0051, ADR-0054). */
export type OpenPart = "repo" | "agent";

/**
 * The `customize` line that binds an Open part, given the identifier the composer holds the
 * registered Machine by: `customize(codeReview, { repos: { target: "<url>" } })` for a part on the
 * root, nested through `actors` for one on a composed Machine —
 * `customize(top, { actors: { review: { repos: { target: "<url>" } } } })`. The same nesting
 * `customize()` accepts, so the line pastes.
 *
 * An Agent binds through `agents` instead, and the placeholder is the model spelling ADR-0018
 * demands — `<provider>/<model>`, not a bare model id, since the prefix is what picks the
 * endpoint. `repo` is the default because a Repo Slot was the first Open part and reads as the
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
      : `{ repos: { ${slot ?? "<slot>"}: "<url>" } }`;
  const inner = path.reduceRight((parts, key) => `{ actors: { ${key}: ${parts} } }`, binds);
  return `customize(${machine}, ${inner})`;
}

/**
 * The runtime twin of the walk's `path`: the actor-slot chain from a run's root actor down to
 * `actor` (its own `src` included), read off the live actor tree — each `src` is the slot key it
 * was invoked or spawned as, and a wrapper's transparent body is skipped by the same record
 * ({@link wrapperBodyOf}) the walk skips it by. `undefined` past an inline-invoked actor, whose
 * `src` is the logic itself and names no slot.
 */
export function actorSlotPath(actor: AnyActorRef | undefined): string[] | undefined {
  const path: string[] = [];
  for (let node = actor; node?._parent; node = node._parent) {
    const src = (node as { src?: unknown }).src;
    if (typeof src !== "string") return undefined;
    const parent = asMachine((node._parent as { logic?: unknown }).logic);
    if (!parent || wrapperBodyOf(parent) !== src) path.unshift(src);
  }
  return path;
}

/** Everything the registered Machines carry that a converge or a boot must act on. */
export type CarriedParts = {
  agents: CarriedAgent[];
  images: CarriedImage[];
  /** Every bound Repo, deduped by identity, in walk order. */
  repos: CarriedRepo[];
  /** Every open Repo Slot, in walk order — non-empty is a converge refusal. An Open MAP
   * (`repos: open`) is one entry with no `slot`. */
  openSlots: OpenSlot[];
  /** Every Agent whose model is still Open (ADR-0054), in walk order — the same refusal, by the
   * same route, and the reason these are two lists rather than one: the fix lines differ. */
  openAgents: OpenSlot[];
  /** Whether any Machine reached, at any depth, composes a Sandbox — the data-plane switch. */
  composesSandbox: boolean;
};

/** A machine actor, told apart from a promise/callback/observable one by having a state tree.
 * Structural on purpose: an Instance resolves its OWN `@j2/orchestrator`, so the CLI's walk and a
 * workflow's machines may come from two module instances and no `instanceof` can hold. */
export function asMachine(logic: unknown): AnyStateMachine | undefined {
  return (logic as AnyStateMachine | undefined)?.root ? (logic as AnyStateMachine) : undefined;
}

/** Every machine object written INLINE on one state's invokes. A named `src` resolves through
 * `implementations.actors` instead and is walked there. */
function inlineMachines(node: StateNode<any, any>): AnyStateMachine[] {
  const config = [node.config.invoke ?? []].flat() as Array<{ src?: unknown }>;
  return config.flatMap((inv) => {
    const machine = asMachine(inv?.src);
    return machine ? [machine] : [];
  });
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
  const images: CarriedImage[] = [];
  const repos: CarriedRepo[] = [];
  const openSlots: OpenSlot[] = [];
  const openAgents: OpenSlot[] = [];
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
    // `j2 up`'s preflight simply has no model to probe for it (ADR-0054).
    if (isOpenAgent(definition)) openAgents.push({ slot: name, path });
  };

  // Only the BUILT origin is collected: a registry ref is deployed-never-built, so there is
  // nothing for a converge to do with it (ADR-0037/0039 — what j2 did not stamp, j2 does not
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

  const walkStates = (node: StateNode<any, any>, visit: (machine: AnyStateMachine) => void): void => {
    for (const machine of inlineMachines(node)) visit(machine);
    for (const child of Object.values(node.states as Record<string, StateNode<any, any>>)) walkStates(child, visit);
  };

  // `path` is the `customize()` route from the registered root to `machine` (see `OpenSlot`):
  // a named child slot extends it, a wrapper's transparent body does not, and an inline invoke
  // ends it — nothing downstream of an actor without a slot key can be named by a composer.
  const walk = (machine: AnyStateMachine, path: OpenSlot["path"]): void => {
    if (walked.has(machine)) return;
    walked.add(machine);
    const parts = sandboxPartsOf(machine);
    collectImage(parts.image);
    collectImage(parts.user);
    if (composesSandbox(machine)) {
      sandboxed = true;
      collectRepos(path, parts.repos);
    }
    const body = wrapperBodyOf(machine);
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      if (isAgent(logic)) collectAgent(path, name, logic.definition);
      else {
        const child = asMachine(logic);
        if (child) walk(child, path === undefined ? undefined : name === body ? path : [...path, name]);
      }
    }
    walkStates(machine.root, (inline) => walk(inline, undefined));
  };

  for (const machine of machines) walk(machine, []);
  return { agents, images, repos, openSlots, openAgents, composesSandbox: sandboxed };
}
