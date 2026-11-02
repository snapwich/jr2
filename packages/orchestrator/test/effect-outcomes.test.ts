// Each Effect outcome is open (ADR-0075). The unions hold a stand-in member, so no author can write
// an exhaustive check, and the walk refuses an `onDone` whose last arm has a guard, because an
// output that no arm matches would hold the run in that state with no fault.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, type AnyStateMachine, type UnknownActorLogic } from "xstate";
import type { CommandOutput, DispatchOutput, LaterOutcome } from "../src/effect.ts";
import type { HttpOutput } from "../src/effector-wire.ts";
import { command } from "../src/harness-client.ts";
import { partsOf } from "../src/parts.ts";
import type { PushOutput } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import type { WorktreeOutput } from "../src/worktree.ts";

// --- The open unions: compile checks, which `tsc --noEmit` runs --------------------------------

/** The stand-in member of each union. An author's type that drops it does not compile. */
const later: LaterOutcome = { outcome: "(a later outcome)" };
export const open: [CommandOutput, HttpOutput, PushOutput, DispatchOutput, WorktreeOutput] = [
  later,
  later,
  later,
  later,
  later,
];

/** A `never` check over every outcome that the kit gives fails to compile: the stand-in is left.
 * `left` proves that the stand-in is ALL that is left, so each `never` fails for that reason alone. */
export function noExhaustiveCheck(o: {
  command: CommandOutput;
  http: HttpOutput;
  push: PushOutput;
  dispatch: DispatchOutput;
  worktree: WorktreeOutput;
}): void {
  if (
    o.command.outcome !== "exited" &&
    o.command.outcome !== "timeout" &&
    o.command.outcome !== "killed" &&
    o.command.outcome !== "unknown"
  ) {
    const left: LaterOutcome = o.command;
    void left;
    // @ts-expect-error the stand-in is left
    const rest: never = o.command;
    void rest;
  }
  if (o.worktree.outcome !== "ready" && o.worktree.outcome !== "refused" && o.worktree.outcome !== "unknown") {
    const left: LaterOutcome = o.worktree;
    void left;
    // @ts-expect-error the stand-in is left
    const rest: never = o.worktree;
    void rest;
  }
  if (
    o.push.outcome !== "pushed" &&
    o.push.outcome !== "rejected" &&
    o.push.outcome !== "diverged" &&
    o.push.outcome !== "unknown"
  ) {
    const left: LaterOutcome = o.push;
    void left;
    // @ts-expect-error the stand-in is left
    const rest: never = o.push;
    void rest;
  }
  if (
    o.dispatch.outcome !== "started" &&
    o.dispatch.outcome !== "settled" &&
    o.dispatch.outcome !== "refused" &&
    o.dispatch.outcome !== "unreachable" &&
    o.dispatch.outcome !== "unknown"
  ) {
    const left: LaterOutcome = o.dispatch;
    void left;
    // @ts-expect-error the stand-in is left
    const rest: never = o.dispatch;
    void rest;
  }
  if (
    o.http.outcome !== "response" &&
    o.http.outcome !== "unreachable" &&
    o.http.outcome !== "refused" &&
    o.http.outcome !== "unknown"
  ) {
    // By `outcome`: one member of this union holds three of them, so no check removes that member.
    const left: LaterOutcome["outcome"] = o.http.outcome;
    void left;
    // @ts-expect-error the stand-in is left
    const rest: never = o.http.outcome;
    void rest;
  }
}

// --- The walk ------------------------------------------------------------------------------------

const tests = command(["npm", "test"]);

/** A Machine that runs the Effect in `outer.testing`, with this `onDone`. */
const config = (onDone?: unknown) => ({
  id: "m",
  initial: "outer",
  states: {
    outer: {
      initial: "testing",
      states: {
        testing: { invoke: { src: "tests", ...(onDone !== undefined ? { onDone } : {}) } },
      },
    },
    passed: { type: "final" as const },
    other: { type: "final" as const },
  },
});

const passed = ({ event }: { event: { output: CommandOutput } }): boolean => event.output.outcome === "exited";

const build = (onDone?: unknown): AnyStateMachine =>
  jr2Setup({ actors: { tests } }).createMachine(config(onDone) as never) as unknown as AnyStateMachine;

/** A Machine that `jr2Setup` did not make: only the load walk reads it. */
const plain = (onDone?: unknown): AnyStateMachine =>
  setup({ actors: { tests: tests as unknown as UnknownActorLogic } }).createMachine(
    config(onDone) as never,
  ) as unknown as AnyStateMachine;

const REFUSED =
  /machine "m": state "m\.outer\.testing" \(Effect "tests"\) has an onDone with no unguarded last arm — .*add a last arm with no guard, as onDone: \[\.\.\., \{ target: "<the state that handles the rest>" \}\] \(ADR-0075\)$/;

test("the walk refuses an onDone whose one arm has a guard, and names the state and the fix", () => {
  assert.throws(() => build({ guard: passed, target: "#m.passed" }), REFUSED);
});

test("the walk refuses an onDone whose last arm has a guard", () => {
  const arms = [
    { guard: passed, target: "#m.passed" },
    { guard: passed, target: "#m.other" },
  ];
  assert.throws(() => build(arms), REFUSED);
  assert.throws(() => partsOf([plain(arms)]), REFUSED);
});

test("the load walk refuses a Machine that jr2Setup did not make", () => {
  assert.throws(() => partsOf([plain({ guard: passed, target: "#m.passed" })]), REFUSED);
});

test("the refusal names each state", () => {
  assert.throws(
    () =>
      jr2Setup({ actors: { tests } }).createMachine({
        id: "m",
        type: "parallel",
        states: {
          a: { invoke: { src: "tests", onDone: { guard: passed as never, actions: [] } } },
          b: { invoke: { src: "tests", onDone: { guard: passed as never, actions: [] } } },
        },
      } as never),
    /states "m\.a" \(Effect "tests"\), "m\.b" \(Effect "tests"\) have an onDone with no unguarded last arm/,
  );
});

test("an unguarded last arm passes, in each form", () => {
  for (const onDone of [
    "#m.passed",
    { target: "#m.passed" },
    [{ guard: passed, target: "#m.passed" }, { target: "#m.other" }],
    [{ guard: passed, target: "#m.passed" }, "#m.other"],
  ]) {
    assert.doesNotThrow(() => build(onDone));
    assert.doesNotThrow(() => partsOf([plain(onDone)]));
  }
});

test("no onDone at all is Rest, and passes", () => {
  assert.doesNotThrow(() => build());
  assert.doesNotThrow(() => partsOf([plain()]));
});

test("the rule is for an Effect: a child Machine's onDone may end on a guard", () => {
  const child = setup({}).createMachine({ id: "child", initial: "x", states: { x: { type: "final" } } });
  assert.doesNotThrow(() =>
    jr2Setup({ actors: { child } }).createMachine({
      id: "m",
      initial: "running",
      states: {
        running: { invoke: { src: "child", onDone: { guard: () => true, target: "done" } } },
        done: { type: "final" },
      },
    }),
  );
});
