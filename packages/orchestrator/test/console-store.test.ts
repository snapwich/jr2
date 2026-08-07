// The Console's reducer (console/store.ts). One `.ts` both consumers read — Node strips the types
// here, the server erases them for the browser (ADR-0034) — and a PURE function of (store, frame)
// so this file can drive it with no DOM, no jsdom and no new deps.
//
// The page's renderer is already a pure function of (doc, status); this is the other half — what the
// page believes, kept separate from what it has painted. Everything worth testing about the client
// lives here: the frames arrive out of a network, and the interesting cases are the ones a manual
// click-through will not reproduce (a duplicate delivery, a reconnect, a run that ended while the
// connection was down).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyStore,
  applyFrame,
  fleetRuns,
  gateCount,
  selectedRunGates,
  visibleGates,
  SETTLED_CAP,
  type Frame,
  type GateCard,
} from "../console/store.ts";

const run = (runId: string, status = "active", workflow = "wf") => ({
  runId,
  workflow,
  status,
  value: "working",
  children: [],
});

const gate = (name = "approval"): GateCard => ({ gate: name, path: [], accepts: [{ name: "approve", input: {} }] });

/** Fold a sequence of frames from empty — most scenarios below are a short history, not one frame. */
const fold = (...frames: Frame[]) => frames.reduce(applyFrame, emptyStore());

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

// ---- Selection (the address) --------------------------------------------------------------------
// `/` and `/workflows/:name` are one shell; the path carries the workflow. `select` is the reducer's
// half of pushState/popstate: what a navigation resets, and what survives it.

test("`select` resets the feed's state — runs, settled, emits belong to the OLD selection", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "status", status: run("a") },
    { kind: "emit", runId: "a", type: "note" },
    { kind: "gone", runId: "a" },
  );
  store = applyFrame(store, { kind: "select", workflow: "other" });

  assert.equal(store.workflow, "other");
  assert.equal(store.runs.size, 0, "the new feed's opening `runs` frame is a whole set — empty is convergent");
  assert.equal(store.settled.size, 0);
  assert.deepEqual(store.emits, []);
  assert.equal(store.selectedRunId, null);
  assert.equal(store.connection, "connecting", "a new selection means a new socket");
});

test("`select` keeps the global halves — the inbox and the fleet outlive a navigation", () => {
  let store = fold(
    { kind: "fleet", workflow: "other", runs: [run("x", "active", "other")] },
    { kind: "token", state: "live" },
    { kind: "gates", runId: "x", workflow: "other", gates: [gate()] },
  );
  store = applyFrame(store, { kind: "select", workflow: "wf" });

  assert.ok(store.fleet.has("other"), "snapshots are the fleet's, not the selection's");
  assert.ok(store.gates.has("x"), "the inbox is global (ADR-0032) — a navigation is not a 401");
  assert.ok(store.expanded.has("wf"), "the selection auto-expands in the rail");
});

test("selecting the already-selected workflow changes nothing — popstate re-fires are free", () => {
  const store = fold({ kind: "select", workflow: "wf" }, { kind: "status", status: run("a") });
  assert.equal(applyFrame(store, { kind: "select", workflow: "wf" }), store);
});

test("`selectRun` is unvalidated — a card click can point at a run the new feed has not delivered yet", () => {
  let store = fold({ kind: "select", workflow: "wf" }, { kind: "selectRun", runId: "coming" });
  assert.equal(store.selectedRunId, "coming");

  // The feed's first frame confirms it: the run is real, the selection holds.
  store = applyFrame(store, { kind: "runs", runs: [run("coming"), run("other")] });
  assert.equal(store.selectedRunId, "coming");

  // Or denies it: the run is gone (or never was), and the selection moves on rather than pinning
  // the diagram to a run no frame will ever mention again.
  store = applyFrame(store, { kind: "runs", runs: [run("other")] });
  assert.equal(store.selectedRunId, "other");
});

// ---- The fleet (rail snapshots + folding) -------------------------------------------------------
// One EventSource, ever: the selected workflow holds it, the rest of the fleet is REST snapshots
// (`{kind:"fleet"}` frames). `fleetRuns` is the painter's one door to both.

test("a fleet snapshot is one workflow's whole set, replaced wholesale — same idiom as `runs`", () => {
  let store = fold({ kind: "fleet", workflow: "other", runs: [run("x", "active", "other")] });
  store = applyFrame(store, { kind: "fleet", workflow: "other", runs: [run("y", "active", "other")] });

  assert.deepEqual(
    fleetRuns(store, "other").map(({ run: r }) => r.runId),
    ["y"],
    "the snapshot is whatever the server just said",
  );
});

test("fleetRuns serves the selection from the feed and the rest from snapshots", () => {
  const store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "status", status: run("a") },
    { kind: "gone", runId: "a" },
    { kind: "status", status: run("b") },
    { kind: "fleet", workflow: "other", runs: [run("x", "active", "other")] },
  );

  assert.deepEqual(
    fleetRuns(store, "wf").map(({ run: r, settled }) => [r.runId, settled]),
    [
      ["b", false],
      ["a", true],
    ],
    "the selected workflow keeps the feed's memory, settled runs included",
  );
  assert.deepEqual(
    fleetRuns(store, "other").map(({ run: r, settled }) => [r.runId, settled]),
    [["x", false]],
    "an unselected workflow is its latest snapshot — no settled half, a snapshot has no memory",
  );
  assert.deepEqual(fleetRuns(store, "unknown"), [], "no snapshot yet is an empty list, not a crash");
});

test("the rail's folding is per workflow and toggles", () => {
  let store = fold({ kind: "toggleWorkflow", workflow: "wf" });
  assert.ok(store.expanded.has("wf"));
  store = applyFrame(store, { kind: "toggleWorkflow", workflow: "wf" });
  assert.ok(!store.expanded.has("wf"), "folded shut again");
});

// ---- The token ----------------------------------------------------------------------------------
// The reducer holds the credential's STATE, never its value (that stays in sessionStorage —
// ADR-0032). Anything but "live" is observer mode; the painter reads nothing else.

test("token transitions: none → checking → live is the unlock path", () => {
  let store = emptyStore();
  assert.equal(store.token, "none", "tokenless is the default — exactly today's observer");
  store = applyFrame(store, { kind: "token", state: "checking" });
  assert.equal(store.token, "checking");
  store = applyFrame(store, { kind: "token", state: "live" });
  assert.equal(store.token, "live");
});

test("leaving `live` empties the inbox — guarded data cannot outlive the credential that read it", () => {
  const unlocked = fold(
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
  );

  // The any-later-401 drop (ADR-0032): one widget's 401 is every widget's observer mode.
  const invalid = applyFrame(unlocked, { kind: "token", state: "invalid" });
  assert.equal(invalid.token, "invalid");
  assert.equal(invalid.gates.size, 0, "no card survives the credential");

  // Clearing the field is the same fact, voluntarily.
  const cleared = applyFrame(unlocked, { kind: "token", state: "none" });
  assert.equal(cleared.gates.size, 0);
});

test("`checking` keeps the inbox — a re-validation that comes back fine must not flash it empty", () => {
  const store = fold(
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
    { kind: "token", state: "checking" },
  );
  assert.equal(store.gates.size, 1);
});

test("a `gates` frame without a live credential is dropped — a straggling guarded re-fetch cannot repopulate the emptied inbox", () => {
  // The re-fetch was in flight when the token was cleared; its answer lands after the `token`
  // frame emptied the map. Folding it would be invisible while locked but surface intact on the
  // next unlock — guarded data outliving the credential that read it.
  const store = fold(
    { kind: "token", state: "live" },
    { kind: "token", state: "none" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
  );
  assert.equal(store.gates.size, 0);
});

// ---- The gate inbox -----------------------------------------------------------------------------
// Frame-triggered guarded re-fetches (ADR-0032): every `gates` frame is one run's WHOLE open-gate
// set off `GET /runs/:id`. A delivery's success is the next re-fetch coming back empty — the
// reducer does no bookkeeping of its own.

test("a `gates` frame fills a card; an empty re-fetch is the ONLY thing that empties it", () => {
  let store = fold(
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate("approval"), gate("veto")] },
  );
  assert.equal(gateCount(store), 2);

  // Re-delivery replaces wholesale — level-triggered, so a duplicate re-fetch is idempotent.
  store = applyFrame(store, { kind: "gates", runId: "a", workflow: "wf", gates: [gate("approval")] });
  assert.deepEqual(
    store.gates.get("a")?.gates.map((g) => g.gate),
    ["approval"],
  );

  // The delivery succeeded server-side; the frame-triggered re-fetch reports no open gates. THAT is
  // what removes the card — never a local "I posted, so it worked".
  store = applyFrame(store, { kind: "gates", runId: "a", workflow: "wf", gates: [] });
  assert.equal(store.gates.size, 0);
  assert.equal(gateCount(store), 0);
});

test("`gone` takes the run's card with it — a gate exists only while its state is entered", () => {
  const store = fold(
    { kind: "status", status: run("a") },
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
    { kind: "gone", runId: "a" },
  );
  assert.equal(store.gates.size, 0);
  assert.ok(store.settled.has("a"), "the run itself still settles as ever");
});

test("a whole-set frame settles the inbox cards its runs left behind", () => {
  // A run that ended during a disconnect gets no `gone` and will never be re-fetched again — the
  // `runs` frame's wholeness is what says its card is stale. Same for a fleet snapshot's workflow.
  let store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
    { kind: "gates", runId: "x", workflow: "other", gates: [gate()] },
  );
  store = applyFrame(store, { kind: "runs", runs: [run("b")] });
  assert.ok(!store.gates.has("a"), "the reconnected feed does not know `a` — neither does the inbox");
  assert.ok(store.gates.has("x"), "another workflow's card is not this frame's to settle");

  store = applyFrame(store, { kind: "fleet", workflow: "other", runs: [] });
  assert.ok(!store.gates.has("x"), "and the snapshot settles its own workflow's the same way");
});

test("the visible inbox follows the selection until widened; the badge count never filters", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "token", state: "live" },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
    { kind: "gates", runId: "x", workflow: "other", gates: [gate(), gate("veto")] },
  );

  assert.deepEqual(
    visibleGates(store).map((e) => e.runId),
    ["a"],
    "filtered to the selection",
  );
  assert.equal(gateCount(store), 3, "attention is global even when the view is not");

  store = applyFrame(store, { kind: "inboxScope", all: true });
  assert.deepEqual(
    visibleGates(store).map((e) => e.runId),
    ["a", "x"],
    "the widen control",
  );

  store = applyFrame(store, { kind: "inboxScope", all: false });
  store = applyFrame(store, { kind: "select", workflow: null });
  assert.equal(visibleGates(store).length, 2, "at `/` there is no selection to filter by");
});

// ---- Small page-owned facts through the same door -----------------------------------------------

test("`connection` and `startForm` are frames like any other — main.ts owns no belief of its own", () => {
  let store = fold({ kind: "connection", state: "live" }, { kind: "startForm", workflow: "wf" });
  assert.equal(store.connection, "live");
  assert.equal(store.startFormFor, "wf");
  store = applyFrame(store, { kind: "startForm", workflow: null });
  assert.equal(store.startFormFor, null);
});

test("`workflows` is the fleet listing, replaced wholesale", () => {
  const store = fold({ kind: "workflows", workflows: ["a", "b"] });
  assert.deepEqual(store.workflows, ["a", "b"]);
});

// ---- The diagram's node selection, and the gate pin's inputs ------------------------------------

test("`selectNode` holds one node at a time — a new click replaces, a repeat click clears", () => {
  let store = applyFrame(emptyStore(), { kind: "selectNode", nodeId: "F-1/wf.review" });
  assert.equal(store.selectedNodeId, "F-1/wf.review");
  store = applyFrame(store, { kind: "selectNode", nodeId: "wf.plan" });
  assert.equal(store.selectedNodeId, "wf.plan", "the new selection replaces the old — never two outlines");
  store = applyFrame(store, { kind: "selectNode", nodeId: "wf.plan" });
  assert.equal(store.selectedNodeId, null, "with no other click behavior, re-click is the deselect");
});

test("`select` clears the node selection — elk node ids are scoped to the diagram that minted them", () => {
  let store = fold({ kind: "select", workflow: "wf" }, { kind: "selectNode", nodeId: "wf.plan" });
  store = applyFrame(store, { kind: "select", workflow: "other" });
  assert.equal(store.selectedNodeId, null);
  // A RUN switch does not clear it: a stale instance-scoped id matches no box (inert), and a
  // root-scope id names the same state under any run — that selection is worth keeping.
  store = fold({ kind: "selectNode", nodeId: "wf.plan" }, { kind: "selectRun", runId: "b" });
  assert.equal(store.selectedNodeId, "wf.plan");
});

test("selectedRunGates follows the selected run — the pin is a view over facts already held", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "token", state: "live" },
    { kind: "runs", runs: [run("a"), run("b")] },
    { kind: "gates", runId: "a", workflow: "wf", gates: [gate()] },
    { kind: "gates", runId: "b", workflow: "wf", gates: [gate("veto")] },
  );
  assert.deepEqual(
    selectedRunGates(store).map((g) => g.gate),
    ["approval"],
    "selection fell to the first run, so its card is the pin's input",
  );
  store = applyFrame(store, { kind: "selectRun", runId: "b" });
  assert.deepEqual(
    selectedRunGates(store).map((g) => g.gate),
    ["veto"],
  );
  store = applyFrame(store, { kind: "gates", runId: "b", workflow: "wf", gates: [] });
  assert.deepEqual(selectedRunGates(store), [], "an emptied card takes the pin with it");
});
