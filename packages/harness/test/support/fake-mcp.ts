// An MCP server over Streamable HTTP, in-process (ADR-0079): what the MCP check of the provider
// preflight talks to in a unit test. It speaks only what `tools/list` needs, and records each
// request it got.

import type { FetchLike } from "../../src/mcp-list.ts";

export type FakeMcp = {
  fetch: FetchLike;
  /** Each request, in order: its method (HTTP and JSON-RPC) and its headers. */
  requests: Array<{ http: string; rpc?: string; headers: Record<string, string> }>;
};

export function fakeMcpServer(opts: {
  /** The tool names, served in pages of `pageSize`. */
  tools: string[];
  /** The bearer it takes; absent, it takes any request. */
  token?: string;
  /** Answer with an event stream in place of JSON. */
  sse?: boolean;
  pageSize?: number;
}): FakeMcp {
  const requests: FakeMcp["requests"] = [];
  const pageSize = opts.pageSize ?? 100;
  const fetch: FetchLike = async (_url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const http = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : undefined;
    requests.push({ http, ...(body?.method ? { rpc: body.method as string } : {}), headers });
    if (opts.token !== undefined && headers.authorization !== `Bearer ${opts.token}`) {
      return new Response("unauthorized", { status: 401 });
    }
    if (http === "DELETE") return new Response(null, { status: 204 });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    let result: Record<string, unknown>;
    if (body.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      };
    } else if (body.method === "tools/list") {
      const start = Number(body.params?.cursor ?? 0);
      const page = opts.tools.slice(start, start + pageSize);
      const next = start + pageSize < opts.tools.length ? String(start + pageSize) : undefined;
      result = {
        tools: page.map((name) => ({ name, inputSchema: { type: "object" } })),
        ...(next ? { nextCursor: next } : {}),
      };
    } else {
      const error = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } };
      return new Response(JSON.stringify(error), { headers: { "content-type": "application/json" } });
    }
    const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const session = { "mcp-session-id": "s-1" };
    return opts.sse
      ? new Response(`event: message\ndata: ${message}\n\n`, {
          headers: { "content-type": "text/event-stream", ...session },
        })
      : new Response(message, { headers: { "content-type": "application/json", ...session } });
  };
  return { fetch, requests };
}
