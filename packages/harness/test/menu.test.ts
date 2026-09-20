// Menu tests (ADR-0013/0027): `connectMenu` driven against a REAL MCP server over a real socket —
// the Adapter's own serving shape (stateless Streamable HTTP per request, `/mcp/:iid`). Asserted:
// the `mcp__jr2__<name>` naming (sanitized like flue did), the encoded-iid URL, the call round-trip
// (arguments arrive under the ORIGINAL tool name; content flattens to text), that an `isError`
// result and a thrown server error both surface as thrown Errors (pi's tool-failure contract),
// that an empty menu is zero tools and no error (ADR-0026), and that `close` is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectMenu } from "../src/menu.ts";

type ToolDef = { name: string; description?: string; inputSchema: { type: "object"; [k: string]: unknown } };

type Fixture = {
  /** `tools/list` pages: page N answers with `nextCursor: String(N+1)` while more pages exist. */
  pages: ToolDef[][];
  /** `tools/call` handler. Throwing here reaches the client as a JSON-RPC error. */
  onCall?: (name: string, args: Record<string, unknown> | undefined) => CallToolResult;
  /** Never answer any request — the shape of an Adapter that hangs mid connect/list. */
  hold?: boolean;
};

/** A fake Adapter: the same stateless serving shape as `@jr2/adapter`'s `startAdapter` — a fresh
 * MCP server + transport per request, torn down when the socket closes. Records request paths so
 * tests can assert the leash URL shape. */
async function serveAdapter(fixture: Fixture): Promise<{ url: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server: HttpServer = createServer((req, res) => {
    paths.push(new URL(req.url ?? "/", "http://adapter").pathname);
    if (fixture.hold) return; // hold the socket open, answer nothing
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const mcp = new Server({ name: "test-adapter", version: "0.0.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, (request) => {
          const page = Number(request.params?.cursor ?? "0");
          const tools = fixture.pages[page] ?? [];
          return page + 1 < fixture.pages.length ? { tools, nextCursor: String(page + 1) } : { tools };
        });
        mcp.setRequestHandler(CallToolRequestSchema, (request) => {
          if (!fixture.onCall) throw new Error("no onCall in this fixture");
          return fixture.onCall(request.params.name, request.params.arguments);
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
      })();
    });
  });
  // A held request keeps its socket open; close() must sever them or it never resolves.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        for (const socket of sockets) socket.destroy();
      }),
  };
}

const VERDICT: ToolDef = {
  name: "review_verdict",
  description: "Deliver the verdict.",
  inputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
};

test("connectMenu: tools surface as mcp__jr2__<name>, sanitized; the iid travels encoded", async () => {
  const adapter = await serveAdapter({
    pages: [[VERDICT, { name: "weird.name!", inputSchema: { type: "object", properties: {} } }]],
  });
  const menu = await connectMenu(adapter.url, "run-1/actor/reviewer/1");
  try {
    assert.deepEqual(
      menu.tools.map((t) => t.name),
      ["mcp__jr2__review_verdict", "mcp__jr2__weird_name_"],
      "the model-facing name is prefixed and sanitized — unsupported characters become _",
    );
    const verdict = menu.tools[0];
    assert.equal(verdict?.label, "review_verdict", "the label stays the Adapter's own name");
    assert.equal(verdict?.description, "Deliver the verdict.");
    assert.deepEqual(
      (verdict?.parameters as { required?: string[] }).required,
      ["verdict"],
      "the MCP input schema IS the advertised signature",
    );
    assert.ok(
      adapter.paths.every((p) => p === "/mcp/run-1%2Factor%2Freviewer%2F1"),
      `a hierarchical iid is ONE encoded path segment (saw: ${adapter.paths[0]})`,
    );
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("connectMenu: tools/list pagination is followed — every page's tools are on the menu", async () => {
  const adapter = await serveAdapter({
    pages: [[VERDICT], [{ name: "done", inputSchema: { type: "object", properties: {} } }]],
  });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    assert.deepEqual(
      menu.tools.map((t) => t.name),
      ["mcp__jr2__review_verdict", "mcp__jr2__done"],
    );
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("execute: one tools/call under the ORIGINAL name; content flattens to text, non-text noted", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  const adapter = await serveAdapter({
    pages: [[VERDICT]],
    onCall: (name, args) => {
      calls.push({ name, args });
      return {
        content: [
          { type: "text", text: "Delivered." },
          { type: "text", text: "Your turn is over." },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      };
    },
  });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    const tool = menu.tools[0];
    assert.ok(tool);
    const result = await tool.execute("call-1", { verdict: "approved" });
    assert.deepEqual(calls, [{ name: "review_verdict", args: { verdict: "approved" } }], "the wire name is unprefixed");
    assert.deepEqual(result.content, [{ type: "text", text: "Delivered.\nYour turn is over.\n[image content]" }]);
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("execute: an MCP isError result becomes a thrown Error — pi renders the message to the model", async () => {
  const adapter = await serveAdapter({
    pages: [[VERDICT]],
    onCall: () => ({ content: [{ type: "text", text: "no such gate" }], isError: true }),
  });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    const tool = menu.tools[0];
    assert.ok(tool);
    await assert.rejects(() => tool.execute("call-1", { verdict: "approved" }), /no such gate/);
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("execute: a server-side throw surfaces the same way — a thrown Error carrying the message", async () => {
  const adapter = await serveAdapter({
    pages: [[VERDICT]],
    onCall: () => {
      throw new Error("the Adapter fell over");
    },
  });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    const tool = menu.tools[0];
    assert.ok(tool);
    await assert.rejects(() => tool.execute("call-1", { verdict: "approved" }), /the Adapter fell over/);
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("connectMenu: an empty menu is valid — zero tools, no error (ADR-0026)", async () => {
  const adapter = await serveAdapter({ pages: [[]] });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    assert.deepEqual(menu.tools, []);
  } finally {
    await menu.close();
    await adapter.close();
  }
});

test("connectMenu: the Submission's signal cancels a connect/list in flight (ADR-0024 hot path)", async () => {
  // An abort landing while connect or tools/list is on the wire must reject NOW — the pump
  // cannot promote the next admission until this settles, and the alternative is the MCP SDK's
  // default request timeout.
  const adapter = await serveAdapter({ pages: [[]], hold: true });
  const controller = new AbortController();
  try {
    const pending = connectMenu(adapter.url, "iid-1", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending);
  } finally {
    await adapter.close();
  }
});

test("close: idempotent — turn.ts may close a connection whatever state its turn ended in", async () => {
  const adapter = await serveAdapter({ pages: [[]] });
  const menu = await connectMenu(adapter.url, "iid-1");
  try {
    await menu.close();
    await menu.close();
  } finally {
    await adapter.close();
  }
});
