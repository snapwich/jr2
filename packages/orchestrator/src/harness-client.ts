// The real, Harness-wire-backed `AgentRunPort` (ADR-0027, on ADR-0002/0007/0016) — the client that
// drives one Agent run over the five-endpoint wire — and the canonical `agentRun` actor built on it
// (ADR-0011: workflows import it statically; the client is constructed from `input.endpoint`).
//
// The wire is j2's own (`@j2/harness/wire` is the shape contract; the stub Harness is the normative
// server model), so this module speaks plain `fetch` — no SDK. Keeping it here (not in `actor.ts`)
// is what keeps the run-lifecycle actor and its unit tests wire-free (see actor.ts header). The
// port is built over an INJECTABLE client (`harnessAgentRunPort(client)`) so the mapping logic is
// unit-testable against a fake; `createHarnessClient(opts)` is the real thing, itself testable
// socket-free through an injected `fetch`.
//
// Channel split (ADR-0002, refined by ADR-0016): the Harness wire carries **lifecycle only** —
// domain events go up the MCP channel via the Adapter. The client's `send`/`wait` pair is exactly
// that lifecycle surface: `send` answers with a serializable Admission
// (`{ streamUrl, offset, submissionId }` — j2's durable re-attach handle, stored in the host
// ledger), and `wait(admission)` follows the durable stream from the admission offset to the
// Submission's Settlement — a long-poll loop that advances by the `stream-next-offset` header and
// reconnects from the SAME offset on network failure (capped backoff, indefinitely: pod death is
// `workspace.lost`'s job to report, not this loop's to guess). Re-attach after a restart is `wait`
// with the SAME persisted admission; replay cost is bounded by one Submission's chunks. A 404 is a
// LOST conversation (ADR-0027: a conversation lives as long as its Harness process) — a
// `SettlementFault`, never an endless poll.
//
// Both verbs re-send on a network failure, for one reason stated twice: an unanswered request is
// not an answer. They differ in bound, and the difference is where the Submission is — `wait`'s is
// already admitted, so the lease may report a dead pod and this loop need never give up, while
// `send`'s does not exist yet, so its window closes and faults. `send` also re-sends ONLY what
// provably never left this host (`postAdmission` — ADR-0042: it is the first thing ever to dial a
// Sandbox's Service, and a CR at `phase: Ready` is not yet routable).
//
// `abort` is the third verb, and ADR-0024 wires it to the END OF THE INVOCATION: a turn ends with
// the state that asked for it. It sweeps the running Submission and everything queued behind it to
// the distinct `aborted` Settlement — worth having for observability, though j2 never reads it
// (the actor is stopped by then; see actor.ts).

import { agentRunActorWith } from "./actor.ts";
import type { AgentAdmission, AgentRunInput, AgentRunPort } from "./actor.ts";
import type { ThinkingLevel } from "./agent.ts";
import type { EchoEvent, Settlement, StreamEvent, SubmissionSettledEvent } from "@j2/harness/wire";

// Wire literals, restated: `@j2/harness` is a types-only devDependency here (the orchestrator
// ships without it), so the value constants in `@j2/harness/wire` cannot be imported — the
// wire-shape tests hold the two in agreement.
const STREAM_NEXT_OFFSET_HEADER = "stream-next-offset";
const VIEW_UPDATES = "updates";
const LIVE_LONG_POLL = "long-poll";

/** The three-verb wire client (the injectable seam — structurally what `@flue/sdk`'s
 * `agents.{send,wait,abort}` was, minus the SDK). */
export type HarnessClient = {
  /** `POST /agents/:name/:id {message, model?, thinkingLevel?}` → the Admission, with `streamUrl`
   * resolved absolute. The optional dials are this Submission's override layer (ADR-0018);
   * omitted, the Harness runs the definition's own values. */
  send(
    agentName: string,
    instanceId: string,
    options: { message: string; model?: string; thinkingLevel?: ThinkingLevel; signal?: AbortSignal },
  ): Promise<AgentAdmission>;
  /** Follow the stream to this Submission's Settlement: resolve on `completed`, reject with
   * `SettlementFault` on `failed`/`aborted`/404. */
  wait(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void>;
  /** `POST /agents/:name/:id/abort`. The `{ aborted }` answer is dropped (ADR-0024). */
  abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void>;
};

export type HarnessClientOptions = {
  /** The Harness base URL — what a workspace publishes, or a stub's `url`. */
  baseUrl: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Reconnect backoff floor/ceiling (capped exponential, jittered per rung — see `jittered`;
   * network failures only, an answered long-poll re-polls immediately). Defaults 250ms → 5s; tests
   * shrink them. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /**
   * How long `send` keeps re-POSTing an admission that never reached the Harness. See
   * `postAdmission` for why this window exists and why it is BOUNDED where `wait`'s reconnect is
   * not.
   *
   * Default 90s, taken from the longest delays anyone has MEASURED rather than from the mechanism.
   * The mechanism argues for much less — kube-proxy programs the EndpointSlice in well under a
   * second, and CoreDNS's 30s negative TTL is the only other obvious floor — but kubernetes#88986
   * records 63s on bare metal (a SYN-retransmit ladder, 1-2-4-8-16-32: dropped, not refused) and
   * kind#2280 records up to 77s with the EndpointSlices already populated. This started at 60s,
   * reasoned from the mechanism alone, and cleared neither. Tests shrink it.
   */
  admitWindowMs?: number;
  /** Where the routability line goes when an admission had to retry — see `routabilityLine`.
   * Default `console.warn`; tests capture it. */
  log?: (line: string) => void;
};

/** A Submission that settled `failed`/`aborted` — or whose conversation the Harness no longer
 * has (404) — surfaced to the actor as an `agent.fault`. Replaces the SDK's execution error. */
export class SettlementFault extends Error {
  /** The Settlement as the stream carried it; absent when the conversation itself was lost. */
  readonly settlement?: Settlement;
  constructor(message: string, settlement?: Settlement) {
    super(message);
    this.name = "SettlementFault";
    this.settlement = settlement;
  }
}

/** Build the real wire client from connection options. */
export function createHarnessClient(options: HarnessClientOptions): HarnessClient {
  const { baseUrl } = options;
  const fetchImpl = options.fetch ?? fetch;
  const backoffInitialMs = options.backoffInitialMs ?? 250;
  const backoffMaxMs = options.backoffMaxMs ?? 5_000;
  const admitWindowMs = options.admitWindowMs ?? 90_000;
  const log = options.log ?? ((line: string) => console.warn(line));

  const conversationUrl = (agentName: string, instanceId: string) =>
    new URL(`/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`, baseUrl).toString();

  /**
   * POST the admission, re-sending it while the request DEMONSTRABLY never left this host.
   *
   * This is `wait`'s reconnect rule, applied one step earlier and for the same reason: a request
   * that could not connect is not a Harness that refused the prompt. It matters here because the
   * admission is the FIRST thing j2 ever sends over the Sandbox's Service — provisioning waits on
   * the CR's `phase: Ready`, which the operator computes from the POD, and the attach reaches the
   * pod through the API server, so nothing before this has proven the Service dialable. Ready is
   * not routable: the EndpointSlice behind the ClusterIP is programmed after the pod passes its
   * probe, and until it is, kube-proxy REJECTs — which arrives here as a refused connection.
   * Un-retried, that single blip lost the whole turn (the actor calls an admission failure a
   * terminal `agent.fault`), which is exactly the flake that kept the `@kind` tier serial.
   *
   * Only a NEVER-DELIVERED failure is re-sent. Admission is accept-and-queue (ADR-0027): a POST
   * the Harness received but could not answer has already queued a Submission, so re-sending it
   * would run the turn twice — worse than losing it. `neverDelivered` is therefore the narrow
   * question "did this reach the wire at all", never "does this look transient".
   *
   * And the window is BOUNDED where `wait`'s is not. `wait` may reconnect forever because its
   * Submission is already admitted, so the lease owns the reporting (`workspace.lost` — ADR-0021).
   * Nothing is admitted yet here, so there is no turn for a lease to be about: an address that
   * never answers is a fault this call has to name itself.
   */
  const postAdmission = async (url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    const startedAt = Date.now();
    const deadline = startedAt + admitWindowMs;
    let backoffMs = backoffInitialMs;
    let attempts = 0;
    let lastCode = "?";
    for (;;) {
      attempts += 1;
      try {
        const res = await fetchImpl(url, init);
        // Only when it actually cost something. A window that is never approached should be silent,
        // so that a line appearing at all is already the signal (see `routabilityLine`).
        if (attempts > 1) log(routabilityLine("admission", url, attempts, Date.now() - startedAt, lastCode));
        return res;
      } catch (err) {
        lastCode = transportCode(err);
        // A local abandon propagates untranslated, exactly as in `wait` — the stopped actor
        // swallows it, and it is not a fault.
        if (signal?.aborted) throw err;
        if (!neverDelivered(err)) throw err;
        if (Date.now() >= deadline) {
          throw new Error(
            `harness admission never connected to ${url} after ${attempts} attempt(s) over ` +
              `${admitWindowMs}ms: ${transportDetail(err)}`,
            { cause: err },
          );
        }
        await sleep(jittered(backoffMs), signal);
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
      }
    }
  };

  return {
    async send(agentName, instanceId, sendOptions) {
      const url = conversationUrl(agentName, instanceId);
      const res = await postAdmission(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: sendOptions.message,
            // Omitted when unset, so an admission with no dials is byte-identical to before.
            ...(sendOptions.model ? { model: sendOptions.model } : {}),
            ...(sendOptions.thinkingLevel ? { thinkingLevel: sendOptions.thinkingLevel } : {}),
          }),
          signal: sendOptions.signal,
        },
        sendOptions.signal,
      );
      if (!res.ok) {
        throw new Error(`harness admission failed (${res.status}): ${await errorDetail(res)}`);
      }
      const admission = (await res.json()) as AgentAdmission;
      // The Harness may mint `streamUrl` relative to itself; the ledgered handle must re-attach
      // without remembering this client's baseUrl, so absolutize it here (absolute passes through).
      return { ...admission, streamUrl: new URL(admission.streamUrl, baseUrl).toString() };
    },

    async wait(admission, opts) {
      const signal = opts?.signal;
      let offset = admission.offset;
      let backoffMs = backoffInitialMs;
      for (;;) {
        signal?.throwIfAborted();
        const url = new URL(admission.streamUrl, baseUrl);
        url.searchParams.set("offset", offset);
        url.searchParams.set("view", VIEW_UPDATES);
        url.searchParams.set("live", LIVE_LONG_POLL);

        let events: StreamEvent[];
        let nextOffset: string | null;
        try {
          const res = await fetchImpl(url.toString(), { signal });
          if (res.status === 404) {
            throw new SettlementFault(
              `conversation lost: the harness answered 404 for submission "${admission.submissionId}" — ` +
                `a conversation lives as long as its Harness process (ADR-0027)`,
            );
          }
          if (!res.ok && res.status !== 204) {
            throw new ReconnectableError(`harness stream read failed (${res.status})`);
          }
          nextOffset = res.headers.get(STREAM_NEXT_OFFSET_HEADER);
          events = res.status === 204 ? [] : ((await res.json()) as StreamEvent[]);
        } catch (err) {
          // Local abandon propagates untranslated (the stopped actor swallows it); a lost
          // conversation is final. Everything else is the network — reconnect from the SAME
          // offset, forever, backing off to the cap.
          if (signal?.aborted) throw err;
          if (err instanceof SettlementFault) throw err;
          await sleep(jittered(backoffMs), signal);
          backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
          continue;
        }
        backoffMs = backoffInitialMs;

        for (const event of events) {
          if (event.type !== "submission-settled" || event.submissionId !== admission.submissionId) continue;
          if (event.outcome === "completed") return;
          throw new SettlementFault(faultMessage(event), toSettlement(event));
        }
        if (nextOffset !== null) offset = nextOffset;
      }
    },

    async abort(agentName, instanceId, opts) {
      const res = await fetchImpl(`${conversationUrl(agentName, instanceId)}/abort`, {
        method: "POST",
        signal: opts?.signal,
      });
      if (!res.ok) {
        throw new Error(`harness abort failed (${res.status}): ${await errorDetail(res)}`);
      }
      // Drain the `{ aborted }` answer so the socket is released; the value is dropped (ADR-0024).
      await res.json().catch(() => undefined);
    },
  };
}

/** Build an `AgentRunPort` over an injected wire client. Stateless — the admission IS the handle. */
export function harnessAgentRunPort(client: HarnessClient): AgentRunPort {
  return {
    async admit(input: AgentRunInput, opts?: { signal?: AbortSignal }): Promise<AgentAdmission> {
      if (input.prompt === undefined) {
        throw new Error("harness admit needs a prompt (a re-attach rides input.attach, set by the host on restore)");
      }
      return await client.send(input.agentName, input.instanceId, {
        message: input.prompt,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        signal: opts?.signal,
      });
    },

    async settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void> {
      await client.wait(admission, { signal: opts?.signal });
    },

    async abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void> {
      // The result (`{ aborted }` — whether there was work to end) is dropped: by the time this
      // runs the state has already moved on, and an idle instance is exactly as fine as a
      // stopped one. Settlement is asynchronous and nothing here is listening (ADR-0024).
      await client.abort(agentName, instanceId, { signal: opts?.signal });
    },
  };
}

/** Convenience: build the real wire client from connection options, then the `AgentRunPort`. */
export function createHarnessAgentRunClient(options: HarnessClientOptions): AgentRunPort {
  return harnessAgentRunPort(createHarnessClient(options));
}

/**
 * The run-narrative echo push (ADR-0023): `POST /echo { events }` against one Workspace Harness,
 * bearing the Instance token (the endpoint is instance-token-gated — the Harness verifies the
 * bearer against the token's sha-256, never holding the token itself). The payload is the
 * STRUCTURED feed events; the Harness renders. A non-OK answer rejects, and the CALLER treats
 * that as log-and-continue — fire-and-forget lives in the tee (run-host.ts), not here, so a test
 * can still assert a push failed.
 */
export function createEchoPush(options: {
  baseUrl: string;
  /** The Instance token — the echo bearer. */
  token: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}): (events: EchoEvent[]) => Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  return async (events) => {
    const url = new URL("/echo", options.baseUrl).toString();
    // The echo is log-only, un-retried, and fires at workspace attach — which makes it the FIRST
    // thing to touch a Sandbox's Service and therefore j2's earliest witness that the Service is
    // not routable yet (ADR-0042). It is only a witness if it says what went wrong: bare
    // `fetch failed` in the pod log is what let that condition hide.
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ events }),
    }).catch((err: unknown) => {
      throw new Error(`harness echo to ${url} failed: ${transportDetail(err)}`, { cause: err });
    });
    if (!res.ok) {
      throw new Error(`harness echo failed (${res.status}): ${await errorDetail(res)}`);
    }
    // Drain the `{ printed }` answer so the socket is released; the count is nobody's contract.
    await res.json().catch(() => undefined);
  };
}

/**
 * THE `agentRun` actor (ADR-0011): pre-registered by `j2Setup` (ADR-0015), importable statically.
 * Everything live is constructed per-invocation from serializable input: the wire client from
 * `input.endpoint` (which Sandbox's Harness — or the wire-compatible dev stub; either way it's
 * only a URL, one code path). Lives here, not in actor.ts, so the actor logic and its unit tests
 * never touch the wire.
 */
export const agentRun = agentRunActorWith((endpoint) => createHarnessAgentRunClient({ baseUrl: endpoint }));

/** A stream read worth retrying (server hiccup) — internal to the reconnect loop, never thrown out. */
class ReconnectableError extends Error {}

/** Errnos that mean no connection was ever established. `getaddrinfo`/`connect` say it by syscall;
 * undici's own connect timeout says it by code. Deliberately short — anything not on this list is
 * treated as possibly-delivered (see `postAdmission`). */
const NEVER_DELIVERED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const NEVER_DELIVERED_SYSCALLS = new Set(["connect", "getaddrinfo"]);

/**
 * Did this rejection happen BEFORE any byte of the request reached the wire?
 *
 * `fetch` reports transport failures as a generic `TypeError: fetch failed` and puts the real
 * errno on `cause`, which for a dual-stack address is an `AggregateError` over one attempt per
 * family — so the answer is only ever legible by walking down. Read structurally (syscall/code),
 * never by matching the message: the message is the part that changes between Node versions.
 */
/**
 * The most specific thing a transport rejection says about itself. `fetch` reports every one of
 * them as the same three words — `fetch failed` — and that string, arriving as an `agent.fault`
 * reason or a log line, names nothing an operator can act on. The errno one level down
 * (`connect ECONNREFUSED 10.96.0.7:8080`, `getaddrinfo ENOTFOUND …`) is the whole diagnosis.
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

function neverDelivered(err: unknown, depth = 0): boolean {
  if (depth > 4 || typeof err !== "object" || err === null) return false;
  const { code, syscall, cause, errors } = err as {
    code?: unknown;
    syscall?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof syscall === "string" && NEVER_DELIVERED_SYSCALLS.has(syscall)) return true;
  if (typeof code === "string" && (code === "UND_ERR_CONNECT_TIMEOUT" || NEVER_DELIVERED_CODES.has(code))) return true;
  if (Array.isArray(errors) && errors.some((nested) => neverDelivered(nested, depth + 1))) return true;
  return neverDelivered(cause, depth + 1);
}

/** A readable fault message from a non-`completed` Settlement. */
function faultMessage(settlement: Settlement): string {
  const detail = settlement.error?.message ?? settlement.error?.type;
  return detail ? `submission settled ${settlement.outcome}: ${detail}` : `submission settled ${settlement.outcome}`;
}

/** The Settlement fields alone, off the stream chunk's envelope. */
function toSettlement(event: SubmissionSettledEvent): Settlement {
  const { submissionId, outcome, error } = event;
  return { submissionId, outcome, ...(error ? { error } : {}) };
}

/** Best-effort error body for a non-OK answer (the wire's error shape is `{ error }`). */
async function errorDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : res.statusText || "no detail";
}

/**
 * The marker the `@kind` tier greps for, and therefore a CONTRACT — duplicated verbatim in
 * `@j2/adapter` (the two packages share no runtime dependency) and matched in
 * `features/steps/kind.steps.ts`. Renaming it on one side does not break a build; it silently turns
 * the tier's routability budget into a check that passes because it matches nothing.
 */
const ROUTABILITY_MARKER = "j2.routability";

/**
 * What a retry at a lifecycle edge COST, emitted once, only when there was a cost.
 *
 * ADR-0042 absorbs these retries (ADR-0016's principle: no event, no budget on the authoring
 * surface), and absorption is the right call — but a fault that is absorbed and never measured is
 * how "Ready is not routable" stayed invisible for three sessions. Absorbing and measuring are not
 * in conflict: this is a log line, not a run-feed event, so nothing about the workflow surface
 * changes and the `@kind` tier can still assert a budget on the window it currently only benefits
 * from. Scoped deliberately to the two hops ADR-0042 is about — `wait`'s reconnect is a live
 * stream re-attaching, not a Service coming into existence, and does not belong in this number.
 *
 * `attempts` and `ms` are BOTH here because they measure different refusals, and the tier's first
 * live reading proved it: 2 attempts costing 10667ms, which is one dropped SYN sitting on undici's
 * 10s connect timeout, not a ladder being climbed. A REJECT (kube-proxy with no ready backend)
 * spends attempts and almost no time; a DROP spends time and almost no attempts. `last` carries the
 * errno of the final failure so the line says WHICH without anyone having to do that arithmetic.
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

/** The errno of a transport rejection, read structurally down the cause chain (`transportDetail`
 * gives the prose; this gives the one token worth aggregating on). */
function transportCode(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return "?";
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === "string") return code;
  const nested = Array.isArray(errors) ? errors[0] : cause;
  return nested === undefined || nested === null ? "?" : transportCode(nested, depth + 1);
}

/**
 * One rung of the ladder, drawn from its TOP HALF (equal jitter).
 *
 * The ladder on its own is synchronized, and the callers arrive together by construction: Sandboxes
 * that converge together cross the same routability window together, so their retries land
 * together, miss together, and re-land together — the ladder turns one late Service into a
 * lockstep herd. Randomizing half the interval decorrelates them. Keeping the other half as a floor
 * is the part worth stating: it is what still holds four clients off a Service that is genuinely
 * down, which full jitter (uniform over the whole interval) would trade away.
 */
function jittered(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}

/** An abortable pause — the reconnect backoff. Rejects with the signal's reason, untranslated. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
