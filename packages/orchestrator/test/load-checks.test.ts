// Load checks on modes and audience (ADR-0015): what `jr2Setup.createMachine` refuses, and what it
// warns about. A warning rides the Machine (`loadWarningsOf`) and its doc, and `jr2 up` prints it;
// a refusal throws at build, where `jr2 up` loads every registered Machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineEvent, type EventDef } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { serializeMachine } from "../src/machine-doc.ts";
import {
  createMachine,
  fromCallback,
  fromObservable,
  fromPromise,
  fromTransition,
  or,
  type AnyStateMachine,
} from "xstate";
import { sentBy } from "../src/party.ts";
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

test("a mode entered only through a history state's default target is no warning — shallow or deep", () => {
  const m = jr2Setup({
    events: [ev("pause"), ev("resume"), ev("dig"), ev("submit")],
    actors: { coder: slot() },
  }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { pause: "paused", dig: "deep" } },
          paused: { on: { resume: "back" } },
          // Nothing targets `reviewing`: the history state's default target is its one entry.
          back: { type: "history", target: "reviewing" },
          reviewing: { on: { submit: "#wf.done" } },
          // A deep history whose default target is a mode inside a compound mode.
          deep: { on: { resume: "again" } },
          again: { type: "history", history: "deep", target: "nested.inner" },
          nested: { initial: "first", states: { first: {}, inner: { on: { submit: "#wf.done" } } } },
          // A history with no target restores the parent's initial: nothing more to follow, and
          // the history state itself is no mode.
          plain: { type: "history" },
        },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a history default target the walk cannot follow is a warning that names it", () => {
  const m = jr2Setup({ events: [ev("pause"), ev("resume"), ev("submit")], actors: { coder: slot() } }).createMachine({
    id: "wf",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { pause: "paused" } },
          paused: { on: { resume: "back" } },
          back: { type: "history", target: "nowhere" },
          reviewing: { on: { submit: "#wf.done" } },
        },
      },
      done: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m).join("\n");
  assert.match(warnings, /history state "wf\.ticket\.back".*"nowhere"/);
  assert.match(warnings, /mode "wf\.ticket\.reviewing".*nothing enters it/);
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

test("two parties' writings of one name on one path: a warning naming both, with the sentBy line on the DEEPER writing", () => {
  // The Gate is seated ABOVE the Agent's state: while the Agent works in `draft`, the reviewer may
  // send `approve`, and xstate selects the deeper writing — the Agent's — first.
  const build = (marked: boolean) =>
    jr2Setup({ events: [ev("approve")], actors: { coder: slot() } }).createMachine({
      id: "same",
      initial: "release",
      states: {
        release: {
          invoke: { src: "gate", id: "review" },
          on: { approve: "shipped" },
          initial: "work",
          states: {
            work: {
              invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
              initial: "draft",
              states: {
                draft: { on: { approve: { target: "#same.mine", ...(marked ? { guard: sentBy("coder") } : {}) } } },
              },
            },
          },
        },
        shipped: { type: "final" },
        mine: { type: "final" },
      },
    });
  const party = (m: AnyStateMachine) => loadWarningsOf(m).filter((w) => w.includes("can be active together"));
  assert.deepEqual(party(build(false)), [
    `"approve" on "same.release" (Gate "review") and on "same.release.work.draft" (Agent "coder") can be active ` +
      `together; Gate "review"'s "approve" would run Agent "coder"'s writing, so jr2 refuses it while both are ` +
      `active. Make the deeper writing decline other senders:\n  draft: { on: { approve: { guard: sentBy("coder"), target: "#same.mine" } } }`,
  ]);
  assert.deepEqual(party(build(true)), [], "the deeper writing declines: the reviewer's approve runs release's");
});

test("the Agent's writing above a party seated below the Agent's state: no warning — the Agent's state is busy there (ADR-0024)", () => {
  // While the Gate runs in `asking`, `t` is not at Rest: every pick of the Agent is refused,
  // whatever its guard, so the Agent never sends `stop` while the deeper writing is active. A
  // `sentBy` on it would change nothing, and the warning would ask for one.
  const build = (marked: boolean) =>
    jr2Setup({ events: [ev("stop"), ev("ask")], actors: { coder: slot() } }).createMachine({
      id: "same",
      initial: "t",
      states: {
        t: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
          on: { stop: "agentStopped" },
          initial: "coding",
          states: {
            coding: { on: { ask: "asking" } },
            asking: {
              invoke: { src: "gate", id: "review" },
              on: { stop: { target: "coding", ...(marked ? { guard: sentBy("review") } : {}) } },
            },
          },
        },
        agentStopped: { type: "final" },
      },
    });
  assert.deepEqual(loadWarningsOf(build(false)), []);
  assert.deepEqual(loadWarningsOf(build(true)), []);
});

test("the warning names a derived Gate id and says how to name the invoke", () => {
  // Two Gates on one path: the inner one, unnamed, is selected first for the outer caller's `stop`.
  const m = jr2Setup({ events: [ev("stop"), ev("ask")] }).createMachine({
    id: "same",
    initial: "t",
    states: {
      t: {
        invoke: { src: "gate", id: "operator" },
        on: { stop: "stopped" },
        initial: "coding",
        states: { coding: { on: { ask: "asking" } }, asking: { invoke: { src: "gate" }, on: { stop: "coding" } } },
      },
      stopped: { type: "final" },
    },
  });
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /guard: sentBy\("t\.asking"\)/);
  assert.match(warnings[0]!, /the Gate's invoke id "t\.asking" is derived from its state; give its invoke an `id`/);
});

test("a mode and a sibling Gate's state writing one name: no warning — they are never selected for each other", () => {
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
  assert.deepEqual(loadWarningsOf(m), []);
});

test("a mode and a sibling nested Agent's state writing one name: no warning", () => {
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
  assert.deepEqual(loadWarningsOf(m), []);
});

test("the root-writing shape: the root's writing is both parties'; the mode's takes the line", () => {
  const build = (marked: boolean) =>
    jr2Setup({ events: [ev("cancel"), ev("approve")], actors: { coder: slot() } }).createMachine({
      id: "root",
      on: { cancel: ".cancelled" },
      initial: "release",
      states: {
        release: {
          invoke: { src: "gate", id: "review" },
          on: { approve: "shipped" },
          initial: "work",
          states: {
            work: {
              invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
              initial: "draft",
              states: {
                draft: { on: { cancel: { target: "#root.discarded", ...(marked ? { guard: sentBy("coder") } : {}) } } },
              },
            },
          },
        },
        shipped: { type: "final" },
        cancelled: { type: "final" },
        discarded: { type: "final" },
      },
    });
  const party = (m: AnyStateMachine) => loadWarningsOf(m).filter((w) => w.includes("can be active together"));
  assert.deepEqual(party(build(false)), [
    `"cancel" on "root" (Gate "review") and on "root.release.work.draft" (Agent "coder") can be active together; ` +
      `Gate "review"'s "cancel" would run Agent "coder"'s writing, so jr2 refuses it while both are active. Make the ` +
      `deeper writing decline other senders:\n  draft: { on: { cancel: { guard: sentBy("coder"), target: "#root.discarded" } } }`,
  ]);
  assert.deepEqual(party(build(true)), []);
});

test("parallel regions: one warning per region, each line on the other region's writing", () => {
  const build = (marked: boolean) =>
    jr2Setup({ events: [ev("go")], actors: { coder: slot() } }).createMachine({
      id: "par",
      type: "parallel",
      states: {
        r1: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
          on: { go: { target: ".b", ...(marked ? { guard: sentBy("coder") } : {}) } },
          initial: "a",
          states: { a: {}, b: {} },
        },
        r2: {
          invoke: { src: "gate", id: "review" },
          on: { go: { target: ".b", ...(marked ? { guard: sentBy("review") } : {}) } },
          initial: "a",
          states: { a: {}, b: {} },
        },
      },
    });
  const warnings = loadWarningsOf(build(false));
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(
    warnings[0]!,
    /\(Agent "coder"\) and on "par\.r2" \(Gate "review"\) can be active together \(parallel regions\)/,
  );
  assert.match(
    warnings[0]!,
    /Make the writing on "par\.r2" decline other senders:\n  r2: \{ on: \{ go: \{ guard: sentBy\("review"\)/,
  );
  assert.match(
    warnings[1]!,
    /Make the writing on "par\.r1" decline other senders:\n  r1: \{ on: \{ go: \{ guard: sentBy\("coder"\)/,
  );
  assert.deepEqual(loadWarningsOf(build(true)), []);
});

test("a sentBy the walk cannot read — under or() — leaves the warning in place", () => {
  const m = jr2Setup({
    events: [ev("approve")],
    actors: { coder: slot() },
    guards: { never: () => false },
  }).createMachine({
    id: "same",
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate", id: "review" },
        on: { approve: "shipped" },
        initial: "work",
        states: {
          work: {
            invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
            initial: "draft",
            states: { draft: { on: { approve: { target: "#same.mine", guard: or([sentBy("coder"), "never"]) } } } },
          },
        },
      },
      shipped: { type: "final" },
      mine: { type: "final" },
    },
  });
  assert.equal(loadWarningsOf(m).filter((w) => w.includes("can be active together")).length, 1);
});

test("one def, one meaning: one party's writings of one name on one path with different targets warn", () => {
  const m = jr2Setup({ events: [ev("cancel")], actors: { coder: slot() } }).createMachine({
    id: "s4",
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { cancel: "abandoned" },
        initial: "draft",
        states: { draft: { on: { cancel: { target: "#s4.discarded", description: "Discard the draft." } } } },
      },
      abandoned: { type: "final" },
      discarded: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), [
    `"cancel" is written for Agent "coder" on "s4.work" (→ s4.abandoned) and on "s4.work.draft" (→ s4.discarded): ` +
      `Agent "coder" reads one description for both — make the def's description true at each writing, or give them ` +
      `distinct names`,
  ]);
  // xstate's own transition description rides the Machine doc beside the warning.
  const doc = serializeMachine("s4", m);
  assert.equal(
    doc.transitions.find((t) => t.source === "s4.work.draft" && t.event === "cancel")?.description,
    "Discard the draft.",
  );
  assert.ok(doc.warnings.some((w) => w.includes("reads one description for both")));
});

test("one def, one meaning: the same target at both writings is silent", () => {
  const m = jr2Setup({ events: [ev("cancel")], actors: { coder: slot() } }).createMachine({
    id: "s4",
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { cancel: "abandoned" },
        initial: "draft",
        states: { draft: { on: { cancel: { target: "#s4.abandoned", guard: () => true } } } },
      },
      abandoned: { type: "final" },
    },
  });
  assert.deepEqual(loadWarningsOf(m), []);
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

test("a name on an Agent's state and on its mode is one party's: only the one-meaning warning (the guard fall-through idiom)", () => {
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
  const warnings = loadWarningsOf(m);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(
    warnings[0]!,
    /"abandon" is written for Agent "coder" on "wf\.t" \(→ wf\.d\) and on "wf\.t\.b" \(→ wf\.t\.a\)/,
  );
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

// --- Rest (ADR-0024): shapes below an Agent's state that keep it from Rest ------------------------

const restMachine = (states: Record<string, unknown>, actors: Record<string, unknown> = {}) =>
  jr2Setup({
    events: [ev("ask"), ev("approve"), ev("go"), ev("finish")],
    actors: { coder: slot(), ...actors } as never,
  }).createMachine({
    id: "r",
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { finish: "#r.done" },
        initial: "rest",
        states: { rest: { on: { ask: "asking", go: "going" } }, ...states } as never,
      },
      done: { type: "final" },
    },
  } as never) as unknown as AnyStateMachine;

test("a Gate below an Agent's state whose answer has no target is a warning: the Gate stays open after it", () => {
  const warned = loadWarningsOf(
    restMachine({
      asking: { invoke: { src: "gate", id: "review" }, on: { approve: { actions: () => {} } } },
      going: {},
    }),
  ).join("\n");
  assert.match(
    warned,
    /Gate "review" at "r\.work\.asking", below Agent "coder"'s state "r\.work": its answer "approve" has no target/,
  );

  const routed = loadWarningsOf(
    restMachine({ asking: { invoke: { src: "gate", id: "review" }, on: { approve: "rest" } }, going: {} }),
  ).join("\n");
  assert.doesNotMatch(routed, /has no target/);
});

test("a long-lived invoke below an Agent's state is a warning: it blocks every pick — a promise, a child Machine and a Gate are not", () => {
  const watcher = fromCallback(() => () => {});
  const warned = loadWarningsOf(
    restMachine({ asking: { on: { approve: "rest" } }, going: { invoke: { src: "watcher" } } }, { watcher }),
  ).join("\n");
  assert.match(
    warned,
    /"r\.work\.going", below Agent "coder"'s state "r\.work", invokes "watcher", which runs until its state exits/,
  );
  assert.match(warned, /blocks every pick of the Agent/);

  for (const actor of [fromPromise(async () => 1), createMachine({})]) {
    const quiet = loadWarningsOf(
      restMachine(
        {
          asking: { invoke: { src: "gate" }, on: { approve: "rest" } },
          going: { invoke: { src: "kid", onDone: "rest" } },
        },
        { kid: actor },
      ),
    ).join("\n");
    assert.doesNotMatch(quiet, /runs until its state exits/);
  }
});

test("the long-lived probe is pinned against the real constructors: only a promise settles on its own", () => {
  const warns = (actor: unknown) =>
    loadWarningsOf(
      restMachine({ asking: { on: { approve: "rest" } }, going: { invoke: { src: "kid" } } }, { kid: actor }),
    ).some((w) => w.includes("runs until its state exits"));
  assert.equal(warns(fromPromise(async () => 1)), false, "a promise settles");
  assert.equal(warns(fromCallback(() => {})), true);
  assert.equal(warns(fromObservable(() => ({ subscribe: () => ({ unsubscribe: () => {} }) }) as never)), true);
  assert.equal(warns(fromTransition((s) => s, 0)), true);
});
