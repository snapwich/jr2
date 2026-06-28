// End-to-end control-plane tests: drive a real MCP Client over an in-memory transport pair
// against `ControlPlane.server(id)`. We assert the wire actually round-trips — ack tools fire
// the mapped ControlEvent and return { ok: true }; `request_approval` blocks until
// `resolveApproval` answers; `check_inbox` drains messages staged via `enqueueInbox`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ControlEvent } from "@j2/agent-protocol";
import { ControlPlane } from "../src/control-plane.ts";

/** Spin up a ControlPlane + connected Client for one instance id; collect emitted events. */
async function connect(instanceId: string): Promise<{
  client: Client;
  events: ControlEvent[];
  plane: ControlPlane;
  close: () => Promise<void>;
}> {
  const events: ControlEvent[] = [];
  const plane = new ControlPlane((e) => events.push(e));
  const server = plane.server(instanceId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    events,
    plane,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("done fires agent.done and returns { ok: true }", async () => {
  const { client, events, close } = await connect("run-1");
  try {
    const res = await client.callTool({ name: "done", arguments: { summary: "wrapped up" } });
    assert.deepEqual(res.structuredContent, { ok: true });
    assert.deepEqual(events, [{ type: "agent.done", instanceId: "run-1", summary: "wrapped up" }]);
  } finally {
    await close();
  }
});

test("request_review fires agent.requestReview and returns { ok: true }", async () => {
  const { client, events, close } = await connect("run-2");
  try {
    const res = await client.callTool({ name: "request_review", arguments: { summary: "please review" } });
    assert.deepEqual(res.structuredContent, { ok: true });
    assert.deepEqual(events, [{ type: "agent.requestReview", instanceId: "run-2", summary: "please review" }]);
  } finally {
    await close();
  }
});

test("report_blocked fires agent.reportBlocked and returns { ok: true }", async () => {
  const { client, events, close } = await connect("run-3");
  try {
    const res = await client.callTool({ name: "report_blocked", arguments: { reason: "missing creds" } });
    assert.deepEqual(res.structuredContent, { ok: true });
    assert.deepEqual(events, [{ type: "agent.reportBlocked", instanceId: "run-3", reason: "missing creds" }]);
  } finally {
    await close();
  }
});

test("request_approval blocks until resolveApproval, then resolves to { decision }", async () => {
  const { client, events, plane, close } = await connect("run-4");
  try {
    const callPromise = client.callTool({
      name: "request_approval",
      arguments: { action: "deploy", reason: "ship it" },
    });

    // The up-event fires immediately; the tool result stays pending.
    await waitFor(() => events.length === 1);
    assert.deepEqual(events, [
      { type: "agent.requestApproval", instanceId: "run-4", action: "deploy", reason: "ship it" },
    ]);

    let settled = false;
    void callPromise.then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false, "call must not settle before resolveApproval");

    plane.resolveApproval("run-4", "approved");
    const res = await callPromise;
    assert.deepEqual(res.structuredContent, { decision: "approved" });
  } finally {
    await close();
  }
});

test("check_inbox drains messages enqueued via enqueueInbox", async () => {
  const { client, plane, close } = await connect("run-5");
  try {
    plane.enqueueInbox("run-5", "hello");
    plane.enqueueInbox("run-5", "world");

    const first = await client.callTool({ name: "check_inbox", arguments: {} });
    assert.deepEqual(first.structuredContent, { messages: ["hello", "world"] });

    // Queue is drained: a second poll comes back empty.
    const second = await client.callTool({ name: "check_inbox", arguments: {} });
    assert.deepEqual(second.structuredContent, { messages: [] });
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
