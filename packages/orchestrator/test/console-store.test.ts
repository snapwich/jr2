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
  failureReason,
  dispatchBadge,
  dispatchStrip,
  dispatchedStrip,
  docSeats,
  fleetEntries,
  fleetRuns,
  callerLabel,
  callerScopes,
  gateCount,
  machineDocSource,
  may,
  runList,
  selectedRun,
  selectedRunFailure,
  selectedRunGates,
  selectedRunHeld,
  selectedRunStarter,
  selectedRunWaiting,
  visibleGates,
  SETTLED_CAP,
  activeSlot,
  olderAssembly,
  olderAssemblyMark,
  selectedDocSource,
  selectedRunDrift,
  slotConversations,
  slotTabs,
  type CallerView,
  type RunSummaryView,
  type Frame,
  type GateCard,
  type WaitingLine,
  type SeatedBody,
  type WorkflowListing,
} from "../console/store.ts";
import { foldEntries, mergeEntries, readSse, type ConversationEntry } from "../console/conversation.ts";

const run = (runId: string, status = "active", workflow = "wf") => ({
  runId,
  workflow,
  status,
  value: "working",
  children: [],
});

const gate = (name = "approval"): GateCard => ({ gate: name, path: [], accepts: [{ name: "approve", input: {} }] });

/** One read of `GET /gates` (ADR-0011): the whole inbox, each run's Gates in the order given. */
const inbox = (...runs: Array<[runId: string, workflow: string, gates: GateCard[]]>): Frame => ({
  kind: "inbox",
  gates: runs.flatMap(([runId, workflow, gates]) => gates.map((g) => ({ runId, workflow, ...g }))),
});

/** A live credential whose Caller may answer and read every Workflow — the Instance token's scopes. */
const unlocked: Frame[] = [
  { kind: "caller", caller: { via: "token", name: "instance", may: { answer: "all", read: "all" } } },
  { kind: "token", state: "live" },
];

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
    ...unlocked,
    inbox(["x", "other", [gate()]]),
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
    fleetRuns(store, "other").map((r) => r.runId),
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
    fleetRuns(store, "wf").map((r) => [r.runId, r.settled]),
    [
      ["b", false],
      ["a", true],
    ],
    "the selected workflow keeps the feed's memory, settled runs included",
  );
  assert.deepEqual(
    fleetRuns(store, "other").map((r) => [r.runId, r.settled]),
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
  const opened = fold(...unlocked, inbox(["a", "wf", [gate()]]));

  // The any-later-401 drop (ADR-0032): one widget's 401 is every widget's observer mode.
  const invalid = applyFrame(opened, { kind: "token", state: "invalid" });
  assert.equal(invalid.token, "invalid");
  assert.equal(invalid.gates.size, 0, "no card survives the credential");

  // Clearing the field is the same fact, voluntarily.
  const cleared = applyFrame(opened, { kind: "token", state: "none" });
  assert.equal(cleared.gates.size, 0);
});

test("`checking` keeps the inbox — a re-validation that comes back fine must not flash it empty", () => {
  const store = fold(...unlocked, inbox(["a", "wf", [gate()]]), { kind: "token", state: "checking" });
  assert.equal(store.gates.size, 1);
});

test("an `inbox` frame without a live credential is dropped — a straggling guarded read cannot repopulate the emptied inbox", () => {
  // The read was in flight when the token was cleared; its answer lands after the `token` frame
  // emptied the map. Folding it would be invisible while locked but surface intact on the next
  // unlock — guarded data outliving the credential that read it.
  const store = fold(...unlocked, { kind: "token", state: "none" }, inbox(["a", "wf", [gate()]]));
  assert.equal(store.gates.size, 0);
});

// ---- The gate inbox -----------------------------------------------------------------------------
// Frame-triggered guarded reads (ADR-0032): every `inbox` frame is the WHOLE answer of `GET /gates`
// (ADR-0011), every open Gate the Caller may answer. A delivery's success is the next read coming
// back without the card — the reducer does no bookkeeping of its own.

test("an `inbox` frame fills the cards; a read without the card is the ONLY thing that empties it", () => {
  let store = fold(...unlocked, inbox(["a", "wf", [gate("approval"), gate("veto")]]));
  assert.equal(gateCount(store), 2);

  // Re-delivery replaces wholesale — level-triggered, so a duplicate read is idempotent.
  store = applyFrame(store, inbox(["a", "wf", [gate("approval")]]));
  assert.deepEqual(
    store.gates.get("a")?.gates.map((g) => g.gate),
    ["approval"],
  );

  // The delivery succeeded server-side; the frame-triggered read lists no open Gate. THAT is what
  // removes the card — never a local "I posted, so it worked".
  store = applyFrame(store, inbox());
  assert.equal(store.gates.size, 0);
  assert.equal(gateCount(store), 0);
});

test("the inbox keeps the server's order and each Gate's open time, and the card holds no run id", () => {
  const openedAt = "2026-11-06T09:00:00.000Z";
  const store = fold(...unlocked, {
    kind: "inbox",
    gates: [
      { runId: "b", workflow: "wf", ...gate("old"), openedAt },
      { runId: "a", workflow: "other", ...gate("mid") },
      { runId: "b", workflow: "wf", ...gate("new") },
    ],
  });
  assert.deepEqual([...store.gates.keys()], ["b", "a"], "oldest first, as `GET /gates` lists them");
  assert.deepEqual(
    store.gates.get("b")?.gates.map((g) => [g.gate, g.openedAt]),
    [
      ["old", openedAt],
      ["new", undefined],
    ],
  );
  assert.equal("runId" in (store.gates.get("b")?.gates[0] ?? {}), false);
});

test("`gone` takes the run's card with it — a gate exists only while its state is entered", () => {
  const store = fold({ kind: "status", status: run("a") }, ...unlocked, inbox(["a", "wf", [gate()]]), {
    kind: "gone",
    runId: "a",
  });
  assert.equal(store.gates.size, 0);
  assert.ok(store.settled.has("a"), "the run itself still settles as ever");
});

test("a whole-set frame of runs leaves the inbox alone — `GET /gates` is its own whole set", () => {
  // The inbox is every Workflow's, read whole on each frame: a `runs` frame or a snapshot does not
  // speak for it, and the next read settles a card of a run that ended during a disconnect.
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    inbox(["a", "wf", [gate()]], ["x", "other", [gate()]]),
  );
  store = applyFrame(store, { kind: "runs", runs: [run("b")] });
  store = applyFrame(store, { kind: "fleet", workflow: "other", runs: [] });
  assert.deepEqual([...store.gates.keys()], ["a", "x"]);
  store = applyFrame(store, inbox());
  assert.equal(store.gates.size, 0, "the read is what settles them");
});

test("the visible inbox follows the selection until widened; the badge count never filters", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    inbox(["a", "wf", [gate()]], ["x", "other", [gate(), gate("veto")]]),
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
    ...unlocked,
    { kind: "runs", runs: [run("a"), run("b")] },
    inbox(["a", "wf", [gate()]], ["b", "wf", [gate("veto")]]),
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
  store = applyFrame(store, inbox(["a", "wf", [gate()]]));
  assert.deepEqual(selectedRunGates(store), [], "an emptied card takes the pin with it");
});

// ---- A wait for capacity (ADR-0064) -------------------------------------------------------------
// The diagram lights `placing` off the open observation like any state. WHY it waits is guarded —
// the scheduler's or the quota's own words — so it rides the same `GET /runs/:id` re-fetch as the
// gates, folded under the same rules.

const wait = (child = "F-1", on: WaitingLine["on"] = "node"): WaitingLine => ({
  child,
  on,
  message: "0/3 nodes are available: 3 Insufficient memory.",
  since: "2026-09-29T10:00:00.000Z",
});

test("a `placing` Workspace lights from the open observation alone — no token, no reason", () => {
  const placing = {
    ...run("a"),
    children: [{ id: "F-1", src: "ws", status: "active", value: "placing", children: [] }],
  };
  let store = fold({ kind: "select", workflow: "wf" }, { kind: "status", status: placing });
  assert.equal((store.runs.get("a")!.children[0] as { value: unknown }).value, "placing");
  // Observer mode: a `waiting` frame (a re-fetch still in flight as the token dropped) folds nothing.
  store = applyFrame(store, { kind: "waiting", runId: "a", workflow: "wf", waiting: [wait()] });
  assert.deepEqual(selectedRunWaiting(store), []);
});

test("`waiting` follows the selected run, is whole per run, and an empty re-fetch clears it", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a"), run("b")] },
    { kind: "waiting", runId: "a", workflow: "wf", waiting: [wait("F-1"), wait("F-2", "quota")] },
  );
  assert.deepEqual(
    selectedRunWaiting(store).map((w) => [w.child, w.on]),
    [
      ["F-1", "node"],
      ["F-2", "quota"],
    ],
  );
  store = applyFrame(store, { kind: "selectRun", runId: "b" });
  assert.deepEqual(selectedRunWaiting(store), [], "b waits for nothing");

  store = applyFrame(store, { kind: "selectRun", runId: "a" });
  store = applyFrame(store, { kind: "waiting", runId: "a", workflow: "wf", waiting: [wait("F-2", "quota")] });
  assert.deepEqual(
    selectedRunWaiting(store).map((w) => w.child),
    ["F-2"],
    "a re-fetch replaces wholesale",
  );
  store = applyFrame(store, { kind: "waiting", runId: "a", workflow: "wf", waiting: [] });
  assert.equal(store.waiting.size, 0, "placed: the next re-fetch says nothing waits");
});

test('an outstanding pick rides the same re-fetch: "outstanding since" for the selected run, cleared when it is answered (ADR-0024)', () => {
  const since = "2026-10-06T10:00:00.000Z";
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a")] },
    { kind: "waiting", runId: "a", workflow: "wf", waiting: [], held: [{ agent: "coder", pick: "run_tests", since }] },
  );
  assert.deepEqual(selectedRunHeld(store), [{ agent: "coder", pick: "run_tests", since }]);
  assert.deepEqual(selectedRunWaiting(store), [], "nothing waits for capacity");
  store = applyFrame(store, { kind: "waiting", runId: "a", workflow: "wf", waiting: [], held: [] });
  assert.deepEqual(selectedRunHeld(store), [], "answered: nothing is held");
  assert.equal(store.waiting.size, 0);
  assert.equal(
    fold(
      { kind: "select", workflow: "wf" },
      { kind: "waiting", runId: "a", workflow: "wf", waiting: [], held: [{ agent: "coder", pick: "x", since }] },
    ).waiting.size,
    0,
    "observer mode folds nothing",
  );
});

test("the reason cannot outlive the credential, the run, or a whole-set frame that dropped it", () => {
  const live = (): Frame[] => [
    { kind: "select", workflow: "wf" },
    { kind: "status", status: run("a") },
    ...unlocked,
    { kind: "waiting", runId: "a", workflow: "wf", waiting: [wait()] },
  ];
  assert.equal(fold(...live(), { kind: "token", state: "invalid" }).waiting.size, 0, "a 401 drops it");
  assert.equal(fold(...live(), { kind: "token", state: "none" }).waiting.size, 0, "clearing the token drops it");
  assert.equal(fold(...live(), { kind: "token", state: "checking" }).waiting.size, 1, "re-validation keeps it");
  assert.equal(fold(...live(), { kind: "gone", runId: "a" }).waiting.size, 0, "the run left");
  assert.equal(fold(...live(), { kind: "runs", runs: [run("b")] }).waiting.size, 0, "the live set dropped it");

  const other = fold(
    ...unlocked,
    { kind: "waiting", runId: "x", workflow: "other", waiting: [wait()] },
    { kind: "fleet", workflow: "other", runs: [] },
  );
  assert.equal(other.waiting.size, 0, "a fleet snapshot settles its own workflow's the same way");
});

// --- the seats (ADR-0015): who may send what, per state, for the Machine and what it composes ----

test("docSeats reads the root's seats and warnings, then each child Machine's, depth-first in state order", () => {
  const leaf = (machine?: SeatedBody): SeatedBody["root"] => ({ states: [], children: machine ? [{ machine }] : [] });
  const child = (id: string, warnings: string[] = []): SeatedBody => ({
    seats: [{ state: `${id}.s`, party: "gate" as const, names: [id] }],
    warnings,
    root: leaf(),
  });
  const doc = {
    seats: [{ state: "wf.w", party: "agent" as const, agent: "coder", names: ["finish", "submit"] }],
    warnings: ["a mode nothing enters"],
    root: { states: [leaf(child("a", ["one name, two meanings"])), leaf(child("b"))], children: [] },
  };
  assert.deepEqual(docSeats(doc), {
    seats: [
      { state: "wf.w", party: "agent", agent: "coder", names: ["finish", "submit"] },
      { state: "a.s", party: "gate", names: ["a"] },
      { state: "b.s", party: "gate", names: ["b"] },
    ],
    warnings: ["a mode nothing enters", "one name, two meanings"],
  });
});

test("docSeats is empty with no doc, and for a recursive child (no body) or a Machine not built by jr2Setup", () => {
  assert.deepEqual(docSeats(null), { seats: [], warnings: [] });
  assert.deepEqual(docSeats({ root: { states: [], children: [{}] } }), { seats: [], warnings: [] });
});

// ---- Charts (ADR-0070) --------------------------------------------------------------------------
// `GET /workflows` lists each Workflow with its origin, a Chart wrapper's named Charts inside its
// entry; the rail draws them indented under the wrapper. A run that binds a Chart draws its own
// Machine, so the pane's doc is per run id for it and per Workflow for every other run.

const LISTING: WorkflowListing[] = [
  { name: "ping", origin: "machine" },
  {
    name: "charted",
    origin: "machine",
    wrapper: {
      body: "body",
      oneShot: true,
      charts: [
        { name: "sample", origin: "file" },
        { name: "loop", origin: "runtime", unrunnable: 'states.draft.invoke.src: "coder" is not lent' },
      ],
    },
  },
];

test("the listing's names are every Workflow and every named Chart, as `<wrapper>/<name>`", () => {
  const store = fold({ kind: "workflows", workflows: LISTING });
  assert.deepEqual(store.workflows, ["ping", "charted", "charted/sample", "charted/loop"]);
  assert.deepEqual(store.listing, LISTING);
});

test("a wrapper's Charts are rows indented under it, with their origin and why one is unrunnable", () => {
  assert.deepEqual(fleetEntries(LISTING), [
    { name: "ping", origin: "machine", depth: 0 },
    { name: "charted", origin: "machine", depth: 0, wrapper: { body: "body", oneShot: true } },
    { name: "charted/sample", origin: "file", depth: 1 },
    {
      name: "charted/loop",
      origin: "runtime",
      depth: 1,
      unrunnable: 'states.draft.invoke.src: "coder" is not lent',
    },
  ]);
});

test("a Chart the listing also gives at the top level is one row, under its wrapper; an orphan stays on top", () => {
  const rows = fleetEntries([
    ...LISTING,
    { name: "charted/sample", origin: "file" },
    { name: "gone/orphan", origin: "runtime", unrunnable: 'no Workflow "gone"' },
  ]);
  assert.equal(rows.filter((r) => r.name === "charted/sample").length, 1);
  assert.deepEqual(rows.at(-1), {
    name: "gone/orphan",
    origin: "runtime",
    depth: 0,
    unrunnable: 'no Workflow "gone"',
  });
});

test("a listing of bare names (an Orchestrator older than ADR-0070) reads as Machines", () => {
  const store = fold({ kind: "workflows", workflows: ["a", "b"] });
  assert.deepEqual(fleetEntries(store.listing), [
    { name: "a", origin: "machine", depth: 0 },
    { name: "b", origin: "machine", depth: 0 },
  ]);
});

test("a later listing replaces the earlier wholesale: a deleted Chart leaves the rail", () => {
  const store = fold(
    { kind: "workflows", workflows: LISTING },
    { kind: "workflows", workflows: [{ ...LISTING[1]!, wrapper: { body: "body", oneShot: true, charts: [] } }] },
  );
  assert.deepEqual(store.workflows, ["charted"]);
});

test("a bound run draws its own Machine, per run id; any other run draws the Workflow's", () => {
  assert.deepEqual(machineDocSource("charted", { runId: "r1", bound: true }), {
    key: "run:r1",
    path: "/workflows/charted/runs/r1/machine",
  });
  assert.deepEqual(machineDocSource("charted", { runId: "r2" }), {
    key: "workflow:charted@",
    path: "/workflows/charted/machine",
  });
  assert.deepEqual(machineDocSource("charted", null), machineDocSource("charted", { runId: "r3" }));
});

test("a named Chart's name rides the doc route as one encoded segment", () => {
  assert.equal(machineDocSource("charted/loop", null).path, "/workflows/charted%2Floop/machine");
  assert.equal(
    machineDocSource("charted/loop", { runId: "r1", bound: true }).path,
    "/workflows/charted%2Floop/runs/r1/machine",
  );
});

test("the doc choice follows the selected run's observation: a status that says `bound` moves it", () => {
  let store = fold({ kind: "select", workflow: "charted" }, { kind: "runs", runs: [run("a", "active", "charted")] });
  assert.equal(machineDocSource("charted", selectedRun(store)).key, "workflow:charted@");
  store = applyFrame(store, { kind: "status", status: { ...run("a", "active", "charted"), bound: true } });
  assert.equal(machineDocSource("charted", selectedRun(store)).key, "run:a");
});

test("a Chart file that shadows a runtime Chart of its name is one row, the runtime Chart a note on it", () => {
  const reason = "the Assembly's Chart file holds this name";
  for (const charts of [
    [
      { name: "sample", origin: "file" as const },
      { name: "sample", origin: "runtime" as const, unrunnable: reason },
    ],
    [
      { name: "sample", origin: "runtime" as const, unrunnable: reason },
      { name: "sample", origin: "file" as const },
    ],
  ]) {
    const listing: WorkflowListing[] = [
      { name: "charted", origin: "machine", wrapper: { body: "body", oneShot: true, charts } },
    ];
    assert.deepEqual(fleetEntries(listing), [
      { name: "charted", origin: "machine", depth: 0, wrapper: { body: "body", oneShot: true } },
      { name: "charted/sample", origin: "file", depth: 1, shadows: { origin: "runtime", unrunnable: reason } },
    ]);
    assert.deepEqual(fold({ kind: "workflows", workflows: listing }).workflows, ["charted", "charted/sample"]);
  }
});

test("a run that binds a second Chart in its life draws a second doc: the key holds the Charts' hashes", () => {
  const first = machineDocSource("planner", { runId: "r1", bound: true, chartHashes: ["aaaaaaaaaaaa"] });
  const second = machineDocSource("planner", { runId: "r1", bound: true, chartHashes: ["bbbbbbbbbbbb"] });
  assert.notEqual(first.key, second.key);
  assert.equal(first.path, second.path, "one route serves the doc of what the run binds now");
  let store = fold({ kind: "select", workflow: "planner" }, { kind: "runs", runs: [run("a", "active", "planner")] });
  store = applyFrame(store, {
    kind: "status",
    status: { ...run("a", "active", "planner"), bound: true, chartHashes: ["aaaaaaaaaaaa"] },
  });
  const a = machineDocSource("planner", selectedRun(store)).key;
  store = applyFrame(store, { kind: "status", status: run("a", "active", "planner") });
  store = applyFrame(store, {
    kind: "status",
    status: { ...run("a", "active", "planner"), bound: true, chartHashes: ["bbbbbbbbbbbb"] },
  });
  assert.notEqual(machineDocSource("planner", selectedRun(store)).key, a);
});

// A dispatched run (ADR-0071) names its caller on the open band: the reducer keeps the observation
// whole, so `dispatchedBy` rides every frame that carries a run, with no fetch and no token.

const dispatched = (runId: string, status = "active") => ({
  ...run(runId, status),
  dispatchedBy: { run: "caller-0123456789", slot: "review", depth: 1 },
});

test("`dispatchedBy` is kept through `runs`, `status` and `gone`, with no token", () => {
  let store = applyFrame(emptyStore(), { kind: "runs", runs: [dispatched("a")] });
  assert.equal(store.token, "none");
  assert.deepEqual(store.runs.get("a")?.dispatchedBy, { run: "caller-0123456789", slot: "review", depth: 1 });
  store = applyFrame(store, { kind: "status", status: dispatched("a", "active") });
  assert.equal(store.runs.get("a")?.dispatchedBy?.slot, "review");
  store = applyFrame(store, { kind: "gone", runId: "a" });
  assert.equal(store.settled.get("a")?.dispatchedBy?.run, "caller-0123456789", "a settled run keeps its caller");
  assert.equal(selectedRun(store)?.dispatchedBy?.depth, 1);
});

test("a fleet snapshot keeps `dispatchedBy` for an unselected workflow's runs", () => {
  const store = applyFrame(emptyStore(), { kind: "fleet", workflow: "wf", runs: [dispatched("a")] });
  assert.equal(fleetRuns(store, "wf")[0]?.dispatchedBy?.slot, "review");
});

test("the row badge and the pane strip name the caller; a run nobody dispatched shows neither", () => {
  assert.equal(dispatchBadge(dispatched("a")), "↳ caller-0");
  assert.equal(dispatchStrip(dispatched("a")), "dispatched by caller-0 · review · depth 1");
  assert.equal(
    dispatchStrip({
      ...run("a"),
      dispatchedBy: { run: "caller-0123456789", slot: "review", depth: 2, instance: "ops" },
    }),
    "dispatched by caller-0 · review · depth 2 · from Orchestrator ops",
    "a foreign caller names its Orchestrator, as opaque text",
  );
  assert.equal(dispatchBadge(run("a")), null);
  assert.equal(dispatchStrip(run("a")), null);
  assert.equal(dispatchStrip(null), null);
});

test("the pane's `dispatched` strip names the runs a run started, newest last, the older counted", () => {
  assert.equal(dispatchedStrip(run("a")), null);
  assert.equal(dispatchedStrip(null), null);
  assert.equal(
    dispatchedStrip({ ...run("a"), dispatched: [{ slot: "intake", run: "callee-0123456789" }] }),
    "dispatched callee-0 (intake)",
  );
  const many = Array.from({ length: 7 }, (_, i) => ({ slot: "intake", run: `run-${i}-abcdef` }));
  assert.equal(
    dispatchedStrip({ ...run("a"), dispatched: many }),
    "dispatched 2 more · run-2-ab (intake) · run-3-ab (intake) · run-4-ab (intake) · run-5-ab (intake) · run-6-ab (intake)",
  );
});

test("`dispatched` is kept through `runs` and `status`, with no token", () => {
  const started = { ...run("a"), dispatched: [{ slot: "intake", run: "callee-1" }] };
  let store = applyFrame(emptyStore(), { kind: "runs", runs: [started] });
  assert.deepEqual(store.runs.get("a")?.dispatched, [{ slot: "intake", run: "callee-1" }]);
  store = applyFrame(store, { kind: "status", status: started });
  assert.equal(selectedRun(store)?.dispatched?.[0]?.run, "callee-1");
});

// --- a failed run's reason (ADR-0073): off the guarded re-fetch, kept through `gone` ---------------

test("failureReason reads the Failure's reason only off a `failed` run, as `jr2 status` does", () => {
  assert.equal(
    failureReason({ status: "failed", output: { reason: "2 of 3 items failed", detail: {} } }),
    "2 of 3 items failed",
  );
  assert.equal(failureReason({ status: "done", output: { reason: "an output field" } }), null, "a done run's output");
  assert.equal(failureReason({ status: "error" }), null);
  assert.equal(failureReason({ status: "failed", output: { reason: 3 } }), null, "no reason text");
  assert.equal(failureReason({ status: "failed" }), null);
});

test("a failed run shows its reason with a live token, and keeps it after `gone` — the re-fetch can land on either side", () => {
  const failed = run("a", "failed");
  const before = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "status", status: run("a") },
    { kind: "selectRun", runId: "a" },
    { kind: "status", status: failed },
    { kind: "failure", runId: "a", reason: "the tests did not pass" },
    { kind: "gone", runId: "a" },
  );
  assert.equal(selectedRunFailure(before), "the tests did not pass", "folded before `gone`");
  const after = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "status", status: run("a") },
    { kind: "selectRun", runId: "a" },
    { kind: "status", status: failed },
    { kind: "gone", runId: "a" },
    { kind: "failure", runId: "a", reason: "the tests did not pass" },
  );
  assert.equal(selectedRunFailure(after), "the tests did not pass", "folded after `gone`, on the settled run");
  assert.equal(selectedRunFailure(applyFrame(after, { kind: "failure", runId: "a", reason: null })), null);
});

test("the reason is guarded: no token folds nothing, a dropped token empties it, and it goes with its run", () => {
  const base: Frame[] = [
    { kind: "select", workflow: "wf" },
    { kind: "status", status: run("a", "failed") },
    { kind: "selectRun", runId: "a" },
  ];
  assert.equal(selectedRunFailure(fold(...base, { kind: "failure", runId: "a", reason: "r" })), null, "observer mode");
  const live = fold(...base, { kind: "token", state: "live" }, { kind: "failure", runId: "a", reason: "r" });
  assert.equal(selectedRunFailure(live), "r");
  assert.equal(applyFrame(live, { kind: "token", state: "invalid" }).failures.size, 0, "a 401 drops it");
  assert.equal(applyFrame(live, { kind: "token", state: "checking" }).failures.size, 1, "re-validation keeps it");
  assert.equal(applyFrame(live, { kind: "select", workflow: "other" }).failures.size, 0, "a navigation drops it");
  assert.equal(applyFrame(live, { kind: "runs", runs: [run("b")] }).failures.size, 0, "neither live nor settled");
  // A re-fetch that comes back for a run the page does not hold folds nothing.
  const stray = applyFrame(fold({ kind: "token", state: "live" }), { kind: "failure", runId: "x", reason: "r" });
  assert.equal(stray.failures.size, 0);
  // A settled run evicted past the cap takes its reason with it.
  let s = fold({ kind: "select", workflow: "wf" }, ...unlocked, { kind: "status", status: run("f") });
  s = applyFrame(s, { kind: "failure", runId: "f", reason: "r" });
  s = applyFrame(s, { kind: "gone", runId: "f" });
  for (let i = 0; i < SETTLED_CAP; i++) {
    s = applyFrame(s, { kind: "status", status: run(`r${i}`) });
    s = applyFrame(s, { kind: "gone", runId: `r${i}` });
  }
  assert.equal(s.failures.has("f"), false, "evicted with its run");
});

// ---- The Caller (ADR-0032, ADR-0078) -------------------------------------------------------------
// `GET /whoami` says what the credential may do, and the page renders a control only where a scope
// opens it. These tests pin the page's half of the rule: the server checks each request anyway.

const ci: CallerView = { via: "token", name: "ci", may: { start: ["ping"], read: ["ping"] } };
const unlockAs = (caller: CallerView): Frame[] => [
  { kind: "caller", caller },
  { kind: "token", state: "live" },
];

test("may: a scope opens only the Workflows it names, and nothing without a live credential", () => {
  const store = fold(...unlockAs(ci));
  assert.equal(may(store, "start", "ping"), true);
  assert.equal(may(store, "start", "intake"), false, "a Workflow the grant does not name");
  assert.equal(may(store, "answer", "ping"), false, "a scope the Caller does not have");
  assert.equal(may(store, "start"), true, "with no Workflow: the scope opens at least one");
  assert.equal(may(store, "answer"), false);
  // The Caller before the token is live, or after it drops, opens nothing.
  assert.equal(may(fold({ kind: "caller", caller: ci }), "start", "ping"), false, "not live yet");
  assert.equal(may(fold(...unlockAs(ci), { kind: "token", state: "checking" }), "start", "ping"), false);
});

test("may: `all` opens every Workflow, and a Chart wrapper's name opens its named Charts", () => {
  const store = fold(
    ...unlockAs({ via: "jwt", name: "u1", may: { answer: "all", start: ["plan"], steer: ["plan/weekly"] } }),
  );
  assert.equal(may(store, "answer", "anything"), true);
  assert.equal(may(store, "start", "plan/weekly"), true, "the wrapper opens its Chart (ADR-0070)");
  assert.equal(may(store, "steer", "plan/weekly"), true);
  assert.equal(may(store, "steer", "plan"), false, "a Chart's name does not open its wrapper");
  assert.equal(may(store, "start", "planner"), false, "a prefix is not a wrapper");
});

test("a JWT with no scope is a live Caller that may do nothing: the page shows who, and no control", () => {
  const store = fold(...unlockAs({ via: "jwt", name: "u2", shown: "u2@example.com", may: {} }));
  assert.equal(store.token, "live");
  for (const scope of ["start", "answer", "cancel", "read", "steer"] as const) assert.equal(may(store, scope), false);
  assert.equal(callerLabel(store), "u2@example.com");
  assert.equal(callerScopes(store.caller), "no scope");
});

test("the nav names the Caller: the shown name, else via/name, and the party it acts for", () => {
  assert.equal(callerLabel(fold(...unlockAs(ci))), "token/ci");
  assert.equal(
    callerLabel(fold(...unlockAs({ via: "token", name: "instance", may: {}, onBehalfOf: "alice" }))),
    "token/instance for alice",
  );
  assert.equal(callerLabel(emptyStore()), null, "an observer acts as nobody");
  assert.equal(callerScopes(ci), "start: ping · read: ping");
  assert.equal(callerScopes({ ...ci, may: { answer: "all", start: [] } }), "answer: all");
});

test("a Gate card shows only where `answer` opens its Workflow — `read` alone reads the run, but sends nothing", () => {
  // The server lists only what the Caller may answer; an entry for `b` (an older server, or a
  // grant that changed mid-read) must not become a send form that meets a 403 (ADR-0032).
  const store = fold(
    { kind: "fleet", workflow: "b", runs: [run("rb", "active", "b")] },
    ...unlockAs({ via: "token", name: "ops", may: { answer: ["a"], read: "all" } }),
    inbox(["ra", "a", [gate()]], ["rb", "b", [gate()]]),
    { kind: "inboxScope", all: true },
  );
  assert.equal(may(store, "answer"), true, "the Attention tab shows: `answer` opens `a`");
  assert.deepEqual(
    visibleGates(store).map((e) => e.workflow),
    ["a"],
    "no card for `b`",
  );
  assert.equal(gateCount(store), 1, "the badge counts only what the Caller may answer");
  assert.deepEqual(
    selectedRunGates(applyFrame(store, { kind: "selectRun", runId: "rb" })),
    [],
    "and no pin on `b`'s diagram",
  );

  // A new Caller keeps only the cards its own `answer` opens.
  const narrowed = applyFrame(fold(...unlocked, inbox(["ra", "a", [gate()]])), {
    kind: "caller",
    caller: { via: "token", name: "viewer", may: { read: "all" } },
  });
  assert.equal(narrowed.gates.size, 0);
});

test("an `answer` item that names single Gates opens its Workflow's Gate cards, and the nav says its Gates", () => {
  const caller: CallerView = {
    via: "token",
    name: "release",
    may: { answer: ["triage", { workflow: "deploy", gates: ["approve", "ship"] }] },
  };
  const store = fold(...unlockAs(caller), inbox(["rd", "deploy", [gate("approve")]]));
  assert.equal(may(store, "answer", "deploy"), true, "the item opens a Gate of the Workflow (ADR-0078)");
  assert.equal(may(store, "answer", "intake"), false);
  assert.equal(store.gates.get("rd")?.gates.length, 1, "the server listed the Gate, so the card stays");
  assert.equal(callerScopes(caller), "answer: triage, deploy (approve, ship)");
});

test("a 401 or a cleared credential drops the Caller with the rest of the guarded state", () => {
  for (const state of ["invalid", "none"] as const) {
    const store = fold(...unlockAs(ci), { kind: "token", state });
    assert.equal(store.caller, null, state);
    assert.equal(may(store, "start", "ping"), false, state);
  }
  // A re-validation keeps it: a fine token should not flash the controls away.
  assert.deepEqual(fold(...unlockAs(ci), { kind: "token", state: "checking" }).caller, ci);
});

test("who started the selected run: folded with a live credential, for a run the page holds", () => {
  const base: Frame[] = [{ kind: "runs", runs: [run("a")] }, ...unlockAs(ci)];
  const byCaller = fold(...base, {
    kind: "starter",
    runId: "a",
    startedBy: { kind: "caller", via: "jwt", name: "u1", shown: "u1@example.com", onBehalfOf: "bob" },
  });
  assert.equal(selectedRunStarter(byCaller), "started by jwt/u1 (u1@example.com) on behalf of bob");
  const byRun = fold(...base, {
    kind: "starter",
    runId: "a",
    startedBy: { kind: "run", run: "0123456789abcdef", slot: "deploy" },
  });
  assert.equal(selectedRunStarter(byRun), "started by run 01234567 (deploy)");
  const byJr2 = fold(...base, { kind: "starter", runId: "a", startedBy: { kind: "jr2", why: "boot" } });
  assert.equal(selectedRunStarter(byJr2), "started by jr2 (boot)");
  // A run the page does not hold, or a fold with no credential, keeps nothing.
  const other = fold(...base, { kind: "starter", runId: "z", startedBy: { kind: "jr2", why: "boot" } });
  assert.equal(other.starters.size, 0);
  const observer = fold(
    { kind: "runs", runs: [run("a")] },
    {
      kind: "starter",
      runId: "a",
      startedBy: { kind: "jr2", why: "boot" },
    },
  );
  assert.equal(observer.starters.size, 0);
});

test("the starter is guarded state: it goes with the credential, the selection and the run", () => {
  const live = fold({ kind: "runs", runs: [run("a")] }, ...unlockAs(ci), {
    kind: "starter",
    runId: "a",
    startedBy: { kind: "jr2", why: "publish" },
  });
  assert.equal(live.starters.size, 1);
  assert.equal(applyFrame(live, { kind: "token", state: "invalid" }).starters.size, 0, "a 401 drops it");
  assert.equal(applyFrame(live, { kind: "select", workflow: "other" }).starters.size, 0, "a new selection");
  assert.equal(applyFrame(live, { kind: "runs", runs: [] }).starters.size, 0, "the run left unseen");
  assert.equal(applyFrame(live, { kind: "gone", runId: "a" }).starters.size, 1, "a settled run keeps it");
  assert.equal(applyFrame(live, { kind: "starter", runId: "a", startedBy: null }).starters.size, 0);
});

// ---- The ended runs in the rail (ADR-0032, ADR-0009) --------------------------------------------

const ended = (runId: string, status = "done", extra: Partial<RunSummaryView> = {}): RunSummaryView => ({
  runId,
  workflow: "wf",
  status,
  startedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

test("the rail lists live runs, then the ended runs: the ones the page watched end, then `GET /runs`'s", () => {
  const store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "status", status: run("a") },
    { kind: "status", status: run("w") },
    { kind: "gone", runId: "w" },
    {
      kind: "history",
      workflow: "wf",
      runs: [ended("w", "failed", { reason: "boom" }), ended("old", "drifted", { reason: "gone Assembly" })],
    },
  );
  assert.deepEqual(
    fleetRuns(store, "wf").map((r) => [r.runId, r.status, r.settled, r.reason ?? null]),
    [
      ["a", "active", false, null],
      ["w", "failed", true, "boom"],
      ["old", "drifted", true, "gone Assembly"],
    ],
    "a run in both halves is one row, with the listing's status and reason",
  );
});

test("the ended runs are guarded, are the selection's, and go with the credential and a navigation", () => {
  const listed: Frame = { kind: "history", workflow: "wf", runs: [ended("e")] };
  assert.equal(fold({ kind: "select", workflow: "wf" }, listed).history, null, "no credential, no list");
  const noRead = fold(
    { kind: "select", workflow: "wf" },
    ...unlockAs({ via: "token", name: "ci", may: { answer: "all" } }),
    listed,
  );
  assert.equal(noRead.history, null, "without `read` the rail lists live runs only");
  const other = fold({ kind: "select", workflow: "wf" }, ...unlocked, { ...listed, workflow: "other" });
  assert.equal(other.history, null, "a list for a Workflow the page left is dropped");

  const store = fold({ kind: "select", workflow: "wf" }, ...unlocked, listed);
  assert.equal(store.history?.runs.length, 1);
  assert.equal(applyFrame(store, { kind: "select", workflow: "next" }).history, null);
  assert.equal(applyFrame(store, { kind: "token", state: "invalid" }).history, null);
});

test("an ended run opened from the rail stays selected, and its last status lights the graph", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a")] },
    { kind: "history", workflow: "wf", runs: [ended("e", "failed")] },
    { kind: "selectRun", runId: "e" },
  );
  store = applyFrame(store, { kind: "status", status: run("a") });
  assert.equal(store.selectedRunId, "e", "a listed ended run is a run the page can say something about");
  assert.equal(selectedRun(store), null, "no status read yet");

  store = applyFrame(store, { kind: "endedStatus", status: run("e", "failed") });
  assert.equal(selectedRun(store)?.status, "failed");
  assert.equal(store.runs.has("e"), false, "it is held with the ended runs");
  store = applyFrame(store, { kind: "failure", runId: "e", reason: "no tests" });
  assert.equal(selectedRunFailure(store), "no tests", "its Failure folds like a watched run's");

  const live = applyFrame(store, { kind: "endedStatus", status: run("a", "done") });
  assert.equal(live.settled.has("a"), false, "the feed speaks for a live run, not this read");
  const stranger = applyFrame(store, { kind: "endedStatus", status: run("zz", "done") });
  assert.equal(stranger.settled.has("zz"), false, "a run the rail does not list is not held");
  assert.equal(stranger.opened.has("zz"), false);
});

test("an ended run read with `read` goes with the credential: no row, no selection, no lit state", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "history", workflow: "wf", runs: [ended("old1", "done")] },
    { kind: "selectRun", runId: "old1" },
    { kind: "endedStatus", status: { ...run("old1", "done"), value: "shipped" } },
  );
  assert.equal(selectedRun(store)?.value, "shipped");
  assert.equal(store.settled.has("old1"), false, "held apart from the runs the page watched end");
  store = applyFrame(store, { kind: "token", state: "invalid" });
  assert.deepEqual(runList(store), []);
  assert.equal(store.selectedRunId, null, "the selection does not stay on a run the page may not show");
  assert.equal(selectedRun(store), null);
});

test("a change of Caller drops what the old one read: a Caller without `read` sees live runs only", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("live1")] },
    { kind: "history", workflow: "wf", runs: [ended("old1", "done")] },
    { kind: "selectRun", runId: "old1" },
    { kind: "endedStatus", status: run("old1", "done") },
    {
      kind: "waiting",
      runId: "live1",
      workflow: "wf",
      waiting: [],
      held: [{ agent: "coder", pick: "approve", since: "t" }],
    },
  );
  assert.deepEqual(
    runList(store).map((r) => r.runId),
    ["live1", "old1"],
  );
  store = [
    { kind: "token", state: "checking" } as Frame,
    ...unlockAs({ via: "token", name: "bridge", may: { answer: "all" } }),
  ].reduce(applyFrame, store);
  assert.deepEqual(
    runList(store).map((r) => r.runId),
    ["live1"],
  );
  assert.equal(store.history, null);
  assert.equal(store.opened.size, 0);
  assert.equal(store.waiting.size, 0);
  assert.equal(store.selectedRunId, "live1", "the selection moves to a run the page can show");

  const same = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "history", workflow: "wf", runs: [ended("old1", "done")] },
    { kind: "token", state: "checking" },
    ...unlocked,
  );
  assert.equal(same.history?.runs.length, 1, "a re-validation of the same Caller keeps what it read");
});

// ---- A run on an older Assembly (ADR-0069) ------------------------------------------------------

const assembly = (current: string | null, held: Record<string, string[]> = {}): Frame => ({
  kind: "assembly",
  current,
  held: Object.entries(held).map(([hash, runs]) => ({ hash, runs })),
});

test("a run on an Assembly that is not the current one carries the mark, live from `GET /assembly`, ended from `GET /runs`", () => {
  const store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a"), run("b")] },
    assembly("cafe00000000", { cafe00000000: ["a"], "0123456789ab": ["b"] }),
    {
      kind: "history",
      workflow: "wf",
      runs: [ended("e", "done", { assembly: "fedcba987654" }), ended("f", "done", { assembly: "cafe00000000" })],
    },
  );
  assert.equal(olderAssembly(store, "a"), null, "on the current Assembly");
  assert.equal(olderAssembly(store, "b"), "0123456789ab");
  assert.equal(olderAssemblyMark(store, "b"), "older Assembly · 01234567");
  assert.equal(olderAssemblyMark(store, "e"), "older Assembly · fedcba98");
  assert.equal(olderAssembly(store, "f"), null);
  assert.equal(olderAssembly(store, "unknown"), null, "a run whose Assembly the page does not know is not marked");
  assert.equal(olderAssembly(fold(assembly(null, { x: ["b"] })), "b"), null, "no Assembly, no mark");
});

test("a run on an older Assembly is drawn on its own Machine, before its status is read too", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a"), run("b")] },
    assembly("cafe00000000", { cafe00000000: ["a"], "0123456789ab": ["b"] }),
  );
  assert.deepEqual(selectedDocSource(store), { key: "workflow:wf@cafe00000000", path: "/workflows/wf/machine" });
  store = applyFrame(store, { kind: "selectRun", runId: "b" });
  assert.deepEqual(selectedDocSource(store), { key: "run:b", path: "/workflows/wf/runs/b/machine" });

  store = applyFrame(store, {
    kind: "history",
    workflow: "wf",
    runs: [ended("e", "done", { assembly: "fedcba987654" })],
  });
  store = applyFrame(store, { kind: "selectRun", runId: "e" });
  assert.equal(selectedRun(store), null);
  assert.deepEqual(selectedDocSource(store), { key: "run:e", path: "/workflows/wf/runs/e/machine" });
  assert.equal(selectedDocSource(emptyStore()), null);
});

test("the Workflow's doc key names the current Assembly: a publish draws the new Machine", () => {
  let store = fold({ kind: "select", workflow: "wf" }, { kind: "runs", runs: [run("a")] }, assembly("cafe00000000"));
  assert.equal(selectedDocSource(store)?.key, "workflow:wf@cafe00000000");
  store = applyFrame(store, assembly("beef00000000", { beef00000000: ["a"] }));
  assert.equal(selectedDocSource(store)?.key, "workflow:wf@beef00000000", "a new current Assembly is a new doc");
});

test("an older-Assembly run that the page watched end stays on its own Machine, with its mark", () => {
  // An observer: no `read`, so no `GET /runs` summary supplies the hash after the run ends.
  let store = fold(
    { kind: "select", workflow: "wf" },
    { kind: "runs", runs: [run("r1")] },
    assembly("cafe00000000", { "0123456789ab": ["r1"] }),
  );
  assert.equal(selectedDocSource(store)?.key, "run:r1");
  store = applyFrame(store, { kind: "status", status: run("r1", "done") });
  store = applyFrame(store, { kind: "gone", runId: "r1" });
  store = applyFrame(store, assembly("cafe00000000"));
  assert.equal(store.selectedRunId, "r1");
  assert.equal(selectedDocSource(store)?.key, "run:r1", "not drawn on the current Machine");
  assert.equal(olderAssemblyMark(store, "r1"), "older Assembly · 01234567");
});

test("an ended run on the current Assembly is drawn on its own kept Machine: its status binds no Chart any more", () => {
  let store = fold(
    { kind: "select", workflow: "charted" },
    ...unlocked,
    { kind: "runs", runs: [{ ...run("c", "active", "charted"), bound: true, chartHashes: ["aaaaaaaaaaaa"] }] },
    assembly("cafe00000000", { cafe00000000: ["c"] }),
    { kind: "selectRun", runId: "c" },
  );
  assert.equal(selectedDocSource(store)?.key, "run:c:aaaaaaaaaaaa");
  store = applyFrame(store, { kind: "status", status: run("c", "done", "charted") });
  store = applyFrame(store, { kind: "gone", runId: "c" });
  assert.deepEqual(selectedDocSource(store), { key: "run:c", path: "/workflows/charted/runs/c/machine" });

  store = applyFrame(store, {
    kind: "history",
    workflow: "charted",
    runs: [ended("d", "done", { assembly: "cafe00000000" })],
  });
  store = applyFrame(store, { kind: "selectRun", runId: "d" });
  assert.equal(selectedDocSource(store)?.key, "run:d", "an ended run of the history, not the Workflow's Machine");
});

test("a drifted run has no Machine to draw: the pane shows its reason", () => {
  let store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    {
      kind: "history",
      workflow: "wf",
      runs: [ended("d", "drifted", { reason: "Assembly 0123 is not on the volume" }), ended("e")],
    },
    { kind: "selectRun", runId: "d" },
  );
  assert.equal(selectedRunDrift(store), "Assembly 0123 is not on the volume");
  store = applyFrame(store, { kind: "selectRun", runId: "e" });
  assert.equal(selectedRunDrift(store), null);
});

// ---- The kept conversations: the bottom drawer (ADR-0023, ADR-0032) -----------------------------

const row = (instanceId: string, slot: string, open = false) => ({
  agent: slot.split("/").pop()!,
  slot,
  instanceId,
  open,
  bytes: 10,
  cut: false,
});

const entry = (seq: number, kind: string, text: string): ConversationEntry => ({
  id: `e${seq}`,
  seq,
  at: `2026-11-06T10:00:0${seq % 10}.000Z`,
  agent: "coder",
  kind,
  text,
});

test("one tab for each Agent slot, a dot where a Turn is open, steerable as `GET /runs/:id/agents` says", () => {
  const store = fold(
    { kind: "select", workflow: "wf" },
    ...unlocked,
    { kind: "runs", runs: [run("a")] },
    {
      kind: "conversations",
      runId: "a",
      rows: [
        row("a/plan/planner", "plan/planner"),
        row("a/code/coder", "code/coder", true),
        row("a/plan/planner#2", "plan/planner"),
      ],
    },
    {
      kind: "agents",
      runId: "a",
      agents: [
        { agent: "code/coder", open: true, steerable: true },
        { agent: "review/reviewer", open: false, steerable: true },
      ],
    },
  );
  assert.deepEqual(slotTabs(store), [
    { slot: "plan/planner", open: false, steerable: false },
    { slot: "code/coder", open: true, steerable: true },
    { slot: "review/reviewer", open: false, steerable: true },
  ]);
  assert.equal(activeSlot(store), "code/coder", "with no choice, the slot whose Turn is open");
  const chosen = applyFrame(store, { kind: "bottom", open: true, slot: "plan/planner" });
  assert.equal(activeSlot(chosen), "plan/planner");
  assert.equal(chosen.bottom.open, true);
  assert.deepEqual(
    slotConversations(chosen, "plan/planner").map((c) => c.row.instanceId),
    ["a/plan/planner", "a/plan/planner#2"],
    "a slot whose conversation began again shows each, the first first",
  );
  assert.equal(
    activeSlot(applyFrame(chosen, { kind: "bottom", slot: "gone/agent" })),
    "code/coder",
    "a slot the run lacks falls back",
  );
});

test("entries merge in sequence order, each once, and a list or entries for another run are dropped", () => {
  let store = fold({ kind: "select", workflow: "wf" }, ...unlocked, { kind: "runs", runs: [run("a"), run("b")] });
  store = applyFrame(store, { kind: "conversations", runId: "a", rows: [row("a/x/coder", "x/coder", true)] });
  store = applyFrame(store, {
    kind: "entries",
    runId: "a",
    instanceId: "a/x/coder",
    entries: [entry(1, "prompt", "go"), entry(2, "text", "ok")],
  });
  store = applyFrame(store, {
    kind: "entries",
    runId: "a",
    instanceId: "a/x/coder",
    entries: [entry(2, "text", "ok"), entry(3, "text", "done")],
  });
  assert.deepEqual(
    slotConversations(store, "x/coder")[0]?.entries.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(applyFrame(store, { kind: "conversations", runId: "b", rows: [] }), store, "not the selected run");
  store = applyFrame(store, { kind: "conversationEnd", runId: "a", instanceId: "a/x/coder", cut: true });
  assert.deepEqual(slotConversations(store, "x/coder")[0]?.ended, { cut: true });

  const moved = applyFrame(store, { kind: "selectRun", runId: "b" });
  assert.equal(moved.talk, null, "another run starts from nothing");
  assert.equal(applyFrame(store, { kind: "token", state: "none" }).talk, null, "guarded: gone with the credential");
  assert.equal(
    fold(
      { kind: "select", workflow: "wf" },
      { kind: "runs", runs: [run("a")] },
      { kind: "conversations", runId: "a", rows: [] },
    ).talk,
    null,
    "no credential, no conversation",
  );
});

test("mergeEntries keeps the order of sequence numbers whatever the order they come in", () => {
  const kept = [entry(1, "text", "a"), entry(4, "text", "d")];
  assert.deepEqual(
    mergeEntries(kept, [entry(3, "text", "c"), entry(1, "text", "a"), entry(2, "text", "b")]).map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.equal(mergeEntries(kept, []), kept, "nothing new is the same list");
});

test("foldEntries folds a pick's answer into its call, and tells a Steering message, a notice and a refusal apart", () => {
  const items = foldEntries([
    entry(1, "prompt", "Implement the ticket."),
    entry(2, "thinking", "First I read the file."),
    entry(3, "bash", "ls -la"),
    entry(4, "approve", '{"summary":"ok"}'),
    entry(5, "approve error", "approve is not allowed now"),
    entry(
      6,
      "prompt",
      "<jr2-turn>\nSteering message from `alice`, from outside the workflow run. It is an instruction to you:\n> stop",
    ),
    entry(7, "prompt", "<jr2-turn>\nNotice: This conversation is new; earlier context is gone (fault).\n</jr2-turn>"),
    entry(8, "submit answer", "receipt 7"),
    entry(9, "compacted", "context 9000 → ~2000 tokens (window 32000)"),
    entry(10, "thinking level", "model has no level"),
    entry(11, "cut", "the conversation reached 8 MiB"),
    entry(12, "line", "a body with no label"),
  ]);
  assert.deepEqual(
    items.map((i) => i.type),
    ["prompt", "thinking", "call", "call", "steering", "notice", "call", "compacted", "mark", "cut", "mark"],
  );
  assert.deepEqual(
    items[2],
    { type: "call", at: items[2]!.at, tool: "bash", input: "ls -la" },
    "a Working tool keeps no result",
  );
  assert.deepEqual(
    (items[3] as { result?: unknown }).result,
    { text: "approve is not allowed now", error: true },
    "a refusal joins its pick",
  );
  assert.deepEqual(items[6], {
    type: "call",
    at: items[6]!.at,
    tool: "submit",
    input: "",
    result: { text: "receipt 7", error: false },
  });
});

test("foldEntries cuts a prompt at its notices and Steering messages: the task text stays a prompt", () => {
  const items = foldEntries([
    entry(
      1,
      "prompt",
      "Implement the ticket.\n<jr2-turn>\nNotice: This conversation is new; earlier context is gone (fault).\n" +
        "Steering message from the workflow:\n> use main\nAllowed picks: approve\n</jr2-turn>",
    ),
  ]);
  assert.deepEqual(
    items.map((i) => [i.type, (i as { text: string }).text]),
    [
      ["prompt", "Implement the ticket.\n<jr2-turn>"],
      ["notice", "Notice: This conversation is new; earlier context is gone (fault)."],
      ["steering", "Steering message from the workflow:\n> use main"],
      ["prompt", "Allowed picks: approve\n</jr2-turn>"],
    ],
  );
});

test("readSse reads whole events and keeps the part a later chunk completes", () => {
  const first = readSse(': ping\n\nevent: entry\ndata: {"seq":1}\n\nevent: en');
  assert.deepEqual(first.events, [{ event: "entry", data: '{"seq":1}' }]);
  const second = readSse(`${first.rest}d\r\ndata: {"cut":false}\r\n\r\n`);
  assert.deepEqual(second.events, [{ event: "end", data: '{"cut":false}' }]);
  assert.equal(second.rest, "");
  assert.deepEqual(readSse("data: a\ndata: b\n\n").events, [{ event: "message", data: "a\nb" }]);
});
