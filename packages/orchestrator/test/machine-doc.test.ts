// serializeMachine (the Console's DTO): prove the StateNode walk captures the full statechart
// structure — nesting, parallel regions, final states, guards, invokes, always/after/done/error
// transitions — and that the result is pure JSON (no functions leak through).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, enqueueActions, fromPromise, setup, spawnChild, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@j2/agent-protocol";
import { fingerprintOf } from "../src/fingerprint.ts";
import { j2Setup } from "../src/setup.ts";
import { opaqueStates, serializeMachine, type MachineStateDoc } from "../src/machine-doc.ts";

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
  // which is exactly why the Console's active-set walk must follow `key`, never split ids.
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
  // still serialize (the Console never assembles providers).
  const template = createMachine({
    id: "tpl",
    initial: "working",
    states: { working: { invoke: { src: "coder" }, onDone: "done" }, done: { type: "final" } },
  });
  const tplDoc = serializeMachine("tpl-wf", template);
  assert.equal(findState(tplDoc.root, "tpl.working")?.invoke[0]?.src, "coder");
  assert.deepEqual(JSON.parse(JSON.stringify(tplDoc)), tplDoc);
});

// ---- Child machines -----------------------------------------------------------------------------
// The shape `coding` actually has, and the reason the Console needed this: the whole feature
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

// The regression that motivated `opaqueActions`: `examples/coding` moved its `spawnChild` inside an
// `enqueueActions` closure to dodge an xstate typing wall, and its entire feature pipeline vanished
// from the diagram — silently, while the machine still ran correctly. We cannot see into the
// closure (it resolves at runtime, and may spawn conditionally or with a computed src), so the
// contract is: report the blind spot rather than emit a confidently incomplete diagram.
test("a spawn hidden in an enqueueActions closure is invisible — so the state is flagged opaque", () => {
  const kid = createMachine({ id: "kid", initial: "a", states: { a: {} } });
  const hiding = setup({ actors: { kid } }).createMachine({
    id: "hiding",
    initial: "s",
    states: { s: { entry: [enqueueActions(({ enqueue }) => enqueue.spawnChild("kid"))] } },
  });

  const doc = serializeMachine("hiding", hiding);
  const s = findState(doc.root, "hiding.s")!;

  assert.equal(s.children.length, 0, "the spawn leaves no static trace — this is the limit, not a bug");
  assert.equal(s.opaqueActions, true, "so the doc must SAY its children may be incomplete");
  assert.deepEqual(opaqueStates(doc), ["hiding.s"]);
});

test("a top-level spawnChild is not opaque — the flag marks a blind spot, not any action", () => {
  const discover = findState(parentDoc.root, "parent.discover");
  assert.equal(discover?.children.length, 1, "the spawn IS visible here");
  assert.equal(discover?.opaqueActions, undefined);
  assert.deepEqual(opaqueStates(parentDoc), [], "nothing to warn about");
});

test("an inline invoked machine nests inside it, keyed by xstate's generated src", () => {
  // An AUTHOR may still write a machine object straight onto an `invoke.src`; none of j2's own
  // wrappers do since ADR-0049 (see the `workspace()` join-key test below).
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
  }) as unknown as AnyStateMachine;
  (recursive.implementations.actors as Record<string, unknown>).self = recursive;

  const doc = serializeMachine("rec-wf", recursive);
  const go = findState(doc.root, "rec.go");
  assert.deepEqual(go?.children, [{ src: "self", label: "self", via: "spawn", recursive: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

// --- fingerprintOf (ADR-0030) -----------------------------------------------------------------
// The hash answers ONE question: can a snapshot written by that Machine still be read by this one.
// So the line it draws is shape vs logic — and both halves of that line need pinning, because a
// hash that is too sensitive strands every parked run on a prompt tweak, and one that is too loose
// resumes a snapshot into a state chart that no longer has its state.

/** The fixture, re-built from a config so each case can vary exactly one thing. */
const shaped = (mut: (c: Record<string, any>) => Record<string, any> = (c) => c): AnyStateMachine =>
  setup({ actors: { work: fromPromise(async () => "ok") }, guards: { isReady: () => true } }).createMachine(
    mut({
      id: "fp",
      initial: "draft",
      states: {
        draft: { invoke: { id: "worker", src: "work" }, on: { SUBMIT: { target: "review", guard: "isReady" } } },
        review: { on: { BACK: { target: "draft" } } },
      },
    }) as never,
  ) as unknown as AnyStateMachine;

test("the fingerprint is stable across rebuilds of the same shape", () => {
  assert.equal(fingerprintOf(shaped()), fingerprintOf(shaped()));
  assert.match(fingerprintOf(shaped()), /^[0-9a-f]{12}$/);
});

test("logic changes are NOT drift: a run parked at a gate survives a guard or prompt edit", () => {
  const base = fingerprintOf(shaped());
  // A different guard implementation entirely — same topology.
  const reguarded = setup({
    actors: { work: fromPromise(async () => "ok") },
    guards: { isReady: () => false },
  }).createMachine({
    id: "fp",
    initial: "draft",
    states: {
      draft: { invoke: { id: "worker", src: "work" }, on: { SUBMIT: { target: "review", guard: "isReady" } } },
      review: { on: { BACK: { target: "draft" } } },
    },
  } as never) as unknown as AnyStateMachine;
  assert.equal(fingerprintOf(reguarded), base, "the snapshot is still readable; only what happens NEXT differs");
});

test("reordering `on:` keys is not drift — the transition set is what matters, not its order", () => {
  const a = fingerprintOf(
    shaped((c) => ({
      ...c,
      states: {
        ...c.states,
        draft: {
          ...c.states.draft,
          on: { SUBMIT: { target: "review", guard: "isReady" }, PING: { target: "review" } },
        },
      },
    })),
  );
  const b = fingerprintOf(
    shaped((c) => ({
      ...c,
      states: {
        ...c.states,
        draft: {
          ...c.states.draft,
          on: { PING: { target: "review" }, SUBMIT: { target: "review", guard: "isReady" } },
        },
      },
    })),
  );
  assert.equal(a, b);
});

test("shape changes ARE drift: a renamed state, a retargeted transition, a moved invoke", () => {
  const base = fingerprintOf(shaped());

  // Renamed state — the persisted `value` names a state that is simply gone. Renamed at BOTH ends,
  // because a machine that still targeted the old name would not build at all.
  const renamed = fingerprintOf(
    shaped((c) => ({
      ...c,
      states: {
        draft: { ...c.states.draft, on: { SUBMIT: { target: "reviewing", guard: "isReady" } } },
        reviewing: { on: { BACK: { target: "draft" } } },
      },
    })),
  );
  assert.notEqual(renamed, base, "a persisted value pointing at `review` cannot be read here");

  // Retargeted transition — same states, different graph.
  const retargeted = fingerprintOf(
    shaped((c) => ({
      ...c,
      states: { ...c.states, draft: { ...c.states.draft, on: { SUBMIT: { target: "draft" } } } },
    })),
  );
  assert.notEqual(retargeted, base);

  // Invoke id changed — that id is the KEY in the snapshot's `children` map, so re-attach depends
  // on it. The most easily-missed of the three, and the one a topology-only hash exists to catch.
  const reinvoked = fingerprintOf(
    shaped((c) => ({
      ...c,
      states: { ...c.states, draft: { ...c.states.draft, invoke: { id: "runner", src: "work" } } },
    })),
  );
  assert.notEqual(reinvoked, base);
});

test("drift in a CHILD machine is drift — most of a workflow lives down there", () => {
  const withBody = (bodyInitial: string): AnyStateMachine => {
    const body = createMachine({
      id: "body",
      initial: bodyInitial,
      states: { [bodyInitial]: {}, other: {} },
    }) as unknown as AnyStateMachine;
    return setup({ actors: { body } }).createMachine({
      id: "outer",
      initial: "running",
      states: { running: { invoke: { id: "body", src: "body" } } },
    } as never) as unknown as AnyStateMachine;
  };
  assert.notEqual(fingerprintOf(withBody("first")), fingerprintOf(withBody("second")));
});

// ---- Vocabulary, per Machine node (ADR-0011, ADR-0049) ------------------------------------------
// Event names are scoped to the Machine that declared them, so the doc attributes them the same
// way: one list per `MachineBodyDoc`, never a flattened root list that would have to reconcile two
// Machines' identically-named, differently-shaped events.

test("each Machine node carries its OWN vocabulary; nothing is flattened to the root", () => {
  const nested = j2Setup({
    events: [defineEvent({ name: "approve", input: z.object({ score: z.number() }) })],
  }).createMachine({
    id: "nested",
    initial: "waiting",
    states: { waiting: { on: { approve: "done" } }, done: { type: "final" } },
  });
  const top = j2Setup({
    events: [defineEvent({ name: "approve", audience: "external", input: z.object({ note: z.string() }) })],
    actors: { nested },
  }).createMachine({
    id: "top",
    initial: "running",
    states: {
      running: { invoke: { id: "nested", src: "nested" }, on: { approve: "done" } },
      done: { type: "final" },
    },
  });

  const doc = serializeMachine("nested-wf", top);
  assert.deepEqual(
    doc.events.map((e) => e.name),
    ["approve"],
  );
  assert.equal(doc.events[0]?.audience, "external");
  assert.deepEqual((doc.events[0]?.input as { required?: string[] }).required, ["note"]);

  // The child node carries the OTHER `approve` — same name, its own schema and audience.
  const child = findState(doc.root, "top.running")!.children[0]!.machine!;
  assert.equal(child.id, "nested");
  assert.equal(child.events[0]?.audience, "any");
  assert.deepEqual((child.events[0]?.input as { required?: string[] }).required, ["score"]);
});

test("a machine not built by j2Setup declares no events", () => {
  assert.deepEqual(parentDoc.events, []);
  assert.deepEqual(wrapperDoc().events, []);
});

test("a workspace() body joins on the stable slot name `body`, not a generated key (ADR-0049)", async () => {
  // The wrapper invokes its body as a NAMED slot now, so the string the Console joins structure and
  // live state on is `body` at both ends — readable, stable under an edit to any sibling invoke,
  // and the same string `provide()`, `customize()` and the parts walk reach the body by. It IS a
  // shape change: a snapshot written under the old inline key fingerprints differently and a run
  // parked across the upgrade is refused, which is exactly ADR-0030's contract.
  const { workspace } = await import("../src/workspace.ts");
  const inner = createMachine({ id: "body", initial: "coding", states: { coding: {}, shipped: { type: "final" } } });
  const wrapped = workspace(inner, { spec: () => ({ repos: [{ name: "app" }], branch: "b" }) });

  const doc = serializeMachine("wrapped", wrapped);
  const running = findState(doc.root, "workspace.running")!;
  const child = running.children.find((c) => c.label === "body")!;
  assert.equal(child.src, "body", "the join key is the slot name");
  assert.equal(child.machine?.id, "body");
  // And every one of the wrapper's own actors is named too, so a reader sees what each state does.
  assert.deepEqual(
    findState(doc.root, "workspace.provisioning")!.invoke.map((i) => i.src),
    ["provision"],
  );
  assert.deepEqual(
    running.invoke.map((i) => i.src),
    ["registrar", "body", "lease"],
  );
});
