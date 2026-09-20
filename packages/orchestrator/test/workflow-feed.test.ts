// Tests for the WORKFLOW-scoped observation feed (the `GET /workflows/:name/events` SSE — ADR-0022),
// driven at the RunHost level like run-feed.test.ts: tiny machines, no HTTP, no flue/MCP.
//
// The per-run feed answers "how is this run doing"; this one answers "what is this workflow doing",
// which is the only question a page opened before any run existed can ask. The behaviors that matter
// are the ones a level-triggered feed lives or dies on: the current set and the subscription arrive
// together (no delta can slip between them), a run that leaves says so, and the listener set belongs
// to the HOST — not to any one run that might take it down with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, emit } from "xstate";
import { RunHost } from "../src/run-host.ts";
import type { WorkflowFeedEvent, WorkflowDef } from "../src/run-host.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

/** working ──after 10ms──▶ (emit "note") done. Settles on its own, shortly after a test subscribes. */
function quickDef(name = "quick"): WorkflowDef {
  const machine = setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "note"; message: string };
    },
  }).createMachine({
    id: name,
    context: {},
    initial: "working",
    states: {
      working: { after: { 10: { target: "done", actions: emit({ type: "note", message: "hi" }) } } },
      done: { type: "final" },
    },
  });
  return { name, machine, provide: () => ({}) };
}

/** A run that never settles — an approval gate, in miniature. */
function parkedDef(name = "parked"): WorkflowDef {
  const machine = setup({
    types: {} as { context: Record<string, never>; input: { instanceId: string } },
  }).createMachine({ id: name, context: {}, initial: "waiting", states: { waiting: {} } });
  return { name, machine, provide: () => ({}) };
}

test("observeWorkflow hands back the current set and the subscription in one call", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());
  const first = await host.start("parked");

  const feed: WorkflowFeedEvent[] = [];
  const { runs } = host.observeWorkflow("parked", (e) => feed.push(e));

  // The snapshot is returned SYNCHRONOUSLY alongside the subscribe. If these were two calls, a run
  // starting between them would appear in neither — the bug this signature exists to make impossible.
  assert.deepEqual(
    runs.map((r) => r.runId),
    [first.runId],
  );

  // A run started after the subscribe arrives as a status frame, with no re-fetch.
  const second = await host.start("parked");
  await waitFor(() => feed.some((e) => e.kind === "status" && e.status.runId === second.runId));
});

test("a settling run is fed its final status, then `gone`", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(quickDef());
  const { runId } = await host.start("quick");

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("quick", (e) => feed.push(e));

  await waitFor(() => feed.some((e) => e.kind === "gone"));
  const gone = feed.findIndex((e) => e.kind === "gone");
  const finalStatus = feed.findIndex((e) => e.kind === "status" && e.status.status === "done");
  assert.ok(finalStatus !== -1, "the terminal status is fed");
  assert.ok(finalStatus < gone, "the final status lands BEFORE `gone` — gone is the last word on a run");
  assert.equal(feed[gone]?.kind === "gone" && feed[gone].runId, runId);
});

test("the author's emit rides the workflow feed, tagged with its run", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(quickDef());
  const { runId } = await host.start("quick");

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("quick", (e) => feed.push(e));

  await waitFor(() => feed.some((e) => e.kind === "emit"));
  const emitted = feed.find((e) => e.kind === "emit");
  // Every run-scoped frame carries `runId` even where a per-run route would make it redundant, so
  // one parser serves both granularities.
  assert.equal(emitted?.kind === "emit" && emitted.runId, runId);
  assert.equal(emitted?.kind === "emit" && emitted.event.type, "note");
});

test("stop() announces the run's departure — it leaves the live set without a terminal status", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());
  const { runId } = await host.start("parked");

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("parked", (e) => feed.push(e));
  await host.stop(runId);

  // Without this the page shows a stopped run as live forever: `stop()` deliberately leaves the
  // STORED status "live" so restore() can pick it up, so nothing else would ever say it left.
  assert.ok(
    feed.some((e) => e.kind === "gone" && e.runId === runId),
    "a stopped run is gone from the workflow's live set",
  );
});

test("the workflow's listeners survive a run settling — the set is the HOST's, not a run's", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(quickDef());
  host.register(parkedDef());

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("quick", (e) => feed.push(e));

  // Run A settles, which clears ITS per-run listener set (persist(), terminal path).
  const a = await host.start("quick");
  await waitFor(() => feed.some((e) => e.kind === "gone" && e.runId === a.runId));
  const afterA = feed.length;

  // Run B must still reach us. If the workflow set ever moves onto LiveRun, A's cleanup takes the
  // watcher down with it and this is the test that says so.
  const b = await host.start("quick");
  await waitFor(() => feed.slice(afterA).some((e) => e.kind === "status" && e.status.runId === b.runId));
});

test("a workflow's feed carries only its own runs", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef("mine"));
  host.register(parkedDef("theirs"));

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("mine", (e) => feed.push(e));

  const mine = await host.start("mine");
  await host.start("theirs");
  await waitFor(() => feed.some((e) => e.kind === "status" && e.status.runId === mine.runId));

  // Scoped server-side (ADR-0014): an observer names a workflow it already knows, and never gets a
  // listing of everything this orchestrator happens to be running.
  assert.ok(
    feed.every((e) => e.kind !== "status" || e.status.workflow === "mine"),
    "no other workflow's runs appear",
  );
});

test("observing an unregistered workflow attaches to an empty set rather than failing", async () => {
  const host = new RunHost({ store: await mkStore() });
  // A page may be open on a workflow whose file has not been written yet (`jr2 dev` reload). The
  // feed is a subscription to a NAME, not to a registration.
  const { runs } = host.observeWorkflow("not-yet", () => {});
  assert.deepEqual(runs, []);
});

test("unregister() leaves the feed attached — its in-flight runs are still running", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());
  const { runId } = await host.start("parked");

  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("parked", (e) => feed.push(e));
  host.unregister("parked");

  // Dropping a registration stops FUTURE starts; it says nothing about the runs already in flight.
  // A feed that closed here would be claiming the work stopped when it did not.
  await host.stop(runId);
  assert.ok(feed.some((e) => e.kind === "gone" && e.runId === runId));
});

test("a stale unsubscribe does not detach somebody else", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());

  // One watcher comes and goes, emptying the set for this name.
  const gone = host.observeWorkflow("parked", () => {});
  gone.unsubscribe();

  // A second watcher arrives under the same name, getting a fresh set...
  const feed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("parked", (e) => feed.push(e));

  // ...and the first one's cleanup runs again — SSE handlers register cleanups on several exits, so
  // a double unsubscribe is ordinary. It must not evict the set it no longer belongs to.
  gone.unsubscribe();

  assert.equal(host.observerCount("parked"), 1, "the live watcher is still attached");
  await host.start("parked");
  assert.ok(
    feed.some((e) => e.kind === "status"),
    "and still hearing about runs",
  );
});

test("unsubscribe detaches, and close() ends the feed", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());

  const detached: WorkflowFeedEvent[] = [];
  const { unsubscribe } = host.observeWorkflow("parked", (e) => detached.push(e));
  unsubscribe();
  await host.start("parked");
  assert.deepEqual(detached, [], "an unsubscribed listener hears nothing further");

  const open: WorkflowFeedEvent[] = [];
  host.observeWorkflow("parked", (e) => open.push(e));
  await host.close();
  assert.equal(open.at(-1)?.kind, "closed", "shutdown ends a feed that has no end of its own");
});
