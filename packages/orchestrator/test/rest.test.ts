// Rest (rest.ts, ADR-0024): the condition of an Agent's state under which a pick is answered — read
// off raw xstate, one shape per child kind. `s` invokes the Agent (an idle callback, invoke id
// `agent`) and starts in `idle`; the pick `go` enters the case's child `x`. Every reading is taken
// after the mailbox drained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assign,
  createActor,
  createMachine,
  fromCallback,
  fromPromise,
  raise,
  sendTo,
  setup,
  type AnyActor,
  type AnyStateMachine,
} from "xstate";
import { restOf } from "../src/rest.ts";
import { pendingTimers, startAndRearm } from "../src/timers.ts";

const idle = fromCallback(() => () => {});

function controllable() {
  let settle: ((v: unknown) => void) | undefined;
  const logic = fromPromise(() => new Promise((resolve) => (settle = resolve)));
  return { logic, settle: (v: unknown) => settle?.(v) };
}

function shape(children: Record<string, unknown>, actors: Record<string, unknown> = {}, sOn: object = {}) {
  return setup({ actors: { agentA: idle, ...actors } as never }).createMachine({
    id: "m",
    initial: "s",
    states: {
      s: {
        invoke: { src: "agentA", id: "agent" },
        initial: "idle",
        on: { go: ".x", ...sOn } as never,
        states: { idle: {}, ...children } as never,
      },
      out: {},
    },
  } as never) as unknown as AnyStateMachine;
}

const reading = (actor: AnyActor) => restOf({ invoker: actor, invokeId: "agent" });
const drained = () => sleep(0);

async function picked(machine: AnyStateMachine): Promise<AnyActor> {
  const actor = createActor(machine);
  actor.start();
  assert.equal(reading(actor), "rest", "at Rest before the pick");
  actor.send({ type: "go" });
  await drained();
  return actor;
}

test("an Effect stand-in (a promise) with onDone back: busy while it runs, Rest when it settles", async () => {
  const p = controllable();
  const actor = await picked(shape({ x: { invoke: { src: "p", onDone: "idle" } } }, { p: p.logic }));
  assert.equal(reading(actor), "busy");
  p.settle("ok");
  await sleep(5);
  assert.equal(reading(actor), "rest");
  actor.stop();
});

test("a settled child with no onDone is Rest: a forgotten route cannot hang a Turn", async () => {
  const p = controllable();
  const actor = await picked(shape({ x: { invoke: { src: "p" } } }, { p: p.logic }));
  assert.equal(reading(actor), "busy");
  p.settle("ok");
  await sleep(5);
  assert.deepEqual(actor.getSnapshot().value, { s: "x" }, "still in x");
  assert.equal(reading(actor), "rest");
  actor.stop();
});

test("a Gate (an invoked callback) holds until its answer routes; an answer with no target keeps it open", async () => {
  const routed = await picked(shape({ x: { invoke: { src: "g" }, on: { approve: "idle" } } }, { g: idle }));
  assert.equal(reading(routed), "busy");
  routed.send({ type: "approve" });
  await drained();
  assert.equal(reading(routed), "rest");
  routed.stop();

  const stays = await picked(
    shape({ x: { invoke: { src: "g" }, on: { approve: { actions: assign({}) } } } }, { g: idle }),
  );
  stays.send({ type: "approve" });
  await drained();
  assert.equal(reading(stays), "busy", "answered, still held: the Gate stays live in x");
  stays.stop();
});

test("another Agent and a child Machine are each running something", async () => {
  const advisor = fromCallback(({ sendBack }) => {
    const t = setTimeout(() => sendBack({ type: "advice" }), 5);
    return () => clearTimeout(t);
  });
  const nested = await picked(shape({ x: { invoke: { src: "adv" }, on: { advice: "idle" } } }, { adv: advisor }));
  assert.equal(reading(nested), "busy");
  await sleep(20);
  assert.equal(reading(nested), "rest");
  nested.stop();

  const kid = createMachine({ initial: "w", states: { w: { after: { 5: "f" } }, f: { type: "final" } } });
  const child = await picked(shape({ x: { invoke: { src: "k", onDone: "idle" } } }, { k: kid }));
  assert.equal(reading(child), "busy");
  await sleep(20);
  assert.equal(reading(child), "rest");
  child.stop();
});

test("a timer holds when it moves the workflow inside the Agent's state — `after`, a delayed raise, a delayed sendTo(self)", async () => {
  for (const x of [
    { after: { 10: "idle" } },
    { entry: raise({ type: "TICK" }, { delay: 10 }), on: { TICK: "idle" } },
    { entry: sendTo(({ self }) => self, { type: "TICK" }, { delay: 10 }), on: { TICK: "idle" } },
  ]) {
    const actor = await picked(shape({ x }));
    assert.equal(reading(actor), "busy", JSON.stringify(Object.keys(x)));
    await sleep(30);
    assert.equal(reading(actor), "rest");
    actor.stop();
  }
});

test("a timer that leaves the Agent's state (a Turn timeout) does not hold a pick", async () => {
  const machine = setup({ actors: { agentA: idle } }).createMachine({
    id: "m",
    initial: "s",
    states: {
      s: {
        invoke: { src: "agentA", id: "agent" },
        after: { 60_000: "out" },
        initial: "idle",
        on: { go: ".x" },
        states: { idle: {}, x: {} },
      },
      out: {},
    },
  });
  const actor = await picked(machine as unknown as AnyStateMachine);
  assert.equal(reading(actor), "rest");
  actor.stop();
});

test("the Agent's state no longer active reads `gone`: the Turn is over", async () => {
  const actor = await picked(shape({ x: {} }, {}, { leave: "#m.out" }));
  actor.send({ type: "leave" });
  await drained();
  assert.equal(reading(actor), "gone");
  actor.stop();
});

test("Rest is computed over the SET of active states below the Agent's state: one region busy is busy", async () => {
  const p = controllable();
  const machine = setup({ actors: { agentA: idle, p: p.logic } }).createMachine({
    id: "m",
    initial: "s",
    states: {
      s: {
        invoke: { src: "agentA", id: "agent" },
        type: "parallel",
        states: {
          a: { initial: "quiet", states: { quiet: {} } },
          b: { initial: "work", states: { work: { invoke: { src: "p", onDone: "done" } }, done: {} } },
        },
      },
    },
  });
  const actor = createActor(machine);
  actor.start();
  await drained();
  assert.equal(reading(actor), "busy");
  p.settle(1);
  await sleep(5);
  assert.equal(reading(actor), "rest");
  actor.stop();
});

test("the same reading after a restore: the timer table comes back, and so does the hold", async () => {
  const machine = shape({ x: { after: { 200: "idle" } } });
  const first = await picked(machine);
  assert.equal(reading(first), "busy");
  const snapshot = first.getPersistedSnapshot();
  const timers = pendingTimers(first);
  first.stop();

  const restored = createActor(machine, { snapshot });
  startAndRearm(restored, timers);
  await drained();
  assert.equal(reading(restored), "busy", "the re-armed `after` holds as before the restart");
  await sleep(250);
  assert.equal(reading(restored), "rest");
  restored.stop();
});
