// The continue-after-signed-push reading (ADR-0066, ADR-0067), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { needsCarried, readContinue, type PushRecord } from "./model-continue.ts";

const signed: PushRecord = { outcome: "pushed", published: "b".repeat(40), source: "a".repeat(40) };
const own: PushRecord = { outcome: "pushed", published: "a".repeat(40), source: "a".repeat(40) };

test("two pushes, the second published: measured; the second refused: a miss", () => {
  assert.deepEqual(readContinue([signed, { outcome: "pushed" }], undefined), { measured: true });
  assert.deepEqual(readContinue([signed, { outcome: "diverged" }], undefined), { measured: false });
});

test("a first push that published no signed copy is void, as before", () => {
  for (const pushes of [[], [own], [{ outcome: "rejected" }]] as PushRecord[][]) {
    const r = readContinue(pushes, undefined);
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", /^void: the first push published no signed copy/, JSON.stringify(pushes));
  }
});

test("one push that carried two or more commits from main is void: the model chose its order before it read any post-push text", () => {
  for (const n of [2, 3]) {
    const r = readContinue([signed], n);
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", new RegExp(`^void: the first push carried ${n} commits`));
  }
});

test("the decision is the push's content, never the push count: one push of one commit stays a miss", () => {
  // "Published once, committed, finished" and "published, reset, finished": one commit carried.
  assert.deepEqual(readContinue([signed], 1), { measured: false });
});

test("the content is read only when it decides: one push past a setup", () => {
  assert.throws(() => readContinue([signed], undefined), /the first push's commits from main/);
  assert.equal(needsCarried([signed]), true);
  assert.equal(needsCarried([signed, signed]), false);
  assert.equal(needsCarried([own]), false);
  assert.equal(needsCarried([]), false);
});
