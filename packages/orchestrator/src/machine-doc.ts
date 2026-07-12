// Serialize a workflow's Machine for the visualizer (`GET /workflows/:name/machine`). Walks the
// live StateNode tree (`machine.root`) rather than `machine.definition`/`toJSON()` — those carry
// entry/exit actions and output mappers as functions, which don't survive JSON. The DTO here is
// pure data: the nested state tree drives the renderer's containment, the flat transition list its
// edges. Structure is provider-independent, so the registered template Machine (before
// `.provide()`) is the right thing to serialize (ADR-0003).

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
};

/** The serialized structure of a workflow's Machine. */
export type MachineDoc = {
  workflow: string;
  /** Root machine id. */
  id: string;
  root: MachineStateDoc;
  transitions: MachineTransitionDoc[];
};

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

/** Classify an event descriptor and derive its display label. */
function eventLabel(eventType: string): { kind: MachineTransitionDoc["kind"]; label: string } {
  if (eventType === "") return { kind: "always", label: "always" };
  const done = /^xstate\.done\.(?:actor|state)\.(.*)$/.exec(eventType);
  if (done) return { kind: "done", label: `done: ${done[1]}` };
  const error = /^xstate\.error\.actor\.(.*)$/.exec(eventType);
  if (error) return { kind: "error", label: `error: ${error[1]}` };
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

function serializeState(node: StateNode<any, any>, into: MachineTransitionDoc[]): MachineStateDoc {
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
    states: children.map((child) => serializeState(child, into)),
  };
  if (node.type === "compound") doc.initial = node.initial.target[0]?.id;
  if (node.description !== undefined) doc.description = node.description;
  return doc;
}

/** Serialize a workflow's template Machine into the visualizer DTO. */
export function serializeMachine(workflow: string, machine: AnyStateMachine): MachineDoc {
  const transitions: MachineTransitionDoc[] = [];
  const root = serializeState(machine.root, transitions);
  return { workflow, id: machine.id, root, transitions };
}
