// The orchestrator HTTP surface (ADR-0009): a thin, run-addressed-by-id REST + SSE facade over a
// `RunHost`. This is the machine-to-machine control channel — push work, control a run, observe it
// — the `j2` CLI and any external caller sit on top of it. It carries NO domain logic of its own:
// every handler delegates to a single `RunHost` method, so the wire shape and the in-process API
// stay one behavior.
//
// Channel split (ADR-0002/0006): this surface is the human-in-the-loop DOWN-channel and the
// observation up-feed. `POST /runs/:id/events` is the down-channel seam (APPROVE / STEER / CANCEL);
// `GET /runs/:id/events` streams the run's status as it transitions. Domain tool calls from the
// Agent do NOT come through here — they arrive over MCP on `/mcp/:instanceId` (mounted separately
// onto this same app), routed by the host's ControlPlane.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HttpBindings } from "@hono/node-server";
import type { RunHost } from "./run-host.ts";

/** A `POST /runs/:id/events` body: the down-channel event plus its (type-specific) payload. */
type RunEventBody = { type?: string; reject?: boolean; decision?: string; message?: string };

/** Read a request body as JSON, tolerating an empty body (→ {}) and malformed JSON (→ {}). */
async function readJson(text: Promise<string>): Promise<Record<string, unknown>> {
  try {
    const raw = await text;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The message of a thrown error, for the `{ error }` 404 body. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The MCP transport writes its JSON-RPC reply straight to the raw Node `ServerResponse`, so the hono
// handler must NOT also produce a body. @hono/node-server v2 dropped the exported RETURN_ALREADY_SENT
// sentinel, but the listener still honors a null-body Response carrying `x-hono-already-sent` by
// leaving the socket untouched (dist: `responseViaResponseObject`). Returning this from the /mcp
// handler yields the response to the transport. (ADR-0009.)
const MCP_ALREADY_SENT = new Response(null, { headers: { "x-hono-already-sent": "true" } });

/** Build the orchestrator HTTP app over a `RunHost` (ADR-0009 route table). */
export function createApp(host: RunHost): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => c.json({ ready: true }));

  app.get("/workflows", (c) => c.json(host.workflows()));

  // Push work: start a run of a registered workflow. Unknown workflow → host.start throws → 404.
  app.post("/workflows/:name/runs", async (c) => {
    const name = c.req.param("name");
    const input = await readJson(c.req.text());
    try {
      const { runId, instanceId } = await host.start(name, input);
      return c.json({ runId, instanceId }, 201);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 404);
    }
  });

  app.get("/runs", (c) => c.json(host.list()));

  // Read-through (ADR-0009): a completed run's final status lives in the store after the registry
  // drops it, so this serves terminal runs too — only a genuinely unknown run is a 404.
  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const status = await host.read(runId);
    return status ? c.json(status) : c.json({ error: `no run "${runId}"` }, 404);
  });

  // SSE: a live run streams its status deltas + author `emit`s (current status replayed on attach,
  // then live until the terminal transition or client abort). A run that has already settled streams
  // its final status once and closes (so `j2 logs -f` works on a finished run). Unknown run → 404.
  app.get("/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    if (host.status(runId) === undefined) {
      const finalStatus = await host.read(runId);
      if (!finalStatus) return c.json({ error: `no run "${runId}"` }, 404);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "status", data: JSON.stringify(finalStatus) });
      });
    }
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = host.subscribe(runId, (ev) => {
          if (ev.kind === "emit") {
            void stream.writeSSE({ event: "emit", data: JSON.stringify(ev.event) });
            return;
          }
          // Resolving lets the handler return, which CLOSES the stream — so on the terminal frame we
          // must wait for the write to flush first, or a fire-and-forget write races the close and the
          // final status is dropped (the very frame `j2 run` blocks on). Chain resolve off the write.
          const terminal = ev.status.status !== "active";
          void stream.writeSSE({ event: "status", data: JSON.stringify(ev.status) }).then(() => {
            if (terminal) {
              unsubscribe();
              resolve();
            }
          });
        });
        // Race guard: the run may have settled between the liveness check above and this subscribe,
        // which then attaches to nothing and never fires. Fall back to the terminal read-through.
        if (host.status(runId) === undefined) {
          unsubscribe();
          void host.read(runId).then((s) => {
            if (s) void stream.writeSSE({ event: "status", data: JSON.stringify(s) });
            resolve();
          });
          return;
        }
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  });

  // Down-channel: feed one event into a live run (ADR-0002). Host method throws (no run) → 404.
  app.post("/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const body = (await readJson(c.req.text())) as RunEventBody;
    try {
      switch (body.type) {
        case "APPROVE":
          host.answer(runId, body.reject ? "rejected" : (body.decision ?? "approved"));
          break;
        case "CANCEL":
          await host.stop(runId);
          break;
        case "STEER":
          host.steer(runId, body.message ?? "");
          break;
        default:
          return c.json({ error: "unknown event type" }, 400);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 404);
    }
  });

  // MCP control plane (ADR-0009 `/mcp/:instanceId`): the DOMAIN up-channel. The Agent's callback
  // tool calls (request_review / request_approval / check_inbox / done / report_blocked) arrive here
  // as JSON-RPC and are routed by the host's ControlPlane into the owning run's Machine.
  //
  // STATELESS PER REQUEST: every HTTP request builds a fresh transport (sessionIdGenerator: undefined
  // → no MCP session) and connects a fresh per-instance McpServer, torn down when the socket closes.
  // This is safe — and the whole point of the host owning ONE ControlPlane — because pendingApprovals
  // and inboxes live on that single ControlPlane keyed by instanceId, NOT on the per-request server.
  // A held `request_approval` therefore survives on its own open POST stream (the SDK keeps the HTTP
  // response open) until `host.answer → controlPlane.resolveApproval(instanceId)` writes the deferred
  // tool result; a sibling request that drains the inbox sees the same shared queue.
  app.all("/mcp/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = host.mcpServer(instanceId);
    await server.connect(transport);

    // Under @hono/node-server the raw Node objects ride on the context env (HttpBindings). The MCP
    // transport needs them directly — it does not go through hono's Response abstraction.
    const { incoming, outgoing } = c.env as unknown as HttpBindings;
    outgoing.on("close", () => {
      void transport.close();
      void server.close();
    });

    // POST carries a JSON-RPC body (single object or batch array) the transport must see — parse it
    // here and pass it as the 3rd arg rather than routing it through `readJson` (which would coerce a
    // batch array to `{}`). GET (SSE) and DELETE carry no body.
    const raw = c.req.method === "POST" ? await c.req.text() : "";
    const body = raw ? JSON.parse(raw) : undefined;
    await transport.handleRequest(incoming, outgoing, body);
    return MCP_ALREADY_SENT;
  });

  return app;
}
