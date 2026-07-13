// The orchestrator HTTP surface (ADR-0009/0013): a thin REST + SSE facade over a `RunHost`. It
// carries NO domain logic of its own: every handler delegates to a single `RunHost` method, so the
// wire shape and the in-process API stay one behavior.
//
// TWO dialects, one primitive (ADR-0013). The Orchestrator does not speak MCP — that moved into the
// Sandbox, where the Adapter serves it to the Agent over localhost. What is left here are two thin
// adapters over the same registration table:
//
//   # human / webhook / CI — the Gate resource of ADR-0011
//   GET  /runs/:id                     open gates: accepts + schemas + meta      [Instance token]
//   POST /runs/:id/gates/:gate/events  validate + deliver                        [Instance token]
//
//   # the Agent's Adapter, and nothing else
//   GET  /agents/:iid/surface          accepts + schemas + semantics             [Sandbox token]
//   POST /agents/:iid/events           validate + deliver → { deliveryId }       [Sandbox token]
//
// The token is not decoration: an Agent has code execution in its Harness container and shares the
// pod's network namespace, so it can reach these routes. A Sandbox token may deliver ONLY to an
// agent surface recorded against its own Sandbox — never to a Gate. That is what stops an Agent
// from approving its own review.
//
// THREE bands of access, not two — the middleware is what says which:
//
//   open         structure + observation. `/workflows`, a template's Machine, the viz page, and the
//                run PROJECTIONS below (`GET /workflows/:name/runs*`). No context, no control.
//   authenticated any principal we minted a token for. The Agent's surface lives here, scoped
//                further per-registration by `mayDeliverToAgent`.
//   operator     the Instance token ALONE. Run control and full run state (`/runs*`): a Sandbox
//                token authenticates but is refused, because reading another feature's context or
//                cancelling a run is not on the Agent's surface any more than a Gate is.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { EventValidationError, UnknownAddressError } from "./registration.ts";
import { mayDeliverToAgent, type Authenticator, type Principal } from "./tokens.ts";
import { observe, type RunHost } from "./run-host.ts";

/** A `POST /runs/:id/events` body: the down-channel event. CANCEL is all that is left of it
 * (ADR-0013): APPROVE and STEER rode the deferred/poll machinery, which is reserved, not built. */
type RunEventBody = { type?: string };

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

/** The app's context: `authenticated` resolves the bearer to a `principal` the routes read back. */
type J2Env = { Variables: { principal: Principal } };

/** The bearer token on a request, if it carries one. */
function bearerOf(c: Context<J2Env>): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

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

/**
 * Build the orchestrator HTTP app over a `RunHost` (ADR-0009/0013 route table).
 *
 * `auth` is how a bearer token becomes a principal. Omitting it leaves the surface OPEN, which is
 * only ever right for an in-process test that reaches `app.request` directly — `startInstance`
 * (the one production path, and `j2 dev`) always supplies one.
 */
export function createApp(host: RunHost, auth?: Authenticator): Hono<J2Env> {
  const app = new Hono<J2Env>();

  /** Authenticate, or refuse. There is no anonymous principal (ADR-0013) — an open surface would
   * hand every Agent in the cluster a delivery API, which is the hole this ADR exists to close. */
  const authenticated: MiddlewareHandler<J2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = auth(bearerOf(c));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    return next();
  };
  /** The principal `authenticated` resolved. An unconfigured `auth` means full trust. */
  const principalOf = (c: Context<J2Env>): Principal => c.get("principal") ?? { kind: "instance" };

  /**
   * Authenticate, AND require the operator. A Sandbox token is a token we minted, so `authenticated`
   * alone lets it through — which on the run surface is too much: it would let an Adapter's
   * credential read every run's context (other features' branches, tickets, verdicts) and CANCEL any
   * run. Neither is on the Agent's surface. Its scope is delivering to agent registrations recorded
   * against its OWN Sandbox (ADR-0013), and the gate route already says so in the other direction.
   */
  const operator: MiddlewareHandler<J2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = auth(bearerOf(c));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind !== "instance") {
      return c.json({ error: "run control is the operator's — a Sandbox token cannot read or steer runs" }, 403);
    }
    c.set("principal", principal);
    return next();
  };

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => c.json({ ready: true }));

  // Structure, not state: the workflow listing, a template's Machine, and the visualizer page are
  // unauthenticated. They expose no run, drive nothing, and the viz page is a BROWSER — it has no
  // token to send. Everything that reads or moves a run is guarded below.
  app.get("/workflows", (c) => c.json(host.workflows()));

  // Push work: start a run of a registered workflow. Unknown workflow → host.start throws → 404.
  app.post("/workflows/:name/runs", authenticated, async (c) => {
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

  // ---- Observation (`GET /workflows/:name/runs*`) ---------------------------------------------
  // What the visualizer needs, and the most it may have. The page is a BROWSER: it has no token to
  // send, and giving it one would mean giving it the INSTANCE token — gates, run control, every
  // run's context — to whatever can load a URL (and `j2 dev` binds 0.0.0.0 once the instance has a
  // Sandbox backend, so that URL is not only yours). So the page gets a projection instead of a
  // credential: `observe()` keeps identity + the state VALUE and drops context, and the guarded
  // `/runs*` routes above stay exactly as guarded as they were. A projection, not a bypass.
  //
  // Scoped to one workflow because that is what an observer already knows (it is in the page's
  // path): no listing of everything this orchestrator is running.

  app.get("/workflows/:name/runs", (c) => c.json(host.observations(c.req.param("name"))));

  app.get("/workflows/:name/runs/:runId/events", async (c) => {
    const name = c.req.param("name");
    const runId = c.req.param("runId");
    const live = host.status(runId);
    // LIVE runs only, and only through the workflow that owns them. A settled run's terminal status
    // is a read-through into the store (`host.read`) — that is the operator's feed, not this one.
    if (!live || live.workflow !== name) return c.json({ error: `no live run "${runId}" of "${name}"` }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = host.subscribe(runId, (ev) => {
          if (ev.kind === "emit") {
            // The TYPE alone: an emit's payload is author data, the same class of thing as context.
            void stream.writeSSE({ event: "emit", data: JSON.stringify({ type: ev.event.type }) });
            return;
          }
          // Terminal frame must flush before the handler returns and closes the stream (see the
          // operator feed below for why the resolve is chained off the write).
          const terminal = ev.status.status !== "active";
          void stream.writeSSE({ event: "status", data: JSON.stringify(observe(ev.status)) }).then(() => {
            if (terminal) {
              unsubscribe();
              resolve();
            }
          });
        });
        // Race guard: settled between the liveness check and the subscribe, which then attached to
        // nothing. No read-through on this route, so there is nothing to fall back to — just close.
        if (host.status(runId) === undefined) {
          unsubscribe();
          resolve();
          return;
        }
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
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

  app.get("/runs", operator, (c) => c.json(host.list()));

  // Read-through (ADR-0009): a completed run's final status lives in the store after the registry
  // drops it, so this serves terminal runs too — only a genuinely unknown run is a 404. The status
  // carries the run's OPEN GATES (ADR-0011) — the discovery listing external callers act on
  // (`j2 send` menus, UI inbox cards, webhook translators matching on meta). Settled run → [].
  app.get("/runs/:runId", operator, async (c) => {
    const runId = c.req.param("runId");
    const status = await host.read(runId);
    return status ? c.json({ ...status, gates: host.gates(runId) }) : c.json({ error: `no run "${runId}"` }, 404);
  });

  // Gates delivery (ADR-0011): validate the body against the gate's named schema and deliver into
  // the gated state. Unknown gate (never opened, state exited, run settled) → 404; a name the gate
  // doesn't accept, or a payload failing its schema → 400 naming what IS accepted.
  //
  // A Gate is a HUMAN's decision (or a webhook's, or CI's). An Agent holding a Sandbox token is
  // refused here unconditionally — this is the exact line between "the Agent reports an outcome"
  // and "the Agent approves its own PR" (ADR-0013).
  app.post("/runs/:runId/gates/:gate/events", authenticated, async (c) => {
    if (principalOf(c).kind === "sandbox") {
      return c.json({ error: "a Sandbox token cannot deliver to a gate — gates are not on the Agent's surface" }, 403);
    }
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
  app.get("/runs/:runId/events", operator, async (c) => {
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

  // Run control (ADR-0002). CANCEL is the only event left on this seam: APPROVE and STEER answered
  // held `deferred` calls and drained `poll` inboxes, and ADR-0013 reserves both semantics without
  // building them. Workflow-defined events reach a run through its GATES, not through here.
  app.post("/runs/:runId/events", operator, async (c) => {
    const runId = c.req.param("runId");
    const body = (await readJson(c.req.text())) as RunEventBody;
    if (body.type !== "CANCEL") {
      return c.json({ error: `unknown event type "${body.type ?? ""}" (accepts: CANCEL)` }, 400);
    }
    try {
      await host.stop(runId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 404);
    }
  });

  // ---- The Agent's surface (`/agents/:iid/*` — ADR-0013) --------------------------------------
  // Served to ONE caller: the Adapter in the Agent's Sandbox. It renders `surface` as `tools/list`
  // and turns a `tools/call` into an `events` POST. The Orchestrator therefore keeps no MCP
  // dependency, no transport, no session handling — and the Agent keeps no route to this API
  // except through a process whose credential it cannot read.
  //
  // Both routes are adapters over the SAME registration table the gates ride: lookup, validation
  // and delivery are implemented once, in `registration.ts`.

  /** Guard: the surface must exist, and this principal must be allowed to speak for it. */
  const agentRegistration = (c: Context<J2Env, "/agents/:instanceId/surface" | "/agents/:instanceId/events">) => {
    const instanceId = c.req.param("instanceId");
    const surface = host.agentSurface(instanceId);
    // The one catch point (ADR-0011): no live registration (settled run, exited state, unknown
    // iid) → there is no surface to serve. 404 BEFORE the scope check — a caller with a valid
    // token learns nothing from it that it did not already know.
    if (!surface) return { error: c.json({ error: `no live agent surface for instance "${instanceId}"` }, 404) };
    if (!mayDeliverToAgent(principalOf(c), surface.sandbox)) {
      // A Sandbox token for a DIFFERENT Sandbox (or for a workspace-less run, which no Sandbox
      // owns). This is the check that keeps one feature's coder out of another's reviewer.
      return { error: c.json({ error: `this token cannot speak for instance "${instanceId}"` }, 403) };
    }
    return { surface };
  };

  // This turn's menu: the events the invoking state accepts, their input schemas, their semantics.
  // A transition swaps the registration, which swaps this — so the Adapter gets a state-scoped
  // toolset for free, and needs no `list_changed` to know it (flue re-lists on every submission).
  app.get("/agents/:instanceId/surface", authenticated, (c) => {
    const { surface, error } = agentRegistration(c);
    return error ?? c.json(surface);
  });

  // The Agent's pick, delivered into the state that invoked it. The receipt's `deliveryId` makes an
  // outcome addressable after the fact — the room a deferred result will need when it lands.
  app.post("/agents/:instanceId/events", authenticated, async (c) => {
    const { error } = agentRegistration(c);
    if (error) return error;
    const body = await readJson(c.req.text());
    try {
      return c.json(host.sendToAgent(c.req.param("instanceId"), body));
    } catch (err) {
      if (err instanceof UnknownAddressError) return c.json({ error: errMessage(err) }, 404);
      if (err instanceof EventValidationError) return c.json({ error: errMessage(err) }, 400);
      throw err;
    }
  });

  return app;
}
