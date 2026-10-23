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

test("the same news still unheard is one notice, whichever witness raised it", () => {
  const book = new NoticeLedger(undefined, ids());
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), true);
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), false, "one kill, read on a stream and in the pod's list");
  // A second kill that tells the same thing keeps its own entry, so a take by its source finds it…
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-2"), true, "a second kill that tells the same thing");
  assert.deepEqual(book.take({ workspace: "ws-1", only: ["ws-1@guard:k-2"] }).notices, [kill]);
  // …and an admission that takes both says it once, and delivers both.
  const other = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  const both = other.take({ workspace: "ws-1" });
  assert.deepEqual(both.notices, [kill]);
  assert.equal(both.ids.length, 2);
  // A notice with no source merges only into a twin with none: one with a source keeps its own.
  assert.equal(other.raise(kill, "ws-1"), true);
  assert.equal(other.raise(kill, "ws-1"), false);
});

test("`only` narrows a take to the notices of those sources — what a nudge or a wake carries (ADR-0062)", () => {
  const book = new NoticeLedger(undefined, ids());
  const idle: Notice = { kind: "memory-limit", scope: "workspace", peak: "1.9Gi", limit: "2Gi" };
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.raise(idle, "ws-1", "ws-1@guard:k-2");
  book.raise(fresh, "run/root/coder");
  const taken = book.take({ workspace: "ws-1", only: ["ws-1@guard:k-2"] });
  assert.deepEqual(taken.notices, [idle]);
  assert.deepEqual(book.take({ workspace: "ws-1", only: [] }).notices, [], "no source, no notice");
  assert.deepEqual(book.take({ workspace: "ws-1", conversation: "run/root/coder" }).notices, [kill, fresh]);
});

test("a burst is one notice: the older sources are marked raised with the newest (ADR-0062)", () => {
  const book = new NoticeLedger(undefined, ids());
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-3", ["ws-1@guard:k-1", "ws-1@guard:k-2"]), true);
  assert.deepEqual(book.state().seen, ["ws-1@guard:k-1", "ws-1@guard:k-2", "ws-1@guard:k-3"]);
  assert.equal(book.state().pending.length, 1);
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-2"), false, "an older one, read again, adds nothing");
});

test("`restore` puts back a heard-not notice with its source, though the source is seen (ADR-0062)", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1", "ws-1@guard:k-0");
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  const taken = book.take({ workspace: "ws-1", only: ["ws-1@guard:k-1"] });
  assert.deepEqual(taken.raised, [{ notice: kill, source: "ws-1@guard:k-1" }]);
  book.delivered(taken.ids);
  // No model heard it: back, with its source — not merged into k-0, which has the same words.
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1"), true);
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1"), false, "once");
  assert.deepEqual(book.take({ workspace: "ws-1", except: ["ws-1@guard:k-0"] }).raised, [
    { notice: kill, source: "ws-1@guard:k-1" },
  ]);
});
