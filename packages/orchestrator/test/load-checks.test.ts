// Load checks on modes and audience (ADR-0015): what `jr2Setup.createMachine` refuses, and what it
// warns about. A warning rides the Machine (`loadWarningsOf`) and its doc, and `jr2 up` prints it;
// a refusal throws at build, where `jr2 up` loads every registered Machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineEvent, type EventDef } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { serializeMachine } from "../src/machine-doc.ts";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf, seatLine } from "../src/vocabulary.ts";
import { coderDefinition, MockFlueClient } from "./_fixtures.ts";

const ev = (name: string, audience?: "agent" | "external" | "any"): EventDef =>
  defineEvent({ name, input: z.object({}), ...(audience ? { audience } : {}) });
const slot = () => agentActorWith(() => new MockFlueClient(), coderDefinition);
const EP = "http://harness.invalid";

test("a registered pick that no state handles is refused at build: it is on no Menu and no Gate", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [ev("finish"), ev("abandon")], actors: { coder: slot() } }).createMachine({
        id: "dead",
        initial: "w",
        states: {
          w: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "d" } },
          d: { type: "final" },
        },
      }),
    (err: Error) => {
      assert.match(err.message, /machine "dead"/);
      assert.match(err.message, /"abandon"/);
      assert.match(err.message, /no state handles/);
      return true;
    },
  );
});

test("a mode that nothing enters is a warning: its picks are on the Menu and never allowed", () => {
  const m = jr2Setup({ events: [ev("run_tests"), ev("submit")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "coding" } },
          orphan: { on: { submit: "#wf.done" } },
        },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /mode "wf\.ticket\.orphan"/);
  assert.match(warnings[0]!, /nothing enters it/);
  assert.match(warnings[0]!, /submit/);
});

test("a compound mode that nothing enters is a warning: its own `initial` does not enter it", () => {
  const m = jr2Setup({ events: [ev("run_tests"), ev("submit")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "coding" } },
          orphan: { initial: "x", states: { x: { on: { submit: "#wf.done" } } } },
        },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /mode "wf\.ticket\.orphan"/);
});

test("a mode whose only entry is its own transition into itself, or a state nothing enters, is a warning", () => {
  const m = jr2Setup({ events: [ev("a"), ev("b"), ev("submit")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { submit: "#wf.done" } },
          self: { on: { a: "self", b: "second" } },
          // `second` is targeted only from `self`, which nothing enters.
          second: { on: { submit: "coding" } },
        },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings.join("\n"), /mode "wf\.ticket\.self"/);
  assert.match(warnings.join("\n"), /mode "wf\.ticket\.second"/);
});

test("a mode entered by a target, by being initial, or through a child it contains is no warning", () => {
  const m = jr2Setup({ events: [ev("a"), ev("b"), ev("c")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "one",
        states: {
          one: { on: { a: "two" } },
          two: { on: { b: "three.inner" } },
          three: { initial: "inner", states: { inner: { on: { c: "#wf.ticket.one" } } } },
        },
      },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a Gate above an Agent's state that takes an unset-audience writing from it is a warning", () => {
  const m = jr2Setup({ events: [ev("finish"), ev("abandon")], actors: { coder: slot() } }).createMachine({
    id: "c",
    initial: "job",
    states: {
      job: {
        invoke: { src: "gate", id: "operator" },
        on: { abandon: "gaveUp" },
        initial: "working",
        states: {
          working: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "#c.done" } },
        },
      },
      gaveUp: { type: "final" },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /Agent "coder" on "c\.job\.working" cannot send "abandon"/);
  assert.match(warnings[0]!, /written on "c\.job", whose Gate/);
  assert.match(warnings[0]!, /audience: "any"/);
});

test('the same Machine with `audience: "any"` on the pick: both may send it, no warning', () => {
  const m = jr2Setup({ events: [ev("finish"), ev("abandon", "any")], actors: { coder: slot() } }).createMachine({
    id: "c",
    initial: "job",
    states: {
      job: {
        invoke: { src: "gate", id: "operator" },
        on: { abandon: "gaveUp" },
        initial: "working",
        states: {
          working: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "#c.done" } },
        },
      },
      gaveUp: { type: "final" },
      done: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("one name written for two parties on one path is a warning: whoever sends it, the deepest handler runs", () => {
  const m = jr2Setup({ events: [ev("stop"), ev("ask")], actors: { coder: slot() } }).createMachine({
    id: "same",
    initial: "t",
    states: {
      t: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { stop: "agentStopped" },
        initial: "coding",
        states: { coding: { on: { ask: "asking" } }, asking: { invoke: { src: "gate" }, on: { stop: "coding" } } },
      },
      agentStopped: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /"stop" is written on "same\.t" for Agent "coder" and on "same\.t\.asking" for a Gate/);
  assert.match(warnings[0]!, /deepest active handler/);
});

test("one name written on a mode for the Agent and on a sibling Gate's state is a warning: the Agent's send runs the Gate's transition", () => {
  const m = jr2Setup({ events: [ev("ask"), ev("approve"), ev("to_m")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { ask: "human", to_m: "m" } },
          m: { on: { approve: "coding" } },
          human: { invoke: { src: "gate" }, on: { approve: "#wf.approved" } },
        },
      },
      approved: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(
    warnings[0]!,
    /"approve" is written on "wf\.ticket\.m" for Agent "coder" and on "wf\.ticket\.human" for a Gate/,
  );
  assert.match(warnings[0]!, /while "wf\.ticket\.human" is active Agent "coder"'s "approve" runs the transition/);
});

test("one name written on a mode for the Agent and on a sibling nested Agent's state is a warning", () => {
  const m = jr2Setup({ events: [ev("x"), ev("go")], actors: { coder: slot(), reviewer: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "a",
        states: {
          a: { on: { x: "a", go: "review" } },
          review: { invoke: { src: "reviewer", input: { prompt: "r", endpoint: EP } }, on: { x: "#wf.hijacked" } },
        },
      },
      hijacked: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(
    warnings[0]!,
    /"x" is written on "wf\.ticket\.a" for Agent "coder" and on "wf\.ticket\.review" for Agent "reviewer"/,
  );
});

test("a name on a mode and on a sibling Gate's state with an explicit audience the Agent may not send: no warning", () => {
  const m = jr2Setup({
    events: [ev("ask"), ev("approve", "external"), ev("to_m")],
    actors: { coder: slot() },
  }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { ask: "human", to_m: "m" } },
          m: { on: { approve: "coding" } },
          human: { invoke: { src: "gate" }, on: { approve: "#wf.approved" } },
        },
      },
      approved: { type: "final" },
    },
  });
  assert.deepEqual(
    loadWarningsOf(m).filter((w) => w.includes("deepest active handler")),
    [],
    "the Agent cannot send `approve`, so nothing it sends runs the Gate's transition",
  );
});

test("a name on an Agent's state and on its mode is one party's: no warning (the guard fall-through idiom)", () => {
  const m = jr2Setup({ events: [ev("abandon"), ev("go")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "t",
    states: {
      t: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { abandon: "d" },
        initial: "a",
        states: { a: { on: { go: "b" } }, b: { on: { abandon: { target: "a", guard: () => false } } } },
      },
      d: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("the Machine's doc carries who may send what, per state, and its warnings", () => {
  const m = jr2Setup({ events: [ev("finish"), ev("abandon")], actors: { coder: slot() } }).createMachine({
    id: "c",
    initial: "job",
    states: {
      job: {
        invoke: { src: "gate", id: "operator" },
        on: { abandon: "gaveUp" },
        initial: "working",
        states: {
          working: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "#c.done" } },
        },
      },
      gaveUp: { type: "final" },
      done: { type: "final" },
    },
  });
  const doc = serializeMachine("c", m);
  assert.deepEqual(doc.seats.map(seatLine), ["c.job gate: [abandon]", "c.job.working agent:coder: [finish]"]);
  assert.equal(doc.warnings.length, 1);
});

test("a parallel region below a state that invokes an Agent is refused at build, with the reserved text", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [ev("finish"), ev("lint")], actors: { coder: slot() } }).createMachine({
        id: "par",
        initial: "t",
        states: {
          t: {
            invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
            on: { finish: "d" },
            initial: "coding",
            states: {
              coding: {
                type: "parallel",
                states: {
                  left: { on: { lint: "right" } },
                  right: {},
                },
              },
            },
          },
          d: { type: "final" },
        },
      }),
    (err: Error) => {
      assert.match(err.message, /machine "par"/);
      assert.match(err.message, /"par\.t\.coding" is parallel/);
      assert.match(err.message, /Agent "coder"'s state "par\.t"/);
      assert.match(err.message, /reserved for picks the Agent does not wait for/);
      assert.match(err.message, /a background task goes above the Agent's state/);
      return true;
    },
  );
});

test("an Agent's state that is itself parallel is refused: its regions are below it", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [ev("finish")], actors: { coder: slot() } }).createMachine({
        id: "par",
        initial: "t",
        states: {
          t: {
            type: "parallel",
            invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
            on: { finish: "d" },
            states: { a: {}, b: {} },
          },
          d: { type: "final" },
        },
      }),
    /"par\.t" is parallel[\s\S]*reserved for picks the Agent does not wait for/,
  );
});

test("a parallel state above an Agent's state is legal: a background task goes there", () => {
  const m = jr2Setup({ events: [ev("finish")], actors: { coder: slot() } }).createMachine({
    id: "par",
    type: "parallel",
    states: {
      work: {
        initial: "t",
        states: {
          t: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "d" } },
          d: { type: "final" },
        },
      },
      background: { invoke: { src: "gate" } },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});
