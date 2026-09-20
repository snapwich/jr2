// The Adapter's inbound side: the MCP endpoint the Agent's Harness connects to, on `localhost`.
//
// STATELESS PER CONNECTION, like the Orchestrator's mount used to be — but for a better reason.
// Each `/mcp/:iid` request builds a fresh server from that iid's LIVE surface (one GET to the
// Orchestrator), serves the turn, and is torn down when the socket closes. There is nothing to keep
// between turns: the menu belongs to the invoking state, and the Harness re-connects per submission
// (flue's `defineAgent` initializer re-runs, and `connectMcpServer` lists at connect). So "which
// turn is live" is answered by the Agent's own connection, every time.
//
// An iid with no live surface is answered, not refused (ADR-0026): `serverForTurn` serves an empty
// menu. The only 404 left here is the one this file owns — an unrouted path. That matters on this
// endpoint specifically, because 404 is not a free status code in Streamable HTTP: it is how a
// server says "your session expired, reinitialize", so spending it on "your turn is over" was
// overloading a transport signal with an application one.
//
// Beside it sits the one route that is not the Agent's: `POST /fetch`, the ask a `git fetch` inside
// the pod makes on its way to the node cache (ADR-0053). Same listener, same loopback, same reason
// — the credential that reaches the Orchestrator is in this container and in no other.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type OrchestratorClient, serverForTurn } from "./adapter.ts";

export type AdapterOptions = {
  orchestrator: OrchestratorClient;
  /** Listen port. Default 8081 (`JR2_ADAPTER_URL` points the Harness at it over `localhost`). */
  port?: number;
  /** Listen hostname. Default `127.0.0.1`: the Agent is IN this pod, and nothing else may connect. */
  hostname?: string;
};

export type RunningAdapter = { url: string; close: () => Promise<void> };

const MCP_PATH = /^\/mcp\/([^/]+)$/;

/** Collect a request body, which every route here reads before it can act. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

/**
 * The Repo identity an ask names, or `undefined` when the body does not carry one.
 *
 * Identity, never the cache key: a key is a derived directory name and not the name a human reads
 * in `git remote -v` (ADR-0004/0053). The Adapter does not interpret it — the Orchestrator derives
 * the key and checks it against the Sandbox's slots — so all this decides is whether there is
 * something to forward.
 */
function askedIdentity(body: string): string | undefined {
  try {
    const asked = JSON.parse(body) as { identity?: unknown };
    return typeof asked.identity === "string" && asked.identity ? asked.identity : undefined;
  } catch {
    return undefined;
  }
}

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

    // The ask (ADR-0053). Not part of the Agent's Menu and not addressed by an instance id: the
    // caller is `jr2-upload-pack`, run by git for whoever typed `git fetch` in this pod — the Agent
    // in the Harness container, or a human in any seat of it. What comes back is the Orchestrator's
    // own answer, status and bytes unread, because the program reads it and this process has no
    // better opinion about freshness than the wait that produced it.
    if (url.pathname === "/fetch") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `the ask is POST /fetch, not ${req.method} (ADR-0053)` }));
        return;
      }
      void (async () => {
        const identity = askedIdentity(await readBody(req));
        if (!identity) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `the ask needs {"identity":"<host/path>"} (ADR-0053)` }));
          return;
        }
        const answer = await opts.orchestrator.ask(identity);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      })();
      return;
    }

    const match = MCP_PATH.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route ${url.pathname} (the Agent's surface is /mcp/<instanceId>)` }));
      return;
    }
    const instanceId = decodeURIComponent(match[1] as string);

    void readBody(req).then((body) => {
      void (async () => {
        try {
          // Build THIS turn's server from the Orchestrator's live registration. A settled run or an
          // exited state has no surface, which serves as an empty menu — there is nothing to call.
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
          // Everything that reaches here is a genuine fault (the Orchestrator is unreachable, or
          // the turn declared an event the Adapter refuses to serve). A turn being over is not one.
          res.writeHead(500, { "content-type": "application/json" });
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
