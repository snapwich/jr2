// MCP dialect-adapter tests (ADR-0011): drive a real MCP Client over an in-memory transport
// against `ControlPlane.server(iid)`, which is built from the instance's LIVE registration in
// the shared table. Assert the wire round-trips per semantics — `ack` delivers and acknowledges;
// `deferred` delivers and holds the tool result until `answerRun`; `poll` drains the inbox fed
// by `steerRun` — and that the served toolset IS the registration (nothing more, nothing less).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { exampleEvents } from "@j2/agent-protocol";
import { ControlPlane } from "../src/control-plane.ts";
import { eventMap } from "@j2/agent-protocol";
import { mcpAddress, RegistrationTable, type DeliveredEvent } from "../src/registration.ts";

/** Register an agent surface for `iid` on a fresh table + plane; connect a real MCP client. */
async function connect(
  iid: string,
  accepts: string[] = ["done", "request_review", "request_approval", "check_inbox"],
): Promise<{
  client: Client;
  delivered: DeliveredEvent[];
  plane: ControlPlane;
  dispose: () => void;
  close: () => Promise<void>;
}> {
  const table = new RegistrationTable();
  const plane = new ControlPlane(table);
  const delivered: DeliveredEvent[] = [];
  const all = eventMap("test", [...exampleEvents]);
  const dispose = table.register({
    address: mcpAddress(iid),
    runId: "run-A",
    kind: "agent",
    id: iid,
    defs: new Map(accepts.map((n) => [n, all.get(n)!])),
    deliver: (e) => delivered.push(e),
  });

  const server = plane.server(iid);
  assert.ok(server, "a live registration must yield a server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    delivered,
    plane,
    dispose,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("no live registration → no server (the one catch point)", () => {
  const plane = new ControlPlane(new RegistrationTable());
  assert.equal(plane.server("ghost"), undefined);
});

test("tools/list serves exactly the registered set — the state-scoped menu", async () => {
  const { client, close } = await connect("i-1", ["done", "request_review"]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["done", "request_review"]);
  } finally {
    await close();
  }
});

test("ack: the tool call delivers the workflow event (no instanceId — closure is provenance)", async () => {
  const { client, delivered, close } = await connect("i-2");
  try {
    const res = await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    assert.deepEqual(res.structuredContent, { ok: true });
    assert.deepEqual(delivered, [{ type: "request_review", summary: "PR up" }]);
  } finally {
    await close();
  }
});

test("deferred: delivers, holds the result until answerRun, resolves with the payload", async () => {
  const { client, delivered, plane, close } = await connect("i-3");
  try {
    const callPromise = client.callTool({ name: "request_approval", arguments: { action: "deploy" } });

    await waitFor(() => delivered.length === 1);
    assert.deepEqual(delivered, [{ type: "request_approval", action: "deploy" }]);

    let settled = false;
    void callPromise.then(() => (settled = true));
    await tick();
    assert.equal(settled, false, "call must not settle before answerRun");

    plane.answerRun("run-A", { decision: "approved" });
    const res = await callPromise;
    assert.deepEqual(res.structuredContent, { decision: "approved" });

    assert.throws(() => plane.answerRun("run-A", { decision: "again" }), /no pending deferred call/);
  } finally {
    await close();
  }
});

test("poll: drains messages queued by steerRun; delivers no machine event", async () => {
  const { client, delivered, plane, close } = await connect("i-4");
  try {
    plane.steerRun("run-A", "hello");
    plane.steerRun("run-A", "world");

    const first = await client.callTool({ name: "check_inbox", arguments: {} });
    assert.deepEqual(first.structuredContent, { messages: ["hello", "world"] });

    const second = await client.callTool({ name: "check_inbox", arguments: {} });
    assert.deepEqual(second.structuredContent, { messages: [] });

    assert.deepEqual(delivered, [], "poll is a drain, not a delivery");
  } finally {
    await close();
  }
});

test("steerRun with no live agent surface refuses instead of queueing into the void", () => {
  const plane = new ControlPlane(new RegistrationTable());
  assert.throws(() => plane.steerRun("run-Z", "msg"), /no live agent surface/);
});

test("a deregistered surface serves nothing on the next request", async () => {
  const { plane, dispose, close } = await connect("i-5");
  try {
    dispose(); // the invoking state exited
    assert.equal(plane.server("i-5"), undefined);
  } finally {
    await close();
  }
});

/** Resolve after a macrotask so pending promises have a chance to settle if they were going to. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Poll `pred` until true (bounded), letting the transport pump messages between checks. */
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor: predicate never became true");
}
