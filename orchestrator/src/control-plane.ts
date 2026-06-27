// The Actor's MCP control plane — the Sandbox → Orchestrator ingress (ADR-0002).
//
// One HTTP server, many Actors. A single MCP endpoint multiplexes every in-flight
// Agent by Instance ID: the Harness-side Agent attaches `connectMcpServer({ url:
// `${base}/mcp/<instanceId>` })`, so each tool call arrives path-routed to the
// Actor invocation that owns that instance. (Topology choice — one keyed server
// vs a server-per-instance — is recorded in poc/actor/README.md.)
//
// The control toolset carries the *up* control channel (`done`, `request_review`,
// `report_blocked` → xstate events the Machine reacts to) and the *down solicited*
// channel: `request_approval` is an ordinary tool call whose result the Actor
// DEFERS until the Machine decides — flue's native pause-for-approval. The Agent's
// turn blocks on the held HTTP response; no flue mid-turn HTTP primitive is needed
// (PoC #4 Finding 2 proved none exists).

import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** An up-channel event raised by an Agent tool call, forwarded to its Actor. */
export type ControlEvent =
  | { type: "agent.requestApproval"; instanceId: string; action: string; reason?: string }
  | { type: "agent.requestReview"; instanceId: string; summary: string }
  | { type: "agent.reportBlocked"; instanceId: string; reason: string }
  | { type: "agent.done"; instanceId: string; summary?: string };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Per-instance registration: where up-events go, plus the down-channel state. */
interface Session {
  emit: (event: ControlEvent) => void;
  /** Pending deferred approvals (FIFO); resolved by the Actor via answerApproval. */
  approvals: Deferred<string>[];
  /** Cooperative steer-at-checkpoint queue, drained by the Agent's check_inbox tool. */
  inbox: string[];
}

export interface ControlPlaneOptions {
  port?: number;
  host?: string;
}

export class ControlPlane {
  private readonly sessions = new Map<string, Session>();
  private server?: http.Server;
  private boundPort = 0;
  private readonly host: string;
  private readonly wantPort: number;

  constructor(opts: ControlPlaneOptions = {}) {
    this.host = opts.host ?? "127.0.0.1";
    this.wantPort = opts.port ?? 0; // 0 → ephemeral; learn the real port from listen()
  }

  /** Start listening. Resolves once the MCP endpoint is reachable. */
  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    // A deferred approval holds the response open for minutes. Disable Node's
    // request/header timeouts so a long human-in-the-loop block is not severed
    // by the server (the *client's* timeoutMs is the limit we actually measure).
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = 0;
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.wantPort, this.host, resolve));
    this.boundPort = (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values())
      s.approvals.forEach((d) => d.resolve("DENIED: control plane shutting down"));
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Base URL an Agent attaches to: `${mcpUrlFor(id)}` → POST target for that instance. */
  mcpUrlFor(instanceId: string): string {
    return `http://${this.host}:${this.boundPort}/mcp/${encodeURIComponent(instanceId)}`;
  }

  get port(): number {
    return this.boundPort;
  }

  // --- Actor-facing API -----------------------------------------------------

  /** Register an Actor invocation. `emit` is the Actor's sendBack. */
  register(instanceId: string, emit: (event: ControlEvent) => void): void {
    this.sessions.set(instanceId, { emit, approvals: [], inbox: [] });
  }

  unregister(instanceId: string): void {
    const s = this.sessions.get(instanceId);
    if (s) s.approvals.forEach((d) => d.resolve("DENIED: run abandoned"));
    this.sessions.delete(instanceId);
  }

  /** Resolve the oldest pending request_approval for an instance (down solicited). */
  answerApproval(instanceId: string, decision: string): boolean {
    const s = this.sessions.get(instanceId);
    const d = s?.approvals.shift();
    if (!d) return false;
    d.resolve(decision);
    return true;
  }

  /** Queue a steer message the Agent will read at its next check_inbox checkpoint. */
  postInbox(instanceId: string, message: string): void {
    this.sessions.get(instanceId)?.inbox.push(message);
  }

  // --- HTTP / MCP -----------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const m = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!m || m[1] === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const instanceId = decodeURIComponent(m[1]);

    // A held approval can outlive the client: when the Agent's MCP client times
    // out (Test 2's limit) it aborts the request, so writes from a late-resolving
    // deferred land on a closed socket. Swallow those — a disconnected client is
    // a normal outcome here, not a control-plane fault.
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

      // Stateless streamable-HTTP: a fresh transport + server per request, with the
      // toolset bound to this instance id. Tool *definitions* are always present (so
      // initialize/tools-list succeed at Agent init); only *invocation* needs a live
      // session.
      const server = this.buildServer(instanceId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      res.setTimeout(0);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      try {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      } catch {
        /* socket already gone */
      }
    }
  }

  private buildServer(instanceId: string): McpServer {
    const server = new McpServer({ name: "j2-control", version: "0.0.0" });
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    const session = () => this.sessions.get(instanceId);

    // up control — fire-and-ack: the Agent emits a semantic event; the result just
    // acknowledges so the turn proceeds.
    server.registerTool(
      "done",
      {
        description: "Signal that you have fully completed the assigned task.",
        inputSchema: { summary: z.string().optional() },
      },
      async ({ summary }) => {
        session()?.emit({ type: "agent.done", instanceId, summary });
        return text("acknowledged");
      },
    );
    server.registerTool(
      "request_review",
      {
        description: "Hand your work off for review. Provide a short summary of what to review.",
        inputSchema: { summary: z.string() },
      },
      async ({ summary }) => {
        session()?.emit({ type: "agent.requestReview", instanceId, summary });
        return text("acknowledged: review requested");
      },
    );
    server.registerTool(
      "report_blocked",
      {
        description: "Report that you are blocked and cannot proceed. Provide the reason.",
        inputSchema: { reason: z.string() },
      },
      async ({ reason }) => {
        session()?.emit({ type: "agent.reportBlocked", instanceId, reason });
        return text("acknowledged: reported blocked");
      },
    );

    // down solicited — the headline: this tool's RESULT is deferred until the
    // Machine answers. The Agent's turn blocks here on the held HTTP response.
    server.registerTool(
      "request_approval",
      {
        description:
          "Request approval BEFORE performing a gated action. You MUST call this and wait for the result before doing the action. The result is the decision: a string starting with APPROVED or DENIED.",
        inputSchema: { action: z.string(), reason: z.string().optional() },
      },
      async ({ action, reason }) => {
        const s = session();
        if (!s) return text("DENIED: no active session for this instance");
        const d = defer<string>();
        s.approvals.push(d);
        s.emit({ type: "agent.requestApproval", instanceId, action, reason });
        const decision = await d.promise; // held until answerApproval()/unregister()
        return text(decision);
      },
    );

    // down solicited (cooperative steer) — the Agent polls this at its own
    // checkpoints; the Machine seeds it via postInbox (PoC #4 Finding 2's
    // tool-layer gate, since flue has no mid-turn HTTP channel).
    server.registerTool(
      "check_inbox",
      {
        description: "Check for new steering instructions from the orchestrator. Call at natural checkpoints.",
        inputSchema: {},
      },
      async () => {
        const s = session();
        if (!s || s.inbox.length === 0) return text("INBOX_EMPTY");
        const msgs = s.inbox.splice(0).join("\n");
        return text(msgs);
      },
    );

    return server;
  }
}
