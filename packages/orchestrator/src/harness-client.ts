// The real, Harness-wire-backed `AgentRunPort` (ADR-0027, on ADR-0002/0007/0016) — the client that
// drives one Agent run over the five-endpoint wire — and `agent(definition)`, the Agent slot built
// on it (ADR-0049: a Machine carries its Agents; the client is constructed from `input.endpoint`).
//
// The wire is jr2's own (`./wire.ts` is the shape contract as this client reads it; the stub Harness
// is the normative server model), so this module speaks plain `fetch` — no SDK. Keeping it here (not in `actor.ts`)
// is what keeps the run-lifecycle actor and its unit tests wire-free (see actor.ts header). The
// port is built over an INJECTABLE client (`harnessAgentRunPort(client)`) so the mapping logic is
// unit-testable against a fake; `createHarnessClient(opts)` is the real thing, itself testable
// socket-free through an injected `fetch`.
//
// Channel split (ADR-0002, refined by ADR-0016): the Harness wire carries **lifecycle only** —
// domain events go up the Menu, through the pod's Custodian. The client's `send`/`wait` pair is exactly
// that lifecycle surface: `send` answers with a serializable Admission
// (`{ streamUrl, offset, submissionId }` — jr2's durable re-attach handle, stored in the host
// ledger), and `wait(admission)` follows the durable stream from the admission offset to the
// Submission's Settlement — a long-poll loop that advances by the `stream-next-offset` header and
// reconnects from the SAME offset on network failure (capped backoff, indefinitely: a lost pod is
// `workspace.lost`'s to report and a restarted Harness the Agent actor's, both off the watch —
// ADR-0021 — never this loop's to guess). Re-attach after a restart is `wait`
// with the SAME persisted admission; replay cost is bounded by one Submission's chunks. A 404 is a
// LOST conversation (ADR-0027: the Harness no longer holds it — a persisted conversation survives a
// Harness restart, ADR-0031, and one it cannot rebuild or has freed does not) — a
// `SettlementFault`, never an endless poll. A Submission a restart cut settles `failed` on the
// rebuilt stream (ADR-0031), which is read like any other Settlement.
//
// Both verbs re-send on a network failure, for one reason stated twice: an unanswered request is
// not an answer. They differ in bound, and the difference is where the Submission is — `wait`'s is
// already admitted, so the watch may report a dead pod or Harness and this loop need never give up, while
// `send`'s does not exist yet, so its window closes and faults. `send` also re-sends ONLY what
// provably never left this host (`postAdmission` — ADR-0042: it is the first thing ever to dial a
// Sandbox's Service, and a CR at `phase: Ready` is not yet routable).
//
// `abort` is the third verb, and ADR-0024 wires it to the END OF THE INVOCATION: a turn ends with
// the state that asked for it. It sweeps the running Submission and everything queued behind it to
// the distinct `aborted` Settlement — worth having for observability, though jr2 never reads it
// (the actor is stopped by then; see actor.ts).

import { agentActorWith } from "./actor.ts";
import type {
  AgentAdmission,
  AgentAdmitOptions,
  AgentLogic,
  AgentRunInput,
  AgentRunPort,
  AgentSettleOptions,
  ListedKill,
} from "./actor.ts";
import type { AgentDeclaration, AgentDefinition, ThinkingLevel } from "./agent.ts";
import {
  commandWith,
  ExecNotSent,
  ExecRefused,
  type Arg,
  type CommandInput,
  type CommandOptions,
  type CommandOutput,
  type OpenCommandInput,
  type EnvOpenParts,
  type EffectLogic,
  type ExecPort,
} from "./effect.ts";
import { open } from "./open.ts";
import type { OpenEffect, OpenOf } from "./open-effect.ts";
import {
  LIVE_LONG_POLL,
  STREAM_NEXT_OFFSET_HEADER,
  VIEW_HISTORY,
  VIEW_UPDATES,
  type EchoEvent,
  type ExecRead,
  type ExecRequest,
  type LiveConversation,
  type LiveSetRequest,
  type LiveSetResponse,
  type MemoryKillsResponse,
  MAX_KILL_NAME,
  MAX_KILL_STAMP,
  MAX_KILLS_BODY,
  MAX_TOLD,
  type Notice,
  type Settlement,
  type StreamEvent,
  type SubmissionSettledEvent,
} from "./wire.ts";

/** The three-verb wire client (the injectable seam — structurally what `@flue/sdk`'s
 * `agents.{send,wait,abort}` was, minus the SDK). */
export type HarnessClient = {
  /** `POST /agents/:name/:id {message, cwd?, definition, model?, thinkingLevel?}` → the Admission,
   * with `streamUrl` resolved absolute. The FRAME is `message` and `cwd` — what this Turn is about
   * and where it works (ADR-0057), flat siblings on the body. The DEFINITION is the slot's,
   * carried by the Machine and sent with every admission (ADR-0049) — the Harness keeps no roster,
   * so `:name` alone would name nothing there — and it travels as IDENTITY alone, because this
   * verb strips `description` (ADR-0057; see {@link admittedDefinition}). The optional dials are this Submission's override
   * layer (ADR-0018); omitted, the Harness runs the definition's own values. */
  send(
    agentName: string,
    instanceId: string,
    options: {
      message: string;
      /** Where the Working tools are rooted for this Turn (ADR-0057). Omitted, the Harness keeps
       * `/work` — the stub-Harness run with no Workspace. */
      cwd?: string;
      definition: AgentDefinition;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      /** The pending notices in this admission's scope (ADR-0062). Omitted when there are none. */
      notices?: Notice[];
      signal?: AbortSignal;
    },
  ): Promise<AgentAdmission>;
  /** Follow the stream to this Submission's Settlement: resolve on `completed`, reject with
   * `SettlementFault` on `failed`/`aborted`/404. A guard kill read on the way is handed to
   * `onMemoryLimit` (ADR-0061). */
  wait(admission: AgentAdmission, opts?: AgentSettleOptions): Promise<void>;
  /** `GET /agents/:name/:id?view=history`: does the Harness still hold this conversation? Only a
   * 404 says no (ADR-0027: a GET on an unknown conversation is 404); anything else — another
   * status, a transport failure — says yes, because unknown is never loss (ADR-0062). */
  holds(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** `GET /memory-kills`: the pod's guard kills (ADR-0061, ADR-0062). A request that never left
   * this host, and a draining Harness's 503, are sent again until `signal` ends the read — the
   * caller owns the read's limit (the Agent actor's 5 s); with no signal, it is sent once. Any other
   * answer but a 200 that reads — a Harness that keeps none, a transport failure, the caller's
   * timeout — is `undefined`, "could not tell": the Harness still holds what it kept, and the next
   * admission reads again. A kill with no id or time, with an id or a time outside the wire's bounds
   * (`wire.ts`), or with a time that does not parse, is skipped; one whose `peak` or `limit` is not
   * a size is kept without sizes, and one whose `told` holds an entry that is not a conversation, or
   * a name outside the bounds, is kept without that entry — each fault said. Absent sizes are no fault: the pod left them out.
   * Each fault is one line, said when it starts. A read that works says nothing, and the next fault
   * after it is said again. */
  memoryKills(opts?: { signal?: AbortSignal }): Promise<ListedKill[] | undefined>;
  /** `POST /agents/:name/:id/abort`. The `{ aborted }` answer is dropped (ADR-0024). */
  abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void>;
};

export type HarnessClientOptions = {
  /** The Harness base URL — what a workspace publishes, or a stub's `url`. */
  baseUrl: string;
  /** The Harness bearer for this placement (ADR-0058; `harnessToken` in tokens.ts) — sent on
   * every call, the long-poll included. Absent only where no placement exists: an explicit-
   * `endpoint` run against the stub Harness, which checks nothing. */
  token?: string;
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
  /** The conversation itself is gone (404): its Harness no longer holds it (ADR-0027). One of the
   * faults the Agent actor asks the Sandbox about, to name a memory kill (ADR-0061). */
  readonly lost: boolean;
  constructor(message: string, settlement?: Settlement, opts: { lost?: boolean } = {}) {
    super(message);
    this.name = "SettlementFault";
    this.settlement = settlement;
    this.lost = opts.lost === true;
  }
}

/** The Harnesses whose memory kills this process could not read, each said once (`memoryKills`).
 * Per process, not per client: an Agent actor builds a client for each Turn. */
const killReadFaults = new Set<string>();

/** The Harnesses whose kills — on the list or on a stream — held a field this process could not
 * use, each said once until a clean read. Per process, like `killReadFaults`. Neither set is cleaned
 * when a Workspace goes: no hook reaches this module from the Sandbox's destroy, and an entry is
 * one URL per Sandbox this process ever read. */
const badKillFaults = new Set<string>();

/** Say once, until a clean read, that a Harness's kills held a field this process could not use. */
function badKill(baseUrl: string, log: (line: string) => void, what: string): void {
  if (badKillFaults.has(baseUrl)) return;
  badKillFaults.add(baseUrl);
  log(`harness ${baseUrl}: ${what} (ADR-0062)`);
}

/** A size as the guard writes one (`1.9Gi`, `512Mi`), short. The Agent's uid can write the file
 * the list is read from, and these words go into the next Agent's Briefing as they are, so
 * nothing else passes (ADR-0062). */
function isSize(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16 && /^\d{1,6}(\.\d{1,3})?(Ki|Mi|Gi|Ti)$/.test(value);
}

/** A string no longer than `max` characters. The bounds are the wire's (`wire.ts`), the same as
 * the Harness's: the Harness counts the bytes of the JSON text, which are never fewer, so a kill it
 * keeps is one this process keeps. An answer larger than `MAX_KILLS_BODY` is no list to act on:
 * the Harness answers no list that large. */
const fits = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** One kill of the list as this process can use it, or undefined when it has no id or time, when
 * its id or time is outside the wire's bounds, or when its time does not parse — the only kills
 * that are dropped. Sizes that are not sizes are left out, so the kill is kept with no sizes; a
 * `told` entry that is not a conversation, or whose name is outside the bounds, is left out of
 * `told`. */
function listedKill(value: unknown): ListedKill | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, at, peak, limit, told } = value as Record<string, unknown>;
  if (!fits(id, MAX_KILL_STAMP) || !fits(at, MAX_KILL_STAMP) || Number.isNaN(Date.parse(at))) return undefined;
  const conversations = (Array.isArray(told) ? told.slice(0, MAX_TOLD) : []).filter(
    (t): t is { agent: string; instanceId: string } =>
      typeof t === "object" && t !== null && fits(t.agent, MAX_KILL_NAME) && fits(t.instanceId, MAX_KILL_NAME),
  );
  const sized = isSize(peak) && isSize(limit);
  return {
    id,
    at,
    told: conversations.map(({ agent, instanceId }) => ({ agent, instanceId })),
    ...(sized ? { peak, limit } : {}),
  };
}

/** Whether a listed kill came through as the wire states it. */
function whole(raw: unknown, kill: ListedKill | undefined): boolean {
  if (kill === undefined) return false;
  const { peak, limit, told } = raw as { peak?: unknown; limit?: unknown; told?: unknown };
  // Sizes the pod left out are no fault; sizes it sent that are not sizes are.
  if (kill.limit === undefined && (peak !== undefined || limit !== undefined)) return false;
  return Array.isArray(told) && Math.min(told.length, MAX_TOLD) === kill.told.length && told.length <= MAX_TOLD;
}

/** A timeout's abort reason (`AbortSignal.timeout`): a read that ran out of time, not an abandon. */
function isTimeout(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

/** Build the real wire client from connection options. */
export function createHarnessClient(options: HarnessClientOptions): HarnessClient {
  const { baseUrl } = options;
  const fetchImpl = options.fetch ?? fetch;
  const backoffInitialMs = options.backoffInitialMs ?? 250;
  const backoffMaxMs = options.backoffMaxMs ?? 5_000;
  const admitWindowMs = options.admitWindowMs ?? 90_000;
  const log = options.log ?? ((line: string) => console.warn(line));
  const authorization: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {};

  const conversationUrl = (agentName: string, instanceId: string) =>
    new URL(`/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`, baseUrl).toString();

  /**
   * POST the admission, re-sending it while the request DEMONSTRABLY never left this host.
   *
   * This is `wait`'s reconnect rule, applied one step earlier and for the same reason: a request
   * that could not connect is not a Harness that refused the prompt. It matters here because
   * provisioning waits on the CR's `phase: Ready`, which the operator computes from the POD, and
   * a Workspace-less Turn (the Instance Harness) has no attach before it — so this can be the first
   * request ever sent over a Service. (A Sandbox's attach, `POST /attach` since ADR-0063, dials it
   * first and retries the same way.) Ready is not routable: the EndpointSlice behind the ClusterIP is programmed after the pod passes its
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
   * Submission is already admitted, so the watch owns the reporting (`workspace.lost`, or the
   * Harness restart that ends the Turn — ADR-0021).
   * Nothing is admitted yet here, so there is no turn for a lease to be about: an address that
   * never answers is a fault this call has to name itself.
   *
   * A draining Harness's 503 is re-sent on the same ladder (ADR-0031): the Harness answers it
   * before it reads the body, so it queued nothing, and it closes the connection with it, so the
   * next attempt dials the Service again — which reaches the replacement once it serves. It is the
   * one answer re-sent: every other status is the Harness's word about this admission.
   */
  const postAdmission = async (url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    const startedAt = Date.now();
    const deadline = startedAt + admitWindowMs;
    let backoffMs = backoffInitialMs;
    let attempts = 0;
    let lastCode = "?";
    for (;;) {
      attempts += 1;
      let res: Response;
      try {
        res = await fetchImpl(url, init);
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
        continue;
      }
      if (res.status === DRAINING && Date.now() < deadline) {
        lastCode = `HTTP${DRAINING}`;
        await res.body?.cancel();
        await sleep(jittered(backoffMs), signal);
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
        continue;
      }
      // Only when it actually cost something. A window that is never approached should be silent,
      // so that a line appearing at all is already the signal (see `routabilityLine`).
      if (attempts > 1) log(routabilityLine("admission", url, attempts, Date.now() - startedAt, lastCode));
      return res;
    }
  };

  return {
    async send(agentName, instanceId, sendOptions) {
      const url = conversationUrl(agentName, instanceId);
      const res = await postAdmission(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authorization },
          body: JSON.stringify({
            message: sendOptions.message,
            // The other half of the Frame (ADR-0057): where this Turn works. Omitted only when
            // UNSET, and the Harness keeps `/work`; anything else — including the empty string a
            // miscomputed worktree path would produce — travels, because a `cwd` the Harness
            // cannot read as an absolute path is a 400 there. Dropping it here would hand that
            // Turn the `/work` default instead: the silent wrong directory ADR-0057 exists for.
            ...(sendOptions.cwd === undefined ? {} : { cwd: sendOptions.cwd }),
            // The Agent this Turn runs (ADR-0049) — plain data, validated at admission by the
            // Harness, which 400s naming the slot rather than settling a Submission `failed`.
            // IDENTITY only: `description` is stripped here (ADR-0057). It is Console material —
            // `machine-doc.ts` and the surface read it — and the Harness neither validates nor
            // uses it, so it has no business on the Turn's wire.
            definition: admittedDefinition(sendOptions.definition),
            // Omitted when unset, so an admission with no dials is byte-identical to before.
            ...(sendOptions.model ? { model: sendOptions.model } : {}),
            ...(sendOptions.thinkingLevel ? { thinkingLevel: sendOptions.thinkingLevel } : {}),
            // The Briefing's news (ADR-0062): typed data, the Harness writes the words. Omitted
            // when there is none, so an admission without notices is byte-identical to before.
            ...(sendOptions.notices?.length ? { notices: sendOptions.notices } : {}),
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
          const res = await fetchImpl(url.toString(), { headers: authorization, signal });
          if (res.status === 404) {
            throw new SettlementFault(
              `conversation lost: the harness answered 404 for submission "${admission.submissionId}" — ` +
                `the Harness no longer holds this conversation (ADR-0027, ADR-0031)`,
              undefined,
              { lost: true },
            );
          }
          // Refused, not unreachable: the bearer is derived, so a Harness that rejects it now
          // rejects it on every retry — reconnecting would park the Turn forever, silently.
          if (res.status === 401 || res.status === 403) {
            throw new SettlementFault(
              `harness refused the stream read (${res.status}) for submission "${admission.submissionId}": ` +
                `${await errorDetail(res)} — the bearer is not this placement's (ADR-0058)`,
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
          if (event.type === "memory-limit") {
            const { id, peak, limit, conversationId, position } = event;
            // A size that is not one is not put in a Briefing (the Agent's uid can write the record):
            // the kill is kept, with no sizes, and the fault is said.
            const sized = isSize(peak) && isSize(limit);
            if (!sized)
              badKill(baseUrl, log, "a memory kill on a stream has sizes that are not sizes — kept without them");
            // An older Harness's event has no id: keyed by its place on the stream, exactly as the
            // Orchestrator before raised it, so a replayed read is the same kill and it can never
            // mark a later kill seen. An id too long to be one is no id.
            const kill = fits(id, MAX_KILL_STAMP)
              ? { id }
              : { id: `${conversationId}@${position.batch}.${position.index}`, legacy: true as const };
            opts?.onMemoryLimit?.({ ...kill, ...(sized ? { peak, limit } : {}) });
            continue;
          }
          if (event.type !== "submission-settled" || event.submissionId !== admission.submissionId) continue;
          if (event.outcome === "completed") return;
          throw new SettlementFault(faultMessage(event), toSettlement(event));
        }
        if (nextOffset !== null) offset = nextOffset;
      }
    },

    async holds(agentName, instanceId, opts) {
      const url = new URL(conversationUrl(agentName, instanceId));
      url.searchParams.set("view", VIEW_HISTORY);
      // Asked as a restart is seen, when the new container may not listen yet: a request that
      // never left this host, and a draining Harness's 503, are sent again until the caller's
      // signal ends the wait — then, and on any other failure, unknown is never loss.
      let backoffMs = backoffInitialMs;
      for (;;) {
        let again = false;
        try {
          const res = await fetchImpl(url.toString(), { headers: authorization, signal: opts?.signal });
          // Drain the body so the socket is released; the snapshot itself is not the question.
          await res.body?.cancel().catch(() => undefined);
          if (res.status !== DRAINING) return res.status !== 404;
          again = true;
        } catch (err) {
          if (opts?.signal?.aborted && !isTimeout(opts.signal.reason)) throw err;
          again = !opts?.signal?.aborted && neverDelivered(err);
        }
        if (!again || opts?.signal === undefined) return true;
        try {
          await sleep(jittered(backoffMs), opts.signal);
        } catch (err) {
          if (opts.signal.aborted && !isTimeout(opts.signal.reason)) throw err;
          return true;
        }
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
      }
    },

    async memoryKills(opts) {
      const url = new URL("/memory-kills", baseUrl).toString();
      // Idempotent, so re-sent on what `postAdmission` re-sends — a request that never left this
      // host, a draining Harness's 503 — on the same ladder, until the caller's signal ends it. The
      // limit is the caller's alone, so there is one clock for it.
      let backoffMs = backoffInitialMs;
      let why: string;
      for (;;) {
        let again = false;
        try {
          const res = await fetchImpl(url, { headers: authorization, signal: opts?.signal });
          if (res.status === 200 && Number(res.headers.get("content-length") ?? 0) > MAX_KILLS_BODY) {
            await res.body?.cancel().catch(() => undefined);
            why = `the answer is larger than ${MAX_KILLS_BODY} bytes`;
          } else if (res.status === 200) {
            const text = await res.text();
            const kills =
              text.length > MAX_KILLS_BODY ? undefined : (JSON.parse(text) as Partial<MemoryKillsResponse>).kills;
            if (Array.isArray(kills)) {
              // A read that works ends the fault: the next fault is said again.
              killReadFaults.delete(baseUrl);
              const read = kills.map(listedKill);
              const usable = read.filter((kill): kill is ListedKill => kill !== undefined);
              const flawed = kills.filter((raw, i) => !whole(raw, read[i])).length;
              if (flawed === 0) badKillFaults.delete(baseUrl);
              else {
                badKill(
                  baseUrl,
                  log,
                  `${flawed} of its memory kills are not the wire's shape — those with no id or time, or with one outside the wire's bounds or a time that does not parse, are skipped, the others are kept without the fields that were wrong`,
                );
              }
              return usable;
            }
            why = "the answer is not a list of kills";
          } else {
            why = `HTTP ${res.status}: ${await errorDetail(res)}`;
            again = res.status === DRAINING;
          }
        } catch (err) {
          // A local abandon propagates, as in every other verb; a timeout the caller set is none.
          if (opts?.signal?.aborted && !isTimeout(opts.signal.reason)) throw err;
          why = transportDetail(err);
          again = !opts?.signal?.aborted && neverDelivered(err);
        }
        if (!again || opts?.signal === undefined) break;
        try {
          await sleep(jittered(backoffMs), opts?.signal);
        } catch (err) {
          if (opts?.signal?.aborted && !isTimeout(opts.signal.reason)) throw err;
          why = "the read's time ran out";
          break;
        }
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
      }
      // One line for each fault: said when it starts. A read that works says nothing, and the next
      // fault after it is said again.
      if (!killReadFaults.has(baseUrl)) {
        killReadFaults.add(baseUrl);
        log(
          `harness ${baseUrl}: cannot read its memory kills (${why}) — no notice from them now; the Harness keeps them, and the next admission reads again (ADR-0062)`,
        );
      }
      return undefined;
    },

    async abort(agentName, instanceId, opts) {
      const res = await fetchImpl(`${conversationUrl(agentName, instanceId)}/abort`, {
        method: "POST",
        headers: authorization,
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

/** The definition as the ADMISSION carries it (ADR-0057): identity alone. `description` is
 * Console material the Orchestrator strips before admission — the Harness has no use for it and
 * no longer validates it. Every other field travels, so a field added to the definition reaches
 * the Harness without a change here. */
function admittedDefinition(definition: AgentDefinition): Omit<AgentDefinition, "description"> {
  const { description: _description, ...identity } = definition;
  return identity;
}

/** Build an `AgentRunPort` over an injected wire client. Stateless — the admission IS the handle. */
export function harnessAgentRunPort(client: HarnessClient): AgentRunPort {
  return {
    async admit(input: AgentRunInput, opts: AgentAdmitOptions): Promise<AgentAdmission> {
      if (input.prompt === undefined) {
        throw new Error("harness admit needs a prompt (a re-attach rides input.attach, set by the host on restore)");
      }
      return await client.send(input.agentName, input.instanceId, {
        message: input.prompt,
        // The Frame's other half (ADR-0057) — absent on a workspace-less run, where `/work` is
        // what the Harness keeps. Absent means UNSET: a cwd the mapper computed travels as it is,
        // to the Harness's refusal if it is not a path.
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        definition: opts.definition,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        ...(opts.notices?.length ? { notices: opts.notices } : {}),
        signal: opts.signal,
      });
    },

    async settle(admission: AgentAdmission, opts?: AgentSettleOptions): Promise<void> {
      await client.wait(admission, opts);
    },

    async holds(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
      return await client.holds(agentName, instanceId, opts);
    },

    async memoryKills(opts?: { signal?: AbortSignal }): Promise<ListedKill[] | undefined> {
      return await client.memoryKills(opts);
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
 * bearing that placement's Harness bearer (ADR-0058 — the Harness verifies it against a sha-256,
 * never holding it at rest). The payload is the
 * STRUCTURED feed events; the Harness renders. A non-OK answer rejects, and the CALLER treats
 * that as log-and-continue — fire-and-forget lives in the tee (run-host.ts), not here, so a test
 * can still assert a push failed.
 */
export function createEchoPush(options: {
  baseUrl: string;
  /** The Workspace's Harness bearer (ADR-0058). Absent only against the stub Harness. */
  token?: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}): (events: EchoEvent[]) => Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  return async (events) => {
    const url = new URL("/echo", options.baseUrl).toString();
    // The echo is log-only, un-retried, and fires at workspace attach — which makes it the FIRST
    // thing to touch a Sandbox's Service and therefore jr2's earliest witness that the Service is
    // not routable yet (ADR-0042). It is only a witness if it says what went wrong: bare
    // `fetch failed` in the pod log is what let that condition hide.
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
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
 * Build the live-set statement for the Instance Harness (ADR-0031): `PUT /agents
 * { live: [{ agent, instanceId }] }` → `{ freed }`, and the Harness frees memory and files of every
 * conversation not named. The whole set every time — level-triggered, so a missed statement costs
 * nothing and the next one says it all again. Un-retried, like the echo: the caller is a timer.
 */
export function createLiveSetPush(options: {
  baseUrl: string;
  /** The Instance Harness's bearer (ADR-0058). Absent only against the stub Harness. */
  token?: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}): (live: LiveConversation[]) => Promise<LiveSetResponse> {
  const fetchImpl = options.fetch ?? fetch;
  return async (live) => {
    const url = new URL("/agents", options.baseUrl).toString();
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ live } satisfies LiveSetRequest),
    }).catch((err: unknown) => {
      throw new Error(`live-set statement to ${url} failed: ${transportDetail(err)}`, { cause: err });
    });
    if (!res.ok) {
      throw new Error(`live-set statement failed (${res.status}): ${await errorDetail(res)}`);
    }
    const { freed } = (await res.json().catch(() => ({}))) as Partial<Record<keyof LiveSetResponse, unknown>>;
    return { freed: typeof freed === "number" ? freed : 0 };
  };
}

/**
 * Make an Agent: an actor slot that runs one Turn of a model each time a state invokes it. Put it
 * under `actors` in `jr2Setup`, and invoke it by its key: `actors: { coder: agent(…) }`, then
 * `invoke: { src: "coder", input: { prompt } }`. The key is the Agent's name.
 *
 * The invoke's `input` is the Turn: `prompt` (required), `cwd`, `model`, `thinkingLevel` and
 * `continue`. `cwd` is the absolute directory where the Working tools work. Absent, it is the
 * Worktree of the Workspace's one Repo Slot. `continue: true` continues the Agent's conversation
 * in this Machine. Absent, each Turn starts a new conversation. The Turn ends when the state that
 * invoked the Agent exits, usually on a pick from the Agent's Menu.
 *
 * The actor of an Agent never finishes, so an `onDone` on its invoke never runs. Give the Agent a
 * pick, such as `finish`, and route on it.
 *
 * An Agent with `workspace: "write"` or `"read"` works in a Sandbox, so invoke it inside a
 * `workspace()` body. An Agent with `workspace: "none"` can run anywhere. A model can lack the
 * definition's thinking level: see {@link ThinkingLevel}.
 *
 * When a Turn starts, it refuses:
 * - a key in `input` that a Turn does not have: ``agent "<slot>": the Turn's input carries
 *   `<key>`, which a Turn has no use for — its input is its Frame (`prompt`, `cwd`), its Dials
 *   (`model`, `thinkingLevel`), and `continue` (ADR-0057)``
 * - no `cwd` under a Workspace with more than one Repo Slot: ``turn <id>: agent "<slot>" works
 *   under a Workspace carrying more than one Repo Slot (<slots>) and its Turn framed no `cwd` —
 *   say which Worktree it works in (`cwd: context.workspace.repos.<slot>`, one of those), because
 *   the kit gives no slot a meaning (ADR-0051) and a Turn's Frame is where it works (ADR-0057)``
 * - a `cwd` that is not an absolute path: ``agent "<slot>": the Turn's Frame carries a `cwd` that
 *   is not an absolute path — the Frame says WHERE this Turn works (ADR-0057), and a Turn rooted
 *   anywhere else would work in the wrong directory silently``. The Harness makes this refusal
 *   when it admits the Turn, and the error starts with `harness admission failed (400): `.
 * - an Agent with Working tools outside a `workspace()`: ``turn <id>: agent "<slot>" has
 *   workspace: "<access>" — invoke it inside a workspace() (ambient resolution), or pass an
 *   explicit `endpoint` (workspace-less stub path)``
 * - a `model` that is still `open`: ``agent "<slot>" has an Open model — nobody bound it; bind it
 *   where the Machine is registered (`customize(<machine>, { agents: { <slot>: { model:
 *   "<provider>/<model>" } } })`), because a packaged Machine cannot pick a model on your behalf
 *   (ADR-0054)``. `jr2 up` refuses this before it builds anything.
 *
 * @param declaration - The Agent's definition (see {@link AgentDefinition}). `model` may be `open`
 *   in a Machine that you publish as a package.
 * @returns The actor logic of the Agent's slot.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";
 *
 * const finish = defineEvent({
 *   name: "finish",
 *   description: "Call this when `node --test` passes.",
 *   input: z.object({}),
 * });
 * const runInput = z.object({ branch: z.string() });
 * type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { input: BodyInput; context: BodyInput },
 *   events: [finish],
 *   actors: {
 *     coder: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You fix failing tests. You change no test.",
 *     }),
 *   },
 * }).createMachine({
 *   id: "fix",
 *   context: ({ input }) => input,
 *   initial: "coding",
 *   states: {
 *     coding: {
 *       invoke: {
 *         src: "coder",
 *         input: ({ context }) => ({
 *           prompt: "Make `node --test` pass, then commit.",
 *           cwd: context.workspace.repos.app,
 *           thinkingLevel: "high",
 *         }),
 *       },
 *       on: { finish: "done" },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   input: runInput,
 *   repos: { app: "https://github.com/you/app.git" },
 *   spec: ({ input }) => ({ branch: input.branch }),
 * });
 * ```
 *
 * @see docs/concepts/agents-and-turns.md
 * @see docs/guides/write-a-workflow.md
 * @see docs/reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md
 * @see docs/reference/decisions/0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md
 */
export function agent(declaration: AgentDeclaration): AgentLogic {
  // THE authoring surface for an Agent (ADR-0049): one definition in, one actor slot out. The
  // slot key is the Agent's name (the Harness route, the minted iid, the markers), so a name the
  // Machine does not carry is a compile error on `src`, and two Machines in one run may each carry
  // their own `coder`.
  //
  // Everything live is constructed per-invocation from serializable input: the wire client from
  // `input.endpoint` (which Sandbox's Harness — or the wire-compatible dev stub; either way it's
  // only a URL, one code path). Lives here, not in actor.ts, so the actor logic and its unit
  // tests never touch the wire.
  //
  // It takes a DECLARATION (ADR-0054), so a packaged Machine may write `agent({ model: open, … })`
  // and leave the one part it cannot honestly fill to whoever registers it. What rides the Turn
  // is still an `AgentDefinition`: the actor narrows on start and refuses an Open one there.
  return agentActorWith(
    (endpoint, bearer) => createHarnessAgentRunClient({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) }),
    declaration,
  );
}

/**
 * The Harness's exec (ADR-0067), as a `command` Effect drives it: `POST /exec/:id` to start,
 * `GET /exec/:id` long-polled by offset, `POST /exec/:id/kill` when the Effect's state exits (sent
 * again until the Harness keeps it), `DELETE /exec/:id` once the output is ledgered. A start that
 * never reached the wire rejects `ExecNotSent`, the one start failure sent again: a Harness runs one
 * id once only within its own process, so a start that reached one that then restarted would run
 * twice. A read's transport failure or 5xx rejects, and the Effect asks again; a 404 on a read is
 * an exec the Harness does not know (it restarted); any other 4xx is a jr2 defect, never retried.
 */
export function createExecPort(options: {
  baseUrl: string;
  /** The Workspace's Harness bearer (ADR-0058). Absent only against a Harness that checks nothing. */
  token?: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}): ExecPort {
  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const url = (id: string, suffix = "") => new URL(`/exec/${encodeURIComponent(id)}${suffix}`, options.baseUrl);
  const call = async (target: URL, init: RequestInit): Promise<Response> =>
    fetchImpl(target.toString(), { ...init, headers }).catch((err: unknown) => {
      throw new Error(`harness exec ${init.method ?? "GET"} ${target.pathname} failed: ${transportDetail(err)}`, {
        cause: err,
      });
    });
  const refusedOrRetry = async (res: Response, what: string): Promise<never> => {
    const detail = await errorDetail(res);
    if (res.status >= 400 && res.status < 500)
      throw new ExecRefused(`harness refused the ${what} (${res.status}): ${detail}`);
    throw new Error(`harness ${what} failed (${res.status}): ${detail}`);
  };
  return {
    start: async (id, req: ExecRequest, signal) => {
      const res = await call(url(id), { method: "POST", body: JSON.stringify(req), signal }).catch((err: unknown) => {
        // Only a request that never reached the wire is safe to send again (see `startOnce`).
        if (!signal.aborted && neverDelivered(err)) throw new ExecNotSent((err as Error).message, { cause: err });
        throw err;
      });
      if (!res.ok) return refusedOrRetry(res, "exec");
      await res.json().catch(() => undefined);
    },
    read: async (id, offset, signal) => {
      const target = url(id);
      if (offset !== undefined) target.searchParams.set("offset", String(offset));
      target.searchParams.set("live", LIVE_LONG_POLL);
      const res = await call(target, { method: "GET", signal });
      if (res.status === 404) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.ok) return refusedOrRetry(res, "exec read");
      return (await res.json()) as ExecRead;
    },
    kill: async (id) => {
      // Not kept until the Harness answers 2xx: the Effect sends it again until then.
      const res = await call(url(id, "/kill"), { method: "POST" });
      if (!res.ok) return refusedOrRetry(res, "exec kill");
      await res.body?.cancel();
    },
    forget: async (id) => {
      const res = await call(url(id), { method: "DELETE" });
      await res.body?.cancel();
    },
  };
}

/**
 * Make a `command` Effect: an actor slot that runs one program in the Workspace's Sandbox when a
 * state invokes it. Put it under `actors` and invoke it by its key: `actors: { tests:
 * command(["node", "--test"]) }`, then `invoke: { src: "tests", onDone: … }`.
 *
 * `argv` is a list, never shell text: each entry is one argument. An `arg("name")` entry is filled
 * from the invoke's `input` (`input: { name: "…" }`), as one argument whatever its text. To use a
 * shell, write it: `["sh", "-c", "…"]`.
 *
 * Where it runs:
 * - With no Effect secret in `env`, in the Harness container of the enclosing Workspace's Sandbox.
 *   It runs in the Worktree of a Repo Slot. The Agent's Working tools also run in this container.
 * - With an Effect secret in `env`, in the Sandbox Effector, against a commit of the branch. This
 *   is the branch tip when it starts, or with `pin: true` the commit that the invoke's `input.sha`
 *   names. The output then says `dirty: true` when the Worktree held edits that the command did
 *   not see.
 *
 * Every outcome is output for `onDone`, never an error: `{ outcome: "exited", code, tail }`,
 * `{ outcome: "timeout", tail }`, `{ outcome: "killed", signal, tail }`, or `{ outcome: "unknown",
 * reason }` when jr2 cannot know what happened. `tail` is the end of the output stream.
 *
 * After an Orchestrator restart:
 * - A command with no Effect secret in `env` never runs twice. jr2 attaches to it again, or settles
 *   `unknown`.
 * - A command with an Effect secret in `env` runs again when the Sandbox Effector no longer holds
 *   it. It runs against the same commit. If jr2 has no commit for it, it settles `unknown`.
 *
 * When the state exits, the command stops: jr2 kills its process group. `onError` is only for a
 * Machine or config defect.
 *
 * It refuses, when you call it:
 * - an empty `argv`: `command(argv): argv is a non-empty list — each entry one argument, never
 *   shell text`
 * - an entry that is not a string or `arg()`: `command(argv): an argv entry is a string or
 *   arg("name"), got <entry>`
 * - a `timeout` that is not a positive duration: `command: timeout "<timeout>" is not a positive
 *   duration (like "90s", "10m", "1h")`
 * - an `env` name that is not a variable name, or `PATH`, `HOME` or `TMPDIR`: ``command(argv, {
 *   env }): "<name>" is not a variable the author sets — PATH, HOME and TMPDIR are the Effector's
 *   (ADR-0067)``
 * - `pin: true` with no Effect secret in `env`: ``command(argv, { pin: true }) names no secret in
 *   its env: `pin` chooses the commit a credentialed command runs against in the Sandbox
 *   Effector, and a command that names no secret runs in the live Worktree (ADR-0067) — name its
 *   secret, command(argv, { env: { NAME: secret("x") }, pin: true }), or drop `pin` ``
 *
 * And when it starts, with no Effect secret in `env`:
 * - outside a `workspace()`: `command "<slot>" runs in the Harness container of a Workspace, and
 *   its state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`
 * - no `slot` under a Workspace with more than one Repo Slot: `command "<slot>" runs under a
 *   Workspace carrying more than one Repo Slot (<slots>) and names none — say which Worktree it
 *   runs in: command(argv, { slot: "<slot>" }) (ADR-0051)`
 * - a `slot` that the Workspace does not have: `command "<slot>" names Repo Slot "<name>", which
 *   its Workspace does not carry (<slots>)`
 * - an `arg()` with no string in `input`: `command "<slot>": argv slot <<name>> has no string
 *   value in its input (got <type>) — map it in the invoke's input`. The angle brackets around the
 *   arg's name are in the text: `argv slot <file>`. `<type>` is `nothing` when `input` has no such
 *   field, or the type of its value, such as `number`.
 *
 * And when it starts, with an Effect secret in `env`:
 * - outside a `workspace()`: `command "<slot>" runs in the Sandbox Effector of a Workspace, and its
 *   state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`
 * - no `slot` under a Workspace with more than one Repo Slot: `command "<slot>" runs under a
 *   Workspace carrying more than one Repo Slot (<slots>) — say which: { slot: "<slot>" }
 *   (ADR-0051)`
 * - a Workspace with no Repo Slot: `command "<slot>" runs under a Workspace carrying no Repo Slot
 *   (none) — say which: { slot: "<slot>" } (ADR-0051)`
 * - a `slot` that the Workspace does not have: `command "<slot>" names Repo Slot "<name>", which
 *   its Workspace does not carry (<slots>)`
 * - `pin: true` and an `input.sha` that is not a full commit id: `command "<slot>" (pin): its
 *   input's sha is not a full commit id`
 * - an `arg()` with no string in `input`: the same text as above.
 *
 * @param argv - The program and its arguments: strings and `arg("name")` entries. Or `open`, in a
 *   Machine that you publish as a package, for the Instance that registers it to bind with
 *   `customize()`.
 * @param options - Optional. `slot`: the Repo Slot whose Worktree the command runs in; needed only
 *   where the Workspace has more than one. `timeout`: `"90s"`, `"10m"` or `"1h"`, default
 *   `"10m"`; when it expires, the output is `timeout`. `tail`: how many characters of the end of
 *   the output stream to keep, default 4096. `env`: environment variables. Each value is
 *   `secret("name")` for the value of an Effect secret, or `secret("name").path` for the path of a
 *   file that holds it. `pin`: `true` to run against the commit in `input.sha`. Use `pin` only
 *   with an Effect secret in `env`.
 * @returns The actor logic of the Effect's slot. Its output is a `CommandOutput`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { arg, command, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";
 *
 * const runInput = z.object({ branch: z.string() });
 * type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { input: BodyInput },
 *   events: [],
 *   actors: {
 *     tests: command(["node", "--test", arg("file")], { timeout: "5m" }),
 *   },
 * }).createMachine({
 *   id: "check",
 *   initial: "testing",
 *   states: {
 *     testing: {
 *       invoke: {
 *         src: "tests",
 *         input: { file: "test/greet.test.js" },
 *         onDone: [
 *           {
 *             guard: ({ event }) => event.output.outcome === "exited" && event.output.code === 0,
 *             target: "passed",
 *           },
 *           { target: "failed" },
 *         ],
 *       },
 *     },
 *     passed: { type: "final" },
 *     failed: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   input: runInput,
 *   repos: { app: "https://github.com/you/app.git" },
 *   spec: ({ input }) => ({ branch: input.branch }),
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 */
export function command<const A extends readonly (string | Arg)[], const Opt extends CommandOptions = CommandOptions>(
  argv: A,
  options?: Opt,
): EffectLogic<CommandInput<A, Opt["pin"]>, CommandOutput> & OpenOf<EnvOpenParts<Opt>>;
/**
 * Make a `command` Effect whose argv is Open: `command(open, options)`, in a Machine that you
 * publish as a package. The Instance that registers the Machine binds the argv one time:
 * `customize(machine, { effects: { <slot>: { argv } } })`. {@link command} tells the rest, and
 * what it refuses.
 *
 * @param argv - `open`.
 * @param options - Optional. The same options as for a written argv.
 * @returns The actor logic of the Effect's slot. Its output is a `CommandOutput`.
 *
 * @see docs/guides/bind-open-parts.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function command<const Opt extends CommandOptions = CommandOptions>(
  argv: typeof open,
  options?: Opt,
): EffectLogic<OpenCommandInput<Opt["pin"]>, CommandOutput> & OpenEffect<"argv" | EnvOpenParts<Opt>>;
export function command(
  argv: readonly (string | Arg)[] | typeof open,
  options: CommandOptions = {},
  // The implementation of the overloads above: each one states the input type.
): EffectLogic<any, CommandOutput> {
  // THE authoring surface for a `command` Effect (ADR-0067). `argv` is never shell text — an
  // `arg("x")` entry is ONE argument, filled from the invoke's input — and `sh -c` is the author's
  // explicit choice. Bound to the real exec port here; `commandWith` in effect.ts is the seam the
  // unit tests share.
  //
  // An Open argv (ADR-0054) is the composer's to bind with `customize()`; see open-effect.ts.
  return commandWith(
    (endpoint, bearer) => createExecPort({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) }),
    argv as readonly (string | Arg)[],
    options,
  );
}

/** What a draining Harness answers an admission (ADR-0031): refused before anything is queued. */
const DRAINING = 503;

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
 * `@jr2/harness`'s Menu (the two packages share no runtime dependency) and matched in
 * `features/steps/kind.steps.ts`. Renaming it on one side does not break a build; it silently turns
 * the tier's routability budget into a check that passes because it matches nothing.
 */
const ROUTABILITY_MARKER = "jr2.routability";

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
