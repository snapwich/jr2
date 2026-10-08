// Load checks on Effects (ADR-0067, ADR-0015): what `jr2Setup.createMachine` refuses and warns about
// where a pick enters a state that runs an Effect, and below an Agent's state. A refusal throws at
// build; a warning rides the Machine (`loadWarningsOf`) and `jr2 up` prints it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { and, assign, fromPromise } from "xstate";
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
function build(input: unknown, actions: unknown[] = [], entry: unknown[] = [], guard?: unknown) {
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
        on: {
          send_email: { target: ".sending", actions: actions as never, ...(guard ? { guard: guard as never } : {}) },
          finish: "done",
        },
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

const toOnly = ({ event }: { event: { to: string } }) => ({ to: event.to, subject: "fixed" });

test("a param the entering transition's guard reads counts as read: the guard is run, inline or inside and()", () => {
  const spam = ({ event }: { event: { subject: string } }) => event.subject !== "spam";
  assert.deepEqual(loadWarningsOf(build(toOnly, [], [], spam)), []);
  assert.deepEqual(loadWarningsOf(build(toOnly, [], [], and([spam as never, () => true]))), []);
});

test("an action the walk does not run may read a param: a warning that names it, never a refusal", () => {
  const onEntry = ({ event }: { event: { subject: string } }) => void String(event.subject);
  for (const m of [build(toOnly, [], [onEntry]), build(toOnly, [onEntry])]) {
    const warnings = loadWarningsOf(m);
    assert.ok(
      warnings.some((w) =>
        /nothing the walk can run reads "subject"; an action it does not run \(an inline action\)/.test(w),
      ),
      warnings.join("\n"),
    );
  }
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

/** `send_email` enters `sending`, which invokes every one of `invokes` (the state's work, and a
 * second invoke beside it with no `onDone`). */
const audit = fromPromise(async () => undefined);
function buildTwo(invokes: unknown[]) {
  return jr2Setup({ events: [send, finish], actors: { coder: coder(), mail, audit } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: { rest: {}, sending: { invoke: invokes as never } },
        on: { send_email: ".sending", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("the check is per state: two invokes that each read a different param read them all — no refusal", () => {
  const m = buildTwo([
    { src: "mail", input: ({ event }: { event: { to: string } }) => ({ to: event.to, subject: "s" }), onDone: "rest" },
    { src: "mail", input: ({ event }: { event: { subject: string } }) => ({ to: "x", subject: event.subject }) },
  ]);
  assert.deepEqual(loadWarningsOf(m), []);
});

test("an invoke beside the Effect that is no Effect reads a param too: no refusal", () => {
  const m = buildTwo([
    {
      src: "mail",
      input: ({ event }: { event: { to: string } }) => ({ to: event.to, subject: "s" }),
      onDone: "rest",
    },
    { src: "audit", input: ({ event }: { event: { subject: string } }) => ({ line: event.subject }) },
  ]);
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a param that no invoke of the state reads is still refused, once, naming every Effect", () => {
  assert.throws(
    () =>
      buildTwo([
        {
          src: "mail",
          input: ({ event }: { event: { to: string } }) => ({ to: event.to, subject: "s" }),
          onDone: "rest",
        },
        { src: "mail", id: "again", input: { to: "x", subject: "y" } },
      ]),
    (err: Error) => {
      assert.match(
        err.message,
        /pick "send_email" enters state "wf\.w\.sending" \(Effects "mail", "mail"\), which never reads "subject"/,
      );
      assert.equal(err.message.match(/never reads/g)?.length, 1);
      return true;
    },
  );
});

test("a fromPick param that is no key still counts as read when `fill` reads it", () => {
  const m = buildCc(fromPick(sendCc, ({ params }) => (params.cc.length > 0 ? {} : {})));
  assert.deepEqual(loadWarningsOf(m), []);
});

/**
 * An Agent's state whose `send_email` pick targets `pick` (a path below `w`), where `work` is a
 * compound state: `work` and `inner` are given as configs.
 */
function buildNested(pick: string, work: Record<string, unknown>) {
  return jr2Setup({
    types: {} as { context: { to?: string; subject?: string } },
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
        states: { rest: {}, work: work as never },
        on: { send_email: pick, finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("an assign on the entry of an ANCESTOR the pick enters counts as read: the pick targets it, its initial child invokes", () => {
  const m = buildNested(".work", {
    entry: assign({
      to: ({ event }: { event: { to: string } }) => event.to,
      subject: ({ event }: { event: { subject: string } }) => event.subject,
    }),
    initial: "run",
    states: { run: { invoke: { src: "mail", input: { to: "fixed@x", subject: "fixed" }, onDone: "#wf.w.rest" } } },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a pick that targets a NON-initial child of the state that invokes enters that state too: its unread params are refused", () => {
  const work = {
    invoke: { src: "mail", input: { to: "fixed@x", subject: "fixed" }, onDone: "rest" },
    initial: "a",
    states: { a: {}, inner: {} },
  };
  for (const pick of [".work", ".work.inner"]) {
    assert.throws(
      () => buildNested(pick, work),
      (err: Error) => {
        assert.match(err.message, /pick "send_email" enters state "wf\.w\.work" \(Effect "mail"\)/, pick);
        assert.match(err.message, /never reads "to", "subject"/, pick);
        return true;
      },
    );
  }
});

test("a transition inside the state that invokes does not enter it: the Effect is not started by that pick", () => {
  // `send_email` moves `work.a` to `work.inner`; `work` stays active and its Effect keeps running.
  const m = jr2Setup({ events: [send, finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "work",
        states: {
          work: {
            invoke: { src: "mail", input: { to: "fixed@x", subject: "fixed" }, onDone: "rest" },
            initial: "a",
            states: { a: { on: { send_email: "inner" } }, inner: {} },
          },
          rest: {},
        },
        on: { finish: "done" },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

/** `send_email` enters `prep`, whose eventless `always` enters `sending`, which runs `mail`. */
function viaAlways(input: unknown, always: Record<string, unknown> = {}) {
  return jr2Setup({ events: [send, finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: {
          rest: {},
          prep: { always: { target: "sending", ...always } as never },
          sending: { invoke: { src: "mail", input: input as never, onDone: "rest" } },
        },
        on: { send_email: ".prep", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("a pick that reaches an Effect's state through an eventless `always` is checked there: an unread param is refused", () => {
  assert.throws(
    () => viaAlways(() => ({ to: "a", subject: "b" })),
    /pick "send_email" enters state "wf\.w\.sending" \(Effect "mail"\), which never reads "to", "subject"/,
  );
  assert.throws(() => viaAlways(fromPick(finish)), /reads the params of pick "finish" but is entered on "send_email"/);
  assert.deepEqual(loadWarningsOf(viaAlways(fromPick(send))), []);
});

test("the `always` transition's guard reads the pick's event: a param it reads counts as read", () => {
  const m = viaAlways(({ event }: { event: { to: string } }) => ({ to: event.to, subject: "x" }), {
    guard: ({ event }: { event: { subject: string } }) => event.subject !== "spam",
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

// The param check is a PICK's: a Gate's event is a human's, and the Agent supplies none of it.
const approve = defineEvent({ name: "approve", audience: "external", input: z.object({ comment: z.string() }) });
const tests = commandWith(never, ["pnpm", "test"]);

test("a Gate's event that enters an Effect's state is no pick: its unread params are not refused, with no Agent", () => {
  const m = jr2Setup({ events: [approve], actors: { tests } }).createMachine({
    id: "g",
    initial: "ask",
    states: {
      ask: { invoke: { src: "gate", id: "review", input: {} }, on: { approve: "testing" } },
      testing: { invoke: { src: "tests", onDone: "done" } },
      done: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a Gate's event below an Agent's state is no pick either; the Agent's pick there is still checked", () => {
  const ok = defineEvent({ name: "ok", input: z.object({ comment: z.string() }) });
  const ask = defineEvent({ name: "ask_review", input: z.object({}) });
  const machine = (sendingInput: unknown) =>
    jr2Setup({ events: [ok, ask, send, finish], actors: { coder: coder(), tests, mail } }).createMachine({
      id: "wf",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
          initial: "rest",
          states: {
            rest: {},
            asking: { invoke: { src: "gate", id: "review", input: {} }, on: { ok: "testing" } },
            testing: { invoke: { src: "tests", onDone: "rest" } },
            sending: { invoke: { src: "mail", input: sendingInput as never, onDone: "rest" } },
          },
          on: { ask_review: ".asking", send_email: ".sending", finish: "done" },
        },
        done: { type: "final" },
      },
    });
  assert.deepEqual(loadWarningsOf(machine(fromPick(send))), []);
  assert.throws(
    () => machine({ to: "a", subject: "b" }),
    /pick "send_email" enters state "wf\.w\.sending".*never reads "to", "subject"/,
  );
});

// The param check does not follow a pick's params across `after`: the Effect's input reads the
// timer's event. A param that must cross is stored with assign on the pick's transition.
const deployE = defineEvent({ name: "deploy", input: z.object({ env: z.string(), note: z.string() }) });
const ship = commandWith(never, ["ship", arg("env")]);
function afterHop(onPick: unknown, input: unknown = ({ event }: { event: { env?: string } }) => ({ env: event.env })) {
  return jr2Setup({
    types: {} as { context: { env?: string; note?: string } },
    events: [deployE, finish],
    actors: { coder: coder(), ship },
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
          waiting: { after: { 10: "deploying" } },
          deploying: { invoke: { src: "ship", input: input as never, onDone: "rest" } },
        },
        on: { deploy: onPick as never, finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("a pick that reaches an Effect's state through an `after` is checked there: a param nothing stores before the timer is refused", () => {
  assert.throws(
    () => afterHop(".waiting"),
    (err: Error) => {
      assert.match(
        err.message,
        /pick "deploy" enters state "wf\.w\.waiting", whose `after` moves on to state "wf\.w\.deploying" \(Effect "ship"\), and nothing stores "env", "note" before the timer/,
      );
      return true;
    },
  );
});

test("a param stored with assign on the pick's transition crosses the timer; one left unstored is still refused", () => {
  const both = assign({
    env: ({ event }: { event: { env: string } }) => event.env,
    note: ({ event }: { event: { note: string } }) => event.note,
  });
  const m = afterHop({ target: ".waiting", actions: both }, ({ context }: { context: { env: string } }) => ({
    env: context.env,
  }));
  assert.deepEqual(loadWarningsOf(m), []);
  const envOnly = assign({ env: ({ event }: { event: { env: string } }) => event.env });
  assert.throws(() => afterHop({ target: ".waiting", actions: envOnly }), /nothing stores "note" before the timer/);
});

test("an action the walk does not run before the timer may read a param: a warning across `after`, never a refusal", () => {
  const m = afterHop({ target: ".waiting", actions: () => {} });
  assert.ok(
    loadWarningsOf(m).some((w) => /whose `after` moves on to state "wf\.w\.deploying".*an inline action/.test(w)),
    loadWarningsOf(m).join("\n"),
  );
});

test("a pick that targets a history state that may enter an Effect's state is a warning, never silent", () => {
  const m = jr2Setup({ events: [send, finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: {
          rest: {},
          box: {
            initial: "sending",
            states: {
              h: { type: "history" },
              sending: { invoke: { src: "mail", input: { to: "a", subject: "b" }, onDone: "#wf.w.rest" } },
            },
          },
        },
        on: { send_email: ".box.h", finish: "done" },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.ok(
    warnings.some((w) =>
      /pick "send_email" targets history state "wf\.w\.box\.h".*"wf\.w\.box\.sending".*unchecked/.test(w),
    ),
    warnings.join("\n"),
  );
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

test("a state below an Effect's state that invokes something and that nothing enters is refused too", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [finish], actors: { coder: coder(), mail } }).createMachine({
        id: "wf",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
            initial: "rest",
            states: {
              rest: {},
              outer: {
                invoke: { src: "mail", input: { to: "a", subject: "b" } },
                initial: "a",
                states: { a: {}, orphan: { invoke: { src: "mail", input: { to: "a", subject: "b" } } } },
              },
            },
            on: { finish: ".outer" },
          },
        },
      }),
    /state "wf\.w\.outer\.orphan" below Agent "coder"'s state "wf\.w" is entered by nothing/,
  );
});

/** An Agent's state whose `send_email` pick enters history state `box.h`; `box`'s initial child is
 * `idle`, and `sending` (which invokes `mail`) is entered only through `h`'s default `target`. */
function historyBuild(target: unknown) {
  return jr2Setup({ events: [send, finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: {
          rest: {},
          box: {
            initial: "idle",
            states: {
              h: { type: "history", target: target as never },
              idle: {},
              sending: { invoke: { src: "mail", input: { to: "a", subject: "b" }, onDone: "#wf.w.rest" } },
            },
          },
        },
        on: { send_email: ".box.h", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

test("a state that invokes and that a history state's default target enters is entered: no refusal", () => {
  for (const target of ["sending", "#wf.w.box.sending"]) {
    const warnings = loadWarningsOf(historyBuild(target));
    assert.ok(!warnings.some((w) => /sending.*entered by nothing/.test(w)), warnings.join("\n"));
  }
});

test("a history default the walk cannot follow makes the unentered-invoke check a warning, never a refusal", () => {
  const warnings = loadWarningsOf(historyBuild("nowhere"));
  assert.ok(
    warnings.some((w) => /history state "wf\.w\.box\.h" has a default target the load walk cannot follow/.test(w)),
    warnings.join("\n"),
  );
  assert.ok(
    warnings.some((w) =>
      /state "wf\.w\.box\.sending" below Agent "coder"'s state "wf\.w" may be entered by nothing.*history state "wf\.w\.box\.h"/.test(
        w,
      ),
    ),
    warnings.join("\n"),
  );
});

test("below a state that invokes a Gate the walk does not look: that state is the Gate's", () => {
  const m = jr2Setup({ events: [finish], actors: { coder: coder(), mail } }).createMachine({
    id: "wf",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "rest",
        states: {
          rest: {},
          review: {
            invoke: { src: "gate", input: {} },
            initial: "a",
            states: { a: {}, orphan: { invoke: { src: "mail", input: { to: "a", subject: "b" } } } },
          },
        },
        on: { finish: ".review" },
      },
    },
  });
  assert.ok(m);
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
