// What `placeAnswers` (pick.ts, ADR-0067) writes into the pinned xstate's StateNodes — plain xstate
// Machines, no jr2 host. `placeAnswers` replaces, after `createMachine` and before the actor runs, a
// state's `entry` and `exit` lists and the `actions` list of each transition object it reads off
// `transitions`, `always` and `initial`. Each test pins one fact that rests on: xstate reads those
// same lists and objects when the Machine runs. This file is the canary for an xstate bump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, createMachine, type AnyStateMachine } from "xstate";
import { answer, placeAnswers } from "../src/pick.ts";

type Node = AnyStateMachine["root"];
type Writable = { entry: unknown[]; exit: unknown[] };
type TransitionObject = { actions: readonly unknown[] };

/** A Machine whose `a` state has an entry, an exit, an event transition, an `always` transition
 * and an initial transition, each with an action that records its name. */
function shaped(ran: string[]) {
  const note = (name: string) => () => void ran.push(name);
  return createMachine({
    id: "m",
    initial: "a",
    context: { go: false },
    states: {
      a: {
        entry: note("entry: author"),
        exit: note("exit: author"),
        initial: { target: "one", actions: note("initial: author") },
        states: {
          one: { always: { guard: ({ context }) => context.go, target: "two", actions: note("always: author") } },
          two: {},
        },
        on: { go: { target: "b", actions: note("on: author") } },
      },
      b: {},
    },
  });
}

test("xstate runs a state's `entry` and `exit` lists as they are after createMachine: a list replaced on the StateNode is what runs", () => {
  const ran: string[] = [];
  const machine = shaped(ran);
  const a = machine.root.states.a as Node;
  assert.ok(Array.isArray(a.entry) && Array.isArray(a.exit), "entry and exit are arrays on the StateNode");
  (a as unknown as Writable).entry = [() => void ran.push("entry: replaced")];
  (a as unknown as Writable).exit = [() => void ran.push("exit: replaced")];
  const actor = createActor(machine).start();
  actor.send({ type: "go" });
  assert.ok(ran.includes("entry: replaced") && !ran.includes("entry: author"), JSON.stringify(ran));
  assert.ok(ran.includes("exit: replaced") && !ran.includes("exit: author"), JSON.stringify(ran));
});

test("xstate selects the transition objects `transitions`, `always` and `initial` hold: their `actions` replaced is what runs", () => {
  const ran: string[] = [];
  const machine = shaped(ran);
  const a = machine.root.states.a as Node;
  const one = a.states.one as Node;
  assert.ok(a.transitions instanceof Map, "`transitions` is a Map of event type to transition objects");
  const onGo = a.transitions.get("go") as unknown as TransitionObject[];
  assert.equal(onGo.length, 1);
  assert.ok(Array.isArray(one.always) && one.always.length === 1, "`always` is a list of transition objects");
  assert.ok(a.initial && Array.isArray((a.initial as unknown as TransitionObject).actions), "`initial` is one");
  assert.equal(a.initial, a.initial, "`initial` reads the same object each time");
  onGo[0]!.actions = [() => void ran.push("on: replaced")];
  (a.initial as unknown as TransitionObject).actions = [() => void ran.push("initial: replaced")];
  const actor = createActor(machine).start();
  assert.ok(ran.includes("initial: replaced") && !ran.includes("initial: author"), JSON.stringify(ran));
  actor.send({ type: "go" });
  assert.ok(ran.includes("on: replaced") && !ran.includes("on: author"), JSON.stringify(ran));
  // An `always` transition whose guard is true at once. Replaced before the actor is created: the
  // actor computes its first state as it is created, so `placeAnswers` runs before that.
  const eventless = createMachine({
    initial: "x",
    context: { go: true },
    states: {
      x: { always: { guard: ({ context }) => context.go, target: "y", actions: () => void ran.push("x") } },
      y: {},
    },
  });
  const x = eventless.root.states.x as Node;
  (x.always![0] as unknown as TransitionObject).actions = [() => void ran.push("always: replaced")];
  createActor(eventless).start();
  assert.ok(ran.includes("always: replaced") && !ran.includes("x"), JSON.stringify(ran));
});

test("placeAnswers replaces each list that holds an `answer` with a list of its own, and leaves the author's list as it was", () => {
  const shaping = answer(() => "shaped");
  const authorEntry = [shaping];
  const machine = createMachine({
    id: "m",
    initial: "a",
    states: {
      a: {
        entry: authorEntry,
        exit: shaping,
        initial: { target: "one", actions: shaping },
        states: { one: { always: { guard: () => false, target: "two", actions: shaping } }, two: {} },
        on: { go: { target: "b", actions: shaping } },
      },
      b: {},
    },
  });
  const a = machine.root.states.a as Node;
  const one = a.states.one as Node;
  const before = {
    entry: a.entry,
    exit: a.exit,
    on: (a.transitions.get("go") as unknown as TransitionObject[])[0]!.actions,
    always: (one.always![0] as unknown as TransitionObject).actions,
    initial: (a.initial as unknown as TransitionObject).actions,
  };
  placeAnswers(machine);
  const after = {
    entry: a.entry,
    exit: a.exit,
    on: (a.transitions.get("go") as unknown as TransitionObject[])[0]!.actions,
    always: (one.always![0] as unknown as TransitionObject).actions,
    initial: (a.initial as unknown as TransitionObject).actions,
  };
  for (const place of Object.keys(before) as (keyof typeof before)[]) {
    assert.notEqual(after[place], before[place], `${place}: a list of its own`);
    assert.equal(after[place].length, 1, `${place}: one action still`);
    assert.notEqual(after[place][0], shaping, `${place}: the placed copy, not the author's action`);
  }
  assert.deepEqual(authorEntry, [shaping], "the author's list is unchanged");
});
