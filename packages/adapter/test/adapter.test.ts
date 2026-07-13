// Adapter tests (ADR-0013): the translation, driven by a REAL MCP client over a real socket — the
// same wire flue's `connectMcpServer` speaks — against a fake Orchestrator. What is asserted is
// that the Adapter is a faithful translator and an honest one:
//
//   - `tools/list` IS the turn's surface (nothing else can be called);
//   - `tools/call` becomes one authenticated delivery, and the receipt comes back;
//   - a settled turn has no menu, rather than a stale one;
//   - the Sandbox token is on every request (the Agent's own container has no such thing);
//   - a `deferred`/`poll` event is REFUSED, not degraded to a fire-and-forget tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OrchestratorClient, type Surface } from "../src/adapter.ts";
import { startAdapter } from "../src/serve.ts";

const TOKEN = "ws-1.signed";

/** A fake Orchestrator: serves one surface, records what was delivered — and what bearer arrived. */
function fakeOrchestrator(surface: Surface | undefined) {
  const seen: { bearers: string[]; delivered: Array<Record<string, unknown>> } = { bearers: [], delivered: [] };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.bearers.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
    if (!surface) return new Response(JSON.stringify({ error: "no live agent surface" }), { status: 404 });
    if (url.endsWith("/surface")) return Response.json(surface);
    seen.delivered.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ deliveryId: "d-1" });
  };
  return {
    seen,
    client: new OrchestratorClient({ url: "http://orchestrator.invalid", token: TOKEN, fetch: fetchImpl }),
  };
}

const REVIEW_SURFACE: Surface = {
  instanceId: "iid-1",
  runId: "run-1",
  sandbox: "ws-1",
  accepts: [
    {
      name: "request_review",
      description: "Hand the work off for review.",
      input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      semantics: "ack",
    },
    { name: "done", input: { type: "object", properties: {} }, semantics: "ack" },
  ],
};

/** Start the Adapter and connect a real MCP client to one agent's turn, as the Harness would. */
async function connect(orchestrator: OrchestratorClient, instanceId = "iid-1") {
  const adapter = await startAdapter({ orchestrator, port: 0 });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${adapter.url}/mcp/${instanceId}`)));
  return {
    client,
    close: async () => {
      await client.close();
      await adapter.close();
    },
  };
}

test("tools/list is the turn's surface, with the def's schema as the tool's", async () => {
  const { client, close } = await connect(fakeOrchestrator(REVIEW_SURFACE).client);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["done", "request_review"],
      "the Agent can call exactly what the invoking state accepts",
    );
    const review = tools.find((t) => t.name === "request_review");
    assert.equal(review?.description, "Hand the work off for review.");
    assert.deepEqual(review?.inputSchema.required, ["summary"], "the advertised signature survives the round trip");
  } finally {
    await close();
  }
});

test("tools/call becomes one authenticated delivery, and the receipt comes back", async () => {
  const { seen, client: orch } = fakeOrchestrator(REVIEW_SURFACE);
  const { client, close } = await connect(orch);
  try {
    const result = await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });

    assert.deepEqual(seen.delivered, [{ type: "request_review", summary: "PR up" }], "the pick, as a run event");
    assert.deepEqual(result.structuredContent, { deliveryId: "d-1" }, "the delivery receipt reaches the Agent");
    // The Sandbox token rides EVERY request. It came from a Secret mounted into this container
    // alone — the Agent, next door with code execution, has no way to read it.
    assert.ok(
      seen.bearers.every((b) => b === `Bearer ${TOKEN}`),
      `every call to the Orchestrator is authenticated (saw: ${seen.bearers.join(", ")})`,
    );
  } finally {
    await close();
  }
});

test("a settled turn has no menu — the Agent is told its turn is over, not served a stale one", async () => {
  const adapter = await startAdapter({ orchestrator: fakeOrchestrator(undefined).client, port: 0 });
  try {
    const res = await fetch(`${adapter.url}/mcp/iid-gone`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /no live surface/);
  } finally {
    await adapter.close();
  }
});

test("a deferred event is refused, not degraded to a fire-and-forget tool", async () => {
  const deferred: Surface = {
    ...REVIEW_SURFACE,
    accepts: [
      {
        name: "request_approval",
        input: { type: "object", properties: { action: { type: "string" } } },
        semantics: "deferred",
      },
    ],
  };
  const adapter = await startAdapter({ orchestrator: fakeOrchestrator(deferred).client, port: 0 });
  try {
    // Serving this as an ordinary tool would promise the Agent a result the Machine never sends.
    // Better to fail the turn loudly than to hand it a contract that is a lie (ADR-0013).
    const res = await fetch(`${adapter.url}/mcp/iid-1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /reserved, not built/);
  } finally {
    await adapter.close();
  }
});
