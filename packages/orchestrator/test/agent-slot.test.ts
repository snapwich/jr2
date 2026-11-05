// An Agent's slot (ADR-0057, ADR-0076): `<machine actor path>/<agent>`, each segment of the path
// encoded before the segments are joined with `.`. Two actor paths never have one spelling, and a
// slot has nothing in a segment that a URL, a header or the iid's joints must escape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup } from "xstate";
import type { AnyActorRef } from "xstate";
import { agentSlot, continuedIid, slotSegment } from "../src/registration.ts";

/** An actor below a root, by its ids from the root's children down: what `actorPath` walks. */
function below(...ids: string[]): AnyActorRef {
  let ref = { id: "root-generated-per-process" } as unknown as AnyActorRef;
  for (const id of ids) ref = { id, _parent: ref } as unknown as AnyActorRef;
  return ref;
}

test("two actor paths that join to one text with `.` are two slots", () => {
  const a = agentSlot(below("a.b", "c"), "coder");
  const b = agentSlot(below("a", "b.c"), "coder");
  const c = agentSlot(below("a", "b", "c"), "coder");
  assert.equal(new Set([a, b, c]).size, 3, `${a} ${b} ${c}`);
  assert.equal(c, "a.b.c/coder", "plain ids keep their spelling");
});

test("a segment keeps letters, digits, `-` and `_`, and escapes each other character as `~` and hex", () => {
  assert.equal(slotSegment("F-12_body"), "F-12_body");
  assert.equal(slotSegment("a.b"), "a~2Eb");
  assert.equal(slotSegment("owner/repo#3"), "owner~2Frepo~233");
  assert.equal(slotSegment("~2E"), "~7E2E", "a `~` is escaped too, so the encoding is one to one");
  assert.equal(slotSegment("é"), "~C3~A9", "each UTF-8 byte");
  assert.notEqual(slotSegment("~2E"), slotSegment("."));
});

test("a child Machine with the id `root` or the empty id never has the root Machine's slot", () => {
  const root = agentSlot(undefined, "coder");
  assert.equal(root, "root/coder");
  const named = agentSlot(below("root"), "coder");
  const empty = agentSlot(below(""), "coder");
  assert.equal(named, "~72oot/coder");
  assert.equal(empty, "~/coder");
  assert.equal(new Set([root, named, empty, agentSlot(below("~72oot"), "coder")]).size, 4);
  assert.equal(agentSlot(below("root", "x"), "coder"), "~72oot.x/coder");
  assert.equal(agentSlot(below("", ""), "coder"), "~.~/coder");
});

test('a real root Machine and its child invoked with `id: "root"` are two slots', () => {
  const child = setup({}).createMachine({ id: "child", initial: "idle", states: { idle: {} } });
  const parent = setup({ actors: { child } }).createMachine({
    id: "parent",
    initial: "on",
    states: { on: { invoke: { src: "child", id: "root" } } },
  });
  const actor = createActor(parent).start();
  const ref = actor.getSnapshot().children["root"] as AnyActorRef;
  assert.notEqual(continuedIid(ref, "run-1", "coder"), continuedIid(actor, "run-1", "coder"));
  assert.equal(agentSlot(actor, "coder"), "root/coder");
  actor.stop();
});

test("a slot's segments carry nothing a URL, a header or the iid's joints must escape", () => {
  const ids = ["a.b", "x/y", "100%", "q?=&", "sp ace", "日本", "review:invocation[0]", "..", ""];
  for (const id of ids) {
    const seg = slotSegment(id);
    assert.match(seg, /^[A-Za-z0-9_~-]*$/, `${JSON.stringify(id)} → ${seg}`);
    assert.equal(encodeURIComponent(seg), seg, "a URL keeps it as it is");
  }
});

test("the slot of a real child Machine: its actor path, encoded; the root's own id is never in it", () => {
  const child = setup({}).createMachine({ id: "child", initial: "idle", states: { idle: {} } });
  const parent = setup({ actors: { child } }).createMachine({
    id: "parent",
    initial: "on",
    states: { on: { invoke: { src: "child", id: "F.12" } } },
  });
  const actor = createActor(parent).start();
  const ref = actor.getSnapshot().children["F.12"] as AnyActorRef;
  assert.equal(agentSlot(ref, "coder"), "F~2E12/coder");
  assert.equal(agentSlot(actor, "coder"), "root/coder", "the root Machine's slot");
  assert.equal(agentSlot(undefined, "coder"), "root/coder");
  assert.equal(continuedIid(ref, "run-1", "coder"), "run-1/F~2E12/coder");
  actor.stop();
});
