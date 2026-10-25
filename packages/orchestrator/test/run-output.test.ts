// The output of a run (ADR-0015): xstate v5 gives a run only its root `output`, so the load walk
// refuses a Machine that writes an `output` on a final state below its root and has no root
// `output`. A final state inside a compound state feeds that state's `onDone` and stays legal, as
// does a Machine with no `output` at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, toPromise } from "xstate";
import { jr2Setup } from "../src/setup.ts";
import { partsOf } from "../src/parts.ts";

const REFUSAL =
  /machine "lost": final state "lost\.done" declares an output, and the root has no output — xstate v5 gives a run only its root output, so this output reaches nothing and the run ends with none: write it at the root, as output: \(\{ context \}\) => \.\.\., or keep it on the final state and pass it on with output: \(\{ event \}\) => event\.output at the root$/;

const lostConfig = {
  id: "lost",
  initial: "done",
  states: { done: { type: "final" as const, output: { outcome: "done" } } },
};

test("xstate v5 itself: a final state's output with no root output gives the run no output", async () => {
  // The fact the refusal stands on. When xstate changes it, this test fails first.
  const lost = setup({}).createMachine(lostConfig);
  assert.equal(await toPromise(createActor(lost).start()), undefined);
  const passed = setup({}).createMachine({ ...lostConfig, output: ({ event }) => event.output });
  assert.deepEqual(await toPromise(createActor(passed).start()), { outcome: "done" });
});

test("jr2Setup's createMachine refuses a final state's output when the root has no output, and names the fix", () => {
  assert.throws(() => jr2Setup({ events: [] }).createMachine(lostConfig), REFUSAL);
});

test("the refusal names each final state below the root that declares an output", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [] }).createMachine({
        id: "two",
        initial: "a",
        states: {
          a: { always: "ok" },
          ok: { type: "final", output: { ok: true } },
          bad: { type: "final", output: { ok: false } },
          quiet: { type: "final" },
        },
      }),
    /machine "two": final states "two\.ok", "two\.bad" declare an output, and the root has no output/,
  );
});

test("the load walk refuses the same shape in a Machine built with xstate's setup(), also as an invoked child", () => {
  assert.throws(() => partsOf([setup({}).createMachine(lostConfig)]), REFUSAL);
  const child = setup({}).createMachine(lostConfig);
  const parent = setup({ actors: { child } }).createMachine({
    id: "parent",
    initial: "running",
    states: { running: { invoke: { src: "child", onDone: "done" } }, done: { type: "final" } },
  });
  assert.throws(() => partsOf([parent]), REFUSAL);
});

test("legal: a root output, a final state inside a compound state, and a Machine with no output", () => {
  const build = jr2Setup({ events: [] });
  // A root output, from the final state or from context.
  build.createMachine({ ...lostConfig, id: "passed", output: ({ event }) => event.output });
  build.createMachine({ ...lostConfig, id: "fromContext", output: () => ({ outcome: "done" }) });
  // A final state in a compound state: its output is the `event.output` of the compound's onDone.
  const nested = build.createMachine({
    id: "nested",
    initial: "work",
    context: { outcome: "" },
    states: {
      work: {
        initial: "step",
        states: { step: { type: "final", output: { outcome: "inner" } } },
        onDone: "done",
      },
      done: { type: "final" },
    },
  });
  build.createMachine({ id: "silent", initial: "done", states: { done: { type: "final" } } });
  assert.doesNotThrow(() => partsOf([nested]));
});
