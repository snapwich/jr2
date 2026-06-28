// End-to-end Machine-host tests: prove the three slice-1 modules cohere under RunHost.
//
// The up-channel is driven the REAL way — a real MCP Client over an in-memory transport calls the
// callback tools on `host.mcpServer(instanceId)`, so ControlPlane.onEvent → routeUp → actor.send is
// exercised, not bypassed. The flue side is a mock FlueClient: it records the admission (so restore
// can be checked) and lets the test push synthetic stream tool calls (which surface `agent.offset`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { codingDef, connectMcp, mkStore, MockFlueClient, tick, waitFor } from "./_fixtures.ts";
import type { Ctx } from "./_fixtures.ts";

test("MCP tool calls route into the owning run's Machine", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(codingDef(new Map()));
  const { runId, instanceId } = await host.start("coding");

  const { client, close } = await connectMcp(host.mcpServer(instanceId));
  try {
    await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

    const status = host.status(runId);
    assert.deepEqual(status?.value, { active: "review" });
    assert.equal((status?.context as Ctx).summary, "PR up");

    await client.callTool({ name: "done", arguments: {} });
    await waitFor(() => host.status(runId) === undefined); // final → dropped from the registry
  } finally {
    await close();
  }
});

test("offset telemetry from the flue stream is persisted into the snapshot", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  await tick();

  // A poll advances the durable offset without being a domain event.
  clients.get(instanceId)!.push!({ name: "check_inbox", args: {}, offset: 17 });
  await waitFor(() => (host.status(runId)?.context as Ctx).offsets[instanceId] === 17);

  const loaded = await store.load(runId);
  const persisted = loaded!.snapshot as { snapshot: { context: Ctx } };
  assert.equal(persisted.snapshot.context.offsets[instanceId], 17);
});

test("a second host restores an in-flight run and re-attaches by persisted offset", async () => {
  const store = await mkStore();

  // Host A: start, advance the durable offset, then "crash" (we just stop driving it).
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(clientsA));
  const { runId, instanceId } = await hostA.start("coding");
  await tick();
  clientsA.get(instanceId)!.push!({ name: "check_inbox", args: {}, offset: 23 });
  await waitFor(() => (hostA.status(runId)?.context as Ctx).offsets[instanceId] === 23);

  // Host B: a brand-new host on the SAME store; reconcile present → re-attach.
  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store, reconcile: () => true });
  hostB.register(codingDef(clientsB));
  const { reattached } = await hostB.restore();
  await tick();

  assert.deepEqual(reattached, [runId]);
  const reattachedClient = clientsB.get(instanceId);
  assert.ok(reattachedClient?.admitted, "re-attached run must re-admit via the FlueClient");
  assert.equal(reattachedClient!.admitted!.attachOffset, 23, "re-attach must resume from the persisted offset");
  assert.equal(reattachedClient!.admitted!.prompt, undefined, "re-attach must not re-POST the prompt");
});

test("request_approval blocks until the host answers it", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(codingDef(new Map()));
  const { runId, instanceId } = await host.start("coding");

  const { client, close } = await connectMcp(host.mcpServer(instanceId));
  try {
    const callP = client.callTool({ name: "request_approval", arguments: { action: "deploy" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("awaitingApproval"));

    let settled = false;
    void callP.then(() => (settled = true));
    await tick();
    assert.equal(settled, false, "tool call must block until the host answers");

    host.answer(runId, "approved");
    const res = await callP;
    assert.deepEqual(res.structuredContent, { decision: "approved" });
  } finally {
    await close();
  }
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
