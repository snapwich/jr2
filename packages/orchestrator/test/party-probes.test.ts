// The party probes on the real RunHost (ADR-0015, ADR-0029): a delivery while the Machine is busy,
// an Orchestrator restart mid-exchange, a payload-reading guard beside sentBy, a Harness restart,
// and the printed conversation (ADR-0023).

import { test } from "node:test";
import assert from "node:assert/strict";
import { partyHost, receipt } from "./_party.ts";
import { s2, s2Delayed } from "./_party-machines.ts";

test("a delivery while the Machine is busy: a Gate answer sent from inside an action keeps its sender and runs (A)", async () => {
  let deliver: (() => void) | undefined;
  const h = await partyHost((x) => s2(x.coder!, "marked", { tickDelivers: () => deliver?.() }));
  const r = await h.start();
  deliver = () => h.host.sendToGate(r.runId, "review-1", { type: "approve" });
  // The reviewer's `tick` runs an action that delivers the reviewer's `approve` mid-macrostep.
  h.host.sendToGate(r.runId, "review-1", { type: "tick" });
  await r.until("doneA");
  assert.deepEqual((await r.context()).ran, ["A"]);
});

test("an Orchestrator restart mid-exchange: the persisted timer holds the sender, and it routes after restore", async () => {
  const h = await partyHost((x) => s2Delayed(x.coder!));
  const r = await h.start();
  // The reviewer's submit parks a copy of its own event, sender and all, as a 300 ms timer.
  h.host.sendToGate(r.runId, "review-1", { type: "submit" });
  let stored = "";
  for (let i = 0; i < 100 && !stored.includes('"timers":[{'); i++) {
    stored = JSON.stringify(await h.store.load(r.runId));
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.match(stored, /"event":\{"type":"approve","sender":\{"party":"gate","id":"review-1"\}\}/);
  await h.host.stop(r.runId);

  const second = await partyHost((x) => s2Delayed(x.coder!), ["coder"], h.store);
  assert.deepEqual((await second.host.restore()).reattached, [r.runId]);
  const rr = second.handle(r.runId);
  await rr.until("doneA");
  assert.deepEqual((await rr.context()).ran, ["A"], "sentBy(coder) on (B) declined the restored event");
});

test("an Orchestrator restart, then deliveries: the Agent is still routed to (B) and the reviewer to (A)", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const ra = await h.start();
  const rb = await h.start();
  await h.host.stop(ra.runId);
  await h.host.stop(rb.runId);
  const second = await partyHost((x) => s2(x.coder!, "marked"), ["coder"], h.store);
  assert.deepEqual((await second.host.restore()).reattached.sort(), [ra.runId, rb.runId].sort());
  assert.deepEqual(second.host.agentSurface(ra.iids.coder!)!.allowed, ["approve", "polish"]);
  assert.deepEqual(second.gateNow(ra.runId)[0]!.acceptsNow, ["approve", "tick"]);
  second.host.sendToGate(ra.runId, "review-1", { type: "approve" });
  await second.handle(ra.runId).until("doneA");
  second.host.sendToAgent(rb.iids.coder!, { type: "approve" });
  await second.handle(rb.runId).until("doneB");
});

test("a payload guard beside sentBy: Allowed stays payload-blind; a payload that turns selection outward is answered and never runs (A)", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked", { payloadGuard: true }));
  const r = await h.start();
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, ["approve", "polish"]);
  const bad = h.host.sendToAgent(r.iids.coder!, { type: "approve", note: "bad" });
  // In `allowed`: the Harness's receipt says to change the arguments (ADR-0029).
  assert.deepEqual(receipt(bad), { moved: false, turnComplete: false, allowed: ["approve", "polish"] });
  assert.deepEqual((await r.context()).ran, [], "(A) is the Gate's: a payload that fails (B) does not run it");
  assert.equal(h.feed.filter((e) => e.kind === "pick").length, 0, "answered, not delivered");
  assert.equal(h.host.sendToAgent(r.iids.coder!, { type: "approve", note: "ok" }).moved, true);
  await r.until("doneB");

  const r2 = await h.start();
  h.host.sendToGate(r2.runId, "review-1", { type: "approve", note: "anything" });
  await r2.until("doneA");
});

test("a Harness restart reads the same surface again, and neither the surface nor GET /runs/:id names the sender", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const r = await h.start();
  const first = JSON.stringify(h.host.agentSurface(r.iids.coder!));
  assert.equal(JSON.stringify(h.host.agentSurface(r.iids.coder!)), first, "what a restarted Harness reads");
  assert.ok(!first.includes("sender"));
  assert.ok(!JSON.stringify(await (await h.app.request(`/runs/${r.runId}`)).json()).includes("sender"));
});

test("the printed conversation (ADR-0023): the pick marker carries the Agent's payload, never the sender", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "approve", note: "done" });
  await r.until("doneB");
  const picks = h.feed.filter((e) => e.kind === "pick");
  assert.deepEqual(
    picks.map((p) => ({
      agent: (p as { agent: string }).agent,
      event: (p as { event: string }).event,
      payload: (p as { payload?: unknown }).payload,
    })),
    [{ agent: "coder", event: "approve", payload: { note: "done" } }],
  );
  assert.ok(!JSON.stringify(picks).includes("sender"));
});
