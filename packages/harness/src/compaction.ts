// Compaction (ADR-0036): the cut a Turn takes on its OWN context, mid-flight — what the model
// still sees, replaced by a summary plus a retained tail. jr2's shape is one long agentic turn per
// Submission (ADR-0027), so a window fills in the middle of a Turn, not between Turns. pi 1.x has no
// Compaction, so jr2 owns all of it: this module decides WHEN to cut and appends the cut to the
// engine part (`pi-engine.ts`); `compaction-summary.ts` decides WHAT the cut is. The seat is the
// loop's `prepareRequest` hook (`turn.ts`), which fires before each provider request, the first one
// included; the rebuilt context it returns is the context of this request and of the rest of the run.
//
// The thresholds are jr2-owned turn mechanics (ADR-0016): derived from the model, no author
// surface, not a Dial (ADR-0018). They and the algorithm are jr2's, so a pin bump cannot move when
// a cut occurs. The summarizer is the Turn's own model, thinking level and abort signal: mechanism
// inherits from the Dials, and a summary jr2 no longer wants must not outlive the run that asked for
// it (ADR-0024).

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import {
  compact,
  estimateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  prepareCompaction,
  type CompactionSettings,
} from "./compaction-summary.ts";
import type { EnginePart } from "./pi-engine.ts";

export type { CompactionSettings } from "./compaction-summary.ts";

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
 * without a policy, and the turn's own stream `maxRetries` never reaches this call — the summary
 * request is jr2's own (`compaction-summary.ts`). So ADR-0036's retry budget is stated here. */
const SUMMARY_RETRIES = 2;
const SUMMARY_RETRY_BASE_DELAY_MS = 500;

/**
 * The compaction settings for one model — the whole jr2-owned derivation, pure so the arithmetic is
 * proven socket-free rather than through the turn loop. `keepRecentTokens` is a parameter only
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

/**
 * Whether a context of this size crosses the reserve. The boundary is strictly over: a context
 * exactly at `window - reserve` still fits.
 */
export function overContextThreshold(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
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
  thinkingLevel: ThinkingLevel;
  settings: CompactionSettings;
  retry: RetryPolicy;
  signal: AbortSignal | undefined;
};

/** A cut that was taken: the rebuilt context to send, and the two numbers the log line reports. */
export type Cut = {
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Take a Compaction if the engine part's context crosses the reserve, and answer with the rebuilt
 * context — or `undefined` when nothing was cut, which is every ordinary step. Called before a
 * request, so the request that NOTICED is already compacted and no round-trip is spent on a full
 * window. The estimate is of the engine part's context, without the leading system message: the
 * system prompt was never counted.
 *
 * Failure is a throw, deliberately: the loop turns it into a failed run, which settles the
 * Submission `failed` as an ADR-0016 infra fault — a legible compaction failure beats walking into
 * an overflow that surfaces as truncation.
 */
export async function compactIfOver(seat: CompactionSeat): Promise<Cut | undefined> {
  // A run that has ended asks for no summary: the loop calls the request hook once more after an
  // abort that landed after the step's end, and there is no request left to cut for. pi-ai sends
  // nothing on an aborted signal, so this check is what keeps the summary call from being made at
  // all (`compaction.test.ts`).
  if (seat.signal?.aborted) return undefined;
  const estimate = estimateContextTokens(seat.part.context());
  if (!overContextThreshold(estimate.tokens, seat.model.contextWindow, seat.settings)) return undefined;

  // The branch the next cut works on. It reaches back past the newest Compaction to the first entry
  // that Compaction keeps: the entry stores no tail, so the previous cut's kept work is still ON the
  // branch — which is exactly what lets the next cut summarize it rather than delete it.
  const branch = seat.part.branch();
  // The stale-reading latch. The estimate reads the last VALID assistant usage, and a cut
  // deliberately RETAINS recent assistant messages — so the reading that triggered a cut survives
  // it. When the request after a cut ends `error` or `aborted` it contributes no usage of its own,
  // the old number is still the newest one, and the next step would cut AGAIN on a context nothing
  // has grown since: a second summarizer round-trip, and a second summary over work the first one
  // already covered. The question is therefore about what landed AFTER the newest cut.
  let newestCut = -1;
  for (let i = branch.entries.length - 1; i >= 0; i--) {
    if (branch.entries[i]!.type === "compaction") {
      newestCut = i;
      break;
    }
  }
  if (newestCut >= 0 && !getLastAssistantUsage(branch.entries.slice(newestCut + 1))) return undefined;

  // `undefined` is "nothing to cut", not a failure — an empty branch, or one whose newest entry is
  // already a compaction. The turn proceeds over the threshold; if the context truly cannot fit,
  // the overflow is the provider's answer and settles as infra.
  const prepared = prepareCompaction(branch, seat.settings);
  if (!prepared) return undefined;

  const cut = await compact(
    prepared,
    {
      models: seat.models,
      model: seat.model,
      thinkingLevel: seat.thinkingLevel,
      retry: seat.retry,
      signal: seat.signal,
    },
    seat.settings,
  );
  // The entry stores `firstKept` and no tail (the engine part's format). The context rule rebuilds
  // `[summary, ...tail, ...after]` from it, and the next cut can reach the tail and summarize it.
  seat.part.appendCompaction({ ...cut, timestamp: Date.now() });

  const rebuilt = seat.part.context();
  return {
    messages: rebuilt,
    tokensBefore: cut.tokensBefore,
    // The character heuristic, NOT `estimateContextTokens`: the retained tail still carries the
    // pre-cut assistant usage, which measured the request that filled the window. Counting it here
    // would print a cut that changed nothing. Mixed units against `tokensBefore` (a provider
    // number) — the line reports the size of what remains, and a reader needs the order of
    // magnitude, not a reconciliation.
    tokensAfter: rebuilt.reduce((total, message) => total + estimateTokens(message), 0),
  };
}
