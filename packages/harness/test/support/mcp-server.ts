// A scripted MCP server, in-process (ADR-0079): what the Harness's MCP client talks to in a unit
// test. One core answers JSON-RPC; it is reached through pi-mcp's in-memory transport, or through a
// `fetch` that speaks Streamable HTTP (JSON answers only). It records each request, each `initialize`
// and each cancellation, and a tool can ask the client for input (`elicitation/create`).

import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { CallToolResult, JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";

/** What a tool's call gets: its abort (the client's `notifications/cancelled`), and a way to ask
 * the client for input, which resolves to the client's answer (`{ error }` for a refusal). */
export type FakeCallContext = { signal: AbortSignal; elicit: () => Promise<{ result?: unknown; error?: unknown }> };

export type FakeTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** The answer to a call. Throw an `RpcError` to answer with a JSON-RPC error. Default: echo the
   * arguments as text. */
  call?: (args: Record<string, unknown>, ctx: FakeCallContext) => CallToolResult | Promise<CallToolResult>;
};

/** A JSON-RPC error answer, thrown from a tool's `call`. */
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Send = (message: JsonRpcMessage) => void;

export class FakeMcpServer {
  tools: FakeTool[];
  /** Every request and notice, in order: its JSON-RPC method, and its HTTP headers over `fetch`. */
  readonly requests: Array<{ method: string; headers?: Record<string, string> }> = [];
  /** The request ids that the client cancelled, and why. */
  readonly cancelled: Array<{ requestId: unknown; reason?: unknown }> = [];
  /** When true, `initialize` never answers: a server that does not answer. */
  silent = false;
  private readonly token: string | undefined;
  private readonly running = new Map<unknown, AbortController>();
  private readonly asked = new Map<unknown, (answer: { result?: unknown; error?: unknown }) => void>();
  private nextAsk = 0;

  constructor(tools: FakeTool[], opts: { token?: string } = {}) {
    this.tools = tools;
    this.token = opts.token;
  }

  /** How many times a client opened a session. */
  get initializes(): number {
    return this.requests.filter((r) => r.method === "initialize").length;
  }

  /** The client end of a new in-memory connection. */
  inMemory(): McpTransport {
    const { client, server } = createInMemoryTransportPair();
    const send: Send = (message) => void server.send(message);
    server.onMessage((message) => {
      void this.answer(message, send).then((reply) => reply && send(reply));
    });
    void server.start();
    return client;
  }

  /** A `fetch` that serves this server over Streamable HTTP, with JSON answers. */
  readonly fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (this.token !== undefined && headers.authorization !== `Bearer ${this.token}`) {
      return new Response("unauthorized", { status: 401 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init?.body)) as JsonRpcMessage;
    if ("method" in message) this.requests.push({ method: message.method, headers });
    // A server request needs a stream back to the client; this fake has none over HTTP.
    const reply = await this.answer(message, () => {}, true);
    if (reply === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(reply), {
      headers: { "content-type": "application/json", "mcp-session-id": "s-1" },
    });
  };

  /** The answer to one message from the client, or undefined for a notice or a response. */
  async answer(message: JsonRpcMessage, send: Send, logged = false): Promise<JsonRpcMessage | undefined> {
    if (!("method" in message)) {
      // The client's answer to a request of this server's.
      const resolve = this.asked.get(message.id);
      this.asked.delete(message.id);
      resolve?.("error" in message ? { error: message.error } : { result: message.result });
      return undefined;
    }
    if (!logged) this.requests.push({ method: message.method });
    const params = (message.params ?? {}) as Record<string, any>;
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") {
        this.cancelled.push({ requestId: params.requestId, reason: params.reason });
        this.running.get(params.requestId)?.abort();
      }
      return undefined;
    }
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code: number, text: string): JsonRpcMessage => ({
      jsonrpc: "2.0",
      id: message.id,
      error: { code, message: text },
    });
    switch (message.method) {
      case "initialize":
        if (this.silent) return new Promise(() => {});
        return ok({
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake", version: "1" },
        });
      case "tools/list":
        return ok({
          tools: this.tools.map((t) => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        });
      case "tools/call": {
        const tool = this.tools.find((t) => t.name === params.name);
        if (tool === undefined) return fail(-32602, `Unknown tool: ${String(params.name)}`);
        const controller = new AbortController();
        this.running.set(message.id, controller);
        const elicit = () =>
          new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
            const id = `ask-${++this.nextAsk}`;
            this.asked.set(id, resolve);
            send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: "Which channel?" } });
          });
        try {
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const result = tool.call
            ? await tool.call(args, { signal: controller.signal, elicit })
            : { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
          return ok(result);
        } catch (err) {
          if (err instanceof RpcError) return fail(err.code, err.message);
          return fail(-32603, err instanceof Error ? err.message : String(err));
        } finally {
          this.running.delete(message.id);
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  }
}
