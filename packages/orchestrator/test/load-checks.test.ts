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
