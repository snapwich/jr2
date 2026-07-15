// End-to-end Machine-host tests: prove the three slice-1 modules cohere under RunHost.
//
// The Agent's up-channel is driven the REAL way — `sendToAgent`, the same registration-table path
// `POST /agents/:iid/events` takes when a Sandbox's Adapter forwards a tool call (ADR-0013) — so
// resolve → validate → deliver-into-the-invoking-state is exercised, not bypassed. The flue side is
// a mock FlueClient: it records admissions and settles (so the ledger and restore can be checked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "xstate";
import { RunHost, type RunStatus } from "../src/run-host.ts";
import { codingDef, mkStore, MockFlueClient, pipelineDef, tick, waitFor } from "./_fixtures.ts";
import type { Ctx } from "./_fixtures.ts";

test("an Agent's delivery routes into the owning run's Machine", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(codingDef(new Map()));
  const { runId, instanceId } = await host.start("coding");

  const receipt = host.sendToAgent(instanceId, { type: "request_review", summary: "PR up" });
  // Every delivery is addressable after the fact — the room a deferred result needs (ADR-0013).
  assert.ok(receipt.deliveryId, "a delivery answers with a receipt");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  const status = host.status(runId);
  assert.deepEqual(status?.value, { active: "review" });
  assert.equal((status?.context as Ctx).summary, "PR up");

  host.sendToAgent(instanceId, { type: "done" });
  await waitFor(() => host.status(runId) === undefined); // final → dropped from the registry
});

test("the agent surface IS the invoking state's registration, and dies with it", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });

  // What the Adapter renders as `tools/list`: this turn's events, their schemas, their semantics.
  const surface = host.agentSurface(instanceId);
  assert.equal(surface?.runId, runId);
  assert.equal(surface?.sandbox, "ws-1", "the surface records its Sandbox — what scopes its token");
  assert.deepEqual(
    surface?.accepts.map((a) => a.name).sort(),
    ["done", "request_review"],
    "exactly what the invoking state accepts — no more, no less",
  );
  assert.deepEqual(
    surface?.accepts.map((a) => a.semantics),
    ["done", "request_review"].map(() => "ack"),
  );

  // The state exits → the registration goes with it → there is no surface to serve. The Adapter
  // needs no `list_changed` to learn this: it re-lists per turn, and a dead turn has no menu.
  host.sendToAgent(instanceId, { type: "done" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(host.agentSurface(instanceId), undefined);
});

test("a delivery outside the turn's surface is refused, naming what IS accepted", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  const { instanceId } = await host.start("coding");

  assert.throws(() => host.sendToAgent(instanceId, { type: "merge" }), /does not accept "merge".*accepts:/s);
  assert.throws(() => host.sendToAgent(instanceId, { type: "request_review" }), /invalid "request_review" payload/);
  assert.throws(() => host.sendToAgent("no-such-iid", { type: "done" }), /no live registration/);
});

test("registration reads the vocabulary off the machine (ADR-0015); a plain machine has none", async () => {
  const host = new RunHost({ store: await mkStore() });

  // A j2Setup machine carries its defs; registering under any name resolves them.
  host.register(codingDef(new Map()));
  assert.deepEqual([...host.events("coding")!.keys()].sort(), ["done", "request_review"]);

  // A machine NOT built by j2Setup (no vocabulary attached) accepts no workflow events.
  const bare = setup({}).createMachine({ id: "bare", initial: "a", states: { a: {} } });
  host.register({ name: "bare", machine: bare, provide: () => ({}) });
  assert.equal(host.events("bare")?.size, 0);
});

test("the admission is ledgered host-side and persisted beside the snapshot (ADR-0016)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  await tick();

  const minted = clients.get(instanceId)!.minted;
  assert.ok(minted, "the run was admitted");
  let agents: Record<string, unknown> | undefined;
  await waitFor(() => {
    void store.load(runId).then((l) => (agents = (l?.snapshot as { agents?: Record<string, unknown> })?.agents));
    return agents?.[instanceId] !== undefined;
  });
  assert.deepEqual(agents?.[instanceId], minted, "the durable handle rides RunBlob.agents");
});

test("a second host restores an in-flight run and re-attaches by persisted admission", async () => {
  const store = await mkStore();

  // Host A: start (the mock admits and parks), then "crash" (we just stop driving it).
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(clientsA));
  const { runId, instanceId } = await hostA.start("coding");
  await tick();
  const minted = clientsA.get(instanceId)!.minted!;
  let persisted = false;
  await waitFor(() => {
    void store
      .load(runId)
      .then((l) => (persisted = !!(l?.snapshot as { agents?: Record<string, unknown> })?.agents?.[instanceId]));
    return persisted;
  });

  // Host B: a brand-new host on the SAME store; reconcile present → re-attach.
  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store, reconcile: () => true });
  hostB.register(codingDef(clientsB));
  const { reattached } = await hostB.restore();
  await tick();

  assert.deepEqual(reattached, [runId]);
  const reattachedClient = clientsB.get(instanceId);
  assert.ok(reattachedClient, "the restored run rebuilt its port");
  assert.equal(reattachedClient!.admitted, undefined, "re-attach must not re-POST the prompt");
  assert.deepEqual(reattachedClient!.settled, [minted], "settlement follows the PERSISTED admission");
});

test("restore marks a run lost when the live world is absent", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(new Map()));
  const { runId } = await hostA.start("coding");
  await tick();

  const hostB = new RunHost({ store, reconcile: () => false });
  hostB.register(codingDef(new Map()));
  const { reattached, lost } = await hostB.restore();

  assert.deepEqual(reattached, []);
  assert.deepEqual(lost, [runId]);
  assert.equal((await store.load(runId))!.status, "lost");
});

// ---- Child machines (the visualizer's live half) ------------------------------------------------
// A run's root `value` is not where the run IS: `pipeline` (like `coding`) sits in `discover` while
// every feature it spawned works two levels down. `RunStatus.children` is that tree — and it rides
// the SAME feed frame the root's status does, because persistence is driven by the actor system's
// inspection stream, so a GRANDCHILD's transition already pushes one.

/** A pipeline run with both features spawned and both bodies invoked (the wrapper's 5ms provision). */
async function mkPipeline() {
  const host = new RunHost({ store: await mkStore() });
  host.register(pipelineDef());
  const { runId } = await host.start("pipeline");
  await waitFor(() => (host.status(runId)?.children[1]?.children.length ?? 0) > 0);
  return { host, runId };
}

test("status().children: the live child machines, their values, and their children's", async () => {
  const { host, runId } = await mkPipeline();
  const status = host.status(runId)!;

  assert.equal(status.value, "discover", "the root has not moved — and says nothing about F-1 or F-2");
  assert.deepEqual(
    status.children.map((c) => ({ id: c.id, src: c.src, value: c.value })),
    [
      { id: "F-1", src: "feature", value: "running" },
      { id: "F-2", src: "feature", value: "running" },
    ],
    "one entry per live instance — this is what makes F-1 and F-2 two boxes, not one",
  );

  // The grandchild: each wrapper invokes its body as an INLINE machine, so its `src` is xstate's
  // generated key — the same string `serializeMachine` records. That string IS the join.
  assert.deepEqual(status.children[0]!.children, [
    { id: "body", src: "xstate.invoke.0.ws.running", status: "active", value: "coding", children: [] },
  ]);
});

test("a GRANDCHILD transition pushes a feed frame carrying its new value", async () => {
  const { host, runId } = await mkPipeline();

  const frames: RunStatus[] = [];
  const off = host.subscribe(runId, (e) => {
    if (e.kind === "status") frames.push(e.status);
  });
  frames.length = 0; // drop the replay-on-attach frame

  // Through the real seam: F-1's gate is registered by the BODY, two levels down (ADR-0011).
  host.sendToGate(runId, "F-1", { type: "approve" });
  await waitFor(() => frames.some((f) => f.children[0]?.children[0]?.value === "shipped"));
  off();

  const last = frames.at(-1)!;
  assert.equal(last.value, "discover", "the root never moved; only the depth did");
  assert.equal(last.children[0]?.children[0]?.status, "done", "F-1's body reached its final state");
  assert.equal(last.children[1]?.children[0]?.value, "coding", "and F-2 is untouched — instances are independent");
});
