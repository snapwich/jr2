// The MCP check's listing (ADR-0019, ADR-0079): what `provider-preflight.ts` runs in the check pod,
// with the Stand-in as the bearer. The server is in-process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listMcpTools, MCP_PROTOCOL_VERSION } from "../src/mcp-list.ts";
import { mcpPreflightLine, mcpPreflightStart } from "../src/preflight-line.ts";
import { fakeMcpServer } from "./support/fake-mcp.ts";

const URL_ = "https://mcp.slack.example/mcp";
const STAND_IN = "jr2-standin-of-SLACK_TOKEN";

test("listMcpTools: initialize, initialized, tools/list page by page, with the session and the bearer", async () => {
  for (const sse of [false, true]) {
    const server = fakeMcpServer({ tools: ["read", "post", "list"], token: STAND_IN, sse, pageSize: 2 });
    assert.deepEqual(await listMcpTools(URL_, STAND_IN, { fetch: server.fetch }), {
      kind: "listed",
      tools: ["list", "post", "read"],
    });
    assert.deepEqual(
      server.requests.map((r) => r.rpc ?? r.http),
      ["initialize", "notifications/initialized", "tools/list", "tools/list", "DELETE"],
      sse ? "event stream" : "json",
    );
    for (const r of server.requests) assert.equal(r.headers.authorization, `Bearer ${STAND_IN}`);
    assert.equal(server.requests[0]!.headers["mcp-session-id"], undefined);
    assert.equal(server.requests[2]!.headers["mcp-session-id"], "s-1");
    assert.equal(server.requests[2]!.headers["mcp-protocol-version"], MCP_PROTOCOL_VERSION);
  }
});

test("listMcpTools: a refused credential, an answer that is not MCP, no answer, a redirect, and the budget", async () => {
  const server = fakeMcpServer({ tools: ["read"], token: STAND_IN });
  assert.deepEqual(await listMcpTools(URL_, "wrong", { fetch: server.fetch }), { kind: "refused", status: 401 });
  const html = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
  const notMcp = await listMcpTools(URL_, undefined, { fetch: html });
  assert.equal(notMcp.kind, "no-answer");
  assert.match((notMcp as { why: string }).why, /not JSON/);
  const down = await listMcpTools(URL_, undefined, {
    fetch: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.deepEqual(down, { kind: "no-answer", why: "connect ECONNREFUSED" });
  const moved = await listMcpTools(URL_, undefined, { fetch: async () => new Response(null, { status: 307 }) });
  assert.match((moved as { why: string }).why, /HTTP 307/);
  const spent = AbortSignal.abort(new Error("the budget ran out"));
  const late = await listMcpTools(URL_, undefined, {
    signal: spent,
    fetch: async (_url, init) => {
      init?.signal?.throwIfAborted();
      return await server.fetch(_url, init);
    },
  });
  assert.deepEqual(late, { kind: "no-answer", why: "the budget ran out" });
});

test("the MCP lines: a list is JSON on one line, a reason one line", () => {
  assert.equal(mcpPreflightStart("slack"), "jr2.preflight mcp=slack start");
  assert.equal(
    mcpPreflightLine("slack", { kind: "listed", tools: ["a.b", "post"] }),
    'jr2.preflight mcp=slack listed=["a.b","post"]',
  );
  assert.equal(
    mcpPreflightLine("slack", { kind: "warn", reason: "no\nanswer" }),
    "jr2.preflight mcp=slack warn=no answer",
  );
});
