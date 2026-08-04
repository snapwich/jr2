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
  /** Reconnect backoff floor/ceiling (capped exponential; network failures only — an answered
   * long-poll re-polls immediately). Defaults 250ms → 5s; tests shrink them. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
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

  const conversationUrl = (agentName: string, instanceId: string) =>
    new URL(`/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`, baseUrl).toString();

  return {
    async send(agentName, instanceId, sendOptions) {
      const res = await fetchImpl(conversationUrl(agentName, instanceId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: sendOptions.message,
          // Omitted when unset, so an admission with no dials is byte-identical to before.
          ...(sendOptions.model ? { model: sendOptions.model } : {}),
          ...(sendOptions.thinkingLevel ? { thinkingLevel: sendOptions.thinkingLevel } : {}),
        }),
        signal: sendOptions.signal,
      });
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
          await sleep(backoffMs, signal);
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
    const res = await fetchImpl(new URL("/echo", options.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ events }),
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
