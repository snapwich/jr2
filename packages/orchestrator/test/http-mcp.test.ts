// MCP-over-HTTP tests (ADR-0009): the DOMAIN up-channel driven the REAL way, over a real socket.
//
// Unlike http.test.ts (which uses `app.request(...)` with no socket), the MCP transport writes
// straight to a Node `ServerResponse`, so these tests stand up an actual `@hono/node-server` and
// point a real `StreamableHTTPClientTransport` MCP Client at `/mcp/:instanceId`. That exercises the
// full path: HTTP → StreamableHTTPServerTransport → per-instance McpServer → ControlPlane.onEvent →
// RunHost.routeUp → actor.send. The down-channel (approval answer) is driven both ways: directly via
// `host.answer` and over HTTP via `POST /runs/:id/events` APPROVE, both landing on the SAME server.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { codingDef, mkStore, waitFor } from "./_fixtures.ts";
import type { Ctx } from "./_fixtures.ts";

/** Start the app on an ephemeral port; resolve once it is listening, with the assigned port. */
async function startServer(host: RunHost): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(host);
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Connect a real MCP Client over Streamable HTTP to a run's `/mcp/:instanceId` endpoint. */
async function connectHttpMcp(
  port: number,
  instanceId: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const url = new URL(`http://127.0.0.1:${port}/mcp/${instanceId}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function mkHost(): Promise<RunHost> {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  return host;
}

test("request_review over real HTTP MCP routes into the owning run's Machine", async () => {
  const host = await mkHost();
  const { port, close: closeServer } = await startServer(host);
  const { runId, instanceId } = await host.start("coding");
  const { client, close: closeClient } = await connectHttpMcp(port, instanceId);
  try {
    await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

    const status = host.status(runId);
    assert.deepEqual(status?.value, { active: "review" });
    assert.equal((status?.context as Ctx).summary, "PR up");
  } finally {
    await closeClient();
    await closeServer();
  }
});

test("request_approval over HTTP blocks until host.answer resolves the tool call", async () => {
  const host = await mkHost();
  const { port, close: closeServer } = await startServer(host);
  const { runId, instanceId } = await host.start("coding");
  const { client, close: closeClient } = await connectHttpMcp(port, instanceId);
  try {
    // Up-channel: park the run on an approval gate (do NOT await — it blocks until answered).
    const callP = client.callTool({ name: "request_approval", arguments: { action: "deploy" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("awaitingApproval"));

    // Down-channel via the in-process host API releases the held HTTP POST stream.
    host.answer(runId, "approved");
    const settled = await callP;
    assert.deepEqual(settled.structuredContent, { decision: "approved" });
  } finally {
    await closeClient();
    await closeServer();
  }
});

test("APPROVE over POST /runs/:id/events releases a request_approval held over HTTP MCP", async () => {
  const host = await mkHost();
  const { port, close: closeServer } = await startServer(host);
  const { runId, instanceId } = await host.start("coding");
  const { client, close: closeClient } = await connectHttpMcp(port, instanceId);
  try {
    const callP = client.callTool({ name: "request_approval", arguments: { action: "deploy" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("awaitingApproval"));

    // Down-channel over the SAME HTTP server: APPROVE on the REST surface.
    const res = await fetch(`http://127.0.0.1:${port}/runs/${runId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "APPROVE" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const settled = await callP;
    assert.deepEqual(settled.structuredContent, { decision: "approved" });
  } finally {
    await closeClient();
    await closeServer();
  }
});
