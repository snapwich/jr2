// The Adapter (ADR-0013): the jr2-owned sidecar that serves the current turn's tool menu to the
// Agent over MCP on `localhost`, and forwards the Agent's picks to the Orchestrator.
//
// It is a separate container from the Harness, and THAT IS THE WHOLE POINT. `local()` tools give
// the Agent code execution in the Harness container, so a credential there is a credential the
// Agent holds — and an Agent that can reach the delivery API can deliver `approve` to its own
// human-review Gate. Split them, and the Agent is confined to a `localhost` menu the Machine set
// for the turn it is already in. This is what makes ADR-0006's "the Agent never steers the
// workflow" ENFORCED rather than advertised.
//
// It is a translator, and holds no state of its own:
//
//   tools/list            → GET  {orchestrator}/agents/:iid/surface     → the invoking state's events
//   tools/call <name>     → POST {orchestrator}/agents/:iid/events      → validate + deliver
//   POST /fetch           → POST {orchestrator}/sandboxes/:name/fetch   → ask the node cache
//
// The third one is not the Agent's to say (ADR-0053): `jr2-upload-pack`, the program git runs for
// `origin`'s fetch url, asks on behalf of whoever ran `git fetch` — the Agent, or a human at a
// shell in any seat of the pod. It is the pod's only route out, and the Adapter forwards this one
// verb and no other, because the credential that makes it possible is here and nowhere else.
//
// The iid comes from the URL the Agent connects to (`/mcp/:iid`), and flue's Harness names it: a
// `defineAgent` initializer re-runs on every submission with `{ id, env }`, where `id` IS the agent
// instance id, so the persona connects to `${env.JR2_ADAPTER_URL}/mcp/${id}` per turn. The Adapter
// therefore never has to LEARN which turn is live — no push channel, no long-poll, no
// sandbox→turn index, no second inbound port on the pod. It asks, per connection, and the answer
// is the turn. (This is also why `list_changed` is unnecessary: flue re-lists on every submission,
// and a jr2 menu only ever changes at a turn boundary.)
//
// Every request it makes carries the Sandbox token — from the Secret the CR mounts into THIS
// container's env, and nowhere else in the pod.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One event on an agent's live surface, as the Orchestrator serves it. */
export type SurfaceEvent = {
  name: string;
  description?: string;
  /** The event's input schema, as JSON Schema — this becomes the MCP tool's input schema. */
  input: unknown;
  semantics: "ack" | "deferred" | "poll";
};

/** `GET /agents/:iid/surface` — the turn's menu. */
export type Surface = { instanceId: string; runId: string; sandbox?: string; accepts: SurfaceEvent[] };

/**
 * `POST /agents/:iid/events` — the answer to one pick, and the Agent's only way to learn what
 * became of it (ADR-0024). `turnComplete` says the state that asked for this turn has stopped
 * waiting; it is a hint that fails conservatively, not the thing that ends the turn. `moved` says a
 * transition accepted the pick at all (ADR-0029) — false is a well-formed pick that a guard
 * rejected, which without this field looked exactly like a pick that moved the Machine and left it
 * in the same state.
 *
 * The Orchestrator declares this shape too (`AgentDeliveryReceipt`), independently: it is the wire
 * between two packages, and neither imports the other.
 */
export type DeliveryReceipt = {
  delivered: boolean;
  event: string;
  /** Optional on the wire, and read fail-open (absent ≠ rejected): the Adapter ships as a stock
   * image and the Orchestrator as the instance image, so the two CAN skew. An Orchestrator too old
   * to send this must not make every receipt read as a rejection. */
  moved?: boolean;
  turnComplete: boolean;
  deliveryId: string;
};

/**
 * No live registration for this iid: the state exited, or the run settled.
 *
 * On the DELIVERY path this is the whole point — an Agent that picks against a turn nobody is
 * waiting on must be told so. On the SURFACE path it is not an error at all (ADR-0026): a turn
 * that is over has an empty menu, and `serverForTurn` swallows this to serve one.
 */
export class NoSurfaceError extends Error {}

/** A pause, for the surface read's backoff ladder. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The marker the `@kind` tier greps for, and therefore a CONTRACT — duplicated verbatim in
 * `@jr2/orchestrator`'s wire client (the two packages share no runtime dependency) and matched in
 * `features/steps/kind.steps.ts`. Renaming it on one side breaks no build; it silently turns the
 * tier's routability budget into a check that passes because it matches nothing.
 */
const ROUTABILITY_MARKER = "jr2.routability";

/**
 * What a retry at a lifecycle edge COST, emitted once, only when there was a cost.
 *
 * ADR-0042 absorbs these retries, and absorption is right — but a fault absorbed and never measured
 * is how "Ready is not routable" stayed invisible for three sessions. This is a log line, not a
 * run-feed event, so the workflow surface is untouched while the `@kind` tier gets a number it can
 * hold a budget against.
 *
 * `attempts` and `ms` measure different refusals and are both needed: a REJECT spends attempts and
 * almost no time, a dropped SYN spends time and almost no attempts (the tier's first live reading
 * was 2 attempts costing 10667ms — one connect timeout). `last` names which.
 */
function routabilityLine(
  seat: "admission" | "surface",
  url: string,
  attempts: number,
  ms: number,
  lastCode: string,
): string {
  return `${ROUTABILITY_MARKER} seat=${seat} attempts=${attempts} ms=${ms} last=${lastCode} url=${url}`;
}

/** The errno of a transport rejection, read structurally down the cause chain. */
function transportCode(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return "?";
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === "string") return code;
  const nested = Array.isArray(errors) ? errors[0] : cause;
  return nested === undefined || nested === null ? "?" : transportCode(nested, depth + 1);
}

/**
 * One rung of the ladder, drawn from its TOP HALF (equal jitter). Duplicated from the
 * Orchestrator's client on purpose — the two packages share no runtime dependency, and this is one
 * line of arithmetic, not a contract.
 *
 * Every Adapter in the cluster dials the SAME Orchestrator Service, so a restart puts all of them
 * on the same ladder at the same instant: un-jittered, they retry in lockstep and miss in lockstep.
 * The random half decorrelates them; the floor that remains is what keeps them off a Service that
 * is genuinely down.
 */
function jittered(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}

/**
 * Did this request fail without the Orchestrator answering at all? `fetch` rejects on transport
 * failure and resolves on every HTTP status, so the rejection itself is the whole test — an
 * answered request never lands here. `this.ok`'s throws are ordinary `Error`s and must NOT be
 * mistaken for one, so the check is the shape of a transport rejection: a `TypeError`, or anything
 * carrying an errno underneath.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return typeof (cause as { code?: unknown } | undefined)?.code === "string";
}

/**
 * The most specific thing a transport rejection says about itself. `fetch` reports every one of
 * them as `fetch failed`, and those three words in a pod log or a settlement message diagnose
 * nothing; the errno one level down (`connect ECONNREFUSED 10.96.0.7:4000`) is the answer.
 */
function transportDetail(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return String(err);
  const { message, cause, errors } = err as { message?: unknown; cause?: unknown; errors?: unknown };
  const nested = Array.isArray(errors) ? errors[0] : cause;
  if (nested !== undefined && nested !== null) {
    const deeper = transportDetail(nested, depth + 1);
    if (deeper) return deeper;
  }
  return typeof message === "string" ? message : String(err);
}

export type OrchestratorOptions = {
  /** Base URL of the Orchestrator, reachable FROM THE POD (Service DNS when deployed —
   * ADR-0019). The Agent never makes this call and is never told this address. */
  url: string;
  /** The Sandbox token (`JR2_SANDBOX_TOKEN`), from the Secret mounted into this container alone. */
  token: string;
  /** This pod's Sandbox (`JR2_SANDBOX`) — the name the ask route is addressed by, and the scope the
   * token is checked against (ADR-0053). Absent on the Instance Harness, which mounts no Repo and
   * therefore has nothing to fetch. */
  sandbox?: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Surface-read retry ladder and window (ADR-0042) — see `surface`. Defaults 250ms → 5s
   * (jittered per rung) over 90s; tests shrink them. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  retryWindowMs?: number;
  /** Where the routability line goes when a surface read had to retry — see `routabilityLine`.
   * Default `console.warn`; tests capture it. */
  log?: (line: string) => void;
  /** How long an ask may wait on the Orchestrator (ADR-0053). Default 85s: longer than the route's
   * own 60s + 15s budget, so a slow remote comes back as `stale` with the cache's timestamp rather
   * than as a transport failure here; shorter than the program's 90s, so the answer wins the race
   * against the program giving up on us. Tests shrink it. */
  askTimeoutMs?: number;
};

/**
 * What the Orchestrator answered an ask, relayed rather than read (ADR-0053).
 *
 * The Adapter is a translator on this path too, and a thinner one than on the Menu: it forwards the
 * verb and hands back the status and the bytes. `fetched` vs `stale` is between the Orchestrator
 * and the program that asked, and the program's fall-through — serve the cache, warn on stderr —
 * is the same for every answer that is not a landing. Parsing here would add a second opinion about
 * freshness to a decision that already has one.
 */
export type AskAnswer = { status: number; body: string };

/** The Orchestrator, as the Adapter uses it: read this turn's surface, deliver this turn's pick. */
export class OrchestratorClient {
  private readonly url: string;
  private readonly token: string;
  private readonly sandbox: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly retryWindowMs: number;
  private readonly askTimeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(opts: OrchestratorOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.sandbox = opts.sandbox;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.retryInitialMs = opts.retryInitialMs ?? 250;
    this.retryMaxMs = opts.retryMaxMs ?? 5_000;
    this.retryWindowMs = opts.retryWindowMs ?? 90_000;
    this.askTimeoutMs = opts.askTimeoutMs ?? 85_000;
    this.log = opts.log ?? ((line: string) => console.warn(line));
  }

  /**
   * This turn's Menu — and the read the WHOLE TURN rides on, which is why it is the one call here
   * that retries (ADR-0042).
   *
   * The Harness fetches its Menu before it asks the model anything, so a transport failure on this
   * hop settles the Submission `failed` with the model never dialed — and the Orchestrator treats
   * that as a terminal `agent.fault`. The hop is not as safe as it looks: the Adapter dials the
   * Orchestrator's SERVICE, which is between EndpointSlices every time the Orchestrator restarts
   * (ordinary, under ADR-0007's restore) and for a moment after a fresh namespace converges. Ready
   * is not routable here either.
   *
   * A GET is idempotent, so unlike an admission this retries on ANY transport failure rather than
   * only a never-delivered one — there is no second turn to accidentally start. Bounded, and the
   * fault names the address: `fetch failed` alone diagnoses nothing.
   *
   * `deliver` deliberately does NOT retry. A failed pick reaches the model as a tool error it can
   * act on — pick again, or pick differently — so the turn survives it; and a POST that may have
   * been delivered must not be re-sent, because a duplicate pick is a duplicate transition.
   */
  async surface(instanceId: string): Promise<Surface> {
    const url = `${this.url}/agents/${encodeURIComponent(instanceId)}/surface`;
    const startedAt = Date.now();
    const deadline = startedAt + this.retryWindowMs;
    let backoffMs = this.retryInitialMs;
    let attempts = 0;
    let lastCode = "?";
    for (;;) {
      attempts += 1;
      try {
        const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}` } });
        // Before the status is read: the measurement is about CONNECTING, and a 404 that took four
        // attempts to reach is the same routability cost as a 200 that did.
        if (attempts > 1) this.log(routabilityLine("surface", url, attempts, Date.now() - startedAt, lastCode));
        if (res.status === 404) throw new NoSurfaceError(`no live surface for agent "${instanceId}"`);
        return (await this.ok(res)) as Surface;
      } catch (err) {
        // An answered request is an answer, however unwelcome: a 404 is ADR-0026's turn-is-over,
        // and a 403 is a scope refusal. Only a request that never got one is worth re-asking.
        if (err instanceof NoSurfaceError || !isTransportFailure(err)) throw err;
        lastCode = transportCode(err);
        if (Date.now() >= deadline) {
          throw new Error(`the Orchestrator never answered ${url}: ${transportDetail(err)}`, { cause: err });
        }
        await sleep(jittered(backoffMs));
        backoffMs = Math.min(backoffMs * 2, this.retryMaxMs);
      }
    }
  }

  async deliver(instanceId: string, event: Record<string, unknown>): Promise<DeliveryReceipt> {
    const res = await this.fetchImpl(`${this.url}/agents/${encodeURIComponent(instanceId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(event),
    });
    if (res.status === 404) throw new NoSurfaceError(`no live surface for agent "${instanceId}"`);
    return (await this.ok(res)) as DeliveryReceipt;
  }

  /**
   * Ask the Orchestrator to have this pod's node cache fetch one Repo from its remote, and wait for
   * the landing (ADR-0053). One ask per `git fetch` inside the pod; the Orchestrator marks the
   * Sandbox CR and answers when the cache agent has reported a fetch no older than the mark.
   *
   * The Sandbox is named in the path and the token is checked against it, so this call can reach
   * the caches this pod mounts and nothing else — the same scope the Menu calls have, and the
   * reason no seat in the pod needed a git credential to get here.
   *
   * It does NOT retry. The wait it makes is already the long one, the caller is a fetch a person or
   * an Agent is watching, and a second ask would only re-mark an annotation the first one set. Every
   * failure — transport, status, timeout — is the same answer to the program: serve the cache and
   * say so on stderr. So a rejection here is turned into an answer rather than thrown.
   */
  async ask(identity: string): Promise<AskAnswer> {
    if (!this.sandbox) {
      return {
        status: 404,
        body: JSON.stringify({ error: "this Adapter serves no Sandbox, so it mounts no Repo to fetch (ADR-0053)" }),
      };
    }
    const url = `${this.url}/sandboxes/${encodeURIComponent(this.sandbox)}/fetch`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ identity }),
        signal: AbortSignal.timeout(this.askTimeoutMs),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      // `fetch failed` diagnoses nothing, and this string is what the program prints inside the
      // warning line a human reads under their own `git fetch` — so name the errno and the address.
      return {
        status: 502,
        body: JSON.stringify({ error: `the Orchestrator never answered ${url}: ${transportDetail(err)}` }),
      };
    }
  }

  /** A non-2xx `{ error }` becomes a throw — including 401/403, which must be LOUD: a silently
   * swallowed auth failure would look to the Agent exactly like a Machine that ignored it. */
  private async ok(res: Response): Promise<unknown> {
    const text = await res.text();
    const body = text ? (JSON.parse(text) as { error?: string }) : undefined;
    if (!res.ok) throw new Error(body?.error ?? `orchestrator answered HTTP ${res.status}`);
    return body;
  }
}

/**
 * Build the MCP server for ONE agent turn, from that turn's live surface.
 *
 * Every tool here is an event the invoking state declared it accepts — nothing more, and nothing
 * that outlives the state. The Agent cannot call what the Machine did not offer, and the
 * Orchestrator re-validates the payload on delivery anyway (the registration table owns that; the
 * Adapter is a translator, not a gatekeeper).
 *
 * A turn that is OVER gets an empty server, not an error (ADR-0026). This used to be an HTTP 404,
 * on the reasoning that "no menu" and "an empty menu" are different claims. They are — but the
 * distinction was not worth what it cost: the Harness re-initializes after the turn ends (to write
 * flue's own abort advisory), so the 404 fired on EVERY successful turn and logged an error every
 * time. A signal that cries wolf on the happy path cannot also be the alarm. Nothing real is lost:
 * with no tools registered, a `tools/call` is an unknown tool, and an Agent that picks against a
 * dead turn still fails loudly on the delivery path, where the claim is actually about acting.
 */
export async function serverForTurn(client: OrchestratorClient, instanceId: string): Promise<McpServer> {
  // `tools` is declared up front because the empty turn below has to answer `tools/list` without
  // ever registering a tool, and the SDK gates that handler on the capability.
  const server = new McpServer({ name: "jr2-adapter", version: "0.0.0" }, { capabilities: { tools: {} } });
  const surface = await liveSurface(client, instanceId);
  if (!surface) {
    // The SDK installs `tools/list` as a side effect of the first `registerTool`, and this turn
    // has none — so answer it here. An empty list is the truth; "method not found" would not be.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return server;
  }

  for (const event of surface.accepts) {
    if (event.semantics !== "ack") {
      // ADR-0013: `deferred`/`poll` are reserved in the model and have room on the wire, but nothing
      // answers a held call yet. Registering one as a plain tool would promise the Agent a result
      // that never comes, so refuse the whole turn rather than serve a lying contract.
      throw new Error(
        `event "${event.name}" is \`${event.semantics}\`, which the Adapter does not implement ` +
          `(ADR-0013: reserved, not built — an Agent must not be handed a tool whose contract is a lie)`,
      );
    }
    server.registerTool(
      event.name,
      { description: event.description, inputSchema: jsonSchemaToShape(event.input) },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const receipt = await client.deliver(instanceId, { type: event.name, ...args });
        return {
          content: [{ type: "text", text: receiptProse(receipt) }],
          structuredContent: receipt as unknown as Record<string, unknown>,
        };
      },
    );
  }
  return server;
}

/** This turn's menu, or `undefined` when the turn is over — the empty-menu rule above. */
async function liveSurface(client: OrchestratorClient, instanceId: string): Promise<Surface | undefined> {
  try {
    return await client.surface(instanceId);
  } catch (err) {
    if (err instanceof NoSurfaceError) return undefined;
    throw err;
  }
}

/**
 * The receipt in WORDS (ADR-0024), because a model reads text before `structuredContent`. What the
 * Agent used to get back was a UUID, printed twice, against instructions that say it must finish by
 * calling the tool and never say when finishing is finished — so it called again. Say the three
 * things it needs: the pick arrived, the workflow consumed it, the turn is over.
 */
function receiptProse(receipt: DeliveryReceipt): string {
  const delivered = `Delivered "${receipt.event}" to the workflow (delivery ${receipt.deliveryId}).`;
  // Order matters: a rejected pick is also `turnComplete: false`, and saying only that sends the
  // Agent back to do the same thing again (ADR-0029). Say what it can act on FIRST.
  if (receipt.moved === false) {
    return (
      `${delivered} The workflow did NOT act on it: no transition in its current state accepts ` +
      `"${receipt.event}" with these arguments. Your turn is not over. Do not repeat this call ` +
      `unchanged — change the arguments, pick a different tool, or do more work first.`
    );
  }
  return receipt.turnComplete
    ? `${delivered} The workflow consumed it and moved on: your turn is over. Stop here — do not call this or any other tool again.`
    : `${delivered} The workflow is still in the state that asked for this turn, so it is not over yet.`;
}

/**
 * Rebuild a zod shape from the def's JSON Schema, because that is the only currency the two ends
 * share: the Orchestrator serves JSON Schema (a zod object cannot cross HTTP), and the MCP SDK's
 * `registerTool` wants a zod shape. Deliberately shallow — the Adapter does NOT re-validate, the
 * registration table does (once, for both dialects). What this shape is for is the tool's ADVERTISED
 * signature: the Agent's model reads it to know which arguments the tool takes.
 */
function jsonSchemaToShape(schema: unknown): Record<string, z.ZodType> {
  const doc = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const required = new Set(doc?.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(doc?.properties ?? {})) {
    const base = leaf(prop?.type);
    shape[name] = required.has(name) ? base : base.optional();
  }
  return shape;
}

/** One JSON-Schema scalar as a zod type; anything richer degrades to `unknown` (see above). */
function leaf(type: string | undefined): z.ZodType {
  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.object({}).loose();
    default:
      return z.unknown();
  }
}
