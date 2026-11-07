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
//   POST   /workflows/:wrapper/charts/:name/runs      start the named Chart                     [start]
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
// The bands of access (ADR-0014, ADR-0078) — the middleware is what says which:
//
//   open          structure + observation. `/workflows`, a template's Machine, the Console shell,
//                 and the run PROJECTIONS below (`GET /workflows/:name/runs*`). No context, no
//                 control.
//   authenticated any principal we minted a token for. The Agent's surface lives here, scoped
//                 further per-registration by `mayDeliverToAgent`.
//   guarded       a CALLER (ADR-0078) with the route's one scope, for the Workflow of the run or
//                 the door it addresses: run state, run control, starting a run and Gates. A
//                 Sandbox token authenticates but is refused, because it is never a Caller:
//                 starting work, reading another feature's context, or cancelling a run is not on
//                 the Agent's surface any more than a Gate is.
//   instanceOnly  the Instance token's Caller ALONE: the routes no scope names (the runtime Chart
//                 routes, `GET /repos`, a Hook's log).
//   hook          `POST /hooks/:name` (ADR-0011): no bearer token, and the Hook's own verifier.

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import tsBlankSpace from "ts-blank-space";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { accepts } from "hono/accepts";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  DISPATCHED_BY_HEADER,
  dispatchKeyOf,
  KEY_ONLY_HEADER,
  EventValidationError,
  NotTakenError,
  OutstandingError,
  UnknownAddressError,
  type DispatchedBy,
} from "./registration.ts";
import type { RepoStatus } from "./repos.ts";
import { parseRunListQuery } from "./run-list.ts";
import { CONVERSATION_SWEPT, type ConversationEntry, type ConversationStore } from "./conversations.ts";
import { parseLfsAsk, UnmountedRepoError, type FetchAnswer, type LfsAnswer, type LfsAsk } from "./repo-fetch.ts";
import {
  callerHasScope,
  callerMay,
  callerMayAnswer,
  callerMayAny,
  instanceCaller,
  isInstancePrincipal,
  mayAskForSandbox,
  mayDeliverToAgent,
  ON_BEHALF_OF_HEADER,
  ON_BEHALF_OF_MAX,
  SLOT_HEADER,
  type Authenticator,
  type Caller,
  type Principal,
} from "./tokens.ts";
import type { Scope } from "./config.ts";
import { callerRecord } from "./callers.ts";
import { STEERING_TEXT_MAX } from "./steer.ts";
import {
  GateRefused,
  observe,
  StandingRefused,
  SteeringRefused,
  UnknownWorkflowError,
  type RunFeedEvent,
  type RunHost,
  type RunStatus,
  type WorkflowFeedEvent,
} from "./run-host.ts";
import { KIT_VERSION } from "./config.ts";
import type { AssemblyDoor } from "./assembly.ts";
import { ChartRefusal } from "./chart.ts";
import { HOOK_LOG_DEFAULT, HOOK_LOG_MAX, type HookDoor } from "./hooks.ts";
import { chartName, NamedChartError, splitChartName, type NamedCharts } from "./charts.ts";

// ---- The route table (ADR-0072) -------------------------------------------------------------
// The routes `createApp` registers, as data. It is the source of the HTTP API Reference page, so a
// row says what a CALLER needs: the address, the credential, the body, the answer. Why a route is
// in its band stays in the comment above its handler. http-routes.test.ts compares the rows with
// the app's own registrations both ways and checks each row's band on the wire, so the table
// cannot drift from the code by forgetting.

/** The access bands of ADR-0014, named for what each checks, the publish door's band (ADR-0069):
 * the publish token alone, and the Hook's band (ADR-0011, ADR-0078): the Hook's own verifier, and
 * no bearer token. `guarded` takes a Caller with the route's {@link HttpRoute.scope}
 * (ADR-0078); `instanceOnly` takes the Instance token's Caller alone, for a route that no scope
 * names. */
export type HttpBand = "open" | "authenticated" | "guarded" | "instanceOnly" | "publishOnly" | "hook";

/** One route of the Orchestrator's HTTP API (ADR-0072). */
export type HttpRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** In Hono syntax, exactly as registered: `:param`, and `:param{regex}` for a constrained one. */
  path: string;
  band: HttpBand;
  /** A `guarded` route's scope (ADR-0078): the one a Caller needs, for the Workflow of the run or
   * the door that the route addresses; a list when any one of them opens the route (each opens its
   * own part of the answer); `any` for a route that takes any Caller. */
  scope?: Scope | readonly Scope[] | "any";
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
    path: "/whoami",
    band: "guarded",
    scope: "any",
    summary: "The request's Caller: how jr2 knows it, its name, what it may do, and the party it says it acts for.",
    response: "Caller",
    stream: false,
    adrs: ["0078"],
  },
  {
    method: "POST",
    path: "/hooks/:name",
    band: "hook",
    summary:
      "A delivery of an outside service to the Hook that the current Assembly's config names. The Hook's verifier authenticates it, and it goes to the open Gates whose handlers hear its kind and event key. 413 for a body above 2 MiB, before the verifier and with no more of the body read than that; 401 for a delivery that fails the verifier, 404 for a name that no Hook has, 503 with no current Assembly, and 503 when a standing Pool that hears it has no live run and is not paused, or when the delivery followed the Pool's hand-overs 3 times and the Pool handed its run over again. A 503 claims no delivery id.",
    body: "the service's own request",
    response:
      "the kind's answer to a handshake, or HookOutcome: { delivery, seen, delivered, refused, ignored, sources, payloadRefused? }",
    stream: false,
    adrs: ["0011", "0078"],
  },
  {
    method: "GET",
    path: "/hooks/:name",
    band: "instanceOnly",
    summary:
      "A Hook's log, newest first: each delivery that jr2 keeps (`runs.retain`, 30 days by default), with what the door did with it. `?limit=` (default 50, at most 1000).",
    response: "{ hook, declared, lines: HookLogLine[] }",
    stream: false,
    adrs: ["0011", "0065"],
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
    summary:
      "The current Assembly, the Assemblies that live runs hold, and each standing Workflow: live, paused or waiting, its run, and how many items it holds.",
    response: "AssemblyView & { standing?: StandingView[] }",
    stream: false,
    adrs: ["0017", "0069"],
  },
  {
    method: "PUT",
    path: "/assembly",
    band: "publishOnly",
    summary:
      "Publish the next Assembly. `jr2 up` calls it, and nothing else. A refused Assembly leaves the current one current.",
    body: "the Assembly as a tar stream, with the headers `jr2-kit-version` and `jr2-assembly-hash`",
    response:
      "200 with the Assembly, its Workflows, the held Assemblies, the ones collected and each standing Workflow's state; 400, 409 or 422 with the reason",
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
    band: "guarded",
    scope: "start",
    summary: "Start a run of a named Chart, as `POST /workflows/<wrapper>%2F<name>/runs` does.",
    body: "the Chart wrapper's input, without the Chart",
    response: "201 { runId, instanceId }; 409 when the named Chart cannot run now",
    stream: false,
    adrs: ["0070", "0078"],
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
    path: "/console/config",
    band: "open",
    summary:
      "What the Console needs before a login: each JWT issuer that offers a login, and its client id. Both are public values.",
    response: "{ login: Array<{ issuer, clientId }> }",
    stream: false,
    adrs: ["0032", "0078"],
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
    band: "guarded",
    scope: "start",
    summary:
      "Start a run of a registered workflow. A `dispatch` from another Orchestrator sends the header `jr2-dispatched-by`, and a repeated start with its key answers the run that it started. With the header `jr2-key-only: true` too, the start is a key-only ask: it answers the run under the key, and starts nothing. For a standing Workflow, jr2 starts the run: the start only resumes a paused one, and `?drop-held=true` resumes it with no held item.",
    body: "the workflow's input, checked against its declared input schema",
    response:
      "201 { runId, instanceId }; 201 { runId, instanceId, resumed: true } for a resumed standing Workflow; 200 { runId, instanceId, existing: true } for a repeated dispatch; 200 { existing: false } for a key-only ask with no run under the key; 409 for a standing Workflow that is not paused, or a dispatch to one; 422 { error, report } when the door refuses a Chart in the input",
    stream: false,
    adrs: ["0017", "0033", "0058", "0070", "0071", "0078"],
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
    band: "guarded",
    scope: "read",
    summary:
      "A page of the runs of the Workflows that the Caller may read, newest first: live runs by default; " +
      "?status=live|ended|all|<list> ?workflow ?since ?cursor ?limit.",
    response: "{ runs: RunSummary[], next? }",
    stream: false,
    adrs: ["0009", "0014", "0078"],
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
    band: "guarded",
    scope: "any",
    summary:
      "The run ids that start with a prefix (`?prefix=`, at least 4 characters), of the Workflows in any scope of the Caller.",
    response: "{ prefix, runIds: string[], truncated }",
    stream: false,
    adrs: ["0009", "0078"],
  },
  {
    method: "GET",
    path: "/gates",
    band: "guarded",
    scope: "answer",
    summary:
      "The Gate inbox: every open Gate of every live run that the Caller may answer, oldest first, never a run's context; ?workflow.",
    response: "{ gates: GateInboxEntry[] }",
    stream: false,
    adrs: ["0011", "0014", "0078"],
  },
  {
    method: "GET",
    path: "/runs/:runId",
    band: "guarded",
    scope: ["read", "answer"],
    summary:
      "One run's status, live or settled, with its open Gates. `read` opens the status, and `answer` opens the Gates that the Caller may answer: with `answer` alone the answer is the run's observation and those Gates, and never its context.",
    response:
      "RunStatus & { gates: GateView[] }; RunStatus with `read` alone; RunObservation & { gates: GateView[] } with `answer` alone",
    stream: false,
    adrs: ["0009", "0011", "0078"],
  },
  {
    method: "POST",
    path: "/runs/:runId/gates/:gate/events",
    band: "guarded",
    scope: "answer",
    summary:
      "Deliver an event to an open Gate of a run. A Caller whose `answer` names single Gates of the Workflow is refused 403 for another Gate.",
    body: "{ type, ...payload }, checked against the Gate's schema for that event",
    response: "{ ok: true }; 409 { error, acceptsNow } when the run does not take it now",
    stream: false,
    adrs: ["0011", "0013", "0078"],
  },
  {
    method: "GET",
    path: "/runs/:runId/events",
    band: "guarded",
    scope: "read",
    summary: "One run's full activity until it settles; a settled run's final status, once.",
    response:
      "SSE: status, emit, retry, admission, pick, placing, placed, child-error, looked, hook-refused, pool, effect, gone",
    stream: true,
    adrs: ["0011", "0022", "0023", "0064", "0067", "0078"],
  },
  {
    method: "GET",
    path: "/runs/:runId/conversations",
    band: "guarded",
    scope: "read",
    summary:
      "A run's kept conversations, the first first: one row for each conversation of each Agent, Menu-only Agents too, with its Agent slot.",
    response: 'Array<{ agent, slot?, instanceId, open, bytes, cut, swept?: "no space" }>',
    stream: false,
    adrs: ["0023", "0065"],
  },
  {
    method: "GET",
    path: "/runs/:runId/conversations/:instanceId",
    band: "guarded",
    scope: "read",
    summary:
      "The entries of one kept conversation after a sequence number (`?after=<seq>`, `?limit=`, 1000 by default). The Instance ID is URL-encoded.",
    response: "Array<{ id, seq, at, agent, kind, text }>",
    stream: false,
    adrs: ["0023"],
  },
  {
    method: "GET",
    path: "/runs/:runId/conversations/:instanceId/events",
    band: "guarded",
    scope: "read",
    summary:
      "Follow one kept conversation: its entries after `?after=<seq>`, then each new one, until the conversation is not open.",
    response: "SSE: entry, end",
    stream: true,
    adrs: ["0023"],
  },
  {
    method: "POST",
    path: "/runs/:runId/events",
    band: "guarded",
    scope: "cancel",
    summary: "Cancel a run: it ends, and its Workspaces go unless `keep` is true.",
    body: '{ type: "CANCEL", keep?: boolean }',
    response: "{ ok: true }",
    stream: false,
    adrs: ["0002", "0025", "0078"],
  },
  {
    method: "GET",
    path: "/runs/:runId/agents",
    band: "guarded",
    scope: "steer",
    summary:
      "The Agent slots of a run that a Steering message can go to: one row for each Agent of each live Machine instance.",
    response: "Array<{ agent, open, steerable }>; [] for a run that is not live",
    stream: false,
    adrs: ["0002", "0078"],
  },
  {
    method: "POST",
    path: "/runs/:runId/steering",
    band: "guarded",
    scope: "steer",
    summary:
      "Send a Steering message to one Agent slot of a live run: its open Turn hears it at a step boundary, or else its next Turn.",
    body: "{ agent, text }, `text` at most 16 KiB",
    response:
      "202 { id, agent, open }; 413 for a longer text; 409 { error, agents? } when no live Machine instance holds the slot; 403 when the Agent is not steerable",
    stream: false,
    adrs: ["0002", "0062", "0078"],
  },
  {
    method: "GET",
    path: "/agents/:instanceId/surface",
    band: "authenticated",
    summary:
      "An Agent's Menu, this Turn's Allowed picks, the conversation's pending notices and its slot's Steering messages. A control token reads only its own pod's, for the slot it states.",
    response: "AgentSurfaceView & { notices: Array<{ id, notice }>, steering?: Array<{ id, message }> }",
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
    path: "/agents/:instanceId/notices",
    band: "authenticated",
    summary:
      "Acknowledge the notices and Steering messages a step boundary appended to the Turn: they are heard in its conversation.",
    body: "{ heard: string[] }",
    response: "{ heard: number }",
    stream: false,
    adrs: ["0062", "0076"],
  },
  {
    method: "POST",
    path: "/agents/:instanceId/conversation",
    band: "authenticated",
    summary:
      "Keep a batch of a conversation's entries. Only the control token of the pod that the run's admission ledger names, for the ledger's slot; never the Instance token. An entry kept already adds nothing.",
    body: "{ entries: Array<{ id, seq, at, kind, text }> }, at most 4 MiB",
    response:
      "{ kept, cut }; 409 while the run's ledger does not name the conversation yet (send again); 404 for a run that is not known",
    stream: false,
    adrs: ["0023", "0076"],
  },
  {
    method: "POST",
    path: "/sandboxes/:name/fetch",
    band: "authenticated",
    summary:
      "Ask the node cache to fetch one Repo that this Sandbox mounts, or, with `lfs`, to get LFS objects of it (1 to 256, by oid and size; `base` is the Binding's base, whose .lfsconfig names the LFS server). An LFS ask causes no git fetch. Past the Orchestrator's cap, a fetch is answered `stale` at once, and an LFS ask waits for a free line inside its budget. A fetch token asks only for its own.",
    body: "{ identity, lfs?: LfsAsk }",
    response:
      "FetchAnswer; with lfs, LfsAnswer: { lfs: { answered, error? } } when the node cache served the ask (error: git-lfs's words when an object is still missing), or { lfs: { error } } when the wait for the node cache or for a free line ran out, or when the Sandbox holds 256 LFS asks open; 400 for an lfs part that is not valid",
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

/** How many candidates `GET /runs/resolve` reads for a Caller whose scopes name Workflows: the ids
 * of other Workflows must not fill its answer. */
const RESOLVE_SCAN = 200;

/** The items of `items` for which `keep` answers true, in order. */
async function filterAsync<T>(items: readonly T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) if (await keep(item)) out.push(item);
  return out;
}

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

/** Why a principal that is not a Caller is refused on a Caller's route (ADR-0014, ADR-0078). */
const NOT_A_CALLER =
  "this route needs a Caller, and a Sandbox token is not one: no Agent reaches run state, run control or a Gate";

/** A Caller as a 403 names it: `token/ci`. */
function callerLabel(caller: Caller): string {
  return `the Caller ${caller.via}/${caller.name}`;
}

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

/** How many entries one read of a kept conversation gives when the query names no `limit`, and the
 * most it can name (ADR-0023). */
const CONVERSATION_PAGE_DEFAULT = 1_000;
const CONVERSATION_PAGE_MAX = 5_000;
/** The largest batch of entries the Harness may send (ADR-0023): it sends less than 1 MiB. */
const CONVERSATION_BATCH_MAX = 4 * 1024 * 1024;
/** How long a followed conversation that is not open stays followed for a late batch. */
const FOLLOW_GRACE_MS = 5_000;

/** A batch of a conversation's entries, as the Harness sends it (ADR-0023). */
const conversationBatch = z.object({
  entries: z.array(
    z.object({
      id: z.string().min(1).max(200),
      seq: z.number().int().min(0),
      at: z.string().max(64),
      kind: z.string().min(1).max(200),
      text: z.string(),
    }),
  ),
});

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
  /** How long a followed conversation that is not open waits for a late batch before its feed
   * ends (ADR-0023). Tests shorten it. */
  followGraceMs?: number;
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
   * `readMountDigests` reads them, and of the digests Secrets as it loaded them (ADR-0078,
   * `loadedDigests`). `GET /assembly` reports them, so `jr2 up` can wait for the kubelet before it
   * publishes, and `jr2 up` and `jr2 caller rotate` before a token they wrote works. Absent when
   * not deployed: nothing is mounted.
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
   * built: mark the Sandbox CR for one Repo key, wait for the landing on its status, answer. With
   * `lfs`, the LFS ask: its own mark, the same wait, the `{ lfs }` answer.
   * Absent for an instance without a data plane and for the in-process tests: no Sandbox, so no
   * ask, and the route says so rather than waiting on a cluster that is not there.
   */
  fetchRepo?: (sandbox: string, identity: string, lfs?: LfsAsk) => Promise<FetchAnswer | LfsAnswer>;
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
  /** The origins a browser app may call from (ADR-0078), read per request: the current Assembly's
   * `cors`. Absent: none. */
  cors?: () => readonly string[];
  /** The JWT issuers the Console offers a login against (ADR-0032), read per request: the current
   * Assembly's issuers with `login: true`, each with its `audience` as the client id. Absent: none. */
  consoleLogin?: () => ReadonlyArray<{ issuer: string; clientId: string }>;
  /** The Hook's door (ADR-0011, ADR-0078): `POST /hooks/:name` and `GET /hooks/:name`. Absent for
   * the in-process tests that build an app straight over a host: `POST` then answers 503, as with
   * no current Assembly, and `GET` answers no line. */
  hooks?: HookDoor;
  /** The kept conversations (ADR-0023): `POST /agents/:iid/conversation` writes them, and the
   * `/runs/:runId/conversations` routes read them. Absent for the in-process tests that build an
   * app straight over a host: the write answers 404, and a run lists no conversation. */
  conversations?: ConversationStore;
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
  const followGraceMs = opts.followGraceMs ?? FOLLOW_GRACE_MS;
  const app = new Hono<JR2Env>();

  /** Authenticate, or refuse. There is no anonymous principal (ADR-0013) — an open surface would
   * hand every Agent in the cluster a delivery API, which is the hole this ADR exists to close. */
  const authenticated: MiddlewareHandler<JR2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    // The slot a control request states (ADR-0076): a control token without one resolves to nothing.
    const principal = await auth(bearerOf(c), c.req.header(SLOT_HEADER));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "publisher") return c.json({ error: PUBLISHER_ONLY }, 403);
    c.set("principal", principal);
    return next();
  };
  /** The principal `authenticated` resolved. An unconfigured `auth` means full trust. */
  const principalOf = (c: Context<JR2Env>): Principal =>
    c.get("principal") ?? { kind: "caller", caller: instanceCaller() };
  /** The Caller a `guarded` middleware resolved. */
  const callerOf = (c: Context<JR2Env>): Caller => {
    const principal = principalOf(c);
    if (principal.kind !== "caller") throw new Error("callerOf: the route is not in the guarded band");
    return principal.caller;
  };

  /**
   * Authenticate a CALLER, and require one of `scopes` for at least one Workflow (ADR-0014,
   * ADR-0078). A Sandbox token is a token we minted, but it is never a Caller: on the run surface it
   * would let a Custodian's credential read every run's context (other features' branches, tickets,
   * verdicts) and CANCEL any run, and neither is on the Agent's surface (ADR-0013). The Workflow of
   * the run or the door is the handler's to check, with `mayFor`, because only the handler knows it.
   * `any` takes every Caller. The Caller's `jr2-on-behalf-of` claim is read here, once.
   */
  const guarded =
    (scopes: Scope | readonly Scope[] | "any"): MiddlewareHandler<JR2Env> =>
    async (c, next) => {
      const onBehalfOf = c.req.header(ON_BEHALF_OF_HEADER)?.trim();
      if (onBehalfOf !== undefined && onBehalfOf.length > ON_BEHALF_OF_MAX) {
        return c.json(
          { error: `the ${ON_BEHALF_OF_HEADER} header is longer than ${ON_BEHALF_OF_MAX} characters` },
          400,
        );
      }
      let caller: Caller;
      if (!auth) {
        caller = instanceCaller(); // no authenticator configured: tests only (see the doc comment)
      } else {
        const principal = await auth(bearerOf(c), c.req.header(SLOT_HEADER));
        if (!principal) return c.json({ error: "unauthorized" }, 401);
        if (principal.kind === "publisher") return c.json({ error: PUBLISHER_ONLY }, 403);
        if (principal.kind !== "caller") return c.json({ error: NOT_A_CALLER }, 403);
        caller = principal.caller;
      }
      // A Hook's `onBehalfOf` comes from its signed payload, never from a header (ADR-0078).
      if (onBehalfOf && caller.via !== "hook") caller = { ...caller, onBehalfOf };
      if (scopes !== "any") {
        const list: readonly Scope[] = typeof scopes === "string" ? [scopes] : scopes;
        if (!list.some((s) => callerHasScope(caller, s))) {
          return c.json(
            {
              error: `${callerLabel(caller)} has no ${list.map((s) => `"${s}"`).join(" or ")} scope for any Workflow (ADR-0078)`,
              scope: list.length === 1 ? list[0] : list,
            },
            403,
          );
        }
      }
      c.set("principal", { kind: "caller", caller });
      return next();
    };

  /** The 403 for a Caller that may not answer the Gate named `name` (its invoke id) of `workflow`,
   * or undefined when it may. It names the scope, the Workflow and the Gate (ADR-0078). */
  const mayAnswer = (c: Context<JR2Env>, workflow: string, name: string): Response | undefined => {
    const caller = callerOf(c);
    if (callerMayAnswer(caller, workflow, name)) return undefined;
    return c.json(
      {
        error: `${callerLabel(caller)} needs the "answer" scope for Gate "${name}" of Workflow "${workflow}" (ADR-0078)`,
        scope: "answer",
        workflow,
        gate: name,
      },
      403,
    );
  };

  /** The 403 for a Caller without `scope` on `workflow`, or undefined when it has it. It names the
   * scope and the Workflow that the request needed (ADR-0078). */
  const mayFor = (c: Context<JR2Env>, scope: Scope, workflow: string): Response | undefined => {
    const caller = callerOf(c);
    if (callerMay(caller, scope, workflow)) return undefined;
    return c.json(
      {
        error: `${callerLabel(caller)} needs the "${scope}" scope for Workflow "${workflow}" (ADR-0078)`,
        scope,
        workflow,
      },
      403,
    );
  };

  /**
   * Authenticate, AND require the Instance token's Caller (ADR-0014): the routes that no scope
   * names — the runtime Chart routes and `GET /repos`. A named token is refused here, whatever its
   * scopes, and so is every principal that is not a Caller.
   */
  const instanceOnly: MiddlewareHandler<JR2Env> = async (c, next) => {
    if (!auth) return next(); // no authenticator configured: tests only (see the doc comment)
    const principal = await auth(bearerOf(c), c.req.header(SLOT_HEADER));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "publisher") return c.json({ error: PUBLISHER_ONLY }, 403);
    if (principal.kind !== "caller") return c.json({ error: NOT_A_CALLER }, 403);
    if (!isInstancePrincipal(principal)) {
      return c.json(
        { error: `this route needs the Instance token: no scope opens it, so ${callerLabel(principal.caller)} cannot` },
        403,
      );
    }
    c.set("principal", principal);
    return next();
  };

  // The origins a browser app may call from (ADR-0078): an allowlist, empty by default, read per
  // request so a publish changes it. The Console is served from this origin and needs no entry. A
  // preflight from an origin that is not listed gets no CORS header, so the browser refuses it.
  const allowedOrigins = opts.cors ?? (() => []);
  app.use(
    "*",
    cors({
      origin: (origin) => (origin !== "" && allowedOrigins().includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
      allowHeaders: ["authorization", "content-type", ON_BEHALF_OF_HEADER, DISPATCHED_BY_HEADER, KEY_ONLY_HEADER],
      maxAge: 600,
    }),
  );

  // Liveness, and the one place an instance says WHAT IT IS. Unauthenticated because it is the
  // readiness probe's target and because identity is not run state — it is the same class of thing
  // as the route table, which is public by being served. The CLI probes it to explain a failure it
  // could otherwise only report as a bare status code (version skew reads as a nonsense 404).
  // `hash` is the current Assembly's (ADR-0069), absent while the process holds none.
  app.get("/healthz", (c) => c.json({ ok: true, version: KIT_VERSION, hash: opts.assembly?.current()?.hash }));
  app.get("/readyz", (c) => c.json({ ready: true }));

  // The request's Caller record (ADR-0078): what a credential may do, asked before it fails. Any
  // Caller: it says nothing that the credential's holder does not already hold.
  app.get("/whoami", guarded("any"), (c) => c.json(callerOf(c)));

  // The Hook's door (ADR-0011, ADR-0078). Outside the bands: no bearer token opens it, and the
  // Hook's own verifier authenticates each delivery, in hooks.ts. The raw bytes, never a parsed
  // body, because a signature covers the bytes. The door reads the body only after it knows the
  // Hook, and no more of it than its limit (`limitedBody`).
  app.post("/hooks/:name", async (c) => {
    if (!opts.hooks) {
      return c.json({ error: "the Orchestrator has no current Assembly, so no Hook is declared now — ask again" }, 503);
    }
    const answer = await opts.hooks.deliver(c.req.param("name"), c.req.raw.headers, limitedBody(c.req.raw));
    // The follow-up (the reply to a Slack click) goes after the answer: the service waits for the
    // answer, not for the post (ADR-0011). It never rejects.
    const after = answer.after;
    if (after) setImmediate(() => void after());
    const status = answer.status as 200 | 400 | 401 | 404 | 413 | 429 | 503;
    if (answer.body === null) return c.body(null, status);
    if (typeof answer.body === "string") return c.text(answer.body, status);
    // As text, not `c.json`: hono's JSON type of a recursive `Json` does not end.
    return c.body(JSON.stringify(answer.body), status, { "content-type": "application/json" });
  });

  // A Hook's log (ADR-0011): the Instance token alone. A line can carry a payload's issues and a
  // handler's words, and no scope names the act of reading what an outside service sent.
  app.get("/hooks/:name", instanceOnly, (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? HOOK_LOG_DEFAULT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > HOOK_LOG_MAX) {
      return c.json({ error: `limit is a whole number from 1 to ${HOOK_LOG_MAX}` }, 400);
    }
    const name = c.req.param("name");
    return c.json(opts.hooks ? opts.hooks.log(name, limit) : { hook: name, declared: false, lines: [] });
  });

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
  // `mounts` is what this process reads from its mounted ConfigMaps and holds from its digests
  // Secrets, so a command can wait until the kubelet has delivered the data it wrote. A digest of
  // digests: no token value.
  app.get("/assembly", async (c) => {
    const base = opts.assembly ? await opts.assembly.view() : { kitVersion: KIT_VERSION, current: null, held: [] };
    // The standing Workflows (ADR-0017): each one's state and how many items it holds, which
    // `jr2 up` and `jr2 status` print. Counts and run ids, as `held` has: no key and no item.
    const standing = await host.standingView();
    const view = standing.length ? { ...base, standing } : base;
    return c.json(opts.mounts ? { ...view, mounts: await opts.mounts() } : view);
  });

  // The publish door (ADR-0069): the publish token ALONE. Publishing imports code into the process
  // that holds the ServiceAccount, so the Instance token, which starts runs and answers Gates, is
  // refused here by name. The checks after authentication are the door's (assembly.ts), each with
  // its own status, and the old Assembly stays current through every refusal.
  app.put("/assembly", async (c) => {
    if (auth) {
      const principal = await auth(bearerOf(c));
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
    // A publish that landed names each standing Workflow's state after it (ADR-0017): `jr2 up` prints
    // it, the paused ones with how many items they hold.
    if (answer.status === 200) {
      const standing = await host.standingView();
      if (standing.length) return c.json({ ...(answer.body as object), standing }, 200);
    }
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
   * asked first, so a re-send answers its run even when the name would be refused now. The key is
   * scoped to the Workflow named: the same key in another Workflow is another run. A header that
   * does not parse is 400. `jr2 run` and the
   * Console send none. Any throw that is not a refusal is a defect, 500: a foreign caller reads a
   * 404 as "nothing was started", and a defect may come after a start.
   *
   * With `jr2-key-only: true` as well, the start is a key-only ask (ADR-0071): the Instance
   * Effector sends it, with no body, when the calling slot's schema refuses the body. The door
   * asks the key as above, and with no run under it answers `200 { existing: false }` and starts
   * nothing: not a 404, which reads as a refused name, and not a 5xx, which reads as a defect.
   * The header without `jr2-dispatched-by`, or with another value, is 400.
   */
  const startRun = async (c: Context<JR2Env>, name: string): Promise<Response> => {
    // The scope first (ADR-0078): a Caller without `start` on this Workflow learns no key's run.
    const refused = mayFor(c, "start", name);
    if (refused) return refused;
    const header = dispatchedByOf(c.req.header(DISPATCHED_BY_HEADER));
    if ("error" in header) return c.json({ error: header.error }, 400);
    const { by } = header;
    const keyOnly = c.req.header(KEY_ONLY_HEADER);
    if (keyOnly !== undefined && (keyOnly !== "true" || !by)) {
      return c.json(
        {
          error: `the ${KEY_ONLY_HEADER} header is "true", with a ${DISPATCHED_BY_HEADER} header that carries the key (ADR-0071)`,
        },
        400,
      );
    }
    if (by) {
      const found = await host.dispatched(name, dispatchKeyOf(by));
      if (found) return c.json({ runId: found.runId, instanceId: found.instanceId, existing: true }, 200);
      // A key-only ask, and no run has the key: nothing is read, nothing is started.
      if (keyOnly !== undefined) return c.json({ existing: false }, 200);
    }
    const unrunnable = opts.charts?.get(name)?.unrunnable;
    if (unrunnable !== undefined) return c.json({ error: `named Chart "${name}" cannot run: ${unrunnable}` }, 409);
    // jr2 starts a standing Workflow's run (ADR-0017): a Caller's start only resumes a paused one,
    // and a dispatch never starts one. `?drop-held=true` resumes with no held item.
    if (host.isStanding(name)) {
      if (by) {
        return c.json(
          { error: `"${name}" is a standing Workflow: jr2 starts its run, and a dispatch cannot (ADR-0017)` },
          409,
        );
      }
      try {
        const resumed = await host.resumeStanding(name, callerRecord(callerOf(c)), {
          dropHeld: c.req.query("drop-held") === "true",
        });
        return c.json({ ...resumed, resumed: true }, 201);
      } catch (err) {
        if (err instanceof StandingRefused) return c.json({ error: errMessage(err) }, 409);
        return c.json({ error: errMessage(err) }, 500);
      }
    }
    const input = await readJson(c.req.text());
    try {
      // The run records its Caller (ADR-0078). A foreign dispatch's too: the Caller is the one whose
      // credential the other Instance sent, with the party it says the start acts for.
      const startedBy = { kind: "caller" as const, ...callerRecord(callerOf(c)) };
      const { runId, instanceId, existing } = await host.start(name, input, {
        ...(by ? { dispatchedBy: by } : {}),
        startedBy,
      });
      return existing ? c.json({ runId, instanceId, existing }, 200) : c.json({ runId, instanceId }, 201);
    } catch (err) {
      if (err instanceof ChartRefusal) return c.json({ error: "refused", report: err.report }, 422);
      if (err instanceof EventValidationError) return c.json({ error: errMessage(err) }, 400);
      if (err instanceof UnknownWorkflowError) return c.json({ error: errMessage(err) }, 404);
      return c.json({ error: errMessage(err) }, 500);
    }
  };

  // The documented start of a named Chart; `POST /workflows/<wrapper>%2F<name>/runs` is the same.
  app.post("/workflows/:wrapper/charts/:name/runs", guarded("start"), (c) =>
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
  // What the Console needs before a login (ADR-0032): the issuers the current config offers a login
  // against, each with its client id (the issuer's `audience`). Open, because the page reads it
  // before it holds a credential, and because both values are public: a public client has no
  // secret, and an issuer's URL is in every JWT it signs. Read per request, so a publish changes it.
  app.get("/console/config", (c) => c.json({ login: opts.consoleLogin?.() ?? [] }));
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
  app.post("/workflows/:name/runs", guarded("start"), (c) => startRun(c, c.req.param("name")));

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
    // A look's mark (ADR-0011) names a Gate id, which a workflow may compute from its data: behind
    // the token.
    if (ev.kind === "looked") return undefined;
    // A Hook's refusal (ADR-0011) carries a handler's own words: behind the token.
    if (ev.kind === "hook-refused") return undefined;
    // A Pool's marks (ADR-0017) name its items' keys, which are the workflow's data: behind the token.
    if (ev.kind === "pool") return undefined;
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

  // The run listing (ADR-0009): live runs by default, the history with `status`, newest start
  // first, a page at a time. Of the Workflows that the Caller may read (ADR-0078): a run of another
  // Workflow is left out, not refused, so one Caller's list says nothing of another's runs.
  app.get("/runs", guarded("read"), async (c) => {
    const query = parseRunListQuery(
      {
        status: c.req.query("status"),
        workflow: c.req.query("workflow"),
        since: c.req.query("since"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      },
      Date.now(),
    );
    if ("error" in query) return c.json({ error: query.error }, 400);
    const page = await host.history(query, callerOf(c).may.read ?? []);
    // A run whose kept conversations the space guard deleted says so (ADR-0065).
    const swept = opts.conversations?.sweptRuns(page.runs.map((r) => r.runId)) ?? new Set<string>();
    if (swept.size === 0) return c.json(page);
    return c.json({
      ...page,
      runs: page.runs.map((r) => (swept.has(r.runId) ? { ...r, swept: CONVERSATION_SWEPT } : r)),
    });
  });

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
  //
  // Any Caller, for the Workflows in any of its scopes (ADR-0014): a Caller resolves only the ids it
  // could address. A Caller with a scope for every Workflow needs no filter; any other reads each
  // candidate's Workflow, over a wider scan, so the ids of other Workflows do not fill its answer.
  app.get("/runs/resolve", guarded("any"), async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    if (prefix.length < MIN_RUN_ID_PREFIX) {
      return c.json({ error: `prefix must be at least ${MIN_RUN_ID_PREFIX} characters` }, 400);
    }
    const caller = callerOf(c);
    const everyWorkflow = Object.values(caller.may).some((grant) => grant === "all");
    // Scan one past the cap so `truncated` is knowable without a second COUNT.
    const found = everyWorkflow
      ? await host.candidates(prefix, RESOLVE_LIMIT + 1)
      : await filterAsync(await host.candidates(prefix, RESOLVE_SCAN), async (id) => {
          const workflow = (await host.read(id))?.workflow;
          return workflow !== undefined && callerMayAny(caller, workflow);
        });
    return c.json({
      prefix,
      runIds: found.slice(0, RESOLVE_LIMIT),
      truncated: found.length > RESOLVE_LIMIT,
    });
  });

  // The Gate inbox (ADR-0011): the open Gates of every live run that the Caller may answer, oldest
  // first, with each Gate's run, Workflow and the time it opened. A Gate the Caller may not answer is
  // left out, not refused, so one Caller's inbox says nothing of another's Gates (ADR-0078). It never
  // gives a run's context (ADR-0014): a person who answers a Gate reads its `meta`.
  app.get("/gates", guarded("answer"), (c) => {
    const caller = callerOf(c);
    const workflow = c.req.query("workflow") || undefined;
    return c.json({ gates: host.gateInbox((w, name) => callerMayAnswer(caller, w, name), workflow) });
  });

  // Read-through (ADR-0009): a completed run's final status lives in the store after the registry
  // drops it, so this serves terminal runs too — only a genuinely unknown run is a 404. The status
  // carries the run's OPEN GATES (ADR-0011) — the discovery listing external callers act on
  // (`jr2 send` menus, UI inbox cards, webhook translators matching on meta). Settled run → [].
  //
  // `read` opens the status, `answer` opens the Gates (ADR-0014): a Caller with `answer` alone gets
  // the run's observation and its Gates, and never its context — a person who answers a Gate reads
  // the Gate's `meta`, which the author wrote for that person.
  app.get("/runs/:runId", guarded(["read", "answer"]), async (c) => {
    const runId = c.req.param("runId");
    const found = await host.read(runId);
    if (!found) return c.json({ error: `no run "${runId}"` }, 404);
    // A run whose kept conversations the space guard deleted says so (ADR-0065).
    const status = opts.conversations?.sweptRuns([runId]).has(runId) ? { ...found, swept: CONVERSATION_SWEPT } : found;
    const caller = callerOf(c);
    const read = callerMay(caller, "read", status.workflow);
    const answer = callerMay(caller, "answer", status.workflow);
    if (!read && !answer) return mayFor(c, "read", status.workflow)!;
    if (!answer) return c.json(status);
    // Only the Gates that the Caller may answer (ADR-0078): a scope that names one Gate of the
    // Workflow does not show the others.
    const gates = host.gates(runId, (name) => callerMayAnswer(caller, status.workflow, name));
    if (!read) return c.json({ ...observe(status), gates });
    return c.json({ ...status, gates });
  });

  // Gates delivery (ADR-0011): validate the body against the gate's named schema and deliver into
  // the gated state. Unknown gate (never opened, state exited, run settled) → 404; a name the gate
  // doesn't accept, or a payload failing its schema → 400 naming what IS accepted.
  //
  // A Gate is a HUMAN's decision (or a Hook's, or CI's): a Caller with `answer` on the run's
  // Workflow. Every Agent principal — a control token or a fetch token — is refused by the band,
  // because it is never a Caller: this is the exact line between "the Agent reports an outcome" and
  // "the Agent approves its own PR" (ADR-0013, ADR-0076). A run that is not live has no open Gate,
  // and the delivery below answers it 404.
  app.post("/runs/:runId/gates/:gate/events", guarded("answer"), async (c) => {
    const runId = c.req.param("runId");
    const gate = c.req.param("gate");
    // The body first: no `await` comes between the scope check and the delivery below, so a Gate
    // that opens while the body is in flight is checked too (ADR-0078).
    const body = await readJson(c.req.text());
    const caller = callerOf(c);
    const live = host.status(runId);
    if (live) {
      const refused = mayFor(c, "answer", live.workflow);
      if (refused) return refused;
    }
    try {
      // The Gate's name, its invoke id, is what a scope that names single Gates names (ADR-0078).
      // The delivery checks it against the registration that it delivers to.
      const opens = live ? (name: string) => callerMayAnswer(caller, live.workflow, name) : undefined;
      host.sendToGate(runId, gate, body, callerRecord(caller), undefined, opens);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof GateRefused) return mayAnswer(c, live!.workflow, err.gate)!;
      if (err instanceof UnknownAddressError) return c.json({ error: errMessage(err) }, 404);
      if (err instanceof EventValidationError) return c.json({ error: errMessage(err) }, 400);
      // The run would not take it from this Gate now (ADR-0013): never `{ ok: true }`. The body
      // names what the Gate takes now, as `GET /runs/:id` lists it.
      if (err instanceof NotTakenError) {
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
    // A Gate's look gave its event and the run took it (ADR-0011).
    if (ev.kind === "looked") return sseFrame(ev.kind, ev);
    // A Hook's delivery reached an open Gate, and the Gate did not take it (ADR-0011).
    if (ev.kind === "hook-refused") return sseFrame(ev.kind, ev);
    // What a Pool of runs did with an item (ADR-0017): started, settled, or a held item refused.
    if (ev.kind === "pool") return sseFrame(ev.kind, ev);
    // An Effect's lines (ADR-0067): its start, its stream, its output, an abort — Instance-token band.
    if (ev.kind === "effect") return sseFrame("effect", ev);
    return sseFrame("status", ev.status);
  });

  // SSE: a live run streams its status deltas + author `emit`s (current status replayed on attach,
  // then live until the terminal transition or client abort). A run that has already settled streams
  // its final status once and closes (so `jr2 watch` works on a finished run). Unknown run → 404.
  app.get("/runs/:runId/events", guarded("read"), async (c) => {
    const runId = c.req.param("runId");
    const live = host.status(runId);
    if (live) {
      const refused = mayFor(c, "read", live.workflow);
      if (refused) return refused;
    }
    if (live === undefined) {
      const finalStatus = await host.read(runId);
      if (!finalStatus) return c.json({ error: `no run "${runId}"` }, 404);
      const refused = mayFor(c, "read", finalStatus.workflow);
      if (refused) return refused;
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
  app.post("/runs/:runId/events", guarded("cancel"), async (c) => {
    const runId = c.req.param("runId");
    const known = await host.read(runId);
    if (known) {
      const refused = mayFor(c, "cancel", known.workflow);
      if (refused) return refused;
    }
    const body = (await readJson(c.req.text())) as RunEventBody;
    if (body.type !== "CANCEL") {
      return c.json({ error: `unknown event type "${body.type ?? ""}" (accepts: CANCEL)` }, 400);
    }
    // Whether to keep is a fact of the moment of the cancel, never a config key (ADR-0025).
    if (body.keep !== undefined && typeof body.keep !== "boolean") {
      return c.json({ error: `"keep" must be a boolean` }, 400);
    }
    try {
      await host.cancel(runId, { keep: body.keep === true, by: callerRecord(callerOf(c)) });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 404);
    }
  });

  // Steering messages (ADR-0002): free text from a Caller to one Agent slot of a run, which the
  // Agent hears once, at a step boundary of its open Turn or at its next Turn's admission. The list
  // says where a message can go, so a Caller never guesses an Instance ID; the same scope opens both.
  app.get("/runs/:runId/agents", guarded("steer"), async (c) => {
    const runId = c.req.param("runId");
    const known = await host.read(runId);
    if (!known) return c.json({ error: `no run "${runId}"` }, 404);
    const refused = mayFor(c, "steer", known.workflow);
    if (refused) return refused;
    return c.json(host.agents(runId) ?? []);
  });

  app.post("/runs/:runId/steering", guarded("steer"), async (c) => {
    const runId = c.req.param("runId");
    const known = await host.read(runId);
    if (!known) return c.json({ error: `no run "${runId}"` }, 404);
    const refused = mayFor(c, "steer", known.workflow);
    if (refused) return refused;
    const body = (await readJson(c.req.text())) as { agent?: unknown; text?: unknown };
    if (typeof body.agent !== "string" || body.agent === "") {
      return c.json(
        { error: `a Steering message names an Agent slot: { agent, text } (see GET /runs/${runId}/agents)` },
        400,
      );
    }
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "a Steering message has a text: { agent, text }" }, 400);
    }
    if (new TextEncoder().encode(body.text).length > STEERING_TEXT_MAX) {
      return c.json({ error: `the text is longer than ${STEERING_TEXT_MAX} bytes (16 KiB)` }, 413);
    }
    try {
      return c.json(host.steer(runId, body.agent, body.text, callerRecord(callerOf(c))), 202);
    } catch (err) {
      if (err instanceof SteeringRefused) {
        return c.json({ error: err.message, ...(err.agents !== undefined ? { agents: err.agents } : {}) }, err.status);
      }
      throw err;
    }
  });

  // ---- The kept conversations (ADR-0023) ----------------------------------------------------------
  // What the Harness sent of each conversation while its Turns ran, for as long as the run is kept
  // (ADR-0065). `read` opens all three, as it opens the run's status (ADR-0014). A conversation is
  // open while a Turn of it is registered on that live run, and the host is not going away.
  const conversationOpen = (runId: string, instanceId: string): boolean =>
    !host.stopping && host.agentRun(instanceId) === runId;

  /** The run, read and in the Caller's scope, or the answer that refuses it. An Instance ID that is
   * not of the run is refused before the store is read: the scope is the run's Workflow. */
  const conversationsRun = async (
    c: Context<JR2Env>,
    runId: string,
    instanceId?: string,
  ): Promise<Response | undefined> => {
    if (instanceId !== undefined && !instanceId.startsWith(`${runId}/`)) {
      return c.json({ error: `run "${runId}" keeps no conversation "${instanceId}"` }, 404);
    }
    const known = await host.read(runId);
    if (!known) return c.json({ error: `no run "${runId}"` }, 404);
    return mayFor(c, "read", known.workflow);
  };

  app.get("/runs/:runId/conversations", guarded("read"), async (c) => {
    const runId = c.req.param("runId");
    const refused = await conversationsRun(c, runId);
    if (refused) return refused;
    const kept = opts.conversations?.list(runId) ?? [];
    // Each conversation's Agent slot, from the run's admission ledger: the address `jr2 logs` and
    // `jr2 steer` take (ADR-0002, ADR-0009). Absent for a row that the ledger does not name.
    const slots = await Promise.all(kept.map(({ instanceId }) => host.conversationPlace(instanceId)));
    return c.json(
      kept.map(({ agent, instanceId, bytes, cut, swept }, i) => ({
        agent,
        ...(slots[i]?.slot !== undefined ? { slot: slots[i].slot } : {}),
        instanceId,
        open: conversationOpen(runId, instanceId),
        bytes,
        cut,
        ...(swept !== undefined ? { swept } : {}),
      })),
    );
  });

  /** `?after=<seq>` (-1, the default, is from the first entry) and `?limit=`, or the 400. */
  const entryQuery = (c: Context<JR2Env>): { after: number; limit: number } | { error: string } => {
    const after = c.req.query("after");
    const limit = c.req.query("limit");
    const a = after === undefined ? -1 : Number(after);
    const l = limit === undefined ? CONVERSATION_PAGE_DEFAULT : Number(limit);
    if (!Number.isInteger(a) || a < -1)
      return { error: `after is a sequence number (an integer of -1 or more), not "${after}"` };
    if (!Number.isInteger(l) || l < 1 || l > CONVERSATION_PAGE_MAX) {
      return { error: `limit is an integer from 1 to ${CONVERSATION_PAGE_MAX}, not "${limit}"` };
    }
    return { after: a, limit: l };
  };

  app.get("/runs/:runId/conversations/:instanceId", guarded("read"), async (c) => {
    const runId = c.req.param("runId");
    const instanceId = c.req.param("instanceId");
    const refused = await conversationsRun(c, runId, instanceId);
    if (refused) return refused;
    const query = entryQuery(c);
    if ("error" in query) return c.json({ error: query.error }, 400);
    const store = opts.conversations;
    if (!store?.conversation(runId, instanceId)) {
      return c.json({ error: `run "${runId}" keeps no conversation "${instanceId}"` }, 404);
    }
    return c.json(store.entries(instanceId, query.after, query.limit));
  });

  // Follow one conversation: what is kept after `after`, then each new entry as it is kept. It ends
  // when the conversation is not open (its Turn is not registered, or its run ended) and no entry
  // came for a short time, so a batch that the Harness sends at its Turn's end is still read; and
  // when the conversation is cut or swept.
  app.get("/runs/:runId/conversations/:instanceId/events", guarded("read"), async (c) => {
    const runId = c.req.param("runId");
    const instanceId = c.req.param("instanceId");
    const refused = await conversationsRun(c, runId, instanceId);
    if (refused) return refused;
    const query = entryQuery(c);
    if ("error" in query) return c.json({ error: query.error }, 400);
    const store = opts.conversations;
    const known = store?.conversation(runId, instanceId);
    // A conversation that is open and has no entry kept yet is followed too.
    if (!store || (!known && !conversationOpen(runId, instanceId))) {
      return c.json({ error: `run "${runId}" keeps no conversation "${instanceId}"` }, 404);
    }
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const exit = closer(resolve);
        const sub = subscriber(stream);
        let last = query.after;
        let quietSince = Date.now();
        const send = (entries: ConversationEntry[]) => {
          for (const entry of entries) {
            if (entry.seq <= last) continue;
            last = entry.seq;
            quietSince = Date.now();
            void sub.send(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`);
          }
        };
        // Subscribe before the replay, so an entry kept between the two is not lost; `last` drops
        // what both give.
        const held: ConversationEntry[] = [];
        let replaying = true;
        exit.onExit(
          store.follow(instanceId, (entries) => {
            if (replaying) held.push(...entries);
            else send(entries);
          }),
        );
        for (;;) {
          const page = store.entries(instanceId, last, CONVERSATION_PAGE_MAX);
          send(page);
          if (page.length < CONVERSATION_PAGE_MAX) break;
        }
        replaying = false;
        send(held);
        let ending = false;
        const end = () => {
          if (ending) return;
          ending = true;
          const now = store.conversation(runId, instanceId);
          void sub
            .send(
              `event: end\ndata: ${JSON.stringify({ cut: now?.cut ?? false, ...(now?.swept ? { swept: now.swept } : {}) })}\n\n`,
            )
            .then(exit.done);
        };
        const check = () => {
          if (stream.aborted || stream.closed) return exit.done();
          // The Orchestrator is going away: the server waits for this request, so end it now.
          if (host.stopping) return end();
          const now = store.conversation(runId, instanceId);
          if (now?.cut || now?.swept) return end();
          if (!conversationOpen(runId, instanceId) && Date.now() - quietSince >= followGraceMs) end();
        };
        const timer = setInterval(check, Math.min(followGraceMs, 1_000));
        exit.onExit(() => clearInterval(timer));
        exit.onExit(host.onClose(check));
        exit.onExit(pinger(stream, sub, exit.done, pingMs));
        stream.onAbort(exit.done);
        check();
      });
    });
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
  const agentRegistration = (
    c: Context<JR2Env, "/agents/:instanceId/surface" | "/agents/:instanceId/events" | "/agents/:instanceId/notices">,
  ) => {
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
    if (!mayDeliverToAgent(principalOf(c), surface)) {
      // A control token for a DIFFERENT pod (or for a workspace-less run, which no pod owns), a
      // stated slot that is not this registration's (ADR-0076), or a fetch token. The first is the
      // check that keeps one feature's coder out of another's reviewer.
      return { error: c.json({ error: `this token cannot speak for instance "${instanceId}"` }, 403) };
    }
    return { surface };
  };

  // The Agent's Menu — every pick it can be offered in this Machine, with input schemas and
  // semantics, fixed for the conversation — and this Turn's Allowed picks (ADR-0029). A transition
  // swaps the registration, which swaps the Allowed picks, never the Menu; the Harness reads both
  // per Submission and needs no `list_changed`.
  // The same read at a step boundary carries the conversation's pending notices in its audience
  // (ADR-0062), reserved for this read: the Harness appends them and acknowledges them below.
  app.get("/agents/:instanceId/surface", authenticated, async (c) => {
    const { surface, error } = agentRegistration(c);
    if (error) return error;
    host.agentSurfaceServed(c.req.param("instanceId"));
    // A notice and a Steering message ride the read apart (ADR-0062): the Harness frames a message
    // by its author. One acknowledgment hears both, by the ids the read named.
    const held = await host.boundaryNotices(c.req.param("instanceId"));
    const notices = held.filter((h) => h.notice.kind !== "steering");
    const steering = held.flatMap((h) => (h.notice.kind === "steering" ? [{ id: h.id, message: h.notice }] : []));
    return c.json({ ...surface, notices, ...(steering.length > 0 ? { steering } : {}) });
  });

  // The Harness appended a step boundary's notices to the Turn (ADR-0062, ADR-0076): they are heard
  // in that conversation, ledgered in one save. An id this conversation did not reserve is ignored,
  // so the call says nothing a caller did not already know.
  app.post("/agents/:instanceId/notices", authenticated, async (c) => {
    const { error } = agentRegistration(c);
    if (error) return error;
    const body = await readJson(c.req.text());
    const heard = (body as { heard?: unknown }).heard;
    if (!Array.isArray(heard) || heard.some((id) => typeof id !== "string")) {
      return c.json({ error: "an acknowledgment names the notices heard: { heard: string[] }" }, 400);
    }
    return c.json({ heard: host.noticesHeard(c.req.param("instanceId"), heard as string[]) });
  });

  // A batch of a conversation's entries (ADR-0023), from the Harness that runs it, through its
  // Custodian. Only the control token of the pod that the run's admission ledger names, for the
  // ledger's slot: the ledger and not the live registration, because the ledger outlives the Turn
  // and the run, and the last batch of a Turn often comes after its sweep. The Instance token does
  // not open it: a holder of it can speak as an Agent, but it cannot write an Agent's kept
  // conversation. A batch that is sent again adds nothing (the store keeps each `seq` once).
  app.post("/agents/:instanceId/conversation", authenticated, async (c) => {
    const instanceId = c.req.param("instanceId");
    const store = opts.conversations;
    if (!store) return c.json({ error: "this Orchestrator keeps no conversation" }, 404);
    const principal = principalOf(c);
    if (auth && principal.kind !== "agent") {
      return c.json(
        { error: `only the Harness of the conversation's pod writes it: this token cannot (ADR-0023)` },
        403,
      );
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text) > CONVERSATION_BATCH_MAX) {
      return c.json({ error: `a batch is at most ${CONVERSATION_BATCH_MAX} bytes: send fewer entries` }, 413);
    }
    const parsed = conversationBatch.safeParse(await readJson(Promise.resolve(text)));
    if (!parsed.success) {
      return c.json(
        {
          error: `a batch is { entries: Array<{ id, seq, at, kind, text }> }: ${parsed.error.issues[0]?.message ?? "no entries"}`,
        },
        400,
      );
    }
    const place = await host.conversationPlace(instanceId);
    if (!place) return c.json({ error: `no run for instance "${instanceId}"` }, 404);
    if (place.agent === undefined) {
      // A live run whose ledger does not name the conversation yet: the batch came before the
      // admission's save. The Harness sends it again.
      if (place.live) return c.json({ error: `the run does not name instance "${instanceId}" yet — send again` }, 409);
      return c.json({ error: `run "${place.runId}" has no conversation "${instanceId}"` }, 404);
    }
    if (
      principal.kind === "agent" &&
      (place.sandbox === undefined ||
        place.sandbox !== principal.sandbox ||
        place.slot === undefined ||
        place.slot !== principal.slot)
    ) {
      return c.json({ error: `this token cannot write the conversation of instance "${instanceId}"` }, 403);
    }
    return c.json(store.append(place.runId, instanceId, place.agent, parsed.data.entries));
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
    if (!mayDeliverToAgent(principalOf(c), scope)) {
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
    // An LFS ask (ADR-0053): the objects a smudge, a cut or an attach needs. Checked here, so a
    // bad part is refused before anything is marked.
    let lfs: LfsAsk | undefined;
    if (body.lfs !== undefined) {
      const parsed = parseLfsAsk(body.lfs);
      if (typeof parsed === "string") return c.json({ error: parsed }, 400);
      lfs = parsed;
    }
    try {
      return c.json(await (lfs ? opts.fetchRepo(name, identity, lfs) : opts.fetchRepo(name, identity)));
    } catch (err) {
      // The scope refusal, and the only one: a Repo this Sandbox does not mount.
      if (err instanceof UnmountedRepoError) return c.json({ error: errMessage(err) }, 404);
      throw err;
    }
  });

  return app;
}

/**
 * The body of a request as the Hook's door reads it (ADR-0011): at most `max` bytes, and
 * `undefined` when the body is longer. A `content-length` above `max` reads nothing; else the
 * stream is read until it ends or passes `max`, and then it is cancelled. So an unbounded body is
 * never kept in memory.
 */
export function limitedBody(req: Request): (max: number) => Promise<Uint8Array | undefined> {
  return async (max) => {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > max) return undefined;
    if (req.body === null) return new Uint8Array();
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  };
}
