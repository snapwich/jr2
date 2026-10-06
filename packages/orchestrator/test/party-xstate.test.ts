// What the pinned xstate does with a sender FIELD and a `sentBy` guard (ADR-0015) — plain xstate
// Machines, no jr2 host. Each test pins one fact the design rests on; this file is the canary for
// an xstate bump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, createActor, fromCallback, setup, type AnyActorRef } from "xstate";
import { SENT_BY, sentBy, sentByGuard } from "../src/party.ts";

const require = createRequire(import.meta.url);
const gate = { party: "gate", id: "review-1" } as const;
const coder = { party: "agent", id: "coder" } as const;

/** A Gate's writing on `release` (A → doneA), and the Agent's deeper writing on `draft` (B →
 * doneB), with jr2's guard registered the way jr2Setup registers it. */
export function nested(guardB: unknown = sentBy("coder"), onTick?: () => void) {
  return setup({ guards: { [SENT_BY]: sentByGuard } as never }).createMachine({
    id: "m",
    initial: "release",
    states: {
      release: {
        on: { approve: "doneA", tick: { actions: () => onTick?.() } },
        initial: "draft",
        states: {
          draft: { on: { approve: { target: "#m.doneB", guard: guardB as never } } },
          polishing: {},
        },
      },
      doneA: { type: "final" },
      doneB: { type: "final" },
    },
  });
}
const run = (m: ReturnType<typeof nested>, event: object) => {
  const a = createActor(m).start();
  a.send(event as never);
  return a.getSnapshot().value;
};

test("pin: the xstate these facts were measured on is 5.32.2", () => {
  assert.equal((require("xstate/package.json") as { version: string }).version, "5.32.2");
});

test("a declined deeper writing lets the shallower one run: selection moves outward", () => {
  assert.equal(run(nested(), { type: "approve", sender: gate }), "doneA");
  assert.equal(run(nested(), { type: "approve", sender: coder }), "doneB");
  assert.equal(run(nested(), { type: "approve" }), "doneB", "no sender: the Machine's own event passes sentBy");
});

test("the field survives the mailbox: an event delivered while the actor is busy still routes", () => {
  let parent: AnyActorRef | undefined;
  const m = nested(sentBy("coder"), () => parent!.send({ type: "approve", sender: gate } as never));
  const a = createActor(m).start();
  parent = a;
  a.send({ type: "tick" } as never);
  assert.equal(a.getSnapshot().value, "doneA");
});

test("the field survives serialization: a JSON round trip routes the same", () => {
  assert.equal(run(nested(), JSON.parse(JSON.stringify({ type: "approve", sender: gate }))), "doneA");
});

test("sentBy inside and([...]) short-circuits: an author's payload guard never sees another party's event", () => {
  const asked: string[] = [];
  const g = and([
    sentBy("coder") as never,
    (({ event }: { event: { note?: string } }) => (asked.push(String(event.note)), true)) as never,
  ]);
  assert.equal(run(nested(g), { type: "approve", note: "x", sender: gate }), "doneA");
  assert.deepEqual(asked, []);
});

test("a child callback's sendBack hands the parent the same object, field and all", () => {
  let push: ((e: object) => void) | undefined;
  const child = fromCallback(({ sendBack }) => {
    push = sendBack as never;
  });
  const m = setup({ actors: { child }, guards: { [SENT_BY]: sentByGuard } as never }).createMachine({
    id: "m",
    initial: "s",
    states: {
      s: {
        invoke: { src: "child" },
        on: { approve: [{ target: "b", guard: sentBy("coder") as never }, { target: "a" }] },
      },
      a: {},
      b: {},
    },
  });
  const a = createActor(m).start();
  push!({ type: "approve", sender: gate });
  assert.equal(a.getSnapshot().value, "a");
});
