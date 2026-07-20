// Tests for the run observation feed + read-through the instance slice exposed (ADR-0009). Three
// behaviors, driven at the RunHost level with a tiny self-finishing Machine (no flue/MCP needed):
//   - `subscribe` replays the current status on attach (so a fresh watcher sees where the run IS);
//   - the workflow author's xstate `emit({...})` is forwarded onto the feed as an `emit` item;
//   - `read` reads a completed run through to the store after the registry drops it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, emit } from "xstate";
import { RunHost } from "../src/run-host.ts";
import type { RunFeedEvent, WorkflowDef } from "../src/run-host.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

/** working ──after 10ms──▶ (emit "note") done. The delayed transition fires AFTER a test subscribes,
 *  so its emit + terminal status land on the feed; entering `working` is the replayed-on-attach state. */
function feedDef(): WorkflowDef {
  const machine = setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "note"; message: string };
    },
  }).createMachine({
    id: "feed",
    context: {},
    initial: "working",
    states: {
      working: { after: { 10: { target: "done", actions: emit({ type: "note", message: "hi" }) } } },
      done: { type: "final" },
    },
  });
  return { name: "feed", machine, provide: () => ({}) };
}

test("subscribe replays current status on attach and forwards author emits", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(feedDef());
  const { runId } = await host.start("feed");

  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => feed.push(e));

  // First item is the replayed current status — the run is in `working`, not yet a transition.
  assert.equal(feed[0]?.kind, "status");
  assert.ok(feed[0]?.kind === "status" && JSON.stringify(feed[0].status.value).includes("working"));

  // The delayed transition's `emit` is forwarded as an `emit` item; the transition itself as a status.
  await waitFor(() => feed.some((e) => e.kind === "emit"));
  const emitted = feed.find((e) => e.kind === "emit");
  assert.deepEqual(emitted?.kind === "emit" ? emitted.event : undefined, { type: "note", message: "hi" });
  assert.ok(
    feed.some((e) => e.kind === "status" && JSON.stringify(e.status.value).includes("done")),
    "the terminal transition is fed as a status delta",
  );
});

test("read() reads a completed run through to the store after it leaves the registry", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(feedDef());
  const { runId } = await host.start("feed");

  await waitFor(() => host.status(runId) === undefined); // terminal → dropped from the live registry
  assert.equal(host.status(runId), undefined, "a settled run is gone from the live registry");

  const status = await host.read(runId);
  assert.equal(status?.workflow, "feed");
  assert.equal(status?.status, "done", "read-through reports the persisted terminal status");
});

test("read() is undefined for a genuinely unknown run", async () => {
  const host = new RunHost({ store: await mkStore() });
  assert.equal(await host.read("nope"), undefined);
});

/** parked: a run that never reaches a final state — an approval gate, in miniature. */
function parkedDef(): WorkflowDef {
  const machine = setup({
    types: {} as { context: Record<string, never>; input: { instanceId: string } },
  }).createMachine({ id: "parked", context: {}, initial: "waiting", states: { waiting: {} } });
  return { name: "parked", machine, provide: () => ({}) };
}

test("close() ends every open feed — a parked run's watcher would otherwise never exit", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(parkedDef());
  const { runId } = await host.start("parked");

  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => feed.push(e));
  assert.ok(!feed.some((e) => e.kind === "closed"), "an open feed is not closed while the host serves");

  await host.close();

  // The run never settles on its own, so `closed` is the ONLY exit its watcher will ever see.
  // Without it `server.close()` waits on the in-flight request forever (instance.ts).
  assert.equal(feed.at(-1)?.kind, "closed");
});
