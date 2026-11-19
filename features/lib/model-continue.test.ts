// The continue-after-signed-push reading (ADR-0066, ADR-0067), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { commentAboveGreet, needsFirstPush, readContinue, type PushRecord } from "./model-continue.ts";

const signed: PushRecord = { outcome: "pushed", published: "b".repeat(40), source: "a".repeat(40) };
const own: PushRecord = { outcome: "pushed", published: "a".repeat(40), source: "a".repeat(40) };

/** The seed's `greet.js` with the fix alone, and with the fix and the comment. */
const FIXED = 'export function greet(name = "world") {\n  return "hello, " + name;\n}\n';
const COMMENTED = `// Returns "hello, <name>", or "hello, world" with no name.\n${FIXED}`;

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
    const r = readContinue([signed], { carried: n, greet: COMMENTED });
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", new RegExp(`^void: the first push carried ${n} commits`));
  }
});

test("one push of one commit that already held the comment is void: the fix and the comment were one commit before any post-push text", () => {
  // Trial 562f8c37 of the M18 run: one commit with both changes, published once, finished.
  const r = readContinue([signed], { carried: 1, greet: COMMENTED });
  assert.equal(r.measured, false);
  assert.match(r.void ?? "", /^void: the first push already held the comment above greet\(\)/);
});

test("the decision is the push's content, never the push count: one push of the fix alone stays a miss", () => {
  // "Published once, committed, finished" and "published, reset, finished": the fix alone carried.
  assert.deepEqual(readContinue([signed], { carried: 1, greet: FIXED }), { measured: false });
});

test("more than one push is measured, whatever the first push held", () => {
  // Trial 70a74ec9 of the M18 run: fix and comment in one commit, then a reset after the signed push.
  assert.deepEqual(readContinue([signed, { outcome: "diverged" }, { outcome: "pushed" }], undefined), {
    measured: false,
  });
});

test("the comment is the nearest line above greet that is not blank", () => {
  assert.equal(commentAboveGreet(COMMENTED), true);
  assert.equal(commentAboveGreet(`/** Returns the greeting. */\n\n${FIXED}`), true);
  assert.equal(commentAboveGreet(`/**\n * Returns the greeting.\n */\n${FIXED}`), true);
  assert.equal(commentAboveGreet(FIXED), false);
  assert.equal(commentAboveGreet('export function greet(name) {\n  return "Hello " + name;\n}\n'), false);
  assert.equal(commentAboveGreet(`${FIXED}// a comment below greet\n`), false);
  assert.equal(commentAboveGreet(""), false);
});

test("the content is read only when it decides: one push past a setup", () => {
  assert.throws(() => readContinue([signed], undefined), /the first push's content on the remote/);
  assert.equal(needsFirstPush([signed]), true);
  assert.equal(needsFirstPush([signed, signed]), false);
  assert.equal(needsFirstPush([own]), false);
  assert.equal(needsFirstPush([]), false);
});
