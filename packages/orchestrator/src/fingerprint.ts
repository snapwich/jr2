// The content address of a Machine's SHAPE (ADR-0030). A persisted snapshot names the Machine it
// was written under; restore compares and refuses a mismatch, because a workflow is matched to a
// run by filename alone and the state volume outlives the image that wrote it — so a run parked at
// a Gate meets whatever `j2 up` baked in next, and nothing used to notice.
//
// What it hashes is RESTORABILITY, not behavior: the facts that decide whether an old snapshot can
// still be interpreted — state ids and nesting, which state is initial, what each state invokes and
// under which id (the invoke id is the key in the snapshot's `children` map), and where every
// transition goes. Not guard bodies, not assigns, not prompts. Editing a guard changes what a run
// DOES next; it does not make the snapshot unreadable, and restore-after-redeploy would be unusable
// if every such edit stranded the runs in flight. That line is the whole design, and ADR-0030 argues
// it: this is a restorability check, and drift means "I can no longer read what I saved."
//
// The traversal is `machine-doc.ts`'s, deliberately — it is already deterministic (states sorted by
// `order`), JSON-pure, provider-independent, and descends into invoked AND spawned child machines.
// This module only projects it down and hashes the result.

import { createHash } from "node:crypto";
import type { AnyStateMachine } from "xstate";
import { serializeMachine, type MachineBodyDoc, type MachineStateDoc } from "./machine-doc.ts";

/** The projection that gets hashed — a Machine reduced to what restore has to agree about. */
type ShapeState = {
  id: string;
  key: string;
  type: string;
  initial?: string;
  /** `id` as well as `src`: the id keys this child in the persisted `children` map. */
  invoke: Array<{ id: string; src: string }>;
  states: ShapeState[];
  children: Array<{ src: string; via: string; machine?: ShapeBody }>;
  /** The walk could not see this state's spawns — recorded so the blind spot is IN the hash. */
  opaque?: true;
};

type ShapeBody = {
  id: string;
  root: ShapeState;
  /** `source|event|targets`, sorted — reordering `on:` keys is not a restorability change. */
  transitions: string[];
};

function shapeState(state: MachineStateDoc): ShapeState {
  const out: ShapeState = {
    id: state.id,
    key: state.key,
    type: state.type,
    invoke: state.invoke.map((inv) => ({ id: inv.id, src: inv.src })),
    states: state.states.map(shapeState),
    children: state.children.map((child) => ({
      src: child.src,
      via: child.via,
      ...(child.machine ? { machine: shapeBody(child.machine) } : {}),
    })),
  };
  if (state.initial !== undefined) out.initial = state.initial;
  if (state.opaqueActions) out.opaque = true;
  return out;
}

function shapeBody(body: MachineBodyDoc): ShapeBody {
  return {
    id: body.id,
    root: shapeState(body.root),
    transitions: body.transitions.map((t) => `${t.source}|${t.event}|${t.targets.join(",")}`).sort(),
  };
}

/** Memoized per machine OBJECT, as `vocabularyOf` is: `persist` runs on every snapshot microtask,
 * and a dev reload's fresh machine object correctly gets a fresh entry. */
const cache = new WeakMap<AnyStateMachine, string>();

/**
 * This Machine's shape, as 12 hex chars — the same width `j2 up`'s content hash uses, and for the
 * same reason: it is read by humans in error messages far more often than by machines.
 *
 * The workflow NAME is deliberately excluded. A run already carries its workflow, and restore looks
 * the def up by that name before it gets here; folding the name in would only make a rename look
 * like a shape change on a run that never resolves to the renamed def anyway.
 */
export function fingerprintOf(machine: AnyStateMachine): string {
  const hit = cache.get(machine);
  if (hit !== undefined) return hit;
  // `serializeMachine` wants a workflow name for the DTO; the projection drops it.
  const shape = shapeBody(serializeMachine("", machine));
  const digest = createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
  cache.set(machine, digest);
  return digest;
}
