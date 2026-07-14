// serializeMachine (the visualizer DTO): prove the StateNode walk captures the full statechart
// structure — nesting, parallel regions, final states, guards, invokes, always/after/done/error
// transitions — and that the result is pure JSON (no functions leak through).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, fromPromise, setup, spawnChild, type AnyStateMachine } from "xstate";
import { serializeMachine, type MachineStateDoc } from "../src/machine-doc.ts";

/** A fixture exercising every serialization path. */
const fixture = setup({
  actors: { work: fromPromise(async () => "ok") },
  guards: { isReady: () => true },
}).createMachine({
  id: "fix",
  initial: "draft",
  states: {
    draft: {
      invoke: { id: "worker", src: "work" },
      on: {
        SUBMIT: { target: "review", guard: "isReady" },
        POKE: { guard: () => false }, // targetless + inline guard
      },
      after: { 500: { target: "review" } },
    },
    review: {
      id: "custom-review", // custom id: value key ("review") ≠ id
      initial: "checking",
      states: {
        checking: {
          always: { target: "settled", guard: "isReady" },
        },
        settled: { type: "final" },
      },
      onDone: { target: "shipping" },
    },
    shipping: {
      type: "parallel",
      states: {
        build: { initial: "running", states: { running: {}, built: { type: "final" } } },
        docs: { initial: "writing", states: { writing: {}, written: { type: "final" } } },
      },
    },
    failed: {},
  },
  on: { ABORT: ".failed" },
});

const doc = serializeMachine("fixture-wf", fixture);

function findState(root: MachineStateDoc, id: string): MachineStateDoc | undefined {
  if (root.id === id) return root;
  for (const child of root.states) {
    const hit = findState(child, id);
    if (hit) return hit;
  }
  return undefined;
}

test("state tree: ids, keys, types, initial, nesting", () => {
  assert.equal(doc.workflow, "fixture-wf");
  assert.equal(doc.id, "fix");
  assert.equal(doc.root.type, "compound");
  assert.equal(doc.root.initial, "fix.draft");
  assert.deepEqual(
    doc.root.states.map((s) => s.key),
    ["draft", "review", "shipping", "failed"],
  );

  const review = findState(doc.root, "custom-review");
  assert.ok(review, "custom id respected");
  assert.equal(review.key, "review"); // key stays the value segment
  // Children of a custom-id state keep their path-based ids — id and value path diverge here,
  // which is exactly why the visualizer's active-set walk must follow `key`, never split ids.
  assert.equal(review.initial, "fix.review.checking");
  assert.equal(findState(doc.root, "fix.review.settled")?.type, "final");

  const shipping = findState(doc.root, "fix.shipping");
  assert.equal(shipping?.type, "parallel");
  assert.equal(shipping?.states.length, 2);
});

test("invoke is captured with its setup() actor name", () => {
  const draft = findState(doc.root, "fix.draft");
  assert.deepEqual(draft?.invoke, [{ id: "worker", src: "work" }]);
});

test("transitions: events, guards, always, after, done, targetless", () => {
  const byLabel = (label: string) => doc.transitions.filter((t) => t.label === label);

  const submit = byLabel("SUBMIT")[0];
  assert.deepEqual(submit, {
    source: "fix.draft",
    targets: ["custom-review"],
    event: "SUBMIT",
    label: "SUBMIT",
    guard: "isReady",
    kind: "event",
  });

  const poke = byLabel("POKE")[0];
  assert.ok(poke);
  assert.deepEqual(poke.targets, [], "targetless transition keeps empty targets");
  assert.equal(poke.guard, "inline");

  const after = doc.transitions.find((t) => t.kind === "after");
  assert.equal(after?.label, "after 500");
  assert.deepEqual(after?.targets, ["custom-review"]);

  const always = doc.transitions.find((t) => t.kind === "always");
  assert.equal(always?.source, "fix.review.checking");
  assert.equal(always?.guard, "isReady");
  assert.deepEqual(always?.targets, ["fix.review.settled"]);

  const done = doc.transitions.find((t) => t.kind === "done");
  assert.equal(done?.source, "custom-review");
  assert.deepEqual(done?.targets, ["fix.shipping"]);

  const abort = byLabel("ABORT")[0];
  assert.ok(abort);
  assert.equal(abort.source, "fix");
  assert.deepEqual(abort.targets, ["fix.failed"]);
});

test("the doc is pure JSON — a stringify round-trip is lossless", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test("an un-provided template Machine (empty actor slot) serializes the same structure", () => {
  // A workflow's exported `machine` references actors by name without providing them; structure must
  // still serialize (the visualizer never assembles providers).
  const template = createMachine({
    id: "tpl",
    initial: "working",
    states: { working: { invoke: { src: "agentRun" }, onDone: "done" }, done: { type: "final" } },
  });
  const tplDoc = serializeMachine("tpl-wf", template);
  assert.equal(findState(tplDoc.root, "tpl.working")?.invoke[0]?.src, "agentRun");
  assert.deepEqual(JSON.parse(JSON.stringify(tplDoc)), tplDoc);
});

// ---- Child machines -----------------------------------------------------------------------------
// The shape `coding` actually has, and the reason the visualizer needed this: the whole feature
// pipeline hangs off a `spawnChild` (an ACTION — it is nowhere in the state tree), and the machine
// it spawns invokes its body as an INLINE machine object. Two different resolutions, one join key.

const body = createMachine({
  id: "body",
  initial: "coding",
  states: { coding: { on: { DONE: "shipped" } }, shipped: { type: "final" } },
});

const wrapper = createMachine({
  id: "wrapper",
  initial: "running",
  states: {
    running: {
      invoke: [
        { id: "body", src: body }, // inline machine object → generated src key
        { id: "reconcile", src: fromPromise(async () => "ok") }, // a promise actor → NOT a child machine
      ],
    },
  },
});

const parent = setup({ actors: { feature: wrapper } }).createMachine({
  id: "parent",
  initial: "discover",
  states: {
    discover: {
      on: { CLAIM: { actions: spawnChild("feature", { id: "F-1" }) } },
    },
  },
});

const parentDoc = serializeMachine("parent-wf", parent);

/** The wrapper's body doc, as the page reaches it: down through the state that spawns it. */
const wrapperDoc = () => findState(parentDoc.root, "parent.discover")!.children[0]!.machine!;

test("a spawnChild'd machine is attached to the state that spawns it", () => {
  const discover = findState(parentDoc.root, "parent.discover");
  assert.equal(discover?.children.length, 1);
  const child = discover!.children[0]!;
  assert.equal(child.via, "spawn");
  assert.equal(child.src, "feature", "the join key is the actor NAME — what the live child reports");
  assert.equal(child.label, "feature");
  assert.equal(child.machine?.id, "wrapper");
});

test("an inline invoked machine nests inside it, keyed by xstate's generated src", () => {
  const running = findState(wrapperDoc().root, "wrapper.running");
  assert.equal(running?.children.length, 1, "the promise actor is not a child machine");
  const inline = running!.children[0]!;
  assert.equal(inline.via, "invoke");
  assert.equal(inline.label, "body");
  // The generated key: this exact string is what `actorRef.src` reports for an inline invoke, which
  // is the ONLY thing the page joins structure and live state on.
  assert.equal(inline.src, "xstate.invoke.0.wrapper.running");
  assert.equal(inline.machine?.id, "body");
  assert.deepEqual(
    inline.machine?.root.states.map((s) => s.key),
    ["coding", "shipped"],
  );
});

test("a child machine carries its OWN transitions, not the parent's", () => {
  const bodyDoc = findState(wrapperDoc().root, "wrapper.running")!.children[0]!.machine!;
  const done = bodyDoc.transitions.find((t) => t.label === "DONE");
  assert.deepEqual(done?.targets, ["body.shipped"]);
  assert.equal(
    parentDoc.transitions.some((t) => t.label === "DONE"),
    false,
  );
});

test("the complete invoke list is untouched — `children` adds to it, never replaces it", () => {
  const running = findState(wrapperDoc().root, "wrapper.running");
  assert.deepEqual(
    running?.invoke.map((i) => i.id),
    ["body", "reconcile"],
  );
});

test("a recursive machine is named, not unrolled", () => {
  // A machine that spawns ITSELF. Legal to run, impossible to serialize by recursion — so the doc
  // names the child and stops. (The registry is patched after construction because the reference
  // cannot exist before the machine does.)
  const recursive = createMachine({
    id: "rec",
    initial: "go",
    states: { go: { entry: spawnChild("self" as never) } },
  }) as AnyStateMachine;
  (recursive.implementations.actors as Record<string, unknown>).self = recursive;

  const doc = serializeMachine("rec-wf", recursive);
  const go = findState(doc.root, "rec.go");
  assert.deepEqual(go?.children, [{ src: "self", label: "self", via: "spawn", recursive: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});
