// A fake remote MCP server (ADR-0079): the @kind and @model tiers' outside service, on the host.
// It speaks the part of MCP over Streamable HTTP that jr2's two clients use — `initialize`, the
// `notifications/initialized` notice, `tools/list`, `tools/call`, `ping` and the session's
// DELETE — and answers each request with JSON, never with an event stream. It records every
// request it got, so a step can see what reached it from outside the pod: the Authorization
// header of each request, and the arguments of each call.
//
// The tiers serve it the way they serve the scripted model (`fake-provider.ts`): it binds 0.0.0.0
// and reports its port, so the World can give the config a POD-reachable url (the kind bridge
// gateway; localhost never works from a pod). @kind serves it over HTTPS with a leaf of the tier's
// CA, so a secret can be bound to it: the Custodian and the Instance Effector trust that CA as the
// instance's `caBundle` (ADR-0020, ADR-0059). @model has no CA of its own, so there it is plain
// HTTP with no secret, which ADR-0079 permits for a server with no `secret`.
//
// With `tokens`, a request that does not carry `Bearer <one of them>` is refused 401, and it is
// recorded first: a Stand-in that reached the server shows in `requests` as what it was.

import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo, Socket } from "node:net";

/** The revision both jr2 clients speak (ADR-0079). */
export const MCP_PROTOCOL = "2025-11-25";

/** What a tool gives back: the text the caller reads, and the optional `structuredContent`. */
export type FakeMcpAnswer = { text: string; structured?: Record<string, unknown>; isError?: boolean };

/** One tool of the fake: its name, its description and the schema of its arguments, and how it
 * answers a call. */
export type FakeMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  answer: (args: Record<string, unknown>) => FakeMcpAnswer;
};

/** One request as the fake received it, refused or not. */
export type FakeMcpRequest = {
  /** The HTTP method. */
  http: string;
  /** The JSON-RPC method, when the body has one. */
  rpc?: string;
  /** The Authorization header as it arrived, or undefined. */
  authorization?: string;
  /** For `tools/call`: the tool's name and the arguments. */
  tool?: string;
  args?: Record<string, unknown>;
  /** True when the fake refused it 401 for its credential. */
  refused?: true;
  /** Arrival order from 1. */
  seq: number;
};

export type FakeMcp = {
  /** The listening port: the World composes the pod-reachable url from it. */
  port: number;
  /** The path the server answers on. */
  path: string;
  /** Every request, in order of arrival. */
  requests: FakeMcpRequest[];
  /** The names `tools/list` gives now. A step can take a tool away before the converge: the call
   * of a tool that is not listed answers with the JSON-RPC error -32602. */
  listed: Set<string>;
  close(): Promise<void>;
};

const PATH = "/mcp";

export async function startFakeMcp(opts: {
  tools: FakeMcpTool[];
  /** A leaf for HTTPS; absent, the server is plain HTTP. */
  tls?: { cert: string; key: string };
  /** The bearer values it takes; absent, it takes any request. */
  tokens?: readonly string[];
}): Promise<FakeMcp> {
  const requests: FakeMcpRequest[] = [];
  const listed = new Set(opts.tools.map((t) => t.name));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  let seq = 0;
  let sessions = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const http = req.method ?? "GET";
      const authorization = req.headers.authorization;
      let body: { id?: unknown; method?: string; params?: Record<string, unknown> } | undefined;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        body = undefined;
      }
      const params = body?.params ?? {};
      const call =
        body?.method === "tools/call"
          ? { tool: String(params.name), args: (params.arguments ?? {}) as Record<string, unknown> }
          : {};
      const record: FakeMcpRequest = {
        http,
        ...(body?.method ? { rpc: body.method } : {}),
        ...(authorization === undefined ? {} : { authorization }),
        ...call,
        seq: ++seq,
      };
      requests.push(record);
      if (opts.tokens !== undefined && !opts.tokens.some((t) => authorization === `Bearer ${t}`)) {
        record.refused = true;
        res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
        return;
      }
      if ((req.url ?? "").split("?")[0] !== PATH) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
        return;
      }
      if (http === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      // No server-sent stream: a client that asks for one is told this server opens none.
      if (http !== "POST") {
        res.writeHead(405, { allow: "POST, DELETE" }).end();
        return;
      }
      if (body === undefined || typeof body.method !== "string") {
        reply(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      // A notification has no id, and gets no answer but 202.
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const id = body.id;
      const session: Record<string, string> = {};
      let result: Record<string, unknown>;
      switch (body.method) {
        case "initialize":
          session["mcp-session-id"] = `s-${++sessions}`;
          result = {
            protocolVersion: MCP_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "jr2-e2e-fake", version: "1.0.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: opts.tools
              .filter((t) => listed.has(t.name))
              .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          };
          break;
        case "tools/call": {
          const tool = listed.has(call.tool ?? "") ? byName.get(call.tool!) : undefined;
          if (tool === undefined) {
            reply(res, { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${call.tool}` } });
            return;
          }
          const a = tool.answer(call.args ?? {});
          result = {
            content: [{ type: "text", text: a.text }],
            ...(a.structured === undefined ? {} : { structuredContent: a.structured }),
            isError: a.isError === true,
          };
          break;
        }
        default:
          reply(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${body.method}` } });
          return;
      }
      reply(res, { jsonrpc: "2.0", id, result }, session);
    });
  };

  const server: Server = opts.tls ? createHttps(opts.tls, handler) : createHttp(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    port,
    path: PATH,
    requests,
    listed,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function reply(res: ServerResponse, message: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify(message));
}

/** The one tool the @kind tier's servers give: it answers `lookup-ok:<query>`, and its structured
 * content repeats the query. No answer holds a credential. */
export const LOOKUP_TOOL: FakeMcpTool = {
  name: "lookup",
  description: "Look up one record by its query string.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "What to look up." } },
    required: ["query"],
  },
  answer: (args) => ({ text: `lookup-ok:${String(args.query)}`, structured: { query: args.query, found: true } }),
};

/** The @model tier's one tool (the `mcp-then-pick` claim): it gives the payment status of an order,
 * from `orders`, which each trial's driver fills before it starts its run. Plain words, as a real
 * service would answer; the status is what the pick depends on. */
export function orderLookupTool(orders: ReadonlyMap<string, string>): FakeMcpTool {
  return {
    name: "lookup_order",
    description: "Get an order's record from the shop's order system: its items and its payment status.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string", description: "The order's id, such as ord-1234." } },
      required: ["order_id"],
    },
    answer: (args) => {
      const id = String(args.order_id ?? "");
      const status = orders.get(id);
      if (status === undefined) return { text: `No order has the id ${JSON.stringify(id)}.`, isError: true };
      return {
        text: `Order ${id}: 1 x desk lamp, 1 x extension cable. Payment status: ${status}.`,
        structured: { order_id: id, payment: status },
      };
    },
  };
}
