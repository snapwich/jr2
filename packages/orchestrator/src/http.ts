// The orchestrator HTTP surface (ADR-0009/0013): a thin REST + SSE facade over a `RunHost`. It
// carries NO domain logic of its own: every handler delegates to a single `RunHost` method, so the
// wire shape and the in-process API stay one behavior.
//
// TWO dialects, one primitive (ADR-0013). The Orchestrator does not speak MCP — nothing does: the
// Harness presents the Menu to its model itself, and reaches these routes through the Custodian in
// its pod, which holds the Sandbox token. What is left here are two thin adapters over the same
// registration table: the Gate resource of ADR-0011, for a human, a webhook or CI
// (`GET /runs/:id`, `POST /runs/:id/gates/:gate/events`), and the Agent's surface, for the Agent's
// Harness through its Custodian and nothing else (`/agents/:iid/*`). `/sandboxes/:name/fetch` also
// serves the Harness's pod, but it is not an adapter over the registration table.
//
// Every route, with its band, is a row of `HTTP_ROUTES` below. That table is data: the HTTP API
// Reference is generated from it (ADR-0072), and http-routes.test.ts holds it to the routes
// `createApp` registers, both ways.
//
//   # named Charts (ADR-0070): a Chart under a name is a Workflow `<wrapper>/<name>`
//   GET    /workflows/:wrapper/chart-schema           the grammar, narrowed to the Open body    [open]
//   PUT    /workflows/:wrapper/charts/:name           admit + keep a runtime Chart              [Instance token]
//   DELETE /workflows/:wrapper/charts/:name           remove a runtime Chart                    [Instance token]
//   POST   /workflows/:wrapper/charts/:name/runs      start the named Chart                     [Instance token]
//   GET    /workflows/:name/runs/:runId/machine       the run's bound Machine, Charts compiled  [open]
//
//   # `jr2 up`, and nothing else (ADR-0069)
//   PUT  /assembly                     publish the next Assembly                 [publish token]
//   GET  /assembly                     the current Assembly and the held ones    [open]
//
// The token is not decoration: an Agent has code execution in its Harness container and shares the
// pod's network namespace, so it can reach these routes. A Sandbox token may deliver ONLY to an
// agent surface recorded against its own Sandbox — never to a Gate. That is what stops an Agent
// from approving its own review.
//
// THREE bands of access, not two (ADR-0014) — the middleware is what says which:
//
//   open          structure + observation. `/workflows`, a template's Machine, the Console shell,
//                 and the run PROJECTIONS below (`GET /workflows/:name/runs*`). No context, no
//                 control.
//   authenticated any principal we minted a token for. The Agent's surface lives here, scoped
//                 further per-registration by `mayDeliverToAgent`.
//   instanceOnly  the Instance token ALONE. Run control — starting a run included (ADR-0058) — and
//                 full run state (`/runs*`): a Sandbox token authenticates but is refused, because
//                 starting work, reading another feature's context, or cancelling a run is not on
//                 the Agent's surface any more than a Gate is.

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import tsBlankSpace from "ts-blank-space";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { accepts } from "hono/accepts";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  DISPATCHED_BY_HEADER,
  EventValidationError,
  NotTakenError,
  OutstandingError,
  UnknownAddressError,
  type DispatchedBy,
} from "./registration.ts";
import type { RepoStatus } from "./repos.ts";
import { UnmountedRepoError, type FetchAnswer } from "./repo-fetch.ts";
import { mayAskForSandbox, mayDeliverToAgent, type Authenticator, type Principal } from "./tokens.ts";
import {
  DispatchKeyConflictError,
  keyAnswer,
  keyConflict,
  observe,
  UnknownWorkflowError,
  type RunFeedEvent,
  type RunHost,
  type RunStatus,
  type WorkflowFeedEvent,
} from "./run-host.ts";
import { KIT_VERSION } from "./config.ts";
import type { AssemblyDoor } from "./assembly.ts";
import { ChartRefusal } from "./chart.ts";
import { chartName, NamedChartError, splitChartName, type NamedCharts } from "./charts.ts";

// ---- The route table (ADR-0072) -------------------------------------------------------------
// The routes `createApp` registers, as data. It is the source of the HTTP API Reference page, so a
// row says what a CALLER needs: the address, the credential, the body, the answer. Why a route is
// in its band stays in the comment above its handler. http-routes.test.ts compares the rows with
// the app's own registrations both ways and checks each row's band on the wire, so the table
// cannot drift from the code by forgetting.

/** The access bands of ADR-0014, named for the credential each requires, and the publish door's
 * band (ADR-0069): the publish token alone. */
export type HttpBand = "open" | "authenticated" | "instanceOnly" | "publishOnly";

/** One route of the Orchestrator's HTTP API (ADR-0072). */
export type HttpRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** In Hono syntax, exactly as registered: `:param`, and `:param{regex}` for a constrained one. */
  path: string;
  band: HttpBand;
  /** One line: what the route does. */
  summary: string;
  /** The request body, as a type name or in short; absent when the route reads none. */
  body?: string;
  /** The success answer, in short. Errors are `{ error }` with the status the handler says. */
  response: string;
  /** `true` when the answer is a Server-Sent Events stream. */
  stream: boolean;
  /** The decisions that shape the route, as bare ADR numbers: `"0014"`. */
  adrs: readonly string[];
};

/** Every route of the Orchestrator's HTTP API, in the order `createApp` registers them. */
export const HTTP_ROUTES: readonly HttpRoute[] = [
  {
    method: "GET",
    path: "/healthz",
    band: "open",
    summary: "Liveness, and what this instance is: its Kit version and image content hash.",
    response: "{ ok: true, version, hash? }",
    stream: false,
    adrs: ["0009", "0019"],
  },
  {
    method: "GET",
    path: "/readyz",
    band: "open",
    summary: "Readiness.",
    response: "{ ready: true }",
    stream: false,
    adrs: ["0009"],
  },
  {
    method: "GET",
    path: "/workflows",
    band: "open",
    summary:
      "The Workflows a run can start, each with its origin, and each Chart wrapper's named Charts in its entry. A named Chart that cannot run now says why.",
    response: "WorkflowListing[]",
    stream: false,
    adrs: ["0014", "0070"],
  },
  {
    method: "GET",
    path: "/assembly",
    band: "open",
    summary: "The current Assembly and the Assemblies that live runs hold.",
    response: "AssemblyView",
    stream: false,
    adrs: ["0069"],
  },
  {
    method: "PUT",
    path: "/assembly",
    band: "publishOnly",
    summary:
      "Publish the next Assembly. `jr2 up` calls it, and nothing else. A refused Assembly leaves the current one current.",
    body: "the Assembly as a tar stream, with the headers `jr2-kit-version` and `jr2-assembly-hash`",
    response:
      "200 with the Assembly, its Workflows, the held Assemblies and the ones collected; 400, 409 or 422 with the reason",
    stream: false,
    adrs: ["0069"],
  },
  {
    method: "GET",
    path: "/workflows/:wrapper/chart-schema",
    band: "open",
    summary: "The Chart grammar, narrowed to the Open body of one Chart wrapper.",
    response: "JSON Schema",
    stream: false,
    adrs: ["0070"],
  },
  {
    method: "PUT",
    path: "/workflows/:wrapper/charts/:name",
    band: "instanceOnly",
    summary: "Admit and keep a runtime Chart under a name. Its Workflow is `<wrapper>/<name>`.",
    body: "the Chart text alone",
    response: "201 { name, origin, hash } when new, 200 when it replaced one; 422 { error, report } when refused",
    stream: false,
    adrs: ["0070"],
  },
  {
    method: "DELETE",
    path: "/workflows/:wrapper/charts/:name",
    band: "instanceOnly",
    summary: "Remove a runtime Chart. A live run of it keeps its own text.",
    response: "204",
    stream: false,
    adrs: ["0070"],
  },
  {
    method: "POST",
    path: "/workflows/:wrapper/charts/:name/runs",
    band: "instanceOnly",
    summary: "Start a run of a named Chart, as `POST /workflows/<wrapper>%2F<name>/runs` does.",
    body: "the Chart wrapper's input, without the Chart",
    response: "201 { runId, instanceId }; 409 when the named Chart cannot run now",
    stream: false,
    adrs: ["0070"],
  },
  {
    method: "GET",
    path: "/workflows/:name/runs/:runId/machine",
    band: "open",
    summary: "The Machine that a run binds, with each bound Chart compiled in, which the Console draws.",
    response: "MachineDoc",
    stream: false,
    adrs: ["0070"],
  },
  {
    method: "GET",
    path: "/",
    band: "open",
    summary: "The Console page to a browser; a 404 to a JSON caller.",
    response: "text/html (the Console shell)",
    stream: false,
    adrs: ["0032"],
  },
  {
    method: "GET",
    path: "/workflows/:name",
    band: "open",
    summary: "The Console page to a browser; to a JSON caller, the workflow and its declared input schema.",
    response: "{ name, machineId, input: JSON Schema | null }, or text/html",
    stream: false,
    adrs: ["0032", "0033"],
  },
  {
    method: "POST",
    path: "/workflows/:name/runs",
    band: "instanceOnly",
    summary:
      "Start a run of a registered workflow. A `dispatch` from another Orchestrator sends the header `jr2-dispatched-by`, and a repeated start with its key answers the run that it started.",
    body: "the workflow's input, checked against its declared input schema",
    response:
      "201 { runId, instanceId }; 200 { runId, instanceId, existing: true } for a repeated dispatch; 422 { error, report } when the door refuses a Chart in the input",
    stream: false,
    adrs: ["0033", "0058", "0070", "0071"],
  },
  {
    method: "GET",
    path: "/workflows/:name/machine",
    band: "open",
    summary: "The registered template Machine's structure, which the Console draws.",
    response: "MachineDoc",
    stream: false,
    adrs: ["0014"],
  },
  {
    method: "GET",
    path: "/workflows/:name/runs",
    band: "open",
    summary: "The live runs of one workflow, as observations: identity and state value, no context.",
    response: "RunObservation[]",
    stream: false,
    adrs: ["0014"],
  },
  {
    method: "GET",
    path: "/workflows/:name/events",
    band: "open",
    summary: "The activity of every run of one workflow, as observations, on one connection.",
    response: "SSE: runs, status, emit (type only), retry, gone",
    stream: true,
    adrs: ["0014", "0022"],
  },
  {
    method: "GET",
    path: "/workflows/:name/runs/:runId/events",
    band: "open",
    summary: "One live run's activity, as observations, until it settles.",
    response: "SSE: status, emit (type only), retry",
    stream: true,
    adrs: ["0014", "0022"],
  },
  {
    method: "GET",
    path: "/assets/style.css",
    band: "open",
    summary: "The Console's stylesheet.",
    response: "text/css",
    stream: false,
    adrs: ["0032"],
  },
  {
    method: "GET",
    path: "/assets/elk.js",
    band: "open",
    summary: "The Console's graph layout library (the elkjs bundle).",
    response: "text/javascript",
    stream: false,
    adrs: ["0032"],
  },
  {
    method: "GET",
    path: "/assets/:file{[\\w.-]+\\.ts}",
    band: "open",
    summary: "A Console source module, with its types erased.",
    response: "text/javascript",
    stream: false,
    adrs: ["0034"],
  },
  {
    method: "GET",
    path: "/assets/components/:file{[\\w.-]+\\.ts}",
    band: "open",
    summary: "A Console view module, with its types erased.",
    response: "text/javascript",
    stream: false,
    adrs: ["0034"],
  },
  {
    method: "GET",
    path: "/assets/vendor/:file",
    band: "open",
    summary: "Preact's browser ESM, which the Console's import map names.",
    response: "text/javascript",
    stream: false,
    adrs: ["0034"],
  },
  {
    method: "GET",
    path: "/runs",
    band: "instanceOnly",
    summary: "The live runs, with their full status.",
    response: "RunStatus[]",
    stream: false,
    adrs: ["0009", "0014"],
  },
  {
    method: "GET",
    path: "/repos",
    band: "instanceOnly",
    summary: "The Repos as the cluster reports them.",
    response: "{ dataPlane, repos: RepoStatus[] }",
    stream: false,
    adrs: ["0048", "0051"],
  },
  {
    method: "GET",
    path: "/runs/resolve",
    band: "instanceOnly",
    summary: "The run ids that start with a prefix (`?prefix=`, at least 4 characters).",
    response: "{ prefix, runIds: string[], truncated }",
    stream: false,
    adrs: ["0009"],
  },
  {
    method: "GET",
    path: "/runs/:runId",
    band: "instanceOnly",
    summary: "One run's status, live or settled, with its open Gates.",
    response: "RunStatus & { gates: GateView[] }",
    stream: false,
    adrs: ["0009", "0011"],
  },
  {
    // `authenticated` in the code, and the handler refuses a Sandbox token itself (ADR-0013): the
    // credential the route requires is the Instance token's, so this is its band.
    method: "POST",
    path: "/runs/:runId/gates/:gate/events",
    band: "instanceOnly",
    summary: "Deliver an event to an open Gate of a run.",
    body: "{ type, ...payload }, checked against the Gate's schema for that event",
    response: "{ ok: true }; 409 { error, acceptsNow } when the run does not take it now",
    stream: false,
    adrs: ["0011", "0013"],
  },
  {
    method: "GET",
    path: "/runs/:runId/events",
    band: "instanceOnly",
    summary: "One run's full activity until it settles; a settled run's final status, once.",
    response: "SSE: status, emit, retry, admission, pick, placing, placed, child-error, effect, gone",
    stream: true,
    adrs: ["0022", "0023", "0064", "0067"],
  },
  {
    method: "POST",
    path: "/runs/:runId/events",
    band: "instanceOnly",
    summary: "Cancel a run: it ends, and its Workspaces go unless `keep` is true.",
    body: '{ type: "CANCEL", keep?: boolean }',
    response: "{ ok: true }",
    stream: false,
    adrs: ["0002", "0025"],
  },
  {
    method: "GET",
    path: "/agents/:instanceId/surface",
    band: "authenticated",
    summary: "An Agent's Menu and this Turn's Allowed picks. A Sandbox token reads only its own Sandbox's.",
    response: "AgentSurfaceView",
    stream: false,
    adrs: ["0013", "0029"],
  },
  {
    method: "POST",
    path: "/agents/:instanceId/events",
    band: "authenticated",
    summary: "Deliver an Agent's pick into the state that invoked it.",
    body: "{ type, ...payload }, checked against the pick's input schema",
    response: 'AgentDeliveryReceipt; 409 { refused: "outstanding", outstanding?, allowed }',
    stream: false,
    adrs: ["0013", "0024", "0029"],
  },
  {
    method: "GET",
    path: "/agents/:instanceId/deliveries/:deliveryId",
    band: "authenticated",
    summary: "Long-poll the answer to an outstanding pick; 503 means ask again.",
    response: "AgentDeliveryReceipt",
    stream: false,
    adrs: ["0013", "0024"],
  },
  {
    method: "POST",
    path: "/sandboxes/:name/fetch",
    band: "authenticated",
    summary: "Ask the node cache to fetch one Repo that this Sandbox mounts. A Sandbox token asks only for its own.",
    body: "{ identity }",
    response: "FetchAnswer: { fetched } | { stale, asOf }",
    stream: false,
    adrs: ["0053"],
  },
];

/** A `POST /runs/:id/events` body: the down-channel event. CANCEL is all that is left of it
 * (ADR-0013): APPROVE and STEER rode the deferred/poll machinery: `deferred`
 * is retired (ADR-0006), `poll` reserved but not built.
 * `keep` leaves the cancelled run's Workspaces for inspection instead of destroying them (ADR-0025). */
type RunEventBody = { type?: string; keep?: unknown };

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

/**
 * The `jr2-dispatched-by` header a foreign `dispatch` sends (ADR-0071). `instance` is required: a
 * start that comes over the door with a key comes from another Orchestrator by construction (an
 * in-process dispatch never reaches the door). Unknown fields are dropped, as a door drops them: a
 * caller at a later Kit version may send more.
 */
const DispatchedByHeader = z.object({
  run: z.string().min(1),
  slot: z.string().min(1),
  effect: z.string().min(1),
  depth: z.number().int().positive(),
  instance: z.string().min(1),
});

/** The header's {@link DispatchedBy}, absent when no header was sent, or why it is refused. */
function dispatchedByOf(raw: string | undefined): { by?: DispatchedBy } | { error: string } {
  if (raw === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { error: `the ${DISPATCHED_BY_HEADER} header is not JSON: ${errMessage(err)} (ADR-0071)` };
  }
  const parsed = DispatchedByHeader.safeParse(json);
  if (!parsed.success) {
    return {
      error:
        `the ${DISPATCHED_BY_HEADER} header must be { run, slot, effect, depth, instance }: ` +
        `${parsed.error.issues.map((i) => `${i.path.join(".") || "(header)"}: ${i.message}`).join("; ")} (ADR-0071)`,
    };
  }
  return { by: parsed.data };
}

/** The message of a thrown error, for the `{ error }` 404 body. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The 503 body while a deferred restore is pending (ADR-0026, ADR-0069): ask again. */
function restorePendingMessage(what: string): string {
  return `the Orchestrator has not restored its runs yet (no current Assembly) — ask again for ${what}`;
}

/** Why the publish token is refused everywhere but `PUT /assembly` (ADR-0069): it is not an
 * Instance principal, so it reads no run, starts none, and speaks for no Agent. */
const PUBLISHER_ONLY = "the publish token publishes an Assembly (PUT /assembly) and does nothing else";

/** The app's context: `authenticated` resolves the bearer to a `principal` the routes read back. */
type JR2Env = { Variables: { principal: Principal } };

/** The bearer token on a request, if it carries one. */
function bearerOf(c: Context<JR2Env>): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

// ---- Console assets (`/assets/*`) -----------------------------------------------------------
// The Console: the browser page that renders a workflow's Machine and its runs. Shipped inside
// this package and read from disk — no CDN, no build step (ADR-0032: the page serves only its own
// assets). `serveStatic` is deliberately avoided: its root is cwd-relative, and this package is a
// library that must serve its own files wherever the process starts. Assets are root-owned
// (`/assets/*`, not under a page path) so no workflow name can ever shadow them. Three kinds:
//
//   .html/.css       the shipped bytes, verbatim.
//   *.ts             Console source (ADR-0034) — the flat files plus the one `components/` level
//                    the view modules live in. Browsers don't type-strip, so the server does what
//                    Node does for itself: types replaced by whitespace (`ts-blank-space`), erased
//                    once per (file, mtime) and cached. Erasure, not compilation — positions are
//                    preserved, so stack traces point at the real line with no sourcemaps.
//   /assets/vendor/* Preact's browser ESM, resolved through THIS package's dep edge like the elkjs
//                    bundle. The page's import map binds the bare specifiers to these URLs.

const CONSOLE_DIR = new URL("../console/", import.meta.url);

/** The vendored elkjs bundle, resolved through THIS package's dep edge (pnpm-safe), read once. */
let elkBundle: Promise<Buffer> | undefined;
function readElkBundle(): Promise<Buffer> {
  // elkjs ships no `exports` map today, so the subpath resolves; if a future version adds one,
  // switch to resolving "elkjs/package.json" and joining "lib/elk.bundled.js".
  elkBundle ??= readFile(createRequire(import.meta.url).resolve("elkjs/lib/elk.bundled.js"));
  return elkBundle;
}

/**
 * Preact's browser ESM at `/assets/vendor/*` (ADR-0034): the served name → the file under the
 * `preact` package. Resolved via "preact/package.json" — preact HAS an `exports` map (unlike
 * elkjs), so its dist subpaths don't resolve directly. `hooks.module.js` imports the bare
 * specifier `"preact"`; the page's import map covers vendored modules too, so that import lands
 * back on `/assets/vendor/preact.module.js` and the files can sit flat.
 */
const VENDOR_FILES: Record<string, string> = {
  "preact.module.js": "dist/preact.module.js",
  "hooks.module.js": "hooks/dist/hooks.module.js",
};

/** Vendor files, read once each — package contents only change with the package. */
const vendorCache = new Map<string, Promise<Buffer>>();
function readVendor(name: string): Promise<Buffer> | undefined {
  const rel = VENDOR_FILES[name];
  if (!rel) return undefined;
  let body = vendorCache.get(name);
  if (!body) {
    const pkg = createRequire(import.meta.url).resolve("preact/package.json");
    body = readFile(new URL(rel, pathToFileURL(pkg)));
    vendorCache.set(name, body);
  }
  return body;
}

/** Serve one file of the Console with its content type. */
async function consoleAsset(rel: string, contentType: string): Promise<Response> {
  const body = await readFile(new URL(rel, CONSOLE_DIR));
  return new Response(new Uint8Array(body), { headers: { "content-type": contentType } });
}

/** Erased Console source, cached per file: an edit moves the mtime, which drops the entry. */
const erasedCache = new Map<string, { mtimeMs: number; js: string }>();

/**
 * Serve one Console `.ts` file with its types erased (ADR-0034). The failure class is gated where
 * it belongs — what `ts-blank-space` cannot erase (an enum, a namespace), `tsc --noEmit` already
 * rejected in CI — so the 500 here is a should-never bar, not a compiler diagnostic surface.
 */
async function consoleTsAsset(file: string): Promise<Response> {
  const url = new URL(file, CONSOLE_DIR);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(url)).mtimeMs;
  } catch {
    return Response.json({ error: `no console asset "${file}"` }, { status: 404 });
  }
  let hit = erasedCache.get(file);
  if (!hit || hit.mtimeMs !== mtimeMs) {
    const source = await readFile(url, "utf8");
    const unerasable: string[] = [];
    // The node's own text, sliced by position — `getText()` needs a parent chain the parse here
    // does not build.
    const js = tsBlankSpace(source, (node) => unerasable.push(source.slice(node.pos, node.end).trim()));
    if (unerasable.length) {
      return new Response(`cannot erase types from ${file}: ${unerasable.join(", ")}`, { status: 500 });
    }
    hit = { mtimeMs, js };
    erasedCache.set(file, hit);
  }
  return new Response(hit.js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

// Content negotiation for the two page addresses (ADR-0032). JSON is the DEFAULT dialect: only a
// request whose `Accept` prefers `text/html` — a browser's navigation — gets the Console shell.
// No header, a bare wildcard, `application/json`, `text/event-stream` all fall through to JSON,
// so the CLI, the Harness and EventSource never see HTML they did not ask for.
function prefersHtml(c: Context): boolean {
  return (
    accepts(c, { header: "Accept", supports: ["application/json", "text/html"], default: "application/json" }) ===
    "text/html"
  );
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
 * is the `error: terminated` an attached `jr2 run` hit). The frame is an SSE COMMENT (`:\n\n`):
 * every client ignores it, so it needs no place in the wire vocabulary.
 *
 * It is deliberately a **ping**, not a heartbeat or keepalive — GLOSSARY.md puts both on the Lease's
 * Avoid list, and this asserts nothing and expects no answer.
 *
 * It is NOT a liveness probe, and must not be mistaken for one: `stream.write` swallows its own
 * errors (hono's `StreamingApi`), so a failed write is indistinguishable from a good one. A peer
 * that goes away is detected by `stream.onAbort`, which is what every handler here wires to its
 * exit. The tick checks `aborted`/`closed` only so a ping that fires between the abort and the
 * teardown does not write into a dead stream.
 *
 * The tick is also where a subscriber is judged (ADR-0022): a reader {@link Subscriber.behind} is
 * closed here, and the ping itself goes out through the subscriber, so a reader stalled on a quiet
 * feed falls behind too. Returns its own clear fn.
 */
function pinger(stream: SseStream, sub: Subscriber, done: () => void, everyMs = PING_MS): () => void {
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) return done();
    if (sub.behind()) {
      // Aborted, not drained: the frames it would never read are dropped with it.
      stream.abort();
      return done();
    }
    void sub.send(":\n\n");
  }, everyMs);
  return () => clearInterval(timer);
}

/** The slice of hono's `StreamingApi` the feeds need: the raw write (a frame is rendered here, and
 *  `writeSSE` cannot express a comment frame), the two flags that say the peer is gone, and the
 *  abort that closes a reader that fell behind. */
type SseStream = { write: (s: string) => Promise<unknown>; aborted: boolean; closed: boolean; abort: () => void };

/**
 * How many writes one subscriber may leave unread across a whole ping interval before it is closed
 * (ADR-0022). A reader this far behind is not catching up, and holding frames for it is a per-client
 * queue the server does not keep: the feeds are level-triggered, so closing it loses no state — the
 * reader reconnects (EventSource on its own retry, the CLI on the stream's end) and the opening
 * frame is the whole current truth.
 */
const BACKLOG_FRAMES = 64;

/**
 * One SSE frame, spelled as hono's `writeSSE` spells it. JSON has no raw newline, so the payload is
 * always one `data:` line.
 */
function sseFrame(event: string, data: unknown, retry?: number): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n${retry ? `retry: ${retry}\n` : ""}\n`;
}

/**
 * A run that left the live set WITHOUT settling — stopped, so parked for the next boot's restore
 * (ADR-0025) — reads through as `active`, which is the truth about the Machine and says nothing
 * about the feed. `gone` is a fact, not an inference (ADR-0022): stated here, so a reader that
 * re-attaches whenever a feed ends before a terminal status (the CLI) knows this end is the run's
 * own and does not re-attach in a loop.
 */
async function sayGoneIfParked(
  stream: { writeSSE: (m: { event: string; data: string }) => Promise<unknown> },
  status: RunStatus,
): Promise<void> {
  if (status.status !== "active") return;
  await stream.writeSSE({ event: "gone", data: JSON.stringify({ runId: status.runId }) });
}

/**
 * Render each feed event ONCE, however many subscribers share it (ADR-0022). The host hands every
 * listener of a feed the same event object, so the object is the key, and the frame is released
 * with it. `undefined` is a rendering too — "this band does not carry it" — and is cached alike.
 */
function renderOnce<E extends object, F>(render: (event: E) => F): (event: E) => F {
  const frames = new WeakMap<E, F>();
  return (event) => {
    if (frames.has(event)) return frames.get(event) as F;
    const frame = render(event);
    frames.set(event, frame);
    return frame;
  };
}

/** One subscriber's writes, and the one question asked of them at each ping. */
type Subscriber = {
  /** Write a shared frame as-is. */
  send: (frame: string) => Promise<void>;
  /** Whether {@link BACKLOG_FRAMES} writes sent before the previous ping are still unread. */
  behind: () => boolean;
};

/**
 * One subscriber (ADR-0022): the only state kept per client is a count of its writes. A reader is
 * judged on LAG, never on burst size — one transition's Emits, or a Pool's statuses, reach every
 * subscriber in one tick, and a reader that keeps up drains them long before the next ping. What is
 * still unread a whole interval after it was sent is a reader that fell behind.
 */
function subscriber(stream: SseStream): Subscriber {
  let sent = 0;
  let read = 0;
  let sentByLastPing = 0;
  return {
    async send(frame) {
      sent++;
      try {
        await stream.write(frame);
      } finally {
        read++; // a stream's writes settle in order, so this counts a prefix
      }
    },
    behind() {
      const unread = sentByLastPing - read;
      sentByLastPing = sent;
      return unread >= BACKLOG_FRAMES;
    },
  };
}

export type CreateAppOptions = {
  /** Ping interval for the SSE feeds. Tests shorten it; nothing in production sets it. */
  pingMs?: number;
  /**
   * Whether this instance has a data plane at all (ADR-0051, ADR-0069): the process is deployed in
   * a cluster, so it wires its kube client whatever the current Assembly composes. `false` is an
   * answer — "this instance runs no Workspace" — and `jr2 status` says so rather than listing
   * nothing.
   */
  dataPlane?: boolean;
  /**
   * The publish door and the current Assembly (ADR-0069). Absent for the in-process tests that
   * build an app straight over a host: `GET /assembly` then answers no current Assembly, and
   * `PUT /assembly` answers 404.
   */
  assembly?: AssemblyDoor;
  /**
   * The digests of the ConfigMaps this process reads through a mount (ADR-0069), as
   * `readMountDigests` reads them. `GET /assembly` reports them, so `jr2 up` can wait for the
   * kubelet before it publishes. Absent when not deployed: nothing is mounted.
   */
  mounts?: () => Promise<Record<string, string>>;
  /**
   * The Repo resources as the cluster currently reports them (ADR-0051), read per request off the
   * port — a cache the agent cloned minutes after boot reads as present the next time anyone asks.
   * Absent for an instance without a data plane and for the in-process tests that build an app
   * straight over a host: both answer no Repos.
   */
  repos?: () => Promise<RepoStatus[]>;
  /**
   * The ask a pod makes when something inside it fetches (ADR-0053), off the port the caller
   * built: mark the Sandbox CR for one Repo key, wait for the landing on its status, answer.
   * Absent for an instance without a data plane and for the in-process tests: no Sandbox, so no
   * ask, and the route says so rather than waiting on a cluster that is not there.
   */
  fetchRepo?: (sandbox: string, identity: string) => Promise<FetchAnswer>;
  /** How long one poll of an outstanding pick waits for its answer before it answers `outstanding`
   * (ADR-0013, ADR-0024). Default 25 s: every request stays far below undici's 300 s and the
   * Custodian's idle limit. Tests shorten it. */
  deliveryWaitMs?: number;
  /**
   * The named Charts of the Instance (ADR-0070): what `PUT`/`DELETE /workflows/:wrapper/charts/:name`
   * change, what `GET /workflows/:wrapper/chart-schema` narrows the grammar from, and the
   * unrunnable ones `GET /workflows` adds to the host's listing. Absent for the in-process tests
   * that build an app straight over a host: those routes then answer 404.
   */
  charts?: NamedCharts;
};

/**
 * Build the orchestrator HTTP app over a `RunHost` (ADR-0009/0013 route table).
 *
 * `auth` is how a bearer token becomes a principal. Omitting it leaves the surface OPEN, which is
 * only ever right for an in-process test that reaches `app.request` directly — `startInstance`
 * (every real boot, deployed or fixture) always supplies one.
 */
export function createApp(host: RunHost, auth?: Authenticator, opts: CreateAppOptions = {}): Hono<JR2Env> {
  const pingMs = opts.pingMs ?? PING_MS;
  const app = new Hono<JR2Env>();

  /** Authenticate, or refuse. There is no anonymous principal (ADR-0013) — an open surface would
   * hand every Agent in the cluster a delivery API, which is the hole this ADR exists to close. */
  const authenticated: MiddlewareHandler<JR2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = auth(bearerOf(c));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "publisher") return c.json({ error: PUBLISHER_ONLY }, 403);
    c.set("principal", principal);
    return next();
  };
  /** The principal `authenticated` resolved. An unconfigured `auth` means full trust. */
  const principalOf = (c: Context<JR2Env>): Principal => c.get("principal") ?? { kind: "instance" };

  /**
   * Authenticate, AND require the INSTANCE token (ADR-0014). A Sandbox token is a token we minted,
   * so `authenticated` alone lets it through — which on the run surface is too much: it would let a
   * Custodian's credential read every run's context (other features' branches, tickets, verdicts) and
   * CANCEL any run. Neither is on the Agent's surface. Its scope is delivering to agent
   * registrations recorded against its OWN Sandbox (ADR-0013), and the gate route already says so in
   * the other direction.
   */
  const instanceOnly: MiddlewareHandler<JR2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = auth(bearerOf(c));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "publisher") return c.json({ error: PUBLISHER_ONLY }, 403);
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
  // `hash` is the current Assembly's (ADR-0069), absent while the process holds none.
  app.get("/healthz", (c) => c.json({ ok: true, version: KIT_VERSION, hash: opts.assembly?.current()?.hash }));
  app.get("/readyz", (c) => c.json({ ready: true }));

  // Structure, not state: the workflow listing, a template's Machine, and the Console shell are
  // unauthenticated. They expose no run, drive nothing, and the Console is a BROWSER page — it
  // loads before any token is entered (ADR-0032). Everything that reads or moves a run is guarded
  // below.
  // Each Workflow with its origin, and each Chart wrapper's Charts inside its entry (ADR-0070); a
  // named Chart that cannot run now is listed with why.
  app.get("/workflows", (c) => {
    const listing = host.workflowList();
    return c.json(opts.charts ? opts.charts.listing(listing) : listing);
  });

  // The current Assembly and the ones live runs hold (ADR-0069). Open like `/workflows`: a hash
  // and a Kit version are identity, the class of thing `/healthz` already serves.
  // `mounts` is what this process reads from its mounted ConfigMaps, so a publish can wait until
  // the kubelet has delivered the data the converge wrote.
  app.get("/assembly", async (c) => {
    const view = opts.assembly ? await opts.assembly.view() : { kitVersion: KIT_VERSION, current: null, held: [] };
    return c.json(opts.mounts ? { ...view, mounts: await opts.mounts() } : view);
  });

  // The publish door (ADR-0069): the publish token ALONE. Publishing imports code into the process
  // that holds the ServiceAccount, so the Instance token, which starts runs and answers Gates, is
  // refused here by name. The checks after authentication are the door's (assembly.ts), each with
  // its own status, and the old Assembly stays current through every refusal.
  app.put("/assembly", async (c) => {
    if (auth) {
      const principal = auth(bearerOf(c));
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      if (principal.kind !== "publisher") {
        return c.json(
          {
            error:
              "publishing an Assembly needs the publish token (JR2_PUBLISH_TOKEN in the instance Secret), which " +
              "`jr2 up` reads through the kube API — the Instance token does not publish (ADR-0069)",
          },
          403,
        );
      }
    }
    if (!opts.assembly) return c.json({ error: "this instance has no publish door" }, 404);
    const answer = await opts.assembly.publish({
      kitVersion: c.req.header("jr2-kit-version"),
      hash: c.req.header("jr2-assembly-hash"),
      body: c.req.raw.body,
    });
    return c.json(answer.body, answer.status);
  });

  // ---- Named Charts (ADR-0070) ----------------------------------------------------------------
  // Before every `/workflows/:name/*` route. A Chart is data and cannot reach the process, so a
  // runtime Chart is kept behind the Instance token, not the publish token; the door that admits it
  // is the one a run's Chart passes. A Chart file is the Assembly's own: no route changes one.

  /** A `NamedChartError` as its answer. */
  const chartError = (c: Context<JR2Env>, err: unknown): Response => {
    if (err instanceof NamedChartError) return c.json(err.body, err.status);
    throw err;
  };
  const noCharts = (c: Context<JR2Env>) => c.json({ error: "this instance keeps no named Charts" }, 404);

  // The grammar narrowed to the wrapper's Open body: its lent names, guard, action and delay names,
  // allowed models and Workspace accesses as `enum`s. Structure, like the Machine doc: open band.
  app.get("/workflows/:wrapper/chart-schema", (c) => {
    const wrapper = c.req.param("wrapper");
    const schema = opts.charts?.schema(wrapper);
    return schema ? c.json(schema) : c.json({ error: `no Chart wrapper "${wrapper}"` }, 404);
  });

  // The body is the Chart text alone. 201 when new, 200 when it replaced one: a live run of the
  // old text holds its own.
  app.put("/workflows/:wrapper/charts/:name", instanceOnly, async (c) => {
    if (!opts.charts) return noCharts(c);
    let text: unknown;
    try {
      text = JSON.parse(await c.req.text());
    } catch (err) {
      return c.json({ error: "refused", report: [`(chart): the body is not JSON: ${errMessage(err)}`] }, 422);
    }
    try {
      const put = await opts.charts.put(c.req.param("wrapper"), c.req.param("name"), text);
      // `unrunnable`: a publish bound a wrapper that refuses the text while it was written. It is
      // kept on the volume and listed with that reason, as each publish's re-admission does.
      return c.json(
        {
          name: put.name,
          origin: "runtime",
          hash: put.hash,
          ...(put.unrunnable !== undefined ? { unrunnable: put.unrunnable } : {}),
        },
        put.created ? 201 : 200,
      );
    } catch (err) {
      return chartError(c, err);
    }
  });

  app.delete("/workflows/:wrapper/charts/:name", instanceOnly, async (c) => {
    if (!opts.charts) return noCharts(c);
    try {
      await opts.charts.remove(c.req.param("wrapper"), c.req.param("name"));
      return c.body(null, 204);
    } catch (err) {
      return chartError(c, err);
    }
  });

  /**
   * Start a run of a Workflow (ADR-0009). A named Chart that cannot run now is 409 with why
   * (ADR-0070); a Chart in the input that the door refuses is 422 with the report; input failing
   * the door schema is 400 (ADR-0033); an unknown Workflow is 404.
   *
   * A foreign `dispatch` sends `jr2-dispatched-by` (ADR-0071): its key makes a repeated start one
   * run, answered `200 { runId, instanceId, existing: true }` where a new one is `201`. The key is
   * asked first, so a re-send answers its run even when the name would be refused now; a key a
   * run of another Workflow carries is 409. A header that does not parse is 400. `jr2 run` and the
   * Console send none. Any throw that is not a refusal is a defect, 500: a foreign caller reads a
   * 404 as "nothing was started", and a defect may come after a start.
   */
  const startRun = async (c: Context<JR2Env>, name: string): Promise<Response> => {
    const header = dispatchedByOf(c.req.header(DISPATCHED_BY_HEADER));
    if ("error" in header) return c.json({ error: header.error }, 400);
    const { by } = header;
    if (by) {
      const found = await host.dispatched(by.effect);
      if (found && found.workflow !== name) return c.json({ error: keyConflict(found, name, by.effect) }, 409);
      if (found) return c.json({ ...keyAnswer(found, name, by.effect), existing: true }, 200);
    }
    const unrunnable = opts.charts?.get(name)?.unrunnable;
    if (unrunnable !== undefined) return c.json({ error: `named Chart "${name}" cannot run: ${unrunnable}` }, 409);
    const input = await readJson(c.req.text());
    try {
      const { runId, instanceId, existing } = await host.start(name, input, by ? { dispatchedBy: by } : {});
      return existing ? c.json({ runId, instanceId, existing }, 200) : c.json({ runId, instanceId }, 201);
    } catch (err) {
      if (err instanceof ChartRefusal) return c.json({ error: "refused", report: err.report }, 422);
      if (err instanceof EventValidationError) return c.json({ error: errMessage(err) }, 400);
      if (err instanceof DispatchKeyConflictError) return c.json({ error: errMessage(err) }, 409);
      if (err instanceof UnknownWorkflowError) return c.json({ error: errMessage(err) }, 404);
      return c.json({ error: errMessage(err) }, 500);
    }
  };

  // The documented start of a named Chart; `POST /workflows/<wrapper>%2F<name>/runs` is the same.
  app.post("/workflows/:wrapper/charts/:name/runs", instanceOnly, (c) =>
    startRun(c, chartName(c.req.param("wrapper"), c.req.param("name"))),
  );

  // The run's bound Machine (ADR-0070): the wrapper's doc with each bound body's Chart compiled in,
  // so the Console draws the states a Chart run moves through. Structure: open band, and only
  // through the Workflow the run is of, as the per-run feed is: an observer names the Workflow
  // it already knows. A settled run's doc is served too, so the Console draws where it ended.
  app.get("/workflows/:name/runs/:runId/machine", async (c) => {
    const runId = c.req.param("runId");
    const doc = await host.runMachine(runId);
    return doc && doc.workflow === c.req.param("name")
      ? c.json(doc)
      : c.json({ error: `no run "${runId}" of workflow "${c.req.param("name")}"` }, 404);
  });

  /** A named Chart that is listed but cannot run now (ADR-0070): 409 with why, as its start is,
   * never a 404 for a name `GET /workflows` lists. */
  const unrunnableChart = (c: Context<JR2Env>, name: string): Response | undefined => {
    const named = opts.charts?.get(name);
    if (named?.unrunnable === undefined) return undefined;
    return c.json(
      {
        error: `named Chart "${name}" cannot run: ${named.unrunnable}`,
        unrunnable: named.unrunnable,
        chart: { origin: named.origin, hash: named.hash },
      },
      409,
    );
  };

  // The two PAGE addresses (ADR-0032): `/` and `/workflows/:name` negotiate. A browser navigation
  // (`Accept` prefers text/html) gets the one Console shell — the path carries the selection, the
  // shell is the same bytes for any of them. Every other caller gets JSON, the default dialect.
  //
  // JSON `/` is a 404: nothing lived there before the Console, and inventing an index now would be
  // surface no client asked for. JSON `/workflows/:name` is the workflow DETAIL: identity plus the
  // machine's declared input as JSON Schema (`null` when it declares none — ADR-0033). Open band:
  // a schema is structure, exactly like the Machine document below.
  app.get("/", (c) => {
    if (prefersHtml(c)) return consoleAsset("page.html", "text/html; charset=utf-8");
    return c.json({ error: "no JSON resource at / — the Console is the HTML dialect" }, 404);
  });
  app.get("/workflows/:name", (c) => {
    // The shell for ANY name — an unknown workflow surfaces in-page via its 404'd /machine fetch.
    if (prefersHtml(c)) return consoleAsset("page.html", "text/html; charset=utf-8");
    const name = c.req.param("name");
    const doc = host.machine(name);
    if (!doc) return unrunnableChart(c, name) ?? c.json({ error: `no workflow "${name}"` }, 404);
    // A named Chart answers its door minus the Chart fields, and its origin and hash; a Chart
    // wrapper answers its Open bodies' declarations, for a client that writes Charts (ADR-0070).
    const split = splitChartName(name);
    const named = split && (opts.charts?.get(name) ?? host.namedChart(split.wrapper, split.name));
    const wrapper = split ? undefined : opts.charts?.wrapperOf(name);
    return c.json({
      name,
      machineId: doc.id,
      input: host.inputSchema(name) ?? null,
      ...(named ? { chart: { origin: named.origin, hash: named.hash } } : {}),
      ...(wrapper ? { openBodies: wrapper.bodies.map((b) => ({ slot: b.slot, ...b.declaration })) } : {}),
    });
  });

  // Push work: start a run of a registered workflow. Unknown workflow → UnknownWorkflowError → 404.
  // A body failing the machine's declared input schema (ADR-0033) → 400 naming the accepted
  // shape — the same error class, and the same wire mapping, as a gate delivery failing its
  // schema (`POST /runs/:id/gates/:gate/events` below). Instance-band (ADR-0058): starting work is
  // run control, and a Sandbox token's scope is its own agent surface — the Custodian's route
  // allowlist not forwarding this route is a second layer, not the control (ADR-0059).
  // A Chart wrapper's one-shot door (ADR-0070): a Chart field in the body is admitted before the
  // run starts, and a refusal is 422 with the report. A named Chart rides the path encoded.
  app.post("/workflows/:name/runs", instanceOnly, (c) => startRun(c, c.req.param("name")));

  // The registered template Machine's structure — what the Console's diagram renders (structure
  // is provider-independent, so the un-`provide()`d template is exactly right).
  app.get("/workflows/:name/machine", (c) => {
    const name = c.req.param("name");
    const doc = host.machine(name);
    return doc ? c.json(doc) : (unrunnableChart(c, name) ?? c.json({ error: `no workflow "${name}"` }, 404));
  });

  // ---- Observation (`GET /workflows/:name/runs*`) ---------------------------------------------
  // What the tokenless Console needs, and the most it may have. The page is a BROWSER: it holds no
  // token until one is ENTERED (ADR-0032), and baking one in would mean giving the INSTANCE token
  // — gates, run control, every run's context — to whatever can load a URL (and the orchestrator
  // binds 0.0.0.0 — pods must reach it — so that URL is not only yours). So the page gets a
  // projection instead of a credential: `observe()` keeps identity + the state VALUE and drops
  // context, and the guarded `/runs*` routes above stay exactly as guarded as they were. A
  // projection, not a bypass.
  //
  // Scoped to one workflow because that is what an observer already knows (it is in the page's
  // path): no listing of everything this orchestrator is running.

  app.get("/workflows/:name/runs", (c) => c.json(host.observations(c.req.param("name"))));

  // The workflow feed, rendered once per event for every page attached to it (ADR-0022): the
  // `observe()` projection and its JSON happen once, not once per open page.
  const workflowFrame = renderOnce((ev: Exclude<WorkflowFeedEvent, { kind: "closed" }>) => {
    if (ev.kind === "gone") return sseFrame("gone", { runId: ev.runId });
    // The TYPE alone: an emit's payload is author data, the same class of thing as context.
    if (ev.kind === "emit") return sseFrame("emit", { runId: ev.runId, type: ev.event.type });
    // `{ child, attempt }` only — `reason` is mechanism/error text, which stays behind the
    // Instance token like `fault` (ADR-0014/0016).
    if (ev.kind === "retry") return sseFrame("retry", { runId: ev.runId, child: ev.child, attempt: ev.attempt });
    return sseFrame("status", observe(ev.status));
  });

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
        const sub = subscriber(stream);
        // Subscribe and snapshot in one call, then write the snapshot in the same tick: nothing can
        // start, move or finish in between, so the client's first frame is a complete picture.
        const { runs, unsubscribe } = host.observeWorkflow(name, (ev) => {
          if (ev.kind === "closed") return exit.done();
          void sub.send(workflowFrame(ev));
        });
        exit.onExit(unsubscribe);
        // `retry` steers the browser's own EventSource backoff. This feed never ends on its own, so
        // every close is a fault worth reconnecting from — the client does not decide that. The
        // snapshot is this subscriber's own, so it is the one frame rendered per client.
        void sub.send(sseFrame("runs", runs.map(observe), 2000));
        exit.onExit(pinger(stream, sub, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  // The per-run feed in the OPEN band, rendered once per event for all its subscribers (ADR-0022).
  // `undefined` = this band does not carry it.
  const openRunFrame = renderOnce((ev: Exclude<RunFeedEvent, { kind: "closed" }>) => {
    // The TYPE alone: an emit's payload is author data, the same class of thing as context.
    if (ev.kind === "emit") return sseFrame("emit", { type: ev.event.type });
    // `{ child, attempt }` only — `reason` is mechanism/error text, which stays behind the
    // Instance token like `fault` (ADR-0014/0016).
    if (ev.kind === "retry") return sseFrame("retry", { child: ev.child, attempt: ev.attempt });
    // Turn markers (ADR-0023) carry an Agent's framing and pick payload — Instance-token class, so
    // the OPEN band never sees them (not even their types).
    if (ev.kind === "admission" || ev.kind === "pick") return undefined;
    // A wait for capacity's lines carry the scheduler's words (ADR-0064): behind the token. The
    // open band sees `placing` lit in the status's children, and nothing more.
    if (ev.kind === "placing" || ev.kind === "placed") return undefined;
    // A child's error below an Agent's state (ADR-0024) is mechanism text, like `fault`: behind the
    // token.
    if (ev.kind === "child-error") return undefined;
    // An Effect's lines (ADR-0067) carry argv and output — working data: behind the token.
    if (ev.kind === "effect") return undefined;
    return sseFrame("status", observe(ev.status));
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
        const sub = subscriber(stream);
        exit.onExit(
          host.subscribe(runId, (ev) => {
            // The host is shutting down under a feed that has no end of its own.
            if (ev.kind === "closed") return exit.done();
            const frame = openRunFrame(ev);
            if (frame === undefined) return;
            // Terminal frame must flush before the handler returns and closes the stream (see the
            // guarded feed below for why the exit is chained off the write).
            const terminal = ev.kind === "status" && ev.status.status !== "active";
            void sub.send(frame).then(() => {
              if (terminal) exit.done();
            });
          }),
        );
        // Race guard: settled between the liveness check and the subscribe, which then attached to
        // nothing. No read-through on this route, so there is nothing to fall back to — just close.
        if (host.status(runId) === undefined) return exit.done();
        exit.onExit(pinger(stream, sub, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  // The Console's assets, root-owned (`/assets/*`): they share no prefix with a page address, so
  // no workflow name can capture them — the guard the old `/viz/assets` ordering provided, now by
  // construction. The shell itself is served by the negotiated page addresses above.
  app.get("/assets/style.css", () => consoleAsset("style.css", "text/css; charset=utf-8"));
  app.get("/assets/elk.js", async () => {
    const body = await readElkBundle();
    return new Response(new Uint8Array(body), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });

  // Console SOURCE (ADR-0034): any `.ts` under console/ is served with its types erased — the
  // flat files (main.ts, store.ts, canvas.ts) and the `components/` level the view modules live
  // in. Each param pattern admits one flat path segment of name characters — no separators, so no
  // traversal, and nothing outside console/ is reachable by construction.
  app.get("/assets/:file{[\\w.-]+\\.ts}", (c) => consoleTsAsset(c.req.param("file")));
  app.get("/assets/components/:file{[\\w.-]+\\.ts}", (c) => consoleTsAsset(`components/${c.req.param("file")}`));

  // Preact's browser ESM (ADR-0034), off this package's own dep edge — the elkjs precedent.
  app.get("/assets/vendor/:file", async (c) => {
    const file = c.req.param("file");
    const body = await readVendor(file);
    if (!body) return c.json({ error: `no vendor asset "${file}"` }, 404);
    return new Response(new Uint8Array(await body), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });

  app.get("/runs", instanceOnly, (c) => c.json(host.list()));

  // The Repos as the cluster currently reports them (ADR-0048/0051) — what `jr2 status` renders,
  // and the place ADR-0047's "register the key, the cache agent retries" points at. Instance band,
  // like every other state route: a row names a Repo and carries git's own error text, which is
  // exactly the class of thing the open observation projections strip (ADR-0014). An instance
  // without a data plane answers `{ dataPlane: false, repos: [] }` rather than 404 — "this
  // instance runs no Workspace" is an answer, and it is the same answer next boot.
  app.get("/repos", instanceOnly, async (c) =>
    c.json({ dataPlane: opts.dataPlane ?? false, repos: (await opts.repos?.()) ?? [] }),
  );

  // Abbreviated run ids (ADR-0009). Registered before `/runs/:runId` so "resolve" is never captured
  // as a run id. The prefix rides in the query string
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
  // (`jr2 send` menus, UI inbox cards, webhook translators matching on meta). Settled run → [].
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
      // The run would not take it from this Gate now (ADR-0013): never `{ ok: true }`. The body
      // names what the Gate takes now, as `GET /runs/:id` lists it.
      if (err instanceof NotTakenError) {
        const runId = c.req.param("runId");
        const gate = c.req.param("gate");
        const acceptsNow = host.gates(runId).find((g) => g.gate === gate)?.acceptsNow ?? [];
        return c.json({ error: errMessage(err), acceptsNow }, 409);
      }
      throw err;
    }
  });

  // The per-run feed in the Instance band, rendered once per event for all its subscribers
  // (ADR-0022).
  const runFrame = renderOnce((ev: Exclude<RunFeedEvent, { kind: "closed" }>) => {
    if (ev.kind === "emit") return sseFrame("emit", ev.event);
    // The Instance's own feed: the full telemetry, reason included (same trust class as `fault`).
    if (ev.kind === "retry") return sseFrame("retry", ev);
    // Turn markers (ADR-0023) — Instance-token band, so the framing/payload ride whole. These stay
    // OFF the open workflow feed entirely (run-host.ts feeds them per-run).
    if (ev.kind === "admission" || ev.kind === "pick") return sseFrame(ev.kind, ev);
    // A wait for capacity starting and ending (ADR-0064) — Instance-token band too: the message is
    // the scheduler's or the quota's own words.
    if (ev.kind === "placing" || ev.kind === "placed") return sseFrame(ev.kind, ev);
    // A child's error below an Agent's state, which the Agent's answer does not carry (ADR-0024):
    // the operator reads it here, with its message.
    if (ev.kind === "child-error") return sseFrame(ev.kind, ev);
    // An Effect's lines (ADR-0067): its start, its stream, its output, an abort — Instance-token band.
    if (ev.kind === "effect") return sseFrame("effect", ev);
    return sseFrame("status", ev.status);
  });

  // SSE: a live run streams its status deltas + author `emit`s (current status replayed on attach,
  // then live until the terminal transition or client abort). A run that has already settled streams
  // its final status once and closes (so `jr2 logs -f` works on a finished run). Unknown run → 404.
  app.get("/runs/:runId/events", instanceOnly, async (c) => {
    const runId = c.req.param("runId");
    if (host.status(runId) === undefined) {
      const finalStatus = await host.read(runId);
      if (!finalStatus) return c.json({ error: `no run "${runId}"` }, 404);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "status", data: JSON.stringify(finalStatus) });
        await sayGoneIfParked(stream, finalStatus);
      });
    }
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const exit = closer(resolve);
        const sub = subscriber(stream);
        exit.onExit(
          host.subscribe(runId, (ev) => {
            if (ev.kind === "closed") return exit.done();
            // Exiting lets the handler return, which CLOSES the stream — so on the terminal frame we
            // must wait for the write to flush first, or a fire-and-forget write races the close and the
            // final status is dropped (the very frame `jr2 run` blocks on). Chain the exit off the write.
            const terminal = ev.kind === "status" && ev.status.status !== "active";
            void sub.send(runFrame(ev)).then(() => {
              if (terminal) exit.done();
            });
          }),
        );
        // Race guard: the run may have settled between the liveness check above and this subscribe,
        // which then attaches to nothing and never fires. Fall back to the terminal read-through.
        if (host.status(runId) === undefined) {
          exit.release();
          void host.read(runId).then(async (s) => {
            if (s) {
              await stream.writeSSE({ event: "status", data: JSON.stringify(s) });
              await sayGoneIfParked(stream, s);
            }
            exit.done();
          });
          return;
        }
        exit.onExit(pinger(stream, sub, exit.done, pingMs));
        stream.onAbort(exit.done);
      });
    });
  });

  // Run control (ADR-0002). CANCEL is the only event left on this seam: APPROVE and STEER answered
  // held calls and drained `poll` inboxes; a held call is now every pick answered at Rest (ADR-0024),
  // and `poll` stays reserved (ADR-0013). Workflow-defined events reach a run through its GATES.
  //
  // It ENDS the run (ADR-0025): the Agents' turns end with it, the run does not come back on the
  // next restore, and its Workspaces are destroyed unless the body says `keep: true`. `RunHost.stop()` — park it, keep it restorable — is a different verb, and
  // deliberately not on the wire.
  app.post("/runs/:runId/events", instanceOnly, async (c) => {
    const runId = c.req.param("runId");
    const body = (await readJson(c.req.text())) as RunEventBody;
    if (body.type !== "CANCEL") {
      return c.json({ error: `unknown event type "${body.type ?? ""}" (accepts: CANCEL)` }, 400);
    }
    // Whether to keep is a fact of the moment of the cancel, never a config key (ADR-0025).
    if (body.keep !== undefined && typeof body.keep !== "boolean") {
      return c.json({ error: `"keep" must be a boolean` }, 400);
    }
    try {
      await host.cancel(runId, { keep: body.keep === true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 404);
    }
  });

  // ---- The Agent's surface (`/agents/:iid/*` — ADR-0013) --------------------------------------
  // Served to ONE caller: the Agent's Harness, through the Custodian in its pod. The Harness renders
  // `surface` as the Menu and turns a pick into an `events` POST. The Orchestrator therefore keeps
  // no MCP dependency, no transport, no session handling — and the Agent keeps no route to this
  // API except through a container whose credential it cannot read. Everything a pick is judged by
  // is judged HERE: the token's scope, the live registration, the event's name and payload — the
  // Custodian forwards and never decides (ADR-0059).
  //
  // Both routes are adapters over the SAME registration table the gates ride: lookup, validation
  // and delivery are implemented once, in `registration.ts`.

  /** Guard: the surface must exist, and this principal must be allowed to speak for it. */
  const agentRegistration = (c: Context<JR2Env, "/agents/:instanceId/surface" | "/agents/:instanceId/events">) => {
    const instanceId = c.req.param("instanceId");
    // Only a Turn that is over answers 404 (ADR-0026). While the host is stopping its runs are
    // parked for restore, not over, so every `/agents/*` call answers 503: the Harness re-asks a
    // surface read on ADR-0042's ladder and tells a pick to try again. BEFORE the lookup, because
    // a stopping host may already have lost the registration the question is about.
    if (host.stopping) {
      return {
        error: c.json({ error: `the Orchestrator is stopping — ask again for instance "${instanceId}"` }, 503),
      };
    }
    const surface = host.agentSurface(instanceId);
    // A boot with no current Assembly listens before it restores (ADR-0069): until the first
    // publish restores the waiting runs, a registration this host does not have may be one of
    // theirs, and that Turn is not over either. AFTER the lookup, so a run that is hosted already
    // (re-attached, or started under the published Assembly) is served.
    if (!surface && host.restorePending) {
      return { error: c.json({ error: restorePendingMessage(`instance "${instanceId}"`) }, 503) };
    }
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

  // The Agent's Menu — every pick it can be offered in this Machine, with input schemas and
  // semantics, fixed for the conversation — and this Turn's Allowed picks (ADR-0029). A transition
  // swaps the registration, which swaps the Allowed picks, never the Menu; the Harness reads both
  // per Submission and needs no `list_changed`.
  app.get("/agents/:instanceId/surface", authenticated, (c) => {
    const { surface, error } = agentRegistration(c);
    if (error) return error;
    host.agentSurfaceServed(c.req.param("instanceId"));
    return c.json(surface);
  });

  // The Agent's pick, delivered into the state that invoked it. The receipt describes itself
  // (ADR-0024): what was delivered, and whether that ended the turn — which the Harness renders as
  // prose. Its `deliveryId` makes an outstanding pick addressable after the fact: its answer is
  // polled at `GET /agents/:iid/deliveries/:id`.
  app.post("/agents/:instanceId/events", authenticated, async (c) => {
    const { error } = agentRegistration(c);
    if (error) return error;
    const body = await readJson(c.req.text());
    try {
      return c.json(host.sendToAgent(c.req.param("instanceId"), body));
    } catch (err) {
      if (err instanceof UnknownAddressError) return c.json({ error: errMessage(err) }, 404);
      // One pick at a time (ADR-0024): refused, nothing delivered, and nothing is allowed until the
      // workflow is back at Rest. `outstanding` names the pick still running, when there is one; the
      // Harness writes the words.
      if (err instanceof OutstandingError) {
        return c.json(
          {
            error: errMessage(err),
            refused: "outstanding",
            ...(err.outstanding !== undefined ? { outstanding: err.outstanding } : {}),
            allowed: [],
          },
          409,
        );
      }
      if (err instanceof EventValidationError) {
        // The Allowed picks ride the refusal (ADR-0029), so "Allowed now: …" can follow it.
        return c.json({ error: errMessage(err), ...(err.allowed ? { allowed: err.allowed } : {}) }, 400);
      }
      throw err;
    }
  });

  // An outstanding pick's answer (ADR-0013, ADR-0024), long-polled: the POST answered at once with a
  // delivery id, and the Harness asks here inside the pick's one tool call, up to `deliveryWaitMs`
  // per request, until the workflow is back at Rest in the Agent's state or has left it. A GET is
  // safe to repeat, so a reset or a restarting Orchestrator costs a retry, never the pick: a stopping
  // or parked host answers 503 — ask again — and the restored host answers from the saved hold.
  // Scoped like the pick: the Sandbox the registration had when the pick was made, because the
  // answer outlives a registration that a route out of the Agent's state ends.
  app.get("/agents/:instanceId/deliveries/:deliveryId", authenticated, async (c) => {
    const instanceId = c.req.param("instanceId");
    const deliveryId = c.req.param("deliveryId");
    if (host.stopping || host.parkedDelivery(instanceId, deliveryId)) {
      return c.json({ error: `the Orchestrator is stopping — ask again for delivery "${deliveryId}"` }, 503);
    }
    const scope = host.deliveryScope(instanceId, deliveryId);
    // Not restored yet is not over (ADR-0026, ADR-0069): the restored host answers from the hold.
    if (!scope && host.restorePending) {
      return c.json({ error: restorePendingMessage(`delivery "${deliveryId}"`) }, 503);
    }
    if (!scope) return c.json({ error: `no delivery "${deliveryId}" for instance "${instanceId}"` }, 404);
    if (!mayDeliverToAgent(principalOf(c), scope.sandbox)) {
      return c.json({ error: `this token cannot speak for instance "${instanceId}"` }, 403);
    }
    const receipt = await host.awaitDelivery(instanceId, deliveryId, opts.deliveryWaitMs, c.req.raw.signal);
    if (host.stopping) {
      return c.json({ error: `the Orchestrator is stopping — ask again for delivery "${deliveryId}"` }, 503);
    }
    return receipt
      ? c.json(receipt)
      : c.json({ error: `no delivery "${deliveryId}" for instance "${instanceId}"` }, 404);
  });

  // The pod's one route out (ADR-0053). A `git fetch` inside a Sandbox runs a program on the
  // runtime volume, which asks the Custodian on localhost, which forwards to this. What lands here
  // is one identity; what goes back is the landing, or the cache as it stands with git's own words
  // — freshness degrades, absence does not, so this answers 200 either way and the program prints
  // the warning. The caller waits on the ask the way an attach waits on Ready: same status, same
  // per-key entry, one wait.
  //
  // Scoped by the token to ITS OWN pod, and then by the CR to the Repos that pod mounts. Neither
  // is decoration: without the first, one feature's Sandbox could spend the cluster's credential
  // on another's; without the second, on any Repo in the namespace.
  app.post("/sandboxes/:name/fetch", authenticated, async (c) => {
    const name = c.req.param("name");
    if (!mayAskForSandbox(principalOf(c), name)) {
      return c.json({ error: `this token cannot ask for Sandbox "${name}"` }, 403);
    }
    if (!opts.fetchRepo) {
      return c.json({ error: "this instance runs no Workspace, so it holds no Repo cache to ask" }, 404);
    }
    const body = await readJson(c.req.text());
    const identity = body.identity;
    if (typeof identity !== "string" || identity === "") {
      return c.json({ error: "a fetch names the Repo's identity: { identity }" }, 400);
    }
    try {
      return c.json(await opts.fetchRepo(name, identity));
    } catch (err) {
      // The scope refusal, and the only one: a Repo this Sandbox does not mount.
      if (err instanceof UnmountedRepoError) return c.json({ error: errMessage(err) }, 404);
      throw err;
    }
  });

  return app;
}
