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
//   POST /agents/:iid/events           validate + deliver → the turn receipt      [Sandbox token]
//
// The token is not decoration: an Agent has code execution in its Harness container and shares the
// pod's network namespace, so it can reach these routes. A Sandbox token may deliver ONLY to an
// agent surface recorded against its own Sandbox — never to a Gate. That is what stops an Agent
// from approving its own review.
//
// THREE bands of access, not two (ADR-0014) — the middleware is what says which:
//
//   open          structure + observation. `/workflows`, a template's Machine, the viz page, and
//                 the run PROJECTIONS below (`GET /workflows/:name/runs*`). No context, no control.
//   authenticated any principal we minted a token for. The Agent's surface lives here, scoped
//                 further per-registration by `mayDeliverToAgent`.
//   instanceOnly  the Instance token ALONE. Run control and full run state (`/runs*`): a Sandbox
//                 token authenticates but is refused, because reading another feature's context or
//                 cancelling a run is not on the Agent's surface any more than a Gate is.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { EventValidationError, UnknownAddressError } from "./registration.ts";
import { mayDeliverToAgent, type Authenticator, type Principal } from "./tokens.ts";
import { observe, type RunHost } from "./run-host.ts";
import { KIT_VERSION } from "./config.ts";

/** A `POST /runs/:id/events` body: the down-channel event. CANCEL is all that is left of it
 * (ADR-0013): APPROVE and STEER rode the deferred/poll machinery, which is reserved, not built. */
type RunEventBody = { type?: string };

/** `GET /runs/resolve` floor — a 1-char prefix is a table scan, not a question. The CLI enforces
 * the same floor on the argument; this one guards the scan regardless of who is calling. */
const MIN_RUN_ID_PREFIX = 4;

/** How many ambiguous candidates are worth showing. Proving ambiguity takes 2; letting the caller
 * PICK is the point, so the listing goes deeper before it truncates. */
const RESOLVE_LIMIT = 10;

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
 * One SSE handler's single exit. Every feed can end four ways — terminal frame, race guard, client
 * abort, host shutdown — and each must unsubscribe, clear the ping timer, and resolve EXACTLY once.
 * Spelling that out per exit is how a timer gets leaked, so each handler builds one of these and
 * every exit becomes `exit.done`.
 *
 * `onExit` is called AFTER subscribing, because `host.subscribe` replays synchronously and can
 * therefore finish the feed before it returns — hence the already-finished check inside it.
 */
function closer(resolve: () => void) {
  let cleanups: Array<() => void> = [];
  let finished = false;
  const release = () => {
    for (const fn of cleanups) fn();
    cleanups = [];
  };
  return {
    done: () => {
      if (finished) return;
      finished = true;
      release();
      resolve();
    },
    /** Register cleanup (an unsubscribe, a timer clear) to run on whichever exit happens first. */
    onExit: (fn: () => void) => (finished ? fn() : cleanups.push(fn)),
    /** Run the cleanups WITHOUT ending the feed — the read-through race guard, which detaches from
     *  a run that is already gone and then still has a final frame to write. */
    release,
  };
}

/** How often an otherwise-silent feed writes a ping. */
const PING_MS = 15_000;

/**
 * Keep a quiet feed alive.
 *
 * A run parked on a gate transitions for hours, so its feed writes zero bytes and any idle
 * intermediary drops the connection — the client sees a dead socket that still looks healthy (this
 * is the `error: terminated` an attached `j2 run` hit). The frame is an SSE COMMENT (`:\n\n`):
 * every client ignores it, so it needs no place in the wire vocabulary.
 *
 * It is deliberately a **ping**, not a heartbeat or keepalive — CONTEXT.md puts both on the Lease's
 * Avoid list, and this asserts nothing and expects no answer.
 *
 * It is NOT a liveness probe, and must not be mistaken for one: `stream.write` swallows its own
 * errors (hono's `StreamingApi`), so a failed write is indistinguishable from a good one. A peer
 * that goes away is detected by `stream.onAbort`, which is what every handler here wires to its
 * exit. The tick checks `aborted`/`closed` only so a ping that fires between the abort and the
 * teardown does not write into a dead stream. Returns its own clear fn.
 */
function pinger(stream: SseStream, done: () => void, everyMs = PING_MS): () => void {
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) return done();
    void stream.write(":\n\n");
  }, everyMs);
  return () => clearInterval(timer);
}

/** The slice of hono's `StreamingApi` the ping needs: the raw write (`writeSSE` cannot express a
 *  comment frame) plus the two flags that say the peer is gone. */
type SseStream = { write: (s: string) => Promise<unknown>; aborted: boolean; closed: boolean };

export type CreateAppOptions = {
  /** Ping interval for the SSE feeds. Tests shorten it; nothing in production sets it. */
  pingMs?: number;
};

/**
 * Build the orchestrator HTTP app over a `RunHost` (ADR-0009/0013 route table).
 *
 * `auth` is how a bearer token becomes a principal. Omitting it leaves the surface OPEN, which is
 * only ever right for an in-process test that reaches `app.request` directly — `startInstance`
 * (every real boot, deployed or fixture) always supplies one.
 */
export function createApp(host: RunHost, auth?: Authenticator, opts: CreateAppOptions = {}): Hono<J2Env> {
  const pingMs = opts.pingMs ?? PING_MS;
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
   * Authenticate, AND require the INSTANCE token (ADR-0014). A Sandbox token is a token we minted,
   * so `authenticated` alone lets it through — which on the run surface is too much: it would let an
   * Adapter's credential read every run's context (other features' branches, tickets, verdicts) and
   * CANCEL any run. Neither is on the Agent's surface. Its scope is delivering to agent
   * registrations recorded against its OWN Sandbox (ADR-0013), and the gate route already says so in
   * the other direction.
   */
  const instanceOnly: MiddlewareHandler<J2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = auth(bearerOf(c));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind !== "instance") {
      return c.json({ error: "run state and control need the Instance token — a Sandbox token has neither" }, 403);
    }
    c.set("principal", principal);
    return next();
  };

  // Liveness, and the one place an instance says WHAT IT IS. Unauthenticated because it is the
  // readiness probe's target and because identity is not run state — it is the same class of thing
  // as the route table, which is public by being served. The CLI probes it to explain a failure it
  // could otherwise only report as a bare status code (version skew reads as a nonsense 404).
  // `hash` is the image's content address (ADR-0019), absent for a host-booted fixture process,
  // which has no image to be addressed.
  app.get("/healthz", (c) => c.json({ ok: true, version: KIT_VERSION, hash: process.env.J2_CONTENT_HASH }));
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
  // run's context — to whatever can load a URL (and the orchestrator binds 0.0.0.0 — pods must
  // reach it — so that URL is not only yours). So the page gets a projection instead of a
  // credential: `observe()` keeps identity + the state VALUE and drops context, and the guarded
  // `/runs*` routes above stay exactly as guarded as they were. A projection, not a bypass.
  //
  // Scoped to one workflow because that is what an observer already knows (it is in the page's
  // path): no listing of everything this orchestrator is running.

  app.get("/workflows/:name/runs", (c) => c.json(host.observations(c.req.param("name"))));

  /**
   * SSE: a whole WORKFLOW's activity (ADR-0022) — every run of it appearing, moving, emitting and
   * leaving, on one connection that outlives all of them.
   *
   * The feed is LEVEL-TRIGGERED: `status` always carries a whole observation, never a patch, and the
   * opening `runs` frame carries the entire current set. A reconnecting client therefore converges
   * with no replay buffer, no Last-Event-ID and no per-client state on this side — re-delivery is
   * idempotent by construction. Same reconciliation idiom as the Lease (ADR-0021) and ADR-0019.
   *
   * Unknown workflow is NOT a 404: it attaches and reports an empty set, matching
   * `/workflows/:name/runs`. The page is opened by path, and a later registration may supply the
   * name a moment later — the already-open feed then just starts working.
   *
   * Same open band as the routes above (ADR-0014): `observe()` projects away context, instanceId and
   * fault at every depth, and an emit contributes its TYPE alone.
   */
  app.get("/workflows/:name/events", async (c) => {
    const name = c.req.param("name");
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const exit = closer(resolve);
        // Subscribe and snapshot in one call, then write the snapshot in the same tick: nothing can
        // start, move or finish in between, so the client's first frame is a complete picture.
        const { runs, unsubscribe } = host.observeWorkflow(name, (ev) => {
          if (ev.kind === "closed") return exit.done();
          if (ev.kind === "gone") {
            void stream.writeSSE({ event: "gone", data: JSON.stringify({ runId: ev.runId }) });
            return;
          }
          if (ev.kind === "emit") {
            // The TYPE alone: an emit's payload is author data, the same class of thing as context.
            void stream.writeSSE({ event: "emit", data: JSON.stringify({ runId: ev.runId, type: ev.event.type }) });
            return;
          }
          if (ev.kind === "retry") {
            // `{ child, attempt }` only — `reason` is mechanism/error text, which stays behind the
            // Instance token like `fault` (ADR-0014/0016).
            void stream.writeSSE({
              event: "retry",
              data: JSON.stringify({ runId: ev.runId, child: ev.child, attempt: ev.attempt }),
            });
            return;
          }
          void stream.writeSSE({ event: "status", data: JSON.stringify(observe(ev.status)) });
        });
        exit.onExit(unsubscribe);
        // `retry` steers the browser's own EventSource backoff. This feed never ends on its own, so
        // every close is a fault worth reconnecting from — the client does not decide that.
        void stream.writeSSE({ event: "runs", data: JSON.stringify(runs.map(observe)), retry: 2000 });
        exit.onExit(pinger(stream, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  app.get("/workflows/:name/runs/:runId/events", async (c) => {
    const name = c.req.param("name");
    const runId = c.req.param("runId");
    const live = host.status(runId);
    // LIVE runs only, and only through the workflow that owns them. A settled run's terminal status
    // is a read-through into the store (`host.read`) — that is the Instance's feed, not this one.
    if (!live || live.workflow !== name) return c.json({ error: `no live run "${runId}" of "${name}"` }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const exit = closer(resolve);
        exit.onExit(
          host.subscribe(runId, (ev) => {
            // The host is shutting down under a feed that has no end of its own.
            if (ev.kind === "closed") return exit.done();
            if (ev.kind === "emit") {
              // The TYPE alone: an emit's payload is author data, the same class of thing as context.
              void stream.writeSSE({ event: "emit", data: JSON.stringify({ type: ev.event.type }) });
              return;
            }
            if (ev.kind === "retry") {
              // `{ child, attempt }` only — `reason` is mechanism/error text, which stays behind
              // the Instance token like `fault` (ADR-0014/0016).
              void stream.writeSSE({ event: "retry", data: JSON.stringify({ child: ev.child, attempt: ev.attempt }) });
              return;
            }
            // Turn markers (ADR-0023) carry an Agent's framing and pick payload — Instance-token
            // class, so the OPEN band never sees them (not even their types).
            if (ev.kind === "admission" || ev.kind === "pick") return;
            // Terminal frame must flush before the handler returns and closes the stream (see the
            // guarded feed below for why the exit is chained off the write).
            const terminal = ev.status.status !== "active";
            void stream.writeSSE({ event: "status", data: JSON.stringify(observe(ev.status)) }).then(() => {
              if (terminal) exit.done();
            });
          }),
        );
        // Race guard: settled between the liveness check and the subscribe, which then attached to
        // nothing. No read-through on this route, so there is nothing to fall back to — just close.
        if (host.status(runId) === undefined) return exit.done();
        exit.onExit(pinger(stream, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  // The visualizer page. Assets are registered before `/viz/:name` so "assets" is never captured
  // as a workflow name. The page itself is one static shell for any name (the browser reads the
  // workflow from the path); an unknown workflow surfaces in-page via its 404'd /machine fetch.
  app.get("/viz/assets/main.js", () => vizAsset("main.js", "text/javascript; charset=utf-8"));
  app.get("/viz/assets/store.js", () => vizAsset("store.js", "text/javascript; charset=utf-8"));
  app.get("/viz/assets/style.css", () => vizAsset("style.css", "text/css; charset=utf-8"));
  app.get("/viz/assets/elk.js", async () => {
    const body = await readElkBundle();
    return new Response(new Uint8Array(body), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });
  app.get("/viz/:name", () => vizAsset("page.html", "text/html; charset=utf-8"));

  app.get("/runs", instanceOnly, (c) => c.json(host.list()));

  // Abbreviated run ids (ADR-0009). Registered before `/runs/:runId` so "resolve" is never captured
  // as a run id — the same guard the viz assets use above. The prefix rides in the query string
  // because this is a search, not an address: `/runs/resolve/abc` would read like a run named
  // "resolve". Resolution lives HERE and not on the addressed routes below, which stay full-id —
  // a prefix that resolves today goes ambiguous tomorrow, and a write must never be prefix-sensitive.
  //
  // Ids ONLY, never RunStatus: it keeps the scan index-only, it matches what git prints for an
  // ambiguous hash, and it holds down what this newly reveals — settled run ids are now visible to
  // an Instance-token holder, which `GET /runs`'s deferred `?all` had withheld. Deliberately not on
  // the open observation routes: prefix probing there would be a run-id enumeration oracle.
  app.get("/runs/resolve", instanceOnly, async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    if (prefix.length < MIN_RUN_ID_PREFIX) {
      return c.json({ error: `prefix must be at least ${MIN_RUN_ID_PREFIX} characters` }, 400);
    }
    // Scan one past the cap so `truncated` is knowable without a second COUNT.
    const found = await host.candidates(prefix, RESOLVE_LIMIT + 1);
    return c.json({
      prefix,
      runIds: found.slice(0, RESOLVE_LIMIT),
      truncated: found.length > RESOLVE_LIMIT,
    });
  });

  // Read-through (ADR-0009): a completed run's final status lives in the store after the registry
  // drops it, so this serves terminal runs too — only a genuinely unknown run is a 404. The status
  // carries the run's OPEN GATES (ADR-0011) — the discovery listing external callers act on
  // (`j2 send` menus, UI inbox cards, webhook translators matching on meta). Settled run → [].
  app.get("/runs/:runId", instanceOnly, async (c) => {
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
  app.get("/runs/:runId/events", instanceOnly, async (c) => {
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
        const exit = closer(resolve);
        exit.onExit(
          host.subscribe(runId, (ev) => {
            if (ev.kind === "closed") return exit.done();
            if (ev.kind === "emit") {
              void stream.writeSSE({ event: "emit", data: JSON.stringify(ev.event) });
              return;
            }
            if (ev.kind === "retry") {
              // The Instance's own feed: the full telemetry, reason included (same trust class as
              // `fault`).
              void stream.writeSSE({ event: "retry", data: JSON.stringify(ev) });
              return;
            }
            if (ev.kind === "admission" || ev.kind === "pick") {
              // Turn markers (ADR-0023) — Instance-token band, so the framing/payload ride whole.
              // These stay OFF the open workflow feed entirely (run-host.ts feeds them per-run).
              void stream.writeSSE({ event: ev.kind, data: JSON.stringify(ev) });
              return;
            }
            // Exiting lets the handler return, which CLOSES the stream — so on the terminal frame we
            // must wait for the write to flush first, or a fire-and-forget write races the close and the
            // final status is dropped (the very frame `j2 run` blocks on). Chain the exit off the write.
            const terminal = ev.status.status !== "active";
            void stream.writeSSE({ event: "status", data: JSON.stringify(ev.status) }).then(() => {
              if (terminal) exit.done();
            });
          }),
        );
        // Race guard: the run may have settled between the liveness check above and this subscribe,
        // which then attaches to nothing and never fires. Fall back to the terminal read-through.
        if (host.status(runId) === undefined) {
          exit.release();
          void host.read(runId).then((s) => {
            if (s) void stream.writeSSE({ event: "status", data: JSON.stringify(s) });
            exit.done();
          });
          return;
        }
        exit.onExit(pinger(stream, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  // Run control (ADR-0002). CANCEL is the only event left on this seam: APPROVE and STEER answered
  // held `deferred` calls and drained `poll` inboxes, and ADR-0013 reserves both semantics without
  // building them. Workflow-defined events reach a run through its GATES, not through here.
  //
  // It ENDS the run (ADR-0025): the Agents' turns end with it and the run does not come back on
  // the next restore. `RunHost.stop()` — park it, keep it restorable — is a different verb, and
  // deliberately not on the wire.
  app.post("/runs/:runId/events", instanceOnly, async (c) => {
    const runId = c.req.param("runId");
    const body = (await readJson(c.req.text())) as RunEventBody;
    if (body.type !== "CANCEL") {
      return c.json({ error: `unknown event type "${body.type ?? ""}" (accepts: CANCEL)` }, 400);
    }
    try {
      await host.cancel(runId);
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

  // The Agent's pick, delivered into the state that invoked it. The receipt describes itself
  // (ADR-0024): what was delivered, and whether that ended the turn — which the Adapter renders as
  // prose. Its `deliveryId` still makes an outcome addressable after the fact, the room a deferred
  // result will need when it lands.
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
