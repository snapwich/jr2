// The Menu (ADR-0013/0027/0029): one Submission's read of the turn's surface — the Menu, fixed for
// the conversation, and the Turn's Allowed picks — and each Menu event as a pick the model can make.
// This module knows the wire and nothing of the model's library: `menu-tools.ts` presents the Menu
// to pi, with no MCP between them. Every word the model reads about picks is written HERE — the
// Allowed-picks text, each receipt, each refusal — so a presenter only maps items to its tool API
// and places the text it is handed, and a second presenter reuses it (ADR-0029).
//
// The Harness reads the surface from the Orchestrator itself, through the Custodian on this pod's
// loopback (`$JR2_CUSTODIAN_URL`, ADR-0059). It sends `Authorization: Bearer <Stand-in>`: its env
// holds the Sandbox token's Stand-in, never the token, and the Custodian — a container the Agent
// executes nothing in — puts the token on the three routes this needs and on no other. So the
// Agent, which has code execution here, holds nothing the Orchestrator would accept, and
// everything a pick is judged by is judged there: the token's scope, the live registration, the
// event's name and payload (ADR-0013).
//
//   GET  /agents/<iid>/surface   → the Menu and this Turn's Allowed picks (404: the turn is over —
//                                  NO surface, and the Turn is never prompted, ADR-0026; 503: the
//                                  Orchestrator is stopping — re-asked, ADR-0042)
//   POST /agents/<iid>/events    → one pick, and the receipt, rendered as prose (ADR-0024/0029);
//                                  `outstanding` when the workflow runs it, 409 while one is out
//   GET  /agents/<iid>/deliveries/<id>
//                                → an outstanding pick's answer, long-polled inside the one tool
//                                  call until the workflow is back at Rest (ADR-0013, ADR-0024)
//
// One pick at a time per Turn, claimed HERE in message order: pi starts the calls of one assistant
// message in that order, each synchronously up to its first `await`, so the first Menu call of a
// message holds the claim and every other is refused before it leaves — `finish` included. The
// Orchestrator refuses the same picks from the Machine; only the Harness sees the message order,
// which a socket race does not keep (measured: `finish` arrived first in 1 of 50).
//
// Each Submission reads afresh, and the iid in the path is how the Orchestrator knows which turn is
// live — no push channel, no turn index (ADR-0013's enabling fact).

import type { PickAnswer } from "./wire.ts";

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

/** One conversation's Menu (ADR-0029): the same items, in the same order, on every Turn. */
export type Menu = MenuItem[];

/** One Submission's read of a live surface: the Menu, presented as the tools block, and the Turn's
 * Allowed picks — event names, stated in the Briefing's Turn part and enforced at delivery. */
export type MenuRead = { menu: Menu; allowed: string[] };

/** One event on an agent's live surface, as the Orchestrator serves it. */
export type SurfaceEvent = {
  name: string;
  description?: string;
  /** The event's input schema, as JSON Schema — this becomes the tool's parameters. */
  input: unknown;
  semantics: "ack" | "poll";
};

/**
 * `GET /agents/:iid/surface` — the Menu and the Turn's Allowed picks (ADR-0029). An older
 * Orchestrator sends neither, only `accepts` — its per-Turn narrowed list (ADR-0027's skew: the
 * Harness is a stock image, the Orchestrator the instance image). That list is read as both the
 * tools and the Allowed picks, which is what it was.
 */
export type Surface = {
  instanceId: string;
  runId: string;
  sandbox?: string;
  /** The Menu: the fixed union of every invoking state's derived set, in a fixed order. */
  menu?: SurfaceEvent[];
  /** The Allowed picks: the invoking state's derived set, narrowed by its guards. Event names. */
  allowed?: string[];
  /** Skew only: an Orchestrator from before ADR-0029's fixed Menu. */
  accepts?: SurfaceEvent[];
};

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
  /** The Allowed picks, read AFTER the delivery (ADR-0029): an in-state move can change the guards
   * mid-Turn. Optional on the wire for the same skew — absent is not empty. */
  allowed?: string[];
  /** The workflow is running the pick (ADR-0024): its answer is long-polled at
   * `GET /agents/:iid/deliveries/:id`, inside this one tool call. */
  outstanding?: boolean;
  /** This receipt is an outstanding pick's answer: the workflow is back at Rest in the state that
   * asked for this Turn (`turnComplete: false`), or it has left it. */
  answered?: boolean;
  /** With `answered`: a guard straight back — the pick entered a state below the Agent's and came
   * back inside its own send, nothing replying. The one answer that reads "moved; nothing ran". */
  straightBack?: boolean;
  /** The last reply since the pick; absent with `answered`: no reply came. */
  answer?: PickAnswer;
  /** With `answered` and `turnComplete`: something other than the pick's route left the state that
   * asked for this Turn while the pick's work ran, and that exit stopped the work. `answer`, if any,
   * is an earlier link's reply, kept. */
  stopped?: boolean;
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
  /** How the presenter names a pick to its model (`menu-tools.ts`: `mcp__jr2__<name>`), so every
   * text here names the tool the model actually sees. Default: the bare name. */
  toolName?: (name: string) => string;
  /** Hears every Allowed-picks list a pick's answer carries — a receipt's or a refusal's — as the
   * model is about to read it. `between-steps.ts` keeps the last list the model read, so a change it
   * already read is never restated. */
  onAllowed?: (allowed: string[]) => void;
  /** Hears that a pick's answer ended the Turn — a receipt's `turnComplete`, or a 404 (no surface).
   * `between-steps.ts` then reads nothing more for that Submission: under `continue: true` the next
   * state re-registers the SAME address, so a later read could answer for the NEXT Turn. */
  onTurnOver?: () => void;
  /** Hears that an outstanding pick was answered (ADR-0024): the world moved, so the Runaway guard's
   * identical-call streak starts again (ADR-0035). */
  onAnswered?: () => void;
  /** Hears that a pick's call starts, or stops, long-polling an outstanding pick's answer — the one
   * wait a stopping Harness cuts at once (ADR-0031). */
  onPolling?: (polling: boolean) => void;
  /** One delivery poll's own bound, past the Orchestrator's ~25 s long-poll (ADR-0013). Default
   * 60s; tests shrink it. The poll itself has no window: it asks again while the Turn lives. */
  pollTimeoutMs?: number;
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

/** An Orchestrator that is stopping answers 503 (ADR-0026): not an answer about the Turn. */
const UNAVAILABLE = 503;

/** An answer that is not about the Turn — a stopping Orchestrator's 503 — carried to the ladder as
 * the transport failure it stands for. */
class UnavailableError extends Error {}

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
export function sanitizeToolNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * This Submission's Menu and Allowed picks, or `undefined` when the Turn is over (ADR-0026: 404, no
 * registration — the state exited and the abort is on its way). turn.ts settles that `aborted`
 * without prompting the model. A surface read that fails for any other reason propagates: a turn
 * that cannot see its Menu settles `failed` (ADR-0027), and turn.ts owns that mapping. The
 * Submission's `signal` cancels a read in flight — an abort must promote the next admission
 * promptly (ADR-0024).
 */
export async function readMenu(
  opts: MenuOptions,
  instanceId: string,
  signal?: AbortSignal,
): Promise<MenuRead | undefined> {
  const surface = await readSurface(opts, instanceId, signal);
  if (!surface) return undefined;
  // ADR-0029's skew: without `menu`, the older Orchestrator's `accepts` is the tools and the
  // Allowed picks both. With `menu` and no `allowed`, all of it is allowed — absent is not empty,
  // and a wrong "allowed" costs one refused pick where a wrong "not allowed" costs the Turn.
  const events = surface.menu ?? surface.accepts ?? [];
  const allowed = surface.allowed ?? events.map((event) => event.name);
  const claim: PickClaim = {};
  return { menu: events.map((event) => menuItem(opts, instanceId, event, claim)), allowed };
}

/** The one pick in flight in this Submission, by event name (ADR-0024). */
type PickClaim = { held?: string };

function menuItem(opts: MenuOptions, instanceId: string, event: SurfaceEvent, claim: PickClaim): MenuItem {
  if (event.semantics !== "ack") {
    // ADR-0013: `poll` is reserved in the model and has room on the wire, but nothing drains a
    // steer inbox yet. Offering one as a plain tool would promise the Agent a contract nothing
    // keeps, so the whole turn is refused rather than served a lying one.
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
    pick: (params, pickSignal) => {
      // The claim is taken before the first `await`: that is what makes it message order.
      if (claim.held !== undefined) {
        return Promise.reject(new Error(outstandingRefusal(event.name, claim.held, opts.toolName)));
      }
      claim.held = event.name;
      return (async () => {
        try {
          // The name last: an argument called `type` cannot make this pick another event.
          const sent = await deliver(opts, instanceId, { ...((params ?? {}) as object), type: event.name }, pickSignal);
          let receipt = sent;
          if (sent.outstanding === true) {
            // The pick is outstanding: from here to its answer, this call only polls (ADR-0031).
            opts.onPolling?.(true);
            try {
              receipt = await awaitAnswer(opts, instanceId, sent, pickSignal);
            } finally {
              opts.onPolling?.(false);
            }
          }
          // The world moved (ADR-0035): an outstanding pick answered on its poll, or a child that
          // replied inside the pick's own send. A guard straight back is answered too, but nothing
          // ran and the state is where it was: the same call again is the same question.
          if (receipt.answered === true && (sent.outstanding === true || receipt.answer !== undefined)) {
            opts.onAnswered?.();
          }
          return receiptProse(receipt, opts.toolName);
        } finally {
          claim.held = undefined;
        }
      })();
    },
  };
}

/** A model-facing name for an event: the presenter's naming over the sanitized name. */
function named(event: string, toolName?: (name: string) => string): string {
  return (toolName ?? ((n: string) => n))(sanitizeToolNamePart(event));
}

/**
 * The refusal of a pick while another is outstanding (ADR-0024) — `held` is the pick still running,
 * or undefined when the workflow is busy with work this Turn did not pick (it started busy). Said
 * the same whether the Harness's claim or the Orchestrator refused it, so the model reads one rule.
 */
export function outstandingRefusal(
  refused: string,
  held: string | undefined,
  toolName?: (name: string) => string,
): string {
  const pick = `\`${named(refused, toolName)}\``;
  if (held !== undefined) {
    return (
      `${pick} was NOT delivered: your pick \`${named(held, toolName)}\` is still running in the workflow, and no ` +
      `other pick is taken until it answers. Wait for its answer, then pick again.`
    );
  }
  return (
    `${pick} was NOT delivered: the workflow is still running work in the state that asked for this turn, and ` +
    `takes no pick until it is back at rest. ${allowedPicksText([], toolName)}`
  );
}

/**
 * What a Menu call cut by a Harness restart answers in the history, forever after (ADR-0031): the
 * pick reached the workflow, which does not run it twice, and its answer is the next message's — the
 * re-admission's notice. `tool` is the name the model called.
 */
export function cutPickResult(tool: string): string {
  return (
    `This pick reached the workflow, but its answer did not reach you: your turn was cut while the ` +
    `workflow ran \`${tool}\`. The workflow did not stop, and it does not run a pick twice. Its result ` +
    `comes in the next message. Do not call \`${tool}\` again to get it.`
  );
}

/**
 * What an outstanding pick's answer says, in words (ADR-0024): the last reply since the pick. With
 * none it says only that: work that a timer or an outside event stopped did run, so "nothing ran"
 * is a guard straight back's words alone (`receiptProse`).
 */
export function answerText(answer: PickAnswer | undefined): string {
  if (answer === undefined) return "No reply came back for it.";
  switch (answer.kind) {
    case "event": {
      const from = answer.sender
        ? ` from ${answer.sender.party === "gate" ? "Gate" : "Agent"} \`${answer.sender.id}\``
        : "";
      const payload = Object.keys(answer.payload).length ? `, with ${JSON.stringify(answer.payload)}` : "";
      return `Its answer: \`${answer.event}\`${from}${payload}.`;
    }
    case "output":
      return `Its answer: the output of \`${answer.actor}\`: ${JSON.stringify(answer.output) ?? "nothing"}.`;
    // The Machine shaped it (ADR-0067): its words, as the workflow wrote them.
    case "answer":
      return `Its answer: ${typeof answer.value === "string" ? answer.value : (JSON.stringify(answer.value) ?? "nothing")}`;
  }
}

/**
 * The Allowed picks in words (ADR-0029), naming each as the presenter presents it. The Briefing's
 * Turn part states it after the Frame's prompt, and every receipt and refusal that leaves the Turn
 * open repeats it — measured, a model obeys it there, and one refusal naming it recovers the rest.
 */
export function allowedPicksText(allowed: string[], toolName: (name: string) => string = (name) => name): string {
  if (allowed.length === 0) {
    return "Allowed now: none — the workflow's current state accepts no pick yet, so any pick is refused or does nothing.";
  }
  return `Allowed now: ${allowed.map((event) => `\`${toolName(sanitizeToolNamePart(event))}\``).join(", ")}.`;
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
export function receiptProse(receipt: DeliveryReceipt, toolName?: (name: string) => string): string {
  const delivered = `Delivered "${receipt.event}" to the workflow (delivery ${receipt.deliveryId}).`;
  // Read AFTER the delivery, so it is the Turn's answer now, not its Submission's (ADR-0029).
  const allowed = receipt.allowed ? ` ${allowedPicksText(receipt.allowed, toolName)}` : "";
  // Order matters: a rejected pick is also `turnComplete: false`, and saying only that sends the
  // Agent back to do the same thing again (ADR-0029). Say what it can act on FIRST.
  if (receipt.moved === false) {
    // Nothing moved, so the Allowed picks after the delivery are the ones before it. A pick outside
    // them — another mode's pick, or one a guard on context closed — was refused by the workflow's
    // current STATE, whatever its arguments: the correction receipt. "Change the arguments" there
    // sends the Agent round the same loop.
    if (receipt.allowed && !receipt.allowed.includes(receipt.event)) {
      const name = (toolName ?? ((n: string) => n))(sanitizeToolNamePart(receipt.event));
      return (
        `${delivered} The workflow did NOT act on it: \`${name}\` is not allowed in the workflow's ` +
        `current state, whatever its arguments. Your turn is not over. Do not repeat this call — ` +
        `pick one of the allowed tools.${allowed}`
      );
    }
    return (
      `${delivered} The workflow did NOT act on it: no transition in its current state accepts ` +
      `"${receipt.event}" with these arguments. Your turn is not over. Do not repeat this call ` +
      `unchanged — change the arguments, pick a different tool, or do more work first.${allowed}`
    );
  }
  // A pick's answer (ADR-0024): the workflow took it, then routed — back to Rest in the state that
  // asked for this Turn, with the Allowed picks read after the route, or out of it. A guard straight
  // back is the one answer that says nothing ran.
  if (receipt.answered === true) {
    // Something other than the pick's route left the state while its work ran: that stopped it. An
    // earlier link's reply, if any, is kept and stated.
    if (receipt.turnComplete && receipt.stopped === true) {
      const kept = receipt.answer === undefined ? "" : ` ${answerText(receipt.answer)}`;
      return (
        `${delivered} The workflow left the state that asked for this turn while it ran your pick, and that ` +
        `stopped the pick's work before it finished: your turn is over.${kept} Stop here — do not call this or ` +
        `any other tool again.`
      );
    }
    if (receipt.turnComplete) {
      return `${delivered} The workflow took it and moved on: your turn is over. Stop here — do not call this or any other tool again.`;
    }
    return receipt.straightBack === true
      ? `${delivered} It moved the workflow, and nothing ran: the workflow is back in the state that asked for ` +
          `this turn. Your turn is not over.${allowed}`
      : `${delivered} The workflow took it and is back in the state that asked for this turn. ` +
          `${answerText(receipt.answer)} Your turn is not over.${allowed}`;
  }
  return receipt.turnComplete
    ? `${delivered} The workflow consumed it and moved on: your turn is over. Stop here — do not call this or any other tool again.`
    : `${delivered} The workflow is still in the state that asked for this turn, so it is not over yet.${allowed}`;
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
 * cost is logged once. So is a 503: a stopping Orchestrator's answer about ITSELF, not the Turn —
 * the restarted one restores its runs before it listens, so the ladder, which outlasts a rollout,
 * finds the live surface (ADR-0026). Every other ANSWER is final: a 404 is ADR-0026's turn-is-over,
 * a 403 a scope refusal.
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
      if (res.status === UNAVAILABLE) throw new UnavailableError(await errorOf(res));
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
      const unavailable = err instanceof UnavailableError;
      if (!timedOut && !unavailable && !(err instanceof UnreachableError) && !isTransportFailure(err)) throw err;
      lastCode = timedOut
        ? "timeout"
        : unavailable
          ? String(UNAVAILABLE)
          : err instanceof UnreachableError
            ? err.code
            : transportCode(err);
      if (performance.now() >= deadline) {
        const detail = timedOut
          ? `no answer within ${attemptMs} ms`
          : unavailable
            ? `HTTP ${UNAVAILABLE} (${err.message})`
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

/** One pick, delivered. A pick against a turn nobody waits on any more fails LOUDLY (ADR-0026). A
 * stopping Orchestrator's 503 fails as a transport failure does — "try it again", never re-sent
 * here (ADR-0042). A refusal names the Allowed picks when the Orchestrator sent them (ADR-0029). */
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
  if (res.status === 404) {
    opts.onTurnOver?.();
    throw new NoSurfaceError(`no live surface for agent "${instanceId}" — this turn is over`);
  }
  if (res.status === UNAVAILABLE) {
    throw new Error(
      `the Orchestrator is unavailable (${await errorOf(res)}), so the pick was not taken — try it again`,
    );
  }
  if (res.status === 409) {
    const body = await bodyOf(res);
    if (body?.refused === "outstanding") {
      opts.onAllowed?.([]);
      throw new Error(outstandingRefusal(String(event.type), body.outstanding, opts.toolName));
    }
    throw new Error(body?.error ?? `the Orchestrator answered HTTP 409`);
  }
  const receipt = (await answered(res, (allowed) => {
    opts.onAllowed?.(allowed);
    return allowedPicksText(allowed, opts.toolName);
  })) as DeliveryReceipt;
  // Absent is not empty (ADR-0029's skew): an older Orchestrator's receipt carries no list to hear.
  if (Array.isArray(receipt.allowed)) opts.onAllowed?.(receipt.allowed);
  if (receipt.turnComplete === true) opts.onTurnOver?.();
  return receipt;
}

/**
 * Long-poll an outstanding pick's answer (ADR-0013, ADR-0024), inside the pick's one tool call. Each
 * request waits up to the Orchestrator's ~25 s and answers `outstanding` (ask again) or the answer.
 * A GET is safe to repeat, so every failure that is not an answer about the delivery — this
 * process's transport failure, a request past its own bound, the Custodian's "never answered", a
 * stopping Orchestrator's 503 — is asked again on the surface read's ladder, with no window: a park
 * or an Orchestrator restart is a longer wait in the same Turn, and only the Submission's `signal`
 * ends it. A 404 is the one answer that ends it: no such delivery — the run ended, or the Turn did.
 */
async function awaitAnswer(
  opts: MenuOptions,
  instanceId: string,
  sent: DeliveryReceipt,
  signal?: AbortSignal,
): Promise<DeliveryReceipt> {
  const url = `${base(opts)}/agents/${encodeURIComponent(instanceId)}/deliveries/${encodeURIComponent(sent.deliveryId)}`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const retryMaxMs = opts.retryMaxMs ?? 5_000;
  let backoffMs = opts.retryInitialMs ?? 250;
  for (;;) {
    const attempt = AbortSignal.timeout(opts.pollTimeoutMs ?? 60_000);
    try {
      const res = await fetchImpl(url, {
        headers: authorization(opts),
        signal: signal ? AbortSignal.any([signal, attempt]) : attempt,
      });
      await unreachable(res);
      if (res.status === UNAVAILABLE) throw new UnavailableError(await errorOf(res));
      if (res.status === 404) {
        await res.body?.cancel();
        opts.onTurnOver?.();
        throw new NoSurfaceError(`no delivery "${sent.deliveryId}" for agent "${instanceId}" — this turn is over`);
      }
      const receipt = (await answered(res)) as DeliveryReceipt;
      backoffMs = opts.retryInitialMs ?? 250;
      if (receipt.outstanding === true) continue;
      if (Array.isArray(receipt.allowed)) opts.onAllowed?.(receipt.allowed);
      if (receipt.turnComplete === true) opts.onTurnOver?.();
      return receipt;
    } catch (err) {
      if (signal?.aborted) throw err;
      const retried =
        attempt.aborted ||
        err instanceof UnavailableError ||
        err instanceof UnreachableError ||
        isTransportFailure(err);
      if (!retried) throw err;
      await sleep((backoffMs * (1 + Math.random())) / 2, signal);
      backoffMs = Math.min(backoffMs * 2, retryMaxMs);
    }
  }
}

/**
 * The Allowed picks NOW, read at a step boundary of a running Turn (`between-steps.ts`). ONE
 * attempt, bounded, and every failure is `undefined`: unlike `readSurface`, this read is not the
 * Turn's footing. A 404 (the Turn is over), a stopping Orchestrator's 503, the Custodian's
 * unreachable, a blip — each means "say nothing this step", and the next boundary asks again. It
 * never stalls or fails a Turn.
 */
export async function readAllowed(
  opts: MenuOptions,
  instanceId: string,
  signal?: AbortSignal,
  timeoutMs = 2_000,
): Promise<string[] | undefined> {
  const url = `${base(opts)}/agents/${encodeURIComponent(instanceId)}/surface`;
  const bound = AbortSignal.timeout(timeoutMs);
  try {
    const res = await (opts.fetch ?? globalThis.fetch)(url, {
      headers: authorization(opts),
      signal: signal ? AbortSignal.any([signal, bound]) : bound,
    });
    if (!res.ok || res.headers.get("x-jr2-custodian") === "unreachable") {
      await res.body?.cancel();
      return undefined;
    }
    const surface = (await res.json()) as Surface;
    // ADR-0029's skew, as in `readMenu`: absent `allowed` is the whole Menu, never empty.
    return surface.allowed ?? (surface.menu ?? surface.accepts ?? []).map((event) => event.name);
  } catch {
    return undefined;
  }
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
 * swallowed auth failure would look to the Agent exactly like a Machine that ignored it. A refusal
 * that carries `allowed` (ADR-0029) says it, through `allowedText`. */
async function answered(res: Response, allowedText?: (allowed: string[]) => string): Promise<unknown> {
  const body = await bodyOf(res);
  if (!res.ok) {
    const error = body?.error ?? `the Orchestrator answered HTTP ${res.status}`;
    const allowed = Array.isArray(body?.allowed) && allowedText ? ` ${allowedText(body.allowed)}` : "";
    throw new Error(`${error}${allowed}`);
  }
  return body;
}

/** An error answer's body: `{ error }`, the Allowed picks a refusal carries, and an outstanding
 * refusal's `refused`/`outstanding` (ADR-0024). */
type ErrorBody = { error?: string; allowed?: string[]; refused?: string; outstanding?: string };

async function bodyOf(res: Response): Promise<ErrorBody | undefined> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as ErrorBody) : undefined;
  } catch {
    return { error: text.trim() };
  }
}

/** What an error answer says about itself — its `{ error }`, or its status. */
async function errorOf(res: Response): Promise<string> {
  return (await bodyOf(res))?.error ?? `HTTP ${res.status}`;
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
