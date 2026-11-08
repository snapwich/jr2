// Compaction (ADR-0036): the cut a Turn takes on its OWN context, mid-flight — what the model
// still sees, replaced by a summary plus a retained tail. jr2's shape is one long agentic turn per
// Submission (ADR-0027), so a window fills in the middle of a Turn, not between Turns. The seat is
// the engine's `beforeRequest` hook (`turn.ts`), which fires before each provider request, the first
// one included; the rebuilt context it returns is the context of this request and of the rest of
// the run.
//
// The Harness decides when, by pi's rule (`shouldCompact` over pi's projected estimate), with jr2's
// derivation of the reserve as pi's per-model setting. The cut, the summary request and its texts
// are pi's (`pi-compaction.ts`), so a pi bump can move them. The thresholds are jr2-owned turn
// mechanics (ADR-0016): derived from the model, no author surface, not a Dial (ADR-0018). The
// summarizer is the Turn's own model, thinking level, stream and abort signal: mechanism inherits
// from the Dials, and a summary jr2 no longer wants must not outlive the run that asked for it
// (ADR-0024).

import type { Api, Model, Models, ModelThinkingLevel, RetryPolicy } from "@earendil-works/pi-ai";
import type { EngineMessage } from "./engine.ts";
import {
  compact,
  estimateContext,
  estimateTokens,
  prepareCompaction,
  sessionChain,
  shouldCompact,
  transcriptCompaction,
  type CompactionSettings,
} from "./pi-compaction.ts";
import { unlimitedPayload } from "./provider.ts";
import type { EnginePart } from "./transcript.ts";

export type { CompactionSettings } from "./pi-compaction.ts";

/** The reserve floor. The threshold is checked BEFORE a request that may emit up to `maxTokens`,
 * so a reserve smaller than one full response reserves nothing — hence `max(floor, maxTokens)`.
 * pi's flat 16384 and flue's `min(20000, maxTokens)` — which SHRINKS the reserve as the model
 * gains room — are both wrong for the live rig's 32768. */
const RESERVE_FLOOR = 16_384;
/** flue's small-window floor: when the reserve would eat half the window, take a third of the
 * window instead, never below this. Without it a small model reserves so much that its first real
 * tool result compacts, and the summary costs more than the context it saved. */
const SMALL_WINDOW_RESERVE_MIN = 1024;
/** What a cut keeps: roughly this many tokens of the most recent work survive verbatim, and
 * everything before them becomes the summary. The value pi ships, restated as jr2's own. */
const KEEP_RECENT_TOKENS = 20_000;
/** The summarizer's retry budget. pi-ai's `retryAssistantCall` makes no attempt past the first
 * without a policy, and the turn's own stream `maxRetries` never reaches this call — pi's summary
 * request is a call of its own. So ADR-0036's retry budget is stated here. */
const SUMMARY_RETRIES = 2;
const SUMMARY_RETRY_BASE_DELAY_MS = 500;

/**
 * The compaction settings for one model — the whole jr2-owned derivation, pure so the arithmetic is
 * proven socket-free rather than through the turn loop. It is pi's per-model setting: pi's flat
 * reserve of 16384 relies on pi's own compact-and-retry after an overflow, which jr2's seam does not
 * have. `keepRecentTokens` is a parameter only
 * because the conformance suite cannot afford a 20000-token transcript; production never passes it
 * (ADR-0036: `TurnDeps` carries test seams, never an author surface).
 */
export function compactionSettingsFor(
  model: { contextWindow: number; maxTokens: number },
  keepRecentTokens: number = KEEP_RECENT_TOKENS,
): CompactionSettings {
  const contextWindow = model.contextWindow;
  // A model whose provider spec declared no `contextWindow` resolves to 0 (`provider.ts`), and
  // compaction is OFF — said out loud, because silently inert is how the original regression hid.
  // It cannot be left to the threshold: at window 0 the comparison is `tokens > -reserve`, so
  // every single request would compact.
  if (!(contextWindow > 0)) return { enabled: false, reserveTokens: RESERVE_FLOOR, keepRecentTokens };
  const reserve = Math.max(RESERVE_FLOOR, model.maxTokens);
  const reserveTokens =
    reserve * 2 >= contextWindow ? Math.max(SMALL_WINDOW_RESERVE_MIN, Math.floor(contextWindow / 3)) : reserve;
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/** The summarizer's retry policy. `maxRetries` is the Turn's own (`TurnDeps.maxRetries`) when the
 * composition set one, so a rig that forbids provider retries forbids them here too. */
export function summaryRetryPolicy(maxRetries: number = SUMMARY_RETRIES): RetryPolicy {
  return { enabled: maxRetries > 0, maxRetries, baseDelayMs: SUMMARY_RETRY_BASE_DELAY_MS };
}

/** What the cut needs, gathered by the caller: the engine part it cuts, the registry and the Turn's
 * resolved model, level and run signal. */
export type CompactionSeat = {
  part: EnginePart;
  models: Models;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  settings: CompactionSettings;
  retry: RetryPolicy;
  signal: AbortSignal | undefined;
  /** The system prompt of the request: the text estimate counts it (`contextTokens`). */
  systemPrompt?: string;
};

/**
 * The tokens of the next request's context, by pi's projected estimate. When the estimate is the
 * text of the messages alone (no usage since the newest cut: the first request, or the one after a
 * cut), it adds the system prompt's text by pi's own heuristic (chars/4): the instructions, the
 * project context (up to 256 KiB, ADR-0062) and the standing part. pi's own sessions put the system
 * prompt in the context as a message, which pi counts; jr2 gives it to the engine apart, so pi's
 * estimate does not see it. A usage counts it already.
 */
export function contextTokens(chain: ReturnType<typeof sessionChain>, systemPrompt = ""): number {
  const { tokens, fromUsage } = estimateContext(chain);
  return fromUsage ? tokens : tokens + Math.ceil(systemPrompt.length / 4);
}

/** A cut that was taken: the rebuilt context to send, and the two numbers the log line reports. */
export type Cut = {
  messages: EngineMessage[];
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Take a Compaction if the engine part's context crosses the reserve, and answer with the rebuilt
 * context — or `undefined` when nothing was cut, which is every ordinary request. Called before a
 * request, so the request that NOTICED is already compacted and no round-trip is spent on a full
 * window. The estimate is pi's, of the engine part's projected context, plus the system prompt when
 * the estimate is text alone (`contextTokens`). pi's estimate does not trust a usage from before the
 * newest cut (it estimates the text then), so a cut whose next request failed does not cut again on
 * the reading that crossed.
 *
 * Failure is a throw, deliberately: the loop turns it into a failed run, which settles the
 * Submission `failed` as an ADR-0016 infra fault — a legible compaction failure beats walking into
 * an overflow that surfaces as truncation.
 */
export async function compactIfOver(seat: CompactionSeat): Promise<Cut | undefined> {
  // A run that has ended asks for no summary: the loop calls the request hook once more after an
  // abort that landed after the step boundary, and there is no request left to cut for. pi-ai sends
  // nothing on an aborted signal, so this check is what keeps the summary call from being made at
  // all (`compaction.test.ts`).
  if (seat.signal?.aborted) return undefined;
  const chain = sessionChain(seat.part.all());
  if (!shouldCompact(contextTokens(chain, seat.systemPrompt), seat.model.contextWindow, seat.settings))
    return undefined;

  // `undefined` is "nothing to cut", not a failure — an empty transcript, or one whose newest entry
  // is already a compaction. The turn proceeds over the threshold; if the context truly cannot fit,
  // the overflow is the provider's answer and settles as infra.
  const prepared = prepareCompaction(chain, seat.settings);
  if (!prepared) return undefined;

  const { models } = seat;
  const result = await compact(prepared, {
    model: seat.model,
    thinkingLevel: seat.thinkingLevel,
    signal: seat.signal,
    retry: seat.retry,
    // A custom model with no limit at all sends none (`unlimitedPayload`, ADR-0018). pi sets no
    // `maxTokens` on a summary: its budget is the model's output limit.
    streamFn: (model, context, options) => {
      const onPayload = unlimitedPayload(model, options?.onPayload);
      return models.streamSimple(model, context, { ...options, ...(onPayload ? { onPayload } : {}) });
    },
  });
  // pi does not fail a summary that an abort ended: it would store an empty or a partial summary.
  // A run that aborted during the summary appends nothing.
  if (seat.signal?.aborted) throw new Error("Summarization aborted");
  // The entry stores `firstKept` and no tail (the engine part's format). The context rule rebuilds
  // `[summary, ...tail, ...after]` from it, and the next cut can reach the tail and summarize it.
  seat.part.appendCompaction(transcriptCompaction(result, Date.now()));

  const rebuilt = seat.part.context();
  return {
    messages: rebuilt,
    tokensBefore: result.tokensBefore,
    // The character heuristic of the context that remains. Mixed units against `tokensBefore` (a
    // provider number) — the line reports the size of what remains, and a reader needs the order of
    // magnitude, not a reconciliation.
    tokensAfter: rebuilt.reduce((total, message: EngineMessage) => total + estimateTokens(message), 0),
  };
}
