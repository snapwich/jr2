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

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HttpBindings } from "@hono/node-server";
import { EventValidationError, UnknownAddressError } from "./registration.ts";
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

// ---- Visualizer assets (`/viz/*`) -----------------------------------------------------------
// The browser page that renders a workflow's Machine. Plain .html/.js/.css shipped inside this
// package (browsers don't type-strip TS) plus the vendored elkjs layout bundle, all read from
// disk — no CDN, no build step. `serveStatic` is deliberately avoided: its root is cwd-relative,
// and this package is a library that must serve its own files wherever the process starts.

const VIZ_DIR = new URL("../viz/", import.meta.url);

/** The vendored elkjs bundle, resolved through THIS package's dep edge (pnpm-safe), read once. */
let elkBundle: Promise<Buffer> | undefined;
function readElkBundle(): Promise<Buffer> {
  // elkjs ships no `exports` map today, so the subpath resolves; if a future version adds one,
  // switch to resolving "elkjs/package.json" and joining "lib/elk.bundled.js".
  elkBundle ??= readFile(createRequire(import.meta.url).resolve("elkjs/lib/elk.bundled.js"));
  return elkBundle;
}

/** Serve one file of the viz page with its content type. */
async function vizAsset(rel: string, contentType: string): Promise<Response> {
  const body = await readFile(new URL(rel, VIZ_DIR));
  return new Response(new Uint8Array(body), { headers: { "content-type": contentType } });
}

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

  // The registered template Machine's structure — what the visualizer renders (structure is
  // provider-independent, so the un-`provide()`d template is exactly right).
  app.get("/workflows/:name/machine", (c) => {
    const name = c.req.param("name");
    const doc = host.machine(name);
    return doc ? c.json(doc) : c.json({ error: `no workflow "${name}"` }, 404);
  });

  // The visualizer page. Assets are registered before `/viz/:name` so "assets" is never captured
  // as a workflow name. The page itself is one static shell for any name (the browser reads the
  // workflow from the path); an unknown workflow surfaces in-page via its 404'd /machine fetch.
  app.get("/viz/assets/main.js", () => vizAsset("main.js", "text/javascript; charset=utf-8"));
  app.get("/viz/assets/style.css", () => vizAsset("style.css", "text/css; charset=utf-8"));
  app.get("/viz/assets/elk.js", async () => {
    const body = await readElkBundle();
    return new Response(new Uint8Array(body), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });
  app.get("/viz/:name", () => vizAsset("page.html", "text/html; charset=utf-8"));

  app.get("/runs", (c) => c.json(host.list()));

  // Read-through (ADR-0009): a completed run's final status lives in the store after the registry
  // drops it, so this serves terminal runs too — only a genuinely unknown run is a 404. The status
  // carries the run's OPEN GATES (ADR-0011) — the discovery listing external callers act on
  // (`j2 send` menus, UI inbox cards, webhook translators matching on meta). Settled run → [].
  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const status = await host.read(runId);
    return status ? c.json({ ...status, gates: host.gates(runId) }) : c.json({ error: `no run "${runId}"` }, 404);
  });

  // Gates delivery (ADR-0011): validate the body against the gate's named schema and deliver into
  // the gated state. Unknown gate (never opened, state exited, run settled) → 404; a name the gate
  // doesn't accept, or a payload failing its schema → 400 naming what IS accepted.
  app.post("/runs/:runId/gates/:gate/events", async (c) => {
    const body = await readJson(c.req.text());
    try {
      host.sendToGate(c.req.param("runId"), c.req.param("gate"), body);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof UnknownAddressError) return c.json({ error: errMessage(err) }, 404);
      if (err instanceof EventValidationError) return c.json({ error: errMessage(err) }, 400);
      throw err;
    }
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

  // MCP control plane (ADR-0009/0011 `/mcp/:instanceId`): the DOMAIN up-channel. The Agent's tool
  // calls arrive here as JSON-RPC; the server is built from the instance's LIVE registration in
  // the shared table (the workflow-defined events its invoking state accepts), and delivery lands
  // through the registration's closure — no routing.
  //
  // STATELESS PER REQUEST: every HTTP request builds a fresh transport (sessionIdGenerator: undefined
  // → no MCP session) and connects a fresh per-instance McpServer, torn down when the socket closes.
  // This is safe — and the whole point of the host owning ONE ControlPlane — because deferred holds
  // and inboxes live on that single ControlPlane keyed by instanceId, NOT on the per-request server.
  // A held `deferred` call therefore survives on its own open POST stream (the SDK keeps the HTTP
  // response open) until `host.answer → controlPlane.answerRun` writes the deferred tool result; a
  // sibling request that drains the inbox sees the same shared queue.
  app.all("/mcp/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const server = host.mcpServer(instanceId);
    // The one catch point (ADR-0011): no live registration (settled run, exited state, unknown
    // iid) → there is no surface to serve.
    if (!server) return c.json({ error: `no live agent surface for instance "${instanceId}"` }, 404);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
