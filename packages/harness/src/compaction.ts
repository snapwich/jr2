// Compaction (ADR-0036): the cut a Turn takes on its OWN context, mid-flight — what the model
// still sees, replaced by a summary plus a retained tail. j2's shape is one long agentic turn per
// Submission (ADR-0027), so a window fills exactly where pi refuses to compact: `compact()` throws
// unless the harness is idle. That guard guards the METHOD, not the mechanism. pi rebuilds its
// loop context from `session.buildContext()` after every tool-result batch (`prepareNextTurn`),
// and `buildContext` replays from the latest compaction entry — so an entry appended at a step
// boundary is honored by the next step, by pi's own design. This module is that append, plus the
// thresholds that decide when to take it.
//
// The thresholds are j2-owned turn mechanics (ADR-0016): derived from the model, no author
// surface, not a Dial (ADR-0018). They are stated HERE — a j2 file — rather than read from pi's
// MUTABLE `DEFAULT_COMPACTION_SETTINGS`, so a pin bump cannot move when compaction fires. The
// summarizer is the Turn's own model, thinking level and abort signal: mechanism inherits from the
// Dials, and a summary j2 no longer wants must not outlive the run that asked for it (ADR-0024).

import {
  compact,
  estimateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";

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
 * everything before them becomes the summary. The value pi ships, restated as j2's own. */
const KEEP_RECENT_TOKENS = 20_000;
/** The summarizer's retry budget. pi's `retry` argument is OPTIONAL and omitting it means ZERO
 * attempts past the first (`retryAssistantCall`: `policy?.enabled ? policy.maxRetries : 0`), and
 * the turn's own stream `maxRetries` never reaches this call — pi builds the summarizer's request
 * options itself. So ADR-0036's "fails after pi's retries" is j2's to state, right here. */
const SUMMARY_RETRIES = 2;
const SUMMARY_RETRY_BASE_DELAY_MS = 500;

/**
 * The compaction settings for one model — the whole j2-owned derivation, pure so the arithmetic is
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
 * Whether a context of this size crosses the reserve — pi's own pure predicate on j2's numbers.
 * ADR-0036 rejected waiting for pi to CALL `shouldCompact` (it has zero internal callers), not the
 * arithmetic; keeping the call at j2's seat makes the conformance suite the canary if a pin moves
 * it. The boundary is strictly over: a context exactly at `window - reserve` still fits.
 */
export function overContextThreshold(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return shouldCompact(contextTokens, contextWindow, settings);
}

/** The summarizer's retry policy. `maxRetries` is the Turn's own (`TurnDeps.maxRetries`) when the
 * composition set one, so a rig that forbids provider retries forbids them here too. */
export function summaryRetryPolicy(maxRetries: number = SUMMARY_RETRIES): RetryPolicy {
  return { enabled: maxRetries > 0, maxRetries, baseDelayMs: SUMMARY_RETRY_BASE_DELAY_MS };
}

/** What the cut needs, gathered by the caller: the Session j2 constructed (pi keeps its own
 * reference private), the registry and the Turn's resolved model/level/signal. */
export type CompactionSeat = {
  session: Session;
  models: Models;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  settings: CompactionSettings;
  retry: RetryPolicy;
  signal: AbortSignal;
};

/** A cut that was taken: the rebuilt context to send, and the two numbers the log line reports. */
export type Cut = {
  messages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Take a Compaction if this context crosses the reserve, and answer with the rebuilt one — or
 * `undefined` when nothing was cut, which is every ordinary step. Called from the `context` hook,
 * so the request that NOTICED is already compacted and no round-trip is spent on a full window.
 *
 * Failure is a throw, deliberately: `prepareCompaction`/`compact` return pi `Result`s, and an
 * error surviving to the caller settles the Submission `failed` as an ADR-0016 infra fault — a
 * legible compaction failure beats walking into an overflow that surfaces as truncation. Never
 * call `harness.abort()` from here: it awaits `waitForIdle`, which is parked on this very hook.
 */
export async function compactIfOver(seat: CompactionSeat, messages: AgentMessage[]): Promise<Cut | undefined> {
  const estimate = estimateContextTokens(messages);
  if (!overContextThreshold(estimate.tokens, seat.model.contextWindow, seat.settings)) return undefined;

  // The branch pi would replay. It is NOT truncated at the last compaction entry: the append below
  // deliberately leaves the retained tail OFF that entry, so pi's walk stops at the entry's
  // `firstKeptEntryId` instead and the previous cut's kept work is still ON the path — which is
  // exactly what lets the next cut summarize it rather than delete it.
  const branch = await seat.session.getBranch();
  // The stale-reading latch. pi's estimate reads the last VALID assistant usage, and a cut
  // deliberately RETAINS recent assistant messages — so the reading that triggered a cut survives
  // it. When the request after a cut ends `error` or `aborted` it contributes no usage of its own,
  // the old number is still the newest one, and the next step would cut AGAIN on a context nothing
  // has grown since: a second summarizer round-trip, and a second summary over work the first one
  // already covered. The question is therefore about what landed AFTER the newest cut, not about
  // the branch's first entry — the walk reaches back past a compaction whose tail is not on it.
  let newestCut = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      newestCut = i;
      break;
    }
  }
  if (newestCut >= 0 && !getLastAssistantUsage(branch.slice(newestCut + 1))) return undefined;

  const prepared = prepareCompaction(branch, seat.settings);
  if (!prepared.ok) throw prepared.error;
  // `ok(undefined)` is "nothing to cut", not a failure — an empty branch, or one whose leaf is
  // already a compaction. The turn proceeds over the threshold; if the context truly cannot fit,
  // the overflow is the provider's answer and settles as infra.
  if (!prepared.value) return undefined;

  const cut = await compact(
    // Verbatim: `compact` destructures all nine fields, including the settings it budgets the
    // summary from and the previous summary that switches it to an incremental update.
    prepared.value,
    seat.models,
    seat.model,
    undefined,
    seat.signal,
    seat.thinkingLevel,
    seat.retry,
  );
  if (!cut.ok) throw cut.error;

  // `fromHook: false` — the summary is j2's own computation, not a `session_before_compact` hook's
  // substitute, and pi carries the file-operation lists forward only for non-hook entries.
  //
  // The retained tail is deliberately NOT passed, which is a stated divergence from pi's own
  // `AgentHarness.compact()`. An entry that CARRIES its tail makes `getPathToRootOrCompaction`
  // break AT the compaction; the next cut's boundary walk then cannot find that entry's
  // `firstKeptEntryId` on the truncated path and falls back to the entry AFTER the compaction, so
  // this cut's retained work is neither summarized by the next cut nor kept by it — up to
  // `keepRecentTokens` of the MOST RECENT work, deleted at every cut past the first. With
  // `firstKeptEntryId` alone the walk stops at that entry, `defaultContextEntryTransform` rebuilds
  // the identical `[summary, ...tail, ...after]` context (the cut shrinks exactly as much), and the
  // next cut can reach the tail and summarize it. pi passes the tail because its own `compact()` is
  // idle-only and manually invoked; j2's mid-turn regime cuts repeatedly on one conversation, so it
  // must not. This is the pi-bump surface ADR-0036 names — the conformance suite is the canary.
  await seat.session.appendCompaction(
    cut.value.summary,
    cut.value.firstKeptEntryId,
    cut.value.tokensBefore,
    cut.value.details,
    false,
    cut.value.usage,
  );

  const rebuilt = await seat.session.buildContext();
  return {
    messages: rebuilt.messages,
    tokensBefore: cut.value.tokensBefore,
    // The character heuristic, NOT `estimateContextTokens`: the retained tail still carries the
    // pre-cut assistant usage, which measured the request that filled the window. Counting it here
    // would print a cut that changed nothing. Mixed units against `tokensBefore` (a provider
    // number) — the line reports the size of what remains, and a reader needs the order of
    // magnitude, not a reconciliation.
    tokensAfter: rebuilt.messages.reduce((total, message) => total + estimateTokens(message), 0),
  };
}
