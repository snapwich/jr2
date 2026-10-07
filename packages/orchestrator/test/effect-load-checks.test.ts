// Load checks on Effects (ADR-0067, ADR-0015): what `jr2Setup.createMachine` refuses and warns about
// where a pick enters a state that runs an Effect, and below an Agent's state. A refusal throws at
// build; a warning rides the Machine (`loadWarningsOf`) and `jr2 up` prints it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { arg, commandWith } from "../src/effect.ts";
import { answer, fromPick, paramsOf } from "../src/pick.ts";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { coderDefinition, MockFlueClient } from "./_fixtures.ts";

const EP = "http://harness.invalid";
const coder = () => agentActorWith(() => new MockFlueClient(), coderDefinition);
const never = () => {
  throw new Error("never run at load");
};
const send = defineEvent({ name: "send_email", input: z.object({ to: z.string(), subject: z.string() }) });
const finish = defineEvent({ name: "finish", input: z.object({}) });
const mail = commandWith(never, ["mail", "-s", arg("subject"), arg("to")]);

/** An Agent's state whose `send_email` pick enters `sending`, which runs `mail` with `input`. */
function build(input: unknown, actions: unknown[] = [], entry: unknown[] = []) {
  return jr2Setup({
    types: {} as { context: { subject?: string } },
    events: [send, finish],
    actors: { coder: coder(), mail },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: {
          rest: {},
          sending: { entry: entry as never, invoke: { src: "mail", input: input as never, onDone: "rest" } },
        },
        on: { send_email: { target: ".sending", actions: actions as never }, finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("fromPick reads every param that is a key of the Effect's input: no refusal", () => {
  const m = build(fromPick(send));
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a pick param that nothing reads is refused: the Agent supplies it and nothing uses it", () => {
  assert.throws(
    () => build(({ event }: { event: { to: string } }) => ({ to: event.to, subject: "fixed" })),
    (err: Error) => {
      assert.match(err.message, /pick "send_email" enters state "wf\.w\.sending" \(Effect "mail"\)/);
      assert.match(err.message, /never reads "subject"/);
      return true;
    },
  );
});

test("a param stored by an assign on the entering transition, or on the state's entry, counts as read", () => {
  const store = assign({ subject: ({ event }: { event: { subject: string } }) => event.subject });
  build(({ event }: { event: { to: string } }) => ({ to: event.to, subject: "x" }), [store]);
  build(({ event }: { event: { to: string } }) => ({ to: event.to, subject: "x" }), [], [store]);
});

test("a plain mapper with paramsOf reads them all", () => {
  build(({ event }: { event: { type: string } }) => paramsOf(event, send));
});

test("a `fill` that overwrites a param is refused: the Machine's value wins and the Agent's is dropped", () => {
  assert.throws(
    () => build(fromPick(send, () => ({ subject: "from the Machine" }))),
    /`fill` sets "subject", which is also a param of the pick/,
  );
});

/** `send_email` with a third param, `cc`, that `mail`'s argv has no slot for. */
const sendCc = defineEvent({
  name: "send_email",
  input: z.object({ to: z.string(), subject: z.string(), cc: z.string() }),
});
function buildCc(input: unknown) {
  return jr2Setup({ events: [sendCc, finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: { rest: {}, sending: { invoke: { src: "mail", input: input as never, onDone: "rest" } } },
        on: { send_email: ".sending", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("a fromPick param that is no key of the Effect's input is refused: it reaches no argv slot", () => {
  assert.throws(
    () => buildCc(fromPick(sendCc)),
    (err: Error) => {
      assert.match(err.message, /pick "send_email" enters state "wf\.w\.sending" \(Effect "mail"\) with fromPick/);
      assert.match(err.message, /"cc" is no key of the Effect's input \(subject, to\)/);
      assert.doesNotMatch(err.message, /"to"|"subject" is no key/);
      return true;
    },
  );
});

test("a fromPick param that is no key still counts as read when `fill` reads it", () => {
  const m = buildCc(fromPick(sendCc, ({ params }) => (params.cc.length > 0 ? {} : {})));
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a fromPick of ANOTHER pick is refused: the state is entered on an event that does not carry its params", () => {
  assert.throws(() => build(fromPick(finish)), /reads the params of pick "finish" but is entered on "send_email"/);
});

test("a mapper the probe cannot run is a warning, never silent", () => {
  const m = build(() => {
    throw new TypeError("boom");
  });
  assert.ok(
    loadWarningsOf(m).some((w) => /could not probe the input mapper \(boom\)/.test(w)),
    loadWarningsOf(m).join("\n"),
  );
});

test("a child of an Agent's state that invokes something and that nothing enters is refused: what it invokes never runs", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [finish], actors: { coder: coder(), mail } }).createMachine({
        id: "wf",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
            initial: "rest",
            states: { rest: {}, orphan: { invoke: { src: "mail", input: { to: "a", subject: "b" } } } },
            on: { finish: "done" },
          },
          done: { type: "final" },
        },
      }),
    /state "wf\.w\.orphan" below Agent "coder"'s state "wf\.w" is entered by nothing, so what it invokes \(mail\) never runs/,
  );
});

test("the narrow no-onDone warning: an Effect child with no onDone where the Agent's state answers on a mode's entry", () => {
  const lint = defineEvent({ name: "lint", input: z.object({}) });
  const linter = commandWith(never, ["pnpm", "lint"]);
  const m = jr2Setup({ events: [lint, finish], actors: { coder: coder(), linter } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: { rest: { entry: answer(({ chain }) => chain) }, lint: { invoke: { src: "linter" } } },
        on: { lint: ".lint", finish: "done" },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.ok(
    warnings.some((w) =>
      /"wf\.w\.lint" invokes Effect "linter" with no onDone, and "wf\.w\.rest" answers the Agent on entry/.test(w),
    ),
    warnings.join("\n"),
  );
});

test("an Effect child with no onDone beside mode picks, and no `answer`, is silent: a one-way mode on purpose", () => {
  const lint = defineEvent({ name: "lint", input: z.object({}) });
  const linter = commandWith(never, ["pnpm", "lint"]);
  const m = jr2Setup({ events: [lint, finish], actors: { coder: coder(), linter } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: { rest: {}, lint: { invoke: { src: "linter" }, on: { finish: "#wf.done" } } },
        on: { lint: ".lint" },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), [], "and an Effect is no long-lived invoke");
});
