// The PARTS a Machine carries (ADR-0049): its Agents, and — on a `workspace()` wrapper — the
// Sandbox Image the pod runs. A Machine carries everything it depends on and composes by invoke,
// so what a deployment must know about a workflow is no longer a folder or a config block: it is
// an attachment on the machine object plus a walk over it.
//
// Two halves, one file, because they are one idea:
//
//   - The ATTACHMENT. `workspace()` stamps its static options here, keyed on `machine.config` —
//     the raw object xstate's `.provide()` passes through unchanged, exactly as the vocabulary is
//     keyed (vocabulary.ts). That is ADR-0049's one rule: parts resolve at invoke time through the
//     LIVE actor's logic, never a build-time closure, so a `provide()` clone and a `customize()`
//     retune both find the part the actor was actually invoked as. The image is therefore never
//     persisted — the provisioning state re-reads it off the Machine on restore.
//   - The WALK. Two callers, both at `j2 up` time (ADR-0018/0019/0031/0037): the custom-provider
//     preflight probes the models the registered Machines actually name, the Instance Harness
//     converges when any of them declares `workspace: "none"`, and every `file:` image context a
//     Machine ships is built and content-tagged. Neither can read an invoke's `input` (it is a
//     function — dials are not statically recoverable), and neither needs to: identity lives in
//     the definition and the image is an option, and both are values ON the Machine.
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
import type { AnyStateMachine, StateNode } from "xstate";
import { isAgent, type AgentDefinition } from "./agent.ts";
import { isImageContext } from "./images.ts";

/**
 * The static parts a `workspace()` wrapper carries (ADR-0049, ADR-0037): what the Sandbox is MADE
 * of. Both are image NAMES in ADR-0037's two shapes — a `file:` URL to a docker context the
 * Machine's module ships, or a registry ref — and both resolve to a concrete ref on the port's
 * side, which is what keeps the Machine cluster-agnostic.
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
};

const sandboxParts = new WeakMap<AnyStateMachine["config"], SandboxParts>();

/** Attach a wrapper's static Sandbox parts. j2-internal: `workspace()` calls it. */
export function attachSandboxParts(machine: AnyStateMachine, parts: SandboxParts): void {
  sandboxParts.set(machine.config, parts);
}

/** The Sandbox parts a Machine carries — empty for any Machine that is not a `workspace()`
 * wrapper, which is the honest answer: it composes no Sandbox. */
export function sandboxPartsOf(machine: AnyStateMachine | undefined): SandboxParts {
  return (machine && sandboxParts.get(machine.config)) ?? {};
}

/** One Agent a Machine carries: the SLOT KEY it is declared under (its name everywhere — the
 * Harness route, the minted iid, the markers) and the definition that slot runs. */
export type CarriedAgent = { name: string; definition: AgentDefinition };

/**
 * One docker context a Machine ships (ADR-0037's built origin) — a `file:` URL a module named with
 * `import.meta.resolve`, which is the only way an ES module can name a folder it owns.
 *
 * `dir` is that URL as a path, which is what `docker build` takes and what the content digest
 * covers. `name` is the directory's basename and is DECORATION — it rides the image tag so a human
 * reading `docker images` sees something better than a hash. The identity is the digest.
 */
export type CarriedImage = { url: string; dir: string; name: string };

/** Everything the registered Machines carry that a converge must act on. */
export type CarriedParts = { agents: CarriedAgent[]; images: CarriedImage[] };

/** A machine actor, told apart from a promise/callback/observable one by having a state tree. */
function asMachine(logic: unknown): AnyStateMachine | undefined {
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
  const seen = new Set<string>();
  // Cycle guard AND work saver: a Machine reached twice carries the same parts both times, and a
  // Machine that composes itself is legal (a recursive pool worker) but not walkable twice.
  const walked = new Set<AnyStateMachine>();

  const collectAgent = (name: string, definition: AgentDefinition): void => {
    // Keyed on the PAIR, serialized whole: a separator character inside a template literal is
    // either ambiguous (a slot key may contain it) or, if chosen for being impossible, a control
    // byte that makes this module binary to git — invisible to diff, blame and grep, forever.
    const key = JSON.stringify(["agent", name, definition]);
    if (seen.has(key)) return;
    seen.add(key);
    agents.push({ name, definition });
  };

  // Only the BUILT origin is collected: a registry ref is deployed-never-built, so there is
  // nothing for a converge to do with it (ADR-0037/0039 — what j2 did not stamp, j2 does not
  // touch). Both image seats ride the same rule, because ADR-0005 gives the User Container the
  // same two origins and the same resolution.
  const collectImage = (url: string | undefined): void => {
    if (url === undefined || !isImageContext(url)) return;
    const key = JSON.stringify(["image", url]);
    if (seen.has(key)) return;
    seen.add(key);
    const dir = fileURLToPath(url);
    images.push({ url, dir, name: basename(dir) });
  };

  const walkStates = (node: StateNode<any, any>, visit: (machine: AnyStateMachine) => void): void => {
    for (const machine of inlineMachines(node)) visit(machine);
    for (const child of Object.values(node.states as Record<string, StateNode<any, any>>)) walkStates(child, visit);
  };

  const walk = (machine: AnyStateMachine): void => {
    if (walked.has(machine)) return;
    walked.add(machine);
    const parts = sandboxPartsOf(machine);
    collectImage(parts.image);
    collectImage(parts.user);
    for (const [name, logic] of Object.entries(machine.implementations.actors as Record<string, unknown>)) {
      if (isAgent(logic)) collectAgent(name, logic.definition);
      else {
        const child = asMachine(logic);
        if (child) walk(child);
      }
    }
    walkStates(machine.root, walk);
  };

  for (const machine of machines) walk(machine);
  return { agents, images };
}
