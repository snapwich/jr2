// J2Client against a real RunHost + hono app over `app.request` (no socket). Proves every verb's wire
// call: workflows/list, start (+ unknown → throw), the SSE feed (replay + emit + terminal), read-through
// after settle, and the down-channel `send`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunFeedEvent } from "../src/client.ts";
import { mkHarness } from "./_fixtures.ts";

test("workflows() and list() report registered + live runs", async () => {
  const { client } = await mkHarness();
  assert.deepEqual((await client.workflows()).sort(), ["feed", "loop"]);

  const { runId } = await client.start("loop");
  const list = await client.list();
  assert.ok(
    list.some((r) => r.runId === runId && r.workflow === "loop"),
    "a freshly started run shows in list()",
  );
});

test("start() throws for an unknown workflow", async () => {
  const { client } = await mkHarness();
  await assert.rejects(() => client.start("nope"), /nope/);
});

test("events() replays current status, forwards emits, ends on terminal; read() reads through", async () => {
  const { client } = await mkHarness();
  const { runId } = await client.start("feed");

  const feed: RunFeedEvent[] = [];
  for await (const ev of client.events(runId)) {
    feed.push(ev);
    if (ev.kind === "status" && ev.status.status !== "active") break;
  }

  // The author's xstate emit surfaced as an `emit` item...
  assert.ok(
    feed.some((e) => e.kind === "emit" && e.event.type === "note" && e.event.message === "hi"),
    "author emit is forwarded",
  );
  // ...and the terminal transition arrived as a `status` delta.
  assert.ok(
    feed.some((e) => e.kind === "status" && e.status.status === "done"),
    "terminal status delta arrives",
  );

  // After settle the live registry has dropped it, but read() reads through to the store.
  const s = await client.read(runId);
  assert.equal(s?.status, "done");
  assert.equal((s?.context as { reply?: string } | undefined)?.reply, undefined); // feed has no reply field
});

test("read() is undefined for an unknown run", async () => {
  const { client } = await mkHarness();
  assert.equal(await client.read("nope"), undefined);
});

test("send() carries CANCEL, and surfaces the host's refusal of anything else", async () => {
  const { client } = await mkHarness();
  const { runId } = await client.start("loop");
  // APPROVE and STEER were sugar over the `deferred` and `poll` semantics, which ADR-0013 reserves
  // without building — so the run-control seam accepts CANCEL and nothing else, loudly.
  await assert.rejects(() => client.send(runId, { type: "STEER" }), /accepts: CANCEL/);

  await client.send(runId, { type: "CANCEL" });
  assert.ok(!(await client.list()).some((r) => r.runId === runId), "CANCEL abandons the run — it is no longer live");
});
