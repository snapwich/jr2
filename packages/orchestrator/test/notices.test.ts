// The Orchestrator's notices (ADR-0062): the pending set is plain data, a notice goes to the next
// admission in its scope, and it counts as delivered only when that admission is ledgered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NoticeLedger } from "../src/notices.ts";
import type { Notice } from "../src/wire.ts";

const kill: Notice = { kind: "memory-limit", scope: "workspace", agent: "coder", limit: "1920Mi" };
const fresh: Notice = { kind: "conversation-new", scope: "conversation", reason: "the last Turn faulted" };

const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

test("a notice goes to the next admission in its scope, and to no other", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1");
  book.raise(fresh, "run/root/coder");

  assert.deepEqual(book.take({ workspace: "ws-2" }).notices, [], "another Workspace hears nothing");
  assert.deepEqual(book.take({ conversation: "run/root/reviewer" }).notices, [], "another conversation neither");
  const taken = book.take({ workspace: "ws-1", conversation: "run/root/coder" });
  assert.deepEqual(taken.notices, [kill, fresh], "in the order they were raised");
});

test("a taken notice is not handed to a second admission while the first is in flight", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1");
  const first = book.take({ workspace: "ws-1" });
  assert.deepEqual(book.take({ workspace: "ws-1" }).notices, [], "reserved for the first admission");

  // The admission failed: the notice is pending again, for the next one.
  book.release(first.ids);
  assert.deepEqual(book.take({ workspace: "ws-1" }).notices, [kill]);
});

test("delivered once: a ledgered admission clears it; a restart BEFORE that delivers it again", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1");
  const taken = book.take({ workspace: "ws-1" });

  // A restart before the ledger write: the persisted state still holds it, reservation and all
  // forgotten — the restored run's next admission carries it.
  const before = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.deepEqual(before.take({ workspace: "ws-1" }).notices, [kill]);

  // The ledger write: gone, and a restart after it does not bring it back.
  book.delivered(taken.ids);
  assert.deepEqual(book.take({ workspace: "ws-1" }).notices, []);
  const after = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.deepEqual(after.take({ workspace: "ws-1" }).notices, []);
});

test("a notice with a source is raised once, even after it was delivered", () => {
  const book = new NoticeLedger(undefined, ids());
  assert.equal(book.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), true);
  // Two Turns lost to the SAME kernel kill both name it; a replayed stream re-reads a guard kill.
  assert.equal(book.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), false);
  book.delivered(book.take({ workspace: "ws-1" }).ids);
  const restored = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.equal(restored.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), false, "the source is remembered");
  assert.deepEqual(restored.take({ workspace: "ws-1" }).notices, []);
});

test("the same news still unheard is one notice, whichever stream it was read on", () => {
  const book = new NoticeLedger(undefined, ids());
  assert.equal(book.raise(kill, "ws-1", "coder-conv@3.0"), true);
  assert.equal(book.raise(kill, "ws-1", "other-conv@9.0"), false, "one kill, written to two running conversations");
  assert.deepEqual(book.take({ workspace: "ws-1" }).notices, [kill]);
});
