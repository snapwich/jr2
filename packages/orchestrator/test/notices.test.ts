// The Orchestrator's notices (ADR-0062): the pending set is plain data, a notice goes to the next
// admission in its scope — a Workspace notice to each conversation in the Workspace, once — and it
// counts as delivered only when that admission is ledgered.

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

const SINCE = "2026-01-01T00:00:00.000Z";
/** These conversations were admitted in `ws` before any kill, and continue: each is in the audience
 * of a kill there (ADR-0062, D4). */
const present = (book: NoticeLedger, ws: string, ...takers: string[]) => {
  for (const taker of takers) book.admitted(ws, { taker, slot: `root/${taker}`, continued: true, since: SINCE });
};
/** A ledger whose Workspace `ws-1` holds the conversations the tests below name. */
const mkBook = () => {
  const book = new NoticeLedger(undefined, ids());
  present(book, "ws-1", "a", "b", "c", "c-1", "run/root/coder", "run/root/coder-x1", "run/root/reviewer-x2");
  return book;
};

test("a notice goes to the next admission in its scope, and to no other", () => {
  const book = mkBook();
  book.raise(kill, "ws-1");
  book.raise(fresh, "run/root/coder");

  assert.deepEqual(book.take({ workspace: "ws-2", taker: "c-1" }).notices, [], "another Workspace hears nothing");
  assert.deepEqual(book.take({ conversation: "run/root/reviewer" }).notices, [], "another conversation neither");
  const taken = book.take({ workspace: "ws-1", conversation: "run/root/coder" });
  assert.deepEqual(taken.notices, [kill, fresh], "in the order they were raised");
});

test("a taken notice is not handed to a second admission in the same conversation while the first is in flight", () => {
  const book = mkBook();
  book.raise(kill, "ws-1");
  const first = book.take({ workspace: "ws-1", taker: "c-1" });
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1" }).notices, [], "reserved for the first admission");

  // The admission failed: the notice is pending again, for the next one.
  book.release(first.ids, "c-1");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1" }).notices, [kill]);
});

test("delivered once in a conversation: a ledgered admission clears it there; a restart BEFORE that delivers it again", () => {
  const book = mkBook();
  book.raise(kill, "ws-1");
  const taken = book.take({ workspace: "ws-1", taker: "c-1" });

  // A restart before the ledger write: the persisted state still holds it, reservation and all
  // forgotten — the restored run's next admission carries it.
  const before = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.deepEqual(before.take({ workspace: "ws-1", taker: "c-1" }).notices, [kill]);

  // The ledger write: gone, and a restart after it does not bring it back.
  book.delivered(taken.ids, "c-1");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1" }).notices, []);
  const after = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.deepEqual(after.take({ workspace: "ws-1", taker: "c-1" }).notices, []);
});

test("a notice with a source is raised once, even after it was delivered", () => {
  const book = mkBook();
  assert.equal(book.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), true);
  // Two Turns lost to the SAME kernel kill both name it; a replayed stream re-reads a guard kill.
  assert.equal(book.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), false);
  book.delivered(book.take({ workspace: "ws-1", taker: "c-1" }).ids, "c-1");
  const restored = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.equal(restored.raise(kill, "ws-1", "ws-1@2026-09-28T10:03:00Z"), false, "the source is remembered");
  assert.deepEqual(restored.take({ workspace: "ws-1", taker: "c-1" }).notices, []);
});

test("the same news still unheard is one notice, whichever witness raised it", () => {
  const book = mkBook();
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), true);
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), false, "one kill, read on a stream and in the pod's list");
  // A second kill that tells the same thing keeps its own entry, so a take by its source finds it…
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-2"), true, "a second kill that tells the same thing");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1", only: ["ws-1@guard:k-2"] }).notices, [kill]);
  // …and an admission that takes both says it once, and delivers both.
  // (Its new ids must not repeat the restored ones', as the run host's never do.)
  let o = 0;
  const other = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), () => `o${++o}`);
  const both = other.take({ workspace: "ws-1", taker: "c-1" });
  assert.deepEqual(both.notices, [kill]);
  assert.equal(both.ids.length, 2);
  // A notice with no source merges only into a twin with none: one with a source keeps its own.
  assert.equal(other.raise(kill, "ws-1"), true);
  assert.equal(other.raise(kill, "ws-1"), false);
});

test("`only` narrows a take to the notices of those sources — what a nudge or a wake carries (ADR-0062)", () => {
  const book = mkBook();
  const idle: Notice = { kind: "memory-limit", scope: "workspace", peak: "1.9Gi", limit: "2Gi" };
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.raise(idle, "ws-1", "ws-1@guard:k-2");
  book.raise(fresh, "run/root/coder");
  const taken = book.take({ workspace: "ws-1", taker: "c-1", only: ["ws-1@guard:k-2"] });
  assert.deepEqual(taken.notices, [idle]);
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1", only: [] }).notices, [], "no source, no notice");
  assert.deepEqual(book.take({ workspace: "ws-1", conversation: "run/root/coder", taker: "c-1" }).notices, [
    kill,
    fresh,
  ]);
});

test("a burst is one notice: the older sources are marked raised with the newest (ADR-0062)", () => {
  const book = mkBook();
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-3", ["ws-1@guard:k-1", "ws-1@guard:k-2"]), true);
  assert.deepEqual(book.state().seen, ["ws-1@guard:k-1", "ws-1@guard:k-2", "ws-1@guard:k-3"]);
  assert.equal(book.state().pending.length, 1);
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-2"), false, "an older one, read again, adds nothing");
});

test("`restore` puts back a heard-not notice with its source, though the source is seen (ADR-0062)", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-0");
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  const taken = book.take({ workspace: "ws-1", taker: "c-1", only: ["ws-1@guard:k-1"] });
  assert.deepEqual(taken.raised, [{ notice: kill, source: "ws-1@guard:k-1" }]);
  book.delivered(taken.ids, "c-1");
  // No model heard it: back, with its source — not merged into k-0, which has the same words.
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1", "c-1"), true);
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1", "c-1"), false, "once");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c-1", except: ["ws-1@guard:k-0"] }).raised, [
    { notice: kill, source: "ws-1@guard:k-1" },
  ]);
});

// ---- A Workspace notice reaches every conversation in the Workspace, once each (ADR-0062) --------

test("a Workspace notice is delivered once in EACH conversation of the Workspace, not once in all", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");

  // Conversation A hears it, and its admission is ledgered.
  const a = book.take({ conversation: "a", workspace: "ws-1" });
  assert.deepEqual(a.notices, [kill]);
  book.delivered(a.ids, "a");

  // Conversation B, in the same Workspace, still hears it: A's delivery is A's alone.
  const b = book.take({ conversation: "b", workspace: "ws-1" });
  assert.deepEqual(b.notices, [kill]);
  book.delivered(b.ids, "b");

  // Each heard it once: neither hears it again.
  assert.deepEqual(book.take({ conversation: "a", workspace: "ws-1" }).notices, []);
  assert.deepEqual(book.take({ conversation: "b", workspace: "ws-1" }).notices, []);
  // A third conversation still does; one in another Workspace does not.
  assert.deepEqual(book.take({ conversation: "c", workspace: "ws-1" }).notices, [kill]);
  assert.deepEqual(book.take({ conversation: "d", workspace: "ws-2" }).notices, []);
});

test("a fresh Turn takes as its own new conversation; a scope with no taker takes no Workspace notice", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  assert.deepEqual(book.take({ workspace: "ws-1" }).notices, [], "no conversation to deliver it in");
  // A fresh Turn continues no conversation (no `conversation`), but it rides its own: `taker`, its
  // Instance ID.
  const first = book.take({ workspace: "ws-1", taker: "run/root/coder-x1" });
  assert.deepEqual(first.notices, [kill]);
  book.delivered(first.ids, "run/root/coder-x1");
  assert.deepEqual(
    book.take({ workspace: "ws-1", taker: "run/root/coder-x1" }).notices,
    [],
    "that conversation does not hear it again",
  );
  // The Agent's continued conversation is another conversation, which has not heard it.
  assert.deepEqual(
    book.take({ conversation: "run/root/coder", workspace: "ws-1", taker: "run/root/coder" }).notices,
    [kill],
    "the continued conversation does",
  );
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "run/root/reviewer-x2" }).notices, [kill], "another does");
});

test("an equal no-source notice raised after one was heard is a new notice for every conversation", () => {
  const book = mkBook();
  assert.equal(book.raise(kill, "ws-1"), true);
  book.delivered(book.take({ conversation: "a", workspace: "ws-1" }).ids, "a");
  // A second kill with the same words: A heard the first, so this one is news to A — and to B.
  assert.equal(book.raise(kill, "ws-1"), true, "not folded into a notice a conversation heard");
  assert.deepEqual(book.take({ conversation: "a", workspace: "ws-1" }).notices, [kill]);
  const b = book.take({ conversation: "b", workspace: "ws-1" });
  assert.deepEqual(b.notices, [kill], "B hears the words once");
  assert.equal(b.ids.length, 2, "for both kills");
  // Nor into one a conversation has reserved and not yet heard.
  const other = mkBook();
  other.raise(kill, "ws-1");
  other.take({ conversation: "a", workspace: "ws-1" });
  assert.equal(other.raise(kill, "ws-1"), true, "not folded into a reserved notice");
  // A restore of the first finds A's own: no second copy.
  assert.equal(book.restore(kill, "ws-1", undefined, "c"), false, "C has both pending already");
});

test("a reservation is per conversation: B takes while A is in flight, and A's failed admission puts it back for A", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  const a = book.take({ conversation: "a", workspace: "ws-1" });
  assert.deepEqual(a.notices, [kill]);
  assert.deepEqual(book.take({ conversation: "a", workspace: "ws-1" }).notices, [], "reserved for A's admission");
  assert.deepEqual(book.take({ conversation: "b", workspace: "ws-1" }).notices, [kill], "B's reservation is its own");

  // A's admission failed: pending again for A — and still reserved for B.
  book.release(a.ids, "a");
  assert.deepEqual(book.take({ conversation: "a", workspace: "ws-1" }).notices, [kill]);
  assert.deepEqual(book.take({ conversation: "b", workspace: "ws-1" }).notices, []);
});

test("a restart keeps who heard a Workspace notice: they do not hear it again, the others still do", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.delivered(book.take({ conversation: "a", workspace: "ws-1" }).ids, "a");
  // B took it, but the restart came before its ledger write: B hears it again.
  book.take({ conversation: "b", workspace: "ws-1" });

  const after = new NoticeLedger(JSON.parse(JSON.stringify(book.state())), ids());
  assert.deepEqual(after.take({ conversation: "a", workspace: "ws-1" }).notices, [], "A heard it before the restart");
  assert.deepEqual(after.take({ conversation: "b", workspace: "ws-1" }).notices, [kill]);
  assert.deepEqual(after.take({ conversation: "c", workspace: "ws-1" }).notices, [kill]);
  assert.equal(after.raise(kill, "ws-1", "ws-1@guard:k-1"), false, "the source is still seen");
});

test("`restore` of a Workspace notice puts it back for the conversation that did not hear it alone", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.delivered(book.take({ conversation: "a", workspace: "ws-1" }).ids, "a");
  book.delivered(book.take({ conversation: "b", workspace: "ws-1" }).ids, "b");
  // A's admission was ledgered, but no model read it.
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1", "a"), true);
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1", "a"), false, "once");
  assert.deepEqual(book.take({ conversation: "a", workspace: "ws-1" }).notices, [kill]);
  assert.deepEqual(book.take({ conversation: "b", workspace: "ws-1" }).notices, [], "B heard it");
  assert.equal(book.state().pending.length, 1, "one notice, not a second copy");
});

test("a conversation notice is unchanged: delivered once to its one conversation, then gone", () => {
  const book = mkBook();
  book.raise(fresh, "run/root/coder");
  const taken = book.take({ conversation: "run/root/coder" });
  assert.deepEqual(taken.notices, [fresh]);
  assert.deepEqual(book.take({ conversation: "run/root/coder" }).notices, [], "reserved");
  book.delivered(taken.ids, "run/root/coder");
  assert.deepEqual(book.state().pending, [], "it leaves the pending set");
  assert.deepEqual(book.take({ conversation: "run/root/coder" }).notices, []);
});

test("a mixed admission: its conversation notice leaves, its Workspace notice stays for the others", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.raise(fresh, "a");
  const taken = book.take({ conversation: "a", workspace: "ws-1" });
  assert.deepEqual(taken.notices, [kill, fresh]);
  book.delivered(taken.ids, "a");
  assert.deepEqual(
    book.state().pending.map((p) => [p.notice.kind, p.heardBy]),
    [["memory-limit", ["a"]]],
  );
});

test("idempotence is unchanged: one source raised twice is one notice; equal notices with no source fold in a take", () => {
  const book = mkBook();
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), true);
  assert.equal(book.raise(kill, "ws-1", "ws-1@guard:k-1"), false);
  assert.equal(book.raise(kill, "ws-1"), true);
  assert.equal(book.raise(kill, "ws-1"), false, "a no-source twin");
  const a = book.take({ conversation: "a", workspace: "ws-1" });
  assert.deepEqual(a.notices, [kill], "said once");
  assert.equal(a.ids.length, 2, "both reserved");
  book.delivered(a.ids, "a");
  const b = book.take({ conversation: "b", workspace: "ws-1" });
  assert.deepEqual(b.notices, [kill], "said once to B too");
  assert.equal(b.ids.length, 2);
});

// ---- The audience (ADR-0062, D4): an Agent hears a kill if it was there for it ----------------

test("the audience is fixed at the raise: a conversation admitted after the kill does not hear it", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", { taker: "a", slot: "root/a", continued: true, since: "2026-01-01T00:00:00Z" });
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { at: "2026-01-01T00:05:00Z" });
  // B arrives after the kill, and so does a conversation admitted before the read but after the kill.
  book.admitted("ws-1", { taker: "b", slot: "root/b", continued: true, since: "2026-01-01T00:06:00Z" });
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "b" }).notices, [], "B was not there");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "a" }).notices, [kill], "A was");
  // A kill no one was there for, that no Turn retries, tells no one: nothing is pending.
  const empty = new NoticeLedger(undefined, ids());
  assert.equal(empty.raise(kill, "ws-1", "ws-1@guard:k-9"), true, "the source is marked seen");
  assert.deepEqual(empty.state().pending, []);
});

test("an open fresh Turn is in the audience; when it ends unheard it leaves it, and a continued one stays", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", { taker: "fresh-1", slot: "root/coder", continued: false, since: SINCE });
  book.admitted("ws-1", { taker: "run/root/reviewer", slot: "root/reviewer", continued: true, since: SINCE });
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  assert.deepEqual(book.state().pending[0]!.audience, ["fresh-1", "run/root/reviewer"]);
  // Both Turns end: the fresh one can take no Turn again, the continued one can.
  book.ended("ws-1", ["fresh-1", "run/root/reviewer"]);
  assert.deepEqual(book.state().pending[0]!.audience, ["run/root/reviewer"]);
  assert.deepEqual(
    book.state().members!["ws-1"]!.map((m) => [m.taker, m.open]),
    [["run/root/reviewer", false]],
  );
  // A later kill: the continued conversation, between Turns, is there; the ended fresh one is not.
  book.raise(kill, "ws-1", "ws-1@guard:k-2");
  assert.deepEqual(book.state().pending[1]!.audience, ["run/root/reviewer"]);
  const heard = book.take({ workspace: "ws-1", taker: "run/root/reviewer" });
  assert.equal(heard.ids.length, 2);
  // Every member heard both: they retire.
  book.delivered(heard.ids, "run/root/reviewer");
  assert.deepEqual(book.state().pending, []);
});

test("a cut Turn's retry: its Agent's NEXT Turn hears the kill, fresh or continued; no other fresh Turn does", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", { taker: "coder-x1", slot: "root/coder", continued: false, since: SINCE });
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/coder", cut: "coder-x1" } });
  // The cut Turn ends unheard (its Agent faulted): it leaves the audience; the retry is still owed.
  book.ended("ws-1", ["coder-x1"]);
  assert.equal(book.state().pending.length, 1);
  // Another Agent's fresh Turn was not there and is no retry.
  assert.deepEqual(
    book.take({ workspace: "ws-1", taker: "reviewer-x2", slot: "root/reviewer", turn: true }).notices,
    [],
  );
  // A nudge of the cut slot is no new Turn.
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "coder-x3", slot: "root/coder" }).notices, []);
  // The coder's next Turn is the retry.
  const retry = book.take({ workspace: "ws-1", taker: "coder-x2", slot: "root/coder", turn: true });
  assert.deepEqual(retry.notices, [kill]);
  book.delivered(retry.ids, "coder-x2");
  assert.deepEqual(book.state().pending, [], "heard by its whole audience and its retry: retired");
});

test("a retry released is owed again", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/coder", cut: "coder-x1" } });
  const first = book.take({ workspace: "ws-1", taker: "coder-x2", slot: "root/coder", turn: true });
  book.release(first.ids, "coder-x2");
  const again = book.take({ workspace: "ws-1", taker: "coder-x3", slot: "root/coder", turn: true });
  assert.deepEqual(again.notices, [kill]);
  book.delivered(again.ids, "coder-x3");
  assert.deepEqual(book.state().pending, []);
});

// D4 rule 2: "that Agent's NEXT Turn, fresh or continued". The next Turn of a continued cut
// conversation is that conversation again: it is the retry, and the notice retires on it — no later
// Turn of the slot hears a kill long handled.
test("the cut Turn's own continued conversation: its next Turn is the retry, and the notice retires", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", { taker: "run/root/coder", slot: "root/coder", continued: true, since: SINCE });
  book.admitted("ws-1", { taker: "run/root/reviewer", slot: "root/reviewer", continued: true, since: SINCE });
  book.raise(kill, "ws-1", "ws-1@kernel:1", [], { retry: { slot: "root/coder", cut: "run/root/coder" } });
  const next = book.take({ workspace: "ws-1", taker: "run/root/coder", slot: "root/coder", turn: true });
  assert.deepEqual(next.notices, [kill]);
  book.delivered(next.ids, "run/root/coder");
  const reviewer = book.take({ workspace: "ws-1", taker: "run/root/reviewer", slot: "root/reviewer", turn: true });
  book.delivered(reviewer.ids, "run/root/reviewer");
  assert.deepEqual(book.state().pending, [], "every member and the retry heard it: retired");
  assert.deepEqual(
    book.take({ workspace: "ws-1", taker: "run/root/coder/1", slot: "root/coder", turn: true }).notices,
    [],
    "a later Turn of the slot is no retry",
  );
});

// D4 rule 3 with rule 2: a continued conversation whose own `bash` answer told it has the verdict in
// its context. Its next Turn is the retry and hears nothing; a fresh cut Turn's retry, a new
// conversation, still hears it.
test("a told cut conversation's next Turn is the retry and hears nothing; a told fresh Turn's retry hears it", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", { taker: "run/root/coder", slot: "root/coder", continued: true, since: SINCE });
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/coder", cut: "run/root/coder" } });
  book.told("ws-1@guard:k-1", ["run/root/coder"]);
  assert.deepEqual(
    book.take({ workspace: "ws-1", taker: "run/root/coder", slot: "root/coder", turn: true }).notices,
    [],
  );
  assert.deepEqual(book.state().pending, [], "the retry happened, in a conversation that knew: retired");

  const fresh = new NoticeLedger(undefined, ids());
  fresh.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/tester", cut: "tester-x1" } });
  fresh.told("ws-1@guard:k-1", ["tester-x1"]);
  assert.deepEqual(
    fresh.take({ workspace: "ws-1", taker: "tester-x2", slot: "root/tester", turn: true }).notices,
    [kill],
    "the next fresh Turn is a new conversation, which the answer never told",
  );
});

// One kill can cut several Turns: a guard kill is read on every running conversation's stream, and
// a kernel kill loses every Turn in the pod. Each Agent's next Turn retries its own work.
test("one kill that cut two Turns: each Agent's next Turn hears it, whichever witness raised first", () => {
  const book = new NoticeLedger(undefined, ids());
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/coder", cut: "coder-x1" } });
  assert.equal(
    book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/tester", cut: "tester-x1" } }),
    true,
    "the second witness adds its retry",
  );
  assert.equal(
    book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { retry: { slot: "root/tester", cut: "tester-x1" } }),
    false,
    "a replayed read adds nothing",
  );
  const coder = book.take({ workspace: "ws-1", taker: "coder-x2", slot: "root/coder", turn: true });
  const tester = book.take({ workspace: "ws-1", taker: "tester-x2", slot: "root/tester", turn: true });
  assert.deepEqual(coder.notices, [kill]);
  assert.deepEqual(tester.notices, [kill]);
  book.delivered(coder.ids, "coder-x2");
  assert.equal(book.state().pending.length, 1, "the tester's retry is still owed");
  book.delivered(tester.ids, "tester-x2");
  assert.deepEqual(book.state().pending, []);

  // A witness with no retry raised first — the admission's read of the kernel kill — and told no
  // one: the cut Turn's retry is still recorded.
  const late = new NoticeLedger(undefined, ids());
  late.raise(kill, "ws-1", "ws-1@kernel:1", [], { at: SINCE });
  assert.deepEqual(late.state().pending, []);
  late.raise(kill, "ws-1", "ws-1@kernel:1", [], { retry: { slot: "root/coder", cut: "coder-x1" }, at: SINCE });
  assert.deepEqual(late.take({ workspace: "ws-1", taker: "coder-x2", slot: "root/coder", turn: true }).notices, [kill]);
});

// A kernel kill's time is the kubelet's `finishedAt`, in whole seconds; a member's is this process's
// clock. A conversation admitted in the second before the kill was there for it.
test("the audience allows for the clocks: a member admitted in the kill's second is there", () => {
  const book = new NoticeLedger(undefined, ids());
  book.admitted("ws-1", {
    taker: "run/root/reviewer",
    slot: "root/reviewer",
    continued: true,
    since: "2026-01-01T12:00:00.400Z",
  });
  book.admitted("ws-1", {
    taker: "run/root/later",
    slot: "root/later",
    continued: true,
    since: "2026-01-01T12:00:05.000Z",
  });
  book.raise(kill, "ws-1", "ws-1@kernel:1", [], { at: "2026-01-01T12:00:00Z" });
  assert.deepEqual(book.state().pending[0]?.audience, ["run/root/reviewer"]);
});

test("a conversation its own `bash` answer told leaves the kill's audience, at the raise or later", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1", [], { told: ["a"] });
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "a" }).notices, [], "told at the raise");
  // Raised off a stream before the answer returned; the pod's list then says who was told.
  assert.equal(book.told("ws-1@guard:k-1", ["b"]), true);
  assert.equal(book.told("ws-1@guard:k-1", ["b"]), false, "once");
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "b" }).notices, []);
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "c" }).notices, [kill], "C was not told");
});

test("an acknowledgment is heard only for the ids its conversation reserved (ADR-0062 step boundary)", () => {
  const book = mkBook();
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  const taken = book.take({ workspace: "ws-1", taker: "a" });
  assert.equal(book.acknowledge(taken.ids, "b"), 0, "B reserved nothing");
  assert.equal(book.acknowledge(["n-unknown"], "a"), 0);
  assert.equal(book.acknowledge(taken.ids, "a"), 1);
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "a" }).notices, [], "heard");
  assert.deepEqual(book.state().pending[0]!.heardBy, ["a"]);
});

test("a burned conversation leaves every audience: it can take no Turn again", () => {
  const book = new NoticeLedger(undefined, ids());
  present(book, "ws-1", "run/root/coder", "run/root/reviewer");
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.delivered(book.take({ workspace: "ws-1", taker: "run/root/reviewer" }).ids, "run/root/reviewer");
  assert.equal(book.forget("run/root/coder"), true);
  assert.deepEqual(book.state().pending, [], "the one left heard it: retired");
  assert.deepEqual(
    book.state().members!["ws-1"]!.map((m) => m.taker),
    ["run/root/reviewer"],
  );
});

test("`restore` of a retired Workspace notice makes it pending again for the one that did not hear it", () => {
  const book = new NoticeLedger(undefined, ids());
  present(book, "ws-1", "a");
  book.raise(kill, "ws-1", "ws-1@guard:k-1");
  book.delivered(book.take({ workspace: "ws-1", taker: "a" }).ids, "a");
  assert.deepEqual(book.state().pending, [], "retired");
  assert.equal(book.restore(kill, "ws-1", "ws-1@guard:k-1", "a"), true);
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "a" }).notices, [kill]);
  assert.deepEqual(book.take({ workspace: "ws-1", taker: "b" }).notices, [], "for A alone");
});
