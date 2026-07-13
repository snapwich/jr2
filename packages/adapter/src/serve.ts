// The Adapter's inbound side: the MCP endpoint the Agent's Harness connects to, on `localhost`.
//
// STATELESS PER CONNECTION, like the Orchestrator's mount used to be — but for a better reason.
// Each `/mcp/:iid` request builds a fresh server from that iid's LIVE surface (one GET to the
// Orchestrator), serves the turn, and is torn down when the socket closes. There is nothing to keep
// between turns: the menu belongs to the invoking state, and the Harness re-connects per submission
// (flue's `defineAgent` initializer re-runs, and `connectMcpServer` lists at connect). So "which
// turn is live" is answered by the Agent's own connection, every time.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NoSurfaceError, OrchestratorClient, serverForTurn } from "./adapter.ts";

export type AdapterOptions = {
  orchestrator: OrchestratorClient;
  /** Listen port. Default 8081 (`J2_ADAPTER_URL` points the Harness at it over `localhost`). */
  port?: number;
  /** Listen hostname. Default `127.0.0.1`: the Agent is IN this pod, and nothing else may connect. */
  hostname?: string;
};

export type RunningAdapter = { url: string; close: () => Promise<void> };

const MCP_PATH = /^\/mcp\/([^/]+)$/;

/** Serve the Agent's MCP surface. One endpoint, one caller, one pod. */
export async function startAdapter(opts: AdapterOptions): Promise<RunningAdapter> {
  const hostname = opts.hostname ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://adapter");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const match = MCP_PATH.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route ${url.pathname} (the Agent's surface is /mcp/<instanceId>)` }));
      return;
    }
    const instanceId = decodeURIComponent(match[1] as string);

    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        try {
          // Build THIS turn's server from the Orchestrator's live registration. A settled run or an
          // exited state has no surface — the Agent's turn is simply over, and it is told so.
          const mcp = await serverForTurn(opts.orchestrator, instanceId);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on("close", () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
        } catch (err) {
          if (res.headersSent) return;
          const status = err instanceof NoSurfaceError ? 404 : 500;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(opts.port ?? 8081, hostname, () => resolve((server.address() as AddressInfo).port));
  });

  return {
    url: `http://${hostname}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
