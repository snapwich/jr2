// Serialize a workflow's Machine for the visualizer (`GET /workflows/:name/machine`). Walks the
// live StateNode tree (`machine.root`) rather than `machine.definition`/`toJSON()` — those carry
// entry/exit actions and output mappers as functions, which don't survive JSON. The DTO here is
// pure data: the nested state tree drives the renderer's containment, the flat transition list its
// edges. Structure is provider-independent, so the registered template Machine (before
// `.provide()`) is the right thing to serialize (ADR-0003).
//
// A workflow's real work usually happens in CHILD machines (`coding`'s whole feature pipeline is a
// `spawnChild`), so the walk descends into them too — one `MachineBodyDoc` per child, attached to
// the state that runs it. Each carries the `src` a live child actor reports, which is how the page
// hangs run state under the right subgraph.

import type { AnyStateMachine, StateNode, TransitionDefinition } from "xstate";

/** One transition of the Machine, id-addressed at both ends. */
export type MachineTransitionDoc = {
  /** Source state id. */
  source: string;
  /** Target state ids; empty = targetless (self/internal) transition. */
  targets: string[];
  /** The raw event descriptor (`""` for always/eventless). */
  event: string;
  /** Display label, precomputed here so the renderer stays dumb. */
  label: string;
  /** Normalized guard name, if guarded. */
  guard?: string;
  kind: "event" | "always" | "after" | "done" | "error";
};

/** One state of the Machine; `states` nests in document order. */
export type MachineStateDoc = {
  /** Unique state id (custom `id:` respected). */
  id: string;
  /** Relative key — the segment that appears in a run's `status.value`. */
  key: string;
  type: "atomic" | "compound" | "parallel" | "final" | "history";
  /** Initial child state id (compound only). */
  initial?: string;
  invoke: Array<{ id: string; src: string }>;
  tags: string[];
  description?: string;
  states: MachineStateDoc[];
  /** The child MACHINES this state runs — invoked ones (a subset of `invoke`, which stays the
   * complete invocation list) plus spawned ones (which appear nowhere else). See
   * {@link ChildMachineDoc}. A promise/callback actor has no state tree, so it is never here. */
  children: ChildMachineDoc[];
  /**
   * This state runs an `enqueueActions` closure, so THIS STATE'S `children` MAY BE INCOMPLETE.
   *
   * Spawning is an action, and `spawnChild` is the only static trace it leaves (see
   * {@link spawnedSrcs}). A spawn issued as `enqueue.spawnChild(...)` inside a closure resolves at
   * runtime — it can be conditional, looped, or have a computed `src` — so no amount of static
   * analysis recovers it, and the subgraph beneath it would simply be absent from the diagram while
   * the machine ran correctly. That silence is the hazard, not the omission: it once erased the
   * whole feature pipeline from `examples/coding` with no signal at all. So the doc carries the
   * fact it cannot see, and callers (`j2 visualize`) say so out loud.
   */
  opaqueActions?: boolean;
};

/**
 * A child Machine reached from a state — the pipeline a workflow delegates to, which is most of
 * what it DOES. Attached to the state that runs it, so the renderer nests it where it belongs.
 *
 * `src` is the JOIN KEY: it is exactly the `src` a live child actor reports (`RunChild.src`), for
 * both kinds — a named actor keeps its name (`"featureWorkspace"`), an inline machine object gets
 * xstate's generated key (`"xstate.invoke.0.workspace.running"`) on both sides. That is what lets
 * the page hang a run's live child state under the right subgraph without the two halves agreeing
 * on anything but this string.
 */
export type ChildMachineDoc = {
  /** The join key — matches a live `RunChild.src` exactly. */
  src: string;
  /** Display name: the invoke id (`"body"`) or the spawned actor's name (`"featureWorkspace"`). */
  label: string;
  /** How the state reaches it: `invoke` binds it to the state's lifetime, `spawn` outlives it. */
  via: "invoke" | "spawn";
  /** The child's own structure. Absent iff `recursive`. */
  machine?: MachineBodyDoc;
  /** The machine is already an ancestor of this point — the body is up there, not repeated here. */
  recursive?: true;
};

/** One Machine's structure, independent of what NAMES it (a `workflow` at the root, a `src` below). */
export type MachineBodyDoc = {
  /** Machine id. */
  id: string;
  root: MachineStateDoc;
  transitions: MachineTransitionDoc[];
};

/** The serialized structure of a workflow's Machine. */
export type MachineDoc = MachineBodyDoc & { workflow: string };

/** Normalize a guard to a display name: setup() name, parameterized type, or `"inline"`. */
function guardName(guard: unknown): string | undefined {
  if (guard === undefined) return undefined;
  if (typeof guard === "string") return guard;
  // An inline arrow gets the property-inferred name "guard" — meaningless, so report "inline";
  // a deliberately named function (`guard: function isValid() {…}`) keeps its name.
  if (typeof guard === "function") return guard.name && guard.name !== "guard" ? guard.name : "inline";
  return (guard as { type?: string }).type ?? "inline";
}

/** Normalize an invoke `src` to a display name: setup() actor name or `"inline"`. */
function srcName(src: unknown): string {
  if (typeof src === "string") return src;
  return ((src as { id?: string })?.id ?? "inline") as string;
}

/**
 * The tail of a done/error descriptor's id. xstate names an ANONYMOUS invoke after its own position
 * (`0.body.working.claimTask`), so the raw descriptor spells out the whole path down to the state
 * the edge already leaves from. Only the last segment says anything new — and a label is not free:
 * in a layered graph an edge label's WIDTH becomes spacing between layers, so the path is paid for
 * in diagram width. The full descriptor stays on `event`, so nothing is lost.
 */
const shortId = (id = "") => id.slice(id.lastIndexOf(".") + 1);

/** Classify an event descriptor and derive its display label. */
function eventLabel(eventType: string): { kind: MachineTransitionDoc["kind"]; label: string } {
  if (eventType === "") return { kind: "always", label: "always" };
  const done = /^xstate\.done\.(?:actor|state)\.(.*)$/.exec(eventType);
  if (done) return { kind: "done", label: `done: ${shortId(done[1])}` };
  const error = /^xstate\.error\.actor\.(.*)$/.exec(eventType);
  if (error) return { kind: "error", label: `error: ${shortId(error[1])}` };
  const after = /^xstate\.after\.([^.]+)\./.exec(eventType);
  if (after) return { kind: "after", label: `after ${after[1]}` };
  return { kind: "event", label: eventType };
}

function serializeTransition(t: TransitionDefinition<any, any>): MachineTransitionDoc {
  const { kind, label } = eventLabel(t.eventType);
  const guard = guardName(t.guard);
  const doc: MachineTransitionDoc = {
    source: t.source.id,
    targets: (t.target ?? []).map((s) => s.id),
    event: t.eventType,
    label,
    kind,
  };
  if (guard !== undefined) doc.guard = guard;
  return doc;
}

/** The registry a `src` name resolves against, plus the cycle guard. One per machine level. */
type Scope = {
  /** The machine's `setup({ actors })` registry — where a named `src` is bound. */
  actors: Record<string, unknown>;
  /** The machines on the path from the root down to here. A machine already on it does not recurse. */
  path: Set<AnyStateMachine>;
};

/** A machine actor, told apart from a promise/callback/observable one by having a state tree. */
function asMachine(logic: unknown): AnyStateMachine | undefined {
  return (logic as AnyStateMachine | undefined)?.root ? (logic as AnyStateMachine) : undefined;
}

/** The machine behind `node.invoke[index]`, if it is one. Named actors resolve through the registry;
 * an INLINE machine object survives only on the raw config node — xstate rewrites
 * `StateNode.invoke[].src` to a generated key (which is exactly the key the live child reports, so
 * the doc keeps it as the join `src` and looks the logic up here instead). */
function invokedMachine(node: StateNode<any, any>, index: number, scope: Scope): AnyStateMachine | undefined {
  const src = node.invoke[index]?.src;
  if (typeof src === "string") {
    const named = asMachine(scope.actors[src]);
    if (named) return named;
  }
  const config = [node.config.invoke ?? []].flat()[index] as { src?: unknown } | undefined;
  return asMachine(config?.src);
}

/** Walk every action list a state can carry: its entry, and all of its transitions'. */
function eachAction(node: StateNode<any, any>, visit: (action: { type?: unknown; src?: unknown }) => void): void {
  const scan = (actions: readonly unknown[] | undefined) => {
    for (const action of actions ?? []) visit(action as { type?: unknown; src?: unknown });
  };
  scan(node.entry);
  for (const defs of node.transitions.values()) for (const t of defs) scan(t.actions);
  for (const t of node.always ?? []) scan(t.actions);
}

/**
 * Does this state run an `enqueueActions` closure? If so its {@link MachineStateDoc.children} may be
 * incomplete — the closure is opaque, and a spawn inside it leaves no static trace at all.
 *
 * We cannot see through it (the body resolves at runtime against a live context and event), so the
 * honest move is to REPORT that we cannot, rather than emit a confidently wrong diagram. xstate
 * gives us exactly enough to do that: the action's `type` is `"xstate.enqueueActions"`, visible even
 * though its contents are not.
 */
function hasOpaqueActions(node: StateNode<any, any>): boolean {
  let opaque = false;
  eachAction(node, (a) => {
    if (a?.type === "xstate.enqueueActions") opaque = true;
  });
  return opaque;
}

/** Every actor name this state `spawnChild`s — from its entry actions or any of its transitions'.
 * A spawned child is an ACTION, so it appears nowhere in the state tree; this is its only trace.
 * Only a TOP-LEVEL `spawnChild` is visible; one issued inside an `enqueueActions` closure is not,
 * which is what {@link hasOpaqueActions} exists to flag. */
function spawnedSrcs(node: StateNode<any, any>): string[] {
  const srcs = new Set<string>();
  eachAction(node, (a) => {
    if (a?.type === "xstate.spawnChild" && typeof a.src === "string") srcs.add(a.src);
  });
  return [...srcs];
}

/** The child machines a state runs, invoked and spawned. */
function childMachines(node: StateNode<any, any>, scope: Scope): ChildMachineDoc[] {
  const docs: ChildMachineDoc[] = [];
  const attach = (src: string, label: string, via: ChildMachineDoc["via"], machine: AnyStateMachine) => {
    // Recursion is legal (a machine that spawns itself); serializing it is not. Name it and stop.
    if (scope.path.has(machine)) docs.push({ src, label, via, recursive: true });
    // A fresh path per branch, not a shared visited-set: two SIBLINGS may run the same machine, and
    // both should carry its body — only an ANCESTOR is a cycle.
    else docs.push({ src, label, via, machine: serializeBody(machine, new Set(scope.path)) });
  };

  node.invoke.forEach((inv, i) => {
    const machine = invokedMachine(node, i, scope);
    if (machine) attach(srcName(inv.src), inv.id, "invoke", machine);
  });
  for (const src of spawnedSrcs(node)) {
    const machine = asMachine(scope.actors[src]);
    if (machine) attach(src, src, "spawn", machine);
  }
  return docs;
}

function serializeState(node: StateNode<any, any>, into: MachineTransitionDoc[], scope: Scope): MachineStateDoc {
  // `node.always` entries are already in the transitions map under the eventless descriptor, so the
  // map alone is the complete edge set; a reference-set dedupe guards against either representation.
  const seen = new Set<TransitionDefinition<any, any>>();
  for (const defs of node.transitions.values()) {
    for (const t of defs) {
      if (!seen.has(t)) {
        seen.add(t);
        into.push(serializeTransition(t));
      }
    }
  }
  for (const t of node.always ?? []) {
    if (!seen.has(t)) {
      seen.add(t);
      into.push(serializeTransition(t));
    }
  }

  const children = Object.values(node.states as Record<string, StateNode<any, any>>).sort((a, b) => a.order - b.order);
  const doc: MachineStateDoc = {
    id: node.id,
    key: node.key,
    type: node.type,
    invoke: node.invoke.map((inv) => ({ id: inv.id, src: srcName(inv.src) })),
    tags: [...node.tags],
    states: children.map((child) => serializeState(child, into, scope)),
    children: childMachines(node, scope),
  };
  if (node.type === "compound") doc.initial = node.initial.target[0]?.id;
  if (node.description !== undefined) doc.description = node.description;
  if (hasOpaqueActions(node)) doc.opaqueActions = true;
  return doc;
}

/** Every state whose `children` may be incomplete, by id — what a caller warns about. Walks the
 * whole doc, child machines included, since an opaque spawn hides just as well one level down. */
export function opaqueStates(doc: MachineDoc): string[] {
  const ids: string[] = [];
  const walk = (state: MachineStateDoc): void => {
    if (state.opaqueActions) ids.push(state.id);
    for (const child of state.children) if (child.machine) walk(child.machine.root);
    for (const nested of state.states) walk(nested);
  };
  walk(doc.root);
  return ids;
}

/** Serialize one Machine — its own state tree and its own transitions. Each level carries its own
 * actor registry (a child machine resolves `src` names against ITS `setup`, not its parent's). */
function serializeBody(machine: AnyStateMachine, path: Set<AnyStateMachine>): MachineBodyDoc {
  path.add(machine);
  const transitions: MachineTransitionDoc[] = [];
  const scope: Scope = { actors: machine.implementations.actors as Record<string, unknown>, path };
  const root = serializeState(machine.root, transitions, scope);
  return { id: machine.id, root, transitions };
}

/** Serialize a workflow's template Machine into the visualizer DTO, child machines and all. */
export function serializeMachine(workflow: string, machine: AnyStateMachine): MachineDoc {
  return { workflow, ...serializeBody(machine, new Set()) };
}
