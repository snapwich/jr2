// `sentBy(id)` (ADR-0015): a jr2 guard the AUTHOR writes, carried as a named guard with params so
// the load walk can read it. True for the named party's event and for the Machine's own; false for
// another party's, so xstate's selection moves outward. An unknown id is refused at load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createActor, fromCallback, type AnyStateMachine } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import { SENT_BY, sentBy, sentByIds } from "../src/party.ts";
import { jr2Setup } from "../src/setup.ts";
import { release, rooted } from "./_sent-by-author.ts";
import { placeholder } from "./_party.ts";

const ev = (name: string) => defineEvent({ name, description: `The ${name} pick.`, input: z.object({}) });
const EP = "http://harness.invalid";

/** Run one event through the Machine with stubbed actors — the author's `.provide()` test seam. */
function valueAfter(machine: AnyStateMachine, event: Record<string, unknown>): unknown {
  const stub = fromCallback(() => () => {});
  const actor = createActor(machine.provide({ actors: { coder: stub, gate: stub } as never })).start();
  actor.send(event as never);
  const value = actor.getSnapshot().value;
  actor.stop();
  return value;
}

test("jr2 writes into the Machine only the guard-map entry: the writing keeps the author's own guard object", () => {
  const config = rooted.config as {
    states: { release: { states: { work: { states: { draft: { on: { cancel: { guard: unknown } } } } } } } };
  };
  assert.deepEqual(config.states.release.states.work.states.draft.on.cancel.guard, {
    type: "jr2.sentBy",
    params: { id: "coder" },
  });
  assert.equal(typeof (rooted.implementations.guards as Record<string, unknown>)[SENT_BY], "function");
});

test("routing by the author's guard: another party's event moves outward; the named party's and the Machine's own stay", () => {
  const gate = { party: "gate", id: "review" };
  const coder = { party: "agent", id: "coder" };
  assert.deepEqual(valueAfter(rooted, { type: "cancel", sender: gate }), "cancelled");
  assert.deepEqual(valueAfter(rooted, { type: "cancel", sender: coder }), "discarded");
  assert.deepEqual(valueAfter(rooted, { type: "cancel" }), "discarded", "no sender: the Machine's own event");
  // Inside and([...]) beside the author's own guard.
  assert.deepEqual(valueAfter(release, { type: "approve", sender: gate }), "shipped");
  assert.deepEqual(valueAfter(release, { type: "approve", sender: coder }), "selfApproved");
});

test("the walk reads sentBy alone and inside and([...]); under or()/not() it is opaque", async () => {
  const { and, or, not } = await import("xstate");
  assert.deepEqual(sentByIds(sentBy("coder")), { ids: ["coder"], opaque: false });
  assert.deepEqual(sentByIds(and([sentBy("coder"), "ready"])), { ids: ["coder"], opaque: false });
  assert.deepEqual(sentByIds(or([sentBy("coder"), "ready"])), { ids: [], opaque: true });
  assert.deepEqual(sentByIds(not(sentBy("coder"))), { ids: [], opaque: true });
  assert.equal(sentByIds("ready"), undefined);
  assert.equal(
    sentByIds(() => true),
    undefined,
  );
});

test("a sentBy id that is no Agent slot and no Gate invoke id is refused at load, like an unknown event key", () => {
  assert.throws(
    () =>
      jr2Setup({ events: [ev("approve")], actors: { coder: placeholder("coder") } }).createMachine({
        id: "typo",
        initial: "release",
        states: {
          release: {
            invoke: { src: "gate", id: "review" },
            on: { approve: "done" },
            initial: "work",
            states: {
              work: {
                invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
                initial: "draft",
                states: { draft: { on: { approve: { target: "#typo.done", guard: sentBy("codr") } } } },
              },
            },
          },
          done: { type: "final" },
        },
      }),
    /machine "typo": sentBy\("codr"\) on "approve" at "typo\.release\.work\.draft" names no party of this Machine \(Agent slots: coder; Gate invoke ids: review\)/,
  );
});

test("a Gate's derived invoke id is a sentBy id too: the walk names an unnamed Gate after its state", () => {
  const m = jr2Setup({ events: [ev("approve")], actors: { coder: placeholder("coder") } }).createMachine({
    id: "named",
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate" },
        on: { approve: { target: "done", guard: sentBy("release") } },
      },
      done: { type: "final" },
    },
  });
  assert.ok(m);
});
