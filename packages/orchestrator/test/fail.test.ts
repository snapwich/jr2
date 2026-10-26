// The `fail()` Part and the `failed` Run status (ADR-0073), through a real RunHost with an
// in-memory store: an uncaught Failure ends the run `failed`, with no fault and the Failure as its
// output, on every reader (the live status, the read-through, the feed, the settle hook); an
// `onError` guarded by `isFailure` catches it at any depth; a plain throw stays a defect; and the
// walk and the Machine doc list each state that invokes a `fail()` slot. The Workspace half (the
// Sandbox goes) is in workspace.test.ts, beside the fake Sandbox port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, fromPromise, setup, toPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { fail, failLogic, isFailSlot, isFailure } from "../src/fail.ts";
import * as surface from "../src/index.ts";
import * as internal from "../src/internal.ts";
import { serializeMachine } from "../src/machine-doc.ts";
import { partsOf } from "../src/parts.ts";
import { RunHost, type RunFeedEvent, type RunStatus, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const def = (name: string, machine: unknown): WorkflowDef => ({ name, machine: machine as never, provide: () => ({}) });

async function host(...defs: WorkflowDef[]): Promise<RunHost> {
  const h = new RunHost({ store: await mkStore() });
  for (const d of defs) h.register(d);
  return h;
}

async function settled(h: RunHost, runId: string): Promise<RunStatus> {
  await waitFor(() => h.status(runId) === undefined);
  return (await h.read(runId))!;
}

// --- The Part and the guard ----------------------------------------------------------------------

test("the surface names fail and isFailure, and nothing that makes or reads the brand another way", () => {
  assert.equal(typeof surface.fail, "function");
  assert.equal(typeof surface.isFailure, "function");
  for (const name of ["failLogic", "failurePayload", "isFailSlot"]) assert.ok(!(name in surface), name);
  // The kit's own packages read a Failure through internal, but get no second way to make one.
  assert.ok(!("failLogic" in internal), "internal does not export the logic that throws a Failure");
});

test("isFailure is true only for the error a fail() slot throws: never a plain Error, nor a look-alike", async () => {
  const thrown = await toPromise(createActor(fail(), { input: { reason: "r", detail: { n: 1 } } }).start()).then(
    () => assert.fail("fail() never resolves"),
    (e: unknown) => e,
  );
  assert.ok(isFailure(thrown));
  assert.equal(thrown.reason, "r");
  assert.deepEqual(thrown.detail, { n: 1 });
  assert.ok(thrown instanceof Error, "an Error, so a stack and a message ride it");
  assert.equal((thrown as Error).message, "r");

  assert.ok(!isFailure(new Error("r")));
  assert.ok(!isFailure({ reason: "r" }), "the fields alone are not a Failure");
  assert.ok(!isFailure(Object.assign(new Error("r"), { reason: "r", name: "Failure" })));
  assert.ok(!isFailure(undefined));
  assert.ok(!isFailure("r"));
});

test("an input that is not a Failure's is a defect, with the slot form", async () => {
  for (const input of [undefined, {}, { reason: "" }, { reason: 7 }]) {
    const err = await toPromise(createActor(fail(), { input: input as never }).start()).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(!isFailure(err), JSON.stringify(input));
    assert.match((err as Error).message, /^fail: the input must be \{ reason: string; detail\?: unknown \}/);
  }
});

test("each fail() slot carries the brand the walk reads; the logic workspace() sends a Failure up with does not", () => {
  const a = fail();
  const b = fail();
  assert.ok(isFailSlot(a) && isFailSlot(b));
  assert.notEqual(a, b, "a logic of its own per slot");
  assert.ok(!isFailSlot(failLogic));
  assert.ok(!isFailSlot(fromPromise(async () => {})));
});

// --- The run host --------------------------------------------------------------------------------

const go = defineEvent({ name: "go", input: z.object({}) });
const failing = jr2Setup({ events: [go], actors: { fail: fail() } }).createMachine({
  id: "failing",
  initial: "waiting",
  states: {
    waiting: { invoke: { src: "gate", id: "ctl" }, on: { go: "giving-up" } },
    "giving-up": { invoke: { src: "fail", input: { reason: "the tests did not pass", detail: { failed: 3 } } } },
  },
  output: () => ({ never: "the Machine's output type" }),
});

test("an uncaught Failure ends the run `failed`: no fault, the Failure as output, on the read and the feed", async () => {
  const h = await host(def("failing", failing));
  const { runId } = await h.start("failing");
  const feed: RunFeedEvent[] = [];
  h.subscribe(runId, (ev) => feed.push(ev));
  await waitFor(() => h.gates(runId).length === 1);
  h.sendToGate(runId, "ctl", { type: "go" });
  const s = await settled(h, runId);
  assert.equal(s.status, "failed");
  assert.equal(s.fault, undefined, "a Failure is not a fault");
  assert.deepEqual(s.output, { reason: "the tests did not pass", detail: { failed: 3 } });
  assert.deepEqual(s.value, "giving-up", "where it failed");
  const last = feed.filter((e) => e.kind === "status").at(-1) as { status: RunStatus };
  assert.equal(last.status.status, "failed");
  assert.deepEqual(last.status.output, s.output);
});

test("the settle hook hears `failed`, live and from the store", async () => {
  const h = await host(def("failing", failing));
  const { runId } = await h.start("failing");
  const heard: RunStatus[] = [];
  h.onSettled(runId, (s) => heard.push(s));
  await waitFor(() => h.gates(runId).length === 1);
  h.sendToGate(runId, "ctl", { type: "go" });
  await waitFor(() => heard.length === 1);
  assert.equal(heard[0]!.status, "failed");
  assert.deepEqual(heard[0]!.output, { reason: "the tests did not pass", detail: { failed: 3 } });
  const later: RunStatus[] = [];
  h.onSettled(runId, (s) => later.push(s));
  await waitFor(() => later.length === 1);
  assert.equal(later[0]!.status, "failed");
});

test("a Failure goes up through a nested Machine with no onError, and the run ends `failed`", async () => {
  const inner = jr2Setup({ actors: { stop: fail() } }).createMachine({
    id: "inner",
    initial: "stuck",
    states: { stuck: { invoke: { src: "stop", input: { reason: "no plan fits" } } } },
  });
  const middle = setup({ actors: { inner } }).createMachine({
    id: "middle",
    initial: "run",
    states: { run: { invoke: { src: "inner", onDone: "done" } }, done: { type: "final" } },
  });
  const root = jr2Setup({ actors: { middle } }).createMachine({
    id: "root",
    initial: "run",
    states: { run: { invoke: { src: "middle", onDone: "done" } }, done: { type: "final" } },
  });
  const h = await host(def("root", root));
  const s = await settled(h, (await h.start("root")).runId);
  assert.equal(s.status, "failed");
  assert.deepEqual(s.output, { reason: "no plan fits" }, "no `detail` key when none was given");
});

test("an onError guarded by isFailure catches a Failure; a defect passes the guard by and ends the run `error`", async () => {
  const failed = jr2Setup({ actors: { stop: fail() } }).createMachine({
    id: "failed",
    initial: "s",
    states: { s: { invoke: { src: "stop", input: { reason: "caught on the way up" } } } },
  });
  const broken = jr2Setup({
    actors: {
      boom: fromPromise(async () => {
        throw new Error("a bug in the step");
      }),
    },
  }).createMachine({ id: "broken", initial: "s", states: { s: { invoke: { src: "boom" } } } });
  const parentOf = (child: typeof failed | typeof broken) =>
    jr2Setup({ actors: { child } }).createMachine({
      id: "parent",
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "child",
            onDone: "done",
            onError: { guard: ({ event }) => isFailure(event.error), target: "replanned" },
          },
        },
        replanned: { type: "final" },
        done: { type: "final" },
      },
    });
  const h = await host(def("caught", parentOf(failed)), def("defect", parentOf(broken)));
  const caught = await settled(h, (await h.start("caught")).runId);
  assert.equal(caught.status, "done");
  assert.equal(caught.value, "replanned");
  const defect = await settled(h, (await h.start("defect")).runId);
  assert.equal(defect.status, "error", "a plain throw stays a defect");
  assert.equal(defect.fault, "a bug in the step");
  assert.equal(defect.output, undefined);
});

// --- The walk and the Machine doc ---------------------------------------------------------------

test("the walk lists each state that invokes a fail() slot, nested Machines too", () => {
  const inner = jr2Setup({ actors: { giveUp: fail() } }).createMachine({
    id: "inner",
    initial: "a",
    states: { a: { initial: "b", states: { b: { invoke: { src: "giveUp", input: { reason: "r" } } } } } },
  });
  const root = jr2Setup({ actors: { inner, fail: fail() } }).createMachine({
    id: "root",
    initial: "work",
    states: {
      work: { invoke: { src: "inner", onDone: "done" } },
      lost: { invoke: { src: "fail", input: { reason: "lost" } } },
      done: { type: "final" },
    },
  });
  assert.deepEqual(partsOf([root]).failures, [
    { machine: "root", state: "root.lost", slot: "fail", path: [] },
    { machine: "inner", state: "inner.a.b", slot: "giveUp", path: ["inner"] },
  ]);
  const doc = serializeMachine("root", root);
  const lost = doc.root.states.find((s) => s.key === "lost")!;
  assert.deepEqual(lost.invoke, [{ id: lost.invoke[0]!.id, src: "fail", fail: true }]);
  const work = doc.root.states.find((s) => s.key === "work")!;
  assert.equal(work.invoke[0]!.fail, undefined, "a child Machine's slot is no fail()");
  const innerDoc = work.children[0]!.machine!;
  assert.equal(innerDoc.root.states[0]!.states[0]!.invoke[0]!.fail, true, "the nested state, in its own body");
});

test("a fail() written inline on an invoke is refused, with the slot form", () => {
  assert.throws(
    () =>
      jr2Setup().createMachine({
        id: "inline",
        initial: "a",
        states: { a: { invoke: { src: fail() as never, input: { reason: "r" } } } },
      }),
    /state "inline\.a" invokes a fail\(\) Part inline — .*actors: \{ <name>: fail\(\) \}/,
  );
});
