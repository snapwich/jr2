// The visualizer page's reducer (viz/store.js). Plain .js so a browser can load it unbuilt, and a
// PURE function of (store, frame) so this file can drive it with no DOM, no jsdom and no new deps.
//
// The page's renderer is already a pure function of (doc, status); this is the other half — what the
// page believes, kept separate from what it has painted. Everything worth testing about the client
// lives here: the frames arrive out of a network, and the interesting cases are the ones a manual
// click-through will not reproduce (a duplicate delivery, a reconnect, a run that ended while the
// connection was down).

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, applyFrame, SETTLED_CAP } from "../viz/store.js";

const run = (runId: string, status = "active") => ({ runId, workflow: "wf", status, value: "working", children: [] });

test("the opening `runs` frame is the whole live set", () => {
  const store = applyFrame(emptyStore(), { kind: "runs", runs: [run("a"), run("b")] });
  assert.deepEqual([...store.runs.keys()], ["a", "b"]);
});

test("a duplicate status is idempotent — the feed is level-triggered, so re-delivery is normal", () => {
  let store = applyFrame(emptyStore(), { kind: "runs", runs: [] });
  store = applyFrame(store, { kind: "status", status: run("a") });
  const once = store.runs.get("a");
  store = applyFrame(store, { kind: "status", status: run("a") });

  assert.equal(store.runs.size, 1, "the same frame twice is still one run");
  assert.deepEqual(store.runs.get("a"), once);
});

test("a status carries a whole observation, so a later one simply replaces the earlier", () => {
  let store = applyFrame(emptyStore(), { kind: "status", status: run("a", "active") });
  store = applyFrame(store, { kind: "status", status: { ...run("a"), value: "review" } });

  // Never a patch to merge: whatever the last frame said IS the run. That is what makes a reconnect
  // convergent without a replay buffer on either side.
  assert.equal(store.runs.get("a")?.value, "review");
  assert.equal(store.runs.size, 1);
});

test("`gone` moves a run into settled — the client's own memory of what it watched leave", () => {
  let store = applyFrame(emptyStore(), { kind: "status", status: run("a", "done") });
  store = applyFrame(store, { kind: "gone", runId: "a" });

  assert.equal(store.runs.size, 0, "no longer live");
  assert.equal(store.settled.get("a")?.status, "done", "but still on the page, where the reader can see it");
});

test("`gone` for a run we never saw is a no-op, not a phantom entry", () => {
  // Perfectly ordinary: a run can start and finish entirely inside a reconnect window.
  const store = applyFrame(emptyStore(), { kind: "gone", runId: "never-seen" });
  assert.equal(store.runs.size, 0);
  assert.equal(store.settled.size, 0);
});

test("a `runs` frame replaces the live set but never touches settled", () => {
  let store = applyFrame(emptyStore(), { kind: "status", status: run("a") });
  store = applyFrame(store, { kind: "status", status: run("b") });
  store = applyFrame(store, { kind: "gone", runId: "a" });

  // Reconnect: `runs` is the server's whole truth about what is LIVE. `b` ended during the outage,
  // so it is simply absent — no `gone` was ever delivered for it, and none is needed.
  store = applyFrame(store, { kind: "runs", runs: [run("c")] });

  assert.deepEqual([...store.runs.keys()], ["c"], "the live set is whatever the server just said");
  assert.deepEqual([...store.settled.keys()], ["a"], "and what this page watched leave is still its own");
});

test("settled is capped, oldest evicted — a long-lived page must not grow without bound", () => {
  let store = emptyStore();
  for (let i = 0; i < SETTLED_CAP + 5; i++) {
    store = applyFrame(store, { kind: "status", status: run(`r${i}`) });
    store = applyFrame(store, { kind: "gone", runId: `r${i}` });
  }
  assert.equal(store.settled.size, SETTLED_CAP);
  assert.ok(!store.settled.has("r0"), "the oldest is evicted");
  assert.ok(store.settled.has(`r${SETTLED_CAP + 4}`), "the newest is kept");
});

test("selection follows the first run to appear — the fix for a page opened before any run existed", () => {
  let store = emptyStore();
  assert.equal(store.selectedRunId, null);

  store = applyFrame(store, { kind: "runs", runs: [] }); // page loads, nothing running
  assert.equal(store.selectedRunId, null, "nothing to select yet");

  store = applyFrame(store, { kind: "status", status: run("a") });
  assert.equal(store.selectedRunId, "a", "the first run to arrive is selected, with no click");
});

test("an explicit selection is kept while that run is still known", () => {
  let store = applyFrame(emptyStore(), { kind: "runs", runs: [run("a"), run("b")] });
  store = { ...store, selectedRunId: "b" }; // the reader clicked
  store = applyFrame(store, { kind: "status", status: run("a") });
  assert.equal(store.selectedRunId, "b", "someone else's frame does not steal the selection");

  // Still theirs once it settles: a reader watching a run to its end keeps watching it.
  store = applyFrame(store, { kind: "gone", runId: "b" });
  assert.equal(store.selectedRunId, "b");
});

test("selection moves on when the selected run is neither live nor settled", () => {
  let store = applyFrame(emptyStore(), { kind: "runs", runs: [run("a")] });
  assert.equal(store.selectedRunId, "a");

  // A reconnect whose `runs` frame does not mention `a`: it ended while the connection was down, so
  // no `gone` ever arrived and it is not in settled either. Without this the page would sit on a
  // run it can never hear from again.
  store = applyFrame(store, { kind: "runs", runs: [run("z")] });
  assert.equal(store.selectedRunId, "z");
});

test("emits accumulate newest-first against their run, and are capped", () => {
  let store = applyFrame(emptyStore(), { kind: "status", status: run("a") });
  store = applyFrame(store, { kind: "emit", runId: "a", type: "first" });
  store = applyFrame(store, { kind: "emit", runId: "a", type: "second" });

  assert.deepEqual(
    store.emits.map((e: { type: string }) => e.type),
    ["second", "first"],
  );
  assert.equal(store.emits[0]?.runId, "a");
});

test("the connection state is the page's own, untouched by frames", () => {
  let store = emptyStore();
  assert.equal(store.connection, "connecting");
  store = { ...store, connection: "live" };
  store = applyFrame(store, { kind: "status", status: run("a") });
  assert.equal(store.connection, "live", "a frame says nothing about the socket that carried it");
});
