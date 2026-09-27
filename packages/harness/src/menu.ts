// The Menu (ADR-0013/0027): one Submission's read of the turn's surface, and each accepted event
// as a pick the model can make. This module knows the wire and nothing of the model's library:
// `menu-tools.ts` presents the Menu to pi, with no MCP between them.
//
// The Harness reads the surface from the Orchestrator itself, through the Custodian on this pod's
// loopback (`$JR2_CUSTODIAN_URL`, ADR-0059). It sends `Authorization: Bearer <Stand-in>`: its env
// holds the Sandbox token's Stand-in, never the token, and the Custodian — a container the Agent
// executes nothing in — puts the token on the three routes this needs and on no other. So the
// Agent, which has code execution here, holds nothing the Orchestrator would accept, and
// everything a pick is judged by is judged there: the token's scope, the live registration, the
// event's name and payload (ADR-0013).
//
//   GET  /agents/<iid>/surface   → this turn's Menu (404: the turn is over — an EMPTY Menu, ADR-0026)
//   POST /agents/<iid>/events    → one pick, and the receipt, rendered as prose (ADR-0024/0029)
//
// Each Submission reads afresh, and the iid in the path is how the Orchestrator knows which turn is
// live — no push channel, no turn index (ADR-0013's enabling fact).

/**
 * One pick on the Menu. `name` is the event's name made safe for a model API, bare: whoever
 * presents the Menu adds its own prefix. `pick` delivers and answers the receipt as prose, and
 * THROWS on every failure, so the model reads the message as an error it can act on.
 */
export type MenuItem = {
  /** The event's name, as the Orchestrator knows it. */
  event: string;
  name: string;
  description: string;
  /** The event's input, as JSON Schema — without `$schema`. */
  parameters: Record<string, unknown>;
  pick: (params: unknown, signal?: AbortSignal) => Promise<string>;
};

/** One turn's Menu. */
export type Menu = MenuItem[];

/** One event on an agent's live surface, as the Orchestrator serves it. */
export type SurfaceEvent = {
  name: string;
  description?: string;
  /** The event's input schema, as JSON Schema — this becomes the tool's parameters. */
  input: unknown;
  semantics: "ack" | "deferred" | "poll";
};

/** `GET /agents/:iid/surface` — the turn's menu. */
export type Surface = { instanceId: string; runId: string; sandbox?: string; accepts: SurfaceEvent[] };

/**
 * `POST /agents/:iid/events` — the answer to one pick, and the Agent's only way to learn what
 * became of it (ADR-0024). `turnComplete` says the state that asked for this turn has stopped
 * waiting; it is a hint that fails conservatively, not the thing that ends the turn. `moved` says a
 * transition accepted the pick at all (ADR-0029).
 *
 * The Orchestrator declares this shape too (`AgentDeliveryReceipt`), independently: it is the wire
 * between two packages, and neither imports the other.
 */
export type DeliveryReceipt = {
  delivered: boolean;
  event: string;
  /** Optional on the wire, and read fail-open (absent ≠ rejected): the Harness ships as a stock
   * image and the Orchestrator as the instance image, so the two CAN skew. */
  moved?: boolean;
  turnComplete: boolean;
  deliveryId: string;
};

export type MenuOptions = {
  /** The Custodian's control listener — `$JR2_CUSTODIAN_URL` (ADR-0059). */
  url: string;
  /** What this container holds for the Sandbox token: its Stand-in (`$JR2_SANDBOX_TOKEN`). */
  token: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Surface-read retry ladder and window (ADR-0042) — see `readSurface`. Defaults 250ms → 5s
   * (jittered per rung) over 90s; tests shrink them. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  retryWindowMs?: number;
  /** How long one surface read may wait for its answer before it is retried. Default 10s. */
  attemptTimeoutMs?: number;
  /** Where the routability line goes when a surface read had to retry. Default `console.warn`. */
  log?: (line: string) => void;
};

/**
 * The marker the `@kind` tier greps for, and therefore a CONTRACT — duplicated verbatim in
 * `@jr2/orchestrator`'s wire client (the two packages share no runtime dependency) and matched in
 * `features/steps/kind.steps.ts`. Renaming it on one side breaks no build; it silently turns the
 * tier's routability budget into a check that passes because it matches nothing.
 */
const ROUTABILITY_MARKER = "jr2.routability";

/** No live registration for this iid: the state exited, or the run settled. */
class NoSurfaceError extends Error {}

/** The Custodian's own word that the Orchestrator never answered (custodian.ts) — a transport
 * failure one hop further out, told apart from an answer by the header it carries. */
class UnreachableError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** flue's sanitization, reproduced: the model-facing name admits `[A-Za-z0-9_-]` only. */
function sanitizeToolNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * This turn's Menu. An empty one is valid (ADR-0026: a turn that is over has an empty Menu): no
 * items, no error. A surface read that fails for any other reason propagates: a turn that cannot
 * see its Menu settles `failed` (ADR-0027), and turn.ts owns that mapping. The Submission's `signal`
 * cancels a read in flight — an abort must promote the next admission promptly (ADR-0024).
 */
export async function readMenu(opts: MenuOptions, instanceId: string, signal?: AbortSignal): Promise<Menu> {
  const surface = await readSurface(opts, instanceId, signal);
  if (!surface) return [];
  return surface.accepts.map((event) => {
    if (event.semantics !== "ack") {
      // ADR-0013: `deferred`/`poll` are reserved in the model and have room on the wire, but nothing
      // answers a held call yet. Offering one as a plain tool would promise the Agent a result that
      // never comes, so the whole turn is refused rather than served a lying contract.
      throw new Error(
        `event "${event.name}" is \`${event.semantics}\`, which the Harness does not implement ` +
          `(ADR-0013: reserved, not built — an Agent must not be handed a tool whose contract is a lie)`,
      );
    }
    return {
      event: event.name,
      name: sanitizeToolNamePart(event.name),
      description: event.description ?? "",
      parameters: parametersOf(event.input),
      pick: async (params, pickSignal) =>
        receiptProse(
          await deliver(
            opts,
            instanceId,
            // The name last: an argument called `type` cannot make this pick another event.
            { ...((params ?? {}) as object), type: event.name },
            pickSignal,
          ),
        ),
    };
  });
}

/**
 * The event's JSON Schema, as the pick's advertised signature. It is what the Orchestrator
 * validates the pick against, so the model sees the real contract. `$schema` is dropped: it names
 * a dialect, not a parameter, and model APIs take the schema body alone.
 */
function parametersOf(input: unknown): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = (input ?? { type: "object", properties: {} }) as Record<string, unknown>;
  return schema;
}

/**
 * The receipt in WORDS (ADR-0024), because a model reads text first. What the Agent used to get
 * back was a UUID, printed twice, against instructions that say it must finish by calling the tool
 * and never say when finishing is finished — so it called again. Say the three things it needs: the
 * pick arrived, the workflow consumed it, the turn is over.
 */
export function receiptProse(receipt: DeliveryReceipt): string {
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
 * The read the WHOLE TURN rides on, which is why it is the one call here that retries (ADR-0042).
 *
 * The Menu is read before the model is asked anything, so a transport failure on this hop settles
 * the Submission `failed` with the model never dialed — a terminal `agent.fault`. The hop is not as
 * safe as it looks: the Custodian dials the Orchestrator's SERVICE, which is between EndpointSlices
 * every time the Orchestrator restarts and for a moment after a fresh namespace converges. So a
 * read that never got an answer — this process's own transport failure, or the Custodian's word
 * that the Orchestrator never answered it — is asked again, on a jittered ladder, and what that
 * cost is logged once. An ANSWER is final: a 404 is ADR-0026's turn-is-over, a 403 a scope refusal.
 *
 * Delivery deliberately does NOT retry: a failed pick reaches the model as a tool error it can act
 * on, and a POST that may have been delivered must not be re-sent — a duplicate pick is a duplicate
 * transition.
 */
async function readSurface(opts: MenuOptions, instanceId: string, signal?: AbortSignal): Promise<Surface | undefined> {
  const url = `${base(opts)}/agents/${encodeURIComponent(instanceId)}/surface`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const retryMaxMs = opts.retryMaxMs ?? 5_000;
  const attemptMs = opts.attemptTimeoutMs ?? 10_000;
  // A monotonic clock: the window and the logged cost do not move with the wall clock.
  const startedAt = performance.now();
  const deadline = startedAt + (opts.retryWindowMs ?? 90_000);
  let backoffMs = opts.retryInitialMs ?? 250;
  let attempts = 0;
  let lastCode = "?";
  for (;;) {
    attempts += 1;
    // An answer that never comes is retried like one that could not be sent: a read is idempotent.
    const attempt = AbortSignal.timeout(attemptMs);
    try {
      const res = await fetchImpl(url, {
        headers: authorization(opts),
        signal: signal ? AbortSignal.any([signal, attempt]) : attempt,
      });
      await unreachable(res);
      // Before the status is read: the measurement is about CONNECTING, and a 404 that took four
      // attempts to reach is the same routability cost as a 200 that did.
      if (attempts > 1) {
        log(
          `${ROUTABILITY_MARKER} seat=surface attempts=${attempts} ms=${Math.round(performance.now() - startedAt)} last=${lastCode} url=${url}`,
        );
      }
      if (res.status === 404) return undefined;
      return (await answered(res)) as Surface;
    } catch (err) {
      if (signal?.aborted) throw err;
      const timedOut = attempt.aborted;
      if (!timedOut && !(err instanceof UnreachableError) && !isTransportFailure(err)) throw err;
      lastCode = timedOut ? "timeout" : err instanceof UnreachableError ? err.code : transportCode(err);
      if (performance.now() >= deadline) {
        const detail = timedOut
          ? `no answer within ${attemptMs} ms`
          : err instanceof UnreachableError
            ? err.message
            : transportDetail(err);
        throw new Error(`the Orchestrator never answered ${url}: ${detail}`, { cause: err });
      }
      await sleep((backoffMs * (1 + Math.random())) / 2, signal);
      backoffMs = Math.min(backoffMs * 2, retryMaxMs);
    }
  }
}

/** One pick, delivered. A pick against a turn nobody waits on any more fails LOUDLY: an empty Menu
 * is not a permissive one (ADR-0026). */
async function deliver(
  opts: MenuOptions,
  instanceId: string,
  event: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DeliveryReceipt> {
  const url = `${base(opts)}/agents/${encodeURIComponent(instanceId)}/events`;
  let res: Response;
  try {
    res = await (opts.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization(opts) },
      body: JSON.stringify(event),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new Error(`the pick never reached the Orchestrator (${transportDetail(err)}) — try it again`, { cause: err });
  }
  await unreachable(res);
  if (res.status === 404) throw new NoSurfaceError(`no live surface for agent "${instanceId}" — this turn is over`);
  return (await answered(res)) as DeliveryReceipt;
}

function base(opts: MenuOptions): string {
  return opts.url.replace(/\/+$/, "");
}

function authorization(opts: MenuOptions): Record<string, string> {
  return { authorization: `Bearer ${opts.token}` };
}

/** Throw the Custodian's "never answered", so it reads as the transport failure it is. */
async function unreachable(res: Response): Promise<void> {
  if (res.headers.get("x-jr2-custodian") !== "unreachable") return;
  const body = (await res.json().catch(() => ({}))) as { detail?: string; flags?: string };
  throw new UnreachableError(
    `the Custodian could not reach it (${body.detail ?? "no detail"})`,
    `custodian:${body.flags ?? "?"}`,
  );
}

/** A non-2xx `{ error }` becomes a throw — including 401/403, which must be LOUD: a silently
 * swallowed auth failure would look to the Agent exactly like a Machine that ignored it. */
async function answered(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: { error?: string } | undefined;
  try {
    body = text ? (JSON.parse(text) as { error?: string }) : undefined;
  } catch {
    body = { error: text.trim() };
  }
  if (!res.ok) throw new Error(body?.error ?? `the Orchestrator answered HTTP ${res.status}`);
  return body;
}

/**
 * Did this request fail without anything answering at all? `fetch` rejects on transport failure
 * and resolves on every HTTP status, so the rejection is the test — but this module's own throws
 * are ordinary `Error`s and must NOT be mistaken for one: a `TypeError`, or an errno underneath.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return typeof (cause as { code?: unknown } | undefined)?.code === "string";
}

/** The errno of a transport rejection, read structurally down the cause chain. */
function transportCode(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return "?";
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === "string") return code;
  const nested = Array.isArray(errors) ? errors[0] : cause;
  return nested === undefined || nested === null ? "?" : transportCode(nested, depth + 1);
}

/** The most specific thing a transport rejection says about itself: `fetch failed` diagnoses
 * nothing, the errno one level down (`connect ECONNREFUSED 127.0.0.1:8081`) is the answer. */
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

/** A pause on the ladder that an abort ends at once. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
