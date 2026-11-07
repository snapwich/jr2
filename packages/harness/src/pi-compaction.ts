// The one module that imports pi's Compaction (ADR-0036). The cut, the summary request and its
// texts, and the context rule are upstream's (`@earendil-works/pi-coding-agent`, MIT, at the exact
// pin that moves with pi-ai and pi-agent-core, ADR-0027). jr2 keeps its own transcript
// (`transcript.ts`): this module shows that flat transcript to pi as a linear session, and turns
// pi's answer back into a transcript entry. The transcript's format does not change.
//
// The import is of three files of pi-coding-agent's `dist`, by a file URL: `prepareCompaction` and
// `estimateProjectedContextTokens` are not exported from the package root, and its `exports` map
// refuses a deep specifier. The package root is not imported at all: it costs about 66 MB more in
// this process, and it adds signal-exit's SIGINT and SIGTERM listeners. The three files are the
// ones that the compaction file loads itself. `pi-compaction.test.ts` fails when a pin bump moves a
// file or a name, so such a bump is loud. When upstream exports the two names, import the root.

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { CompactionResult, SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import type { EngineMessage } from "./engine.ts";
import type { CompactionDetails, TranscriptEntry } from "./transcript.ts";

/** pi's per-model setting: whether a cut is on, the room kept for the answer, and the recent work
 * that a cut keeps verbatim. jr2 derives it (`compaction.ts`). */
export type CompactionSettings = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

/** A cut that pi prepared. jr2 reads only these fields; pi reads the rest. */
export type CompactionPreparation = { firstKeptEntryId: string; isSplitTurn: boolean; tokensBefore: number };

/** The private files, relative to the package root's entry (`dist/index.js`). */
export const PRIVATE_FILES = {
  compaction: "./core/compaction/compaction.js",
  session: "./core/session-manager.js",
  messages: "./core/messages.js",
} as const;

type CompactionFile = {
  prepareCompaction(path: SessionEntry[], settings: CompactionSettings): CompactionPreparation | undefined;
  estimateProjectedContextTokens(projection: SessionProjection, branch: SessionEntry[]): { tokens: number };
  shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean;
  estimateTokens(message: AgentMessage): number;
  compact(
    preparation: CompactionPreparation,
    model: Model<Api>,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    customInstructions: string | undefined,
    signal: AbortSignal | undefined,
    thinkingLevel: ModelThinkingLevel | undefined,
    streamFn: StreamFn | undefined,
    env: Record<string, string> | undefined,
    retry: RetryPolicy | undefined,
  ): Promise<CompactionResult<CompactionDetails>>;
};
type SessionFile = { buildSessionProjection(entries: SessionEntry[]): SessionProjection };
type MessagesFile = { convertToLlm(messages: AgentMessage[]): Message[] };

const root = import.meta.resolve("@earendil-works/pi-coding-agent");
const load = async <T>(file: string): Promise<T> => (await import(new URL(file, root).href)) as T;

const compaction = await load<CompactionFile>(PRIVATE_FILES.compaction);
const session = await load<SessionFile>(PRIVATE_FILES.session);
const messages = await load<MessagesFile>(PRIVATE_FILES.messages);

/** The custom type of a Submission's mark. It has no context, as pi's own state entries have none. */
export const SUBMISSION_TYPE = "jr2.submission";

/** A time in milliseconds as pi's entry time. A message from a source that set no time gets 0. */
function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * The flat transcript as pi's session: a linear chain, `id` the entry's index and `parentId` the
 * index before it. A Submission's mark is a custom entry. pi's cut moves back over it, as it moves
 * over its own state entries, so a cut at a Submission's prompt is a split turn. A Compaction keeps
 * the index of its first kept entry as that entry's id.
 */
export function sessionChain(entries: readonly TranscriptEntry[]): SessionEntry[] {
  return entries.map((entry, i): SessionEntry => {
    const base = { id: String(i), parentId: i === 0 ? null : String(i - 1) };
    switch (entry.type) {
      case "message":
        return { ...base, type: "message", timestamp: iso(entry.message.timestamp), message: entry.message };
      case "submission":
        return { ...base, type: "custom", timestamp: iso(0), customType: SUBMISSION_TYPE };
      case "compaction":
        return {
          ...base,
          type: "compaction",
          timestamp: iso(entry.timestamp),
          summary: entry.summary,
          firstKeptEntryId: String(entry.firstKept),
          tokensBefore: entry.tokensBefore,
          details: entry.details,
          usage: entry.usage,
        };
    }
  });
}

/** pi's Compaction as a transcript entry. Its first kept entry's id is the index of that entry. */
export function transcriptCompaction(
  result: CompactionResult<CompactionDetails>,
  timestamp: number,
): Omit<Extract<TranscriptEntry, { type: "compaction" }>, "type"> {
  const firstKept = Number(result.firstKeptEntryId);
  if (!Number.isInteger(firstKept) || firstKept < 0) {
    throw new Error(`the cut keeps an entry that is not in the transcript (${result.firstKeptEntryId})`);
  }
  return {
    summary: result.summary,
    firstKept,
    tokensBefore: result.tokensBefore,
    details: result.details ?? { readFiles: [], modifiedFiles: [] },
    usage: result.usage ?? NO_USAGE,
    timestamp,
  };
}

const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A message of pi's that the seam carries. pi-coding-agent's types add roles (a bash execution, a
 * custom message, a branch summary) that jr2 never writes to the transcript or gives the loop. */
export function isEngineMessage(message: AgentMessage): message is EngineMessage {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
    case "toolResult":
    case "compactionSummary":
      return true;
    default:
      return false;
  }
}

/** pi's projection of the transcript: the messages the model reads, and the entries they came from. */
export function projection(chain: SessionEntry[]): SessionProjection {
  return session.buildSessionProjection(chain);
}

/** The messages the model reads, without the system message: pi's context rule over the chain.
 * No Compaction is given a system message, so pi's context has none. */
export function contextOf(entries: readonly TranscriptEntry[]): EngineMessage[] {
  return projection(sessionChain(entries)).messages.filter(isEngineMessage);
}

/** pi's estimate of the projected context. It does not trust a usage from before the newest cut. */
export function estimateContext(chain: SessionEntry[]): number {
  return compaction.estimateProjectedContextTokens(projection(chain), chain).tokens;
}

export const shouldCompact: CompactionFile["shouldCompact"] = (tokens, window, settings) =>
  compaction.shouldCompact(tokens, window, settings);
export const prepareCompaction: CompactionFile["prepareCompaction"] = (chain, settings) =>
  compaction.prepareCompaction(chain, settings);
export const estimateTokens = (message: EngineMessage): number => compaction.estimateTokens(message);

/** pi's summary request for a prepared cut, on the Turn's model, level, signal and stream. */
export function compact(
  preparation: CompactionPreparation,
  seat: {
    model: Model<Api>;
    thinkingLevel: ModelThinkingLevel;
    signal: AbortSignal | undefined;
    streamFn: StreamFn;
    retry: RetryPolicy;
  },
): Promise<CompactionResult<CompactionDetails>> {
  return compaction.compact(
    preparation,
    seat.model,
    undefined,
    undefined,
    undefined,
    seat.signal,
    seat.thinkingLevel,
    seat.streamFn,
    undefined,
    seat.retry,
  );
}

/** pi's conversion of one Compaction summary to the user message the model reads. */
export function summaryLlmMessage(message: Extract<EngineMessage, { role: "compactionSummary" }>): Message[] {
  return messages.convertToLlm([message]);
}
