// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/compaction/compaction.js, dist/harness/compaction/utils.js and the summary text of dist/harness/messages.js
//
// The cut and the summary of a Compaction (ADR-0036), over the engine part's linear transcript
// (`transcript.ts`). pi 1.x removed Compaction from pi-agent-core, so jr2 owns the algorithm now:
// where the cut goes, which messages the summary covers, the summary request, and the files the
// summary names. Every text the summarizer reads is pi 0.82.1's, byte for byte, and so are the
// failure words (`Summarization failed: …`). `compaction.ts` decides WHEN to cut; this module
// decides WHAT the cut is.

import {
  contentText,
  retryAssistantCall,
  uuidv7,
  type Api,
  type Message,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type RetryPolicy,
  type Usage,
} from "@earendil-works/pi-ai";
import type { EngineMessage } from "./engine.ts";
import { contextOf, type CompactionDetails, type TranscriptEntry } from "./transcript.ts";

/** What a cut is told: whether it is on, how much room to keep for the answer, and how much recent
 * work survives verbatim. Derived by `compaction.ts`. */
export type CompactionSettings = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

// ─── the estimate ────────────────────────────────────────────────────────────

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

/** A provider's context size from its usage: the total, or the sum of the parts. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** A valid assistant usage: not an error, not an abort, and more than zero. */
function getAssistantUsage(message: EngineMessage): Usage | undefined {
  if (message.role === "assistant" && "usage" in message) {
    if (
      message.stopReason !== "aborted" &&
      message.stopReason !== "error" &&
      message.usage &&
      calculateContextTokens(message.usage) > 0
    ) {
      return message.usage;
    }
  }
  return undefined;
}

/** The newest valid assistant usage among these entries. */
export function getLastAssistantUsage(entries: readonly TranscriptEntry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) return usage;
    }
  }
  return undefined;
}

export type ContextEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

/** The newest valid assistant usage, plus the estimate of each message after it. */
export function estimateContextTokens(messages: readonly EngineMessage[]): ContextEstimate {
  let index = -1;
  let usage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    usage = getAssistantUsage(messages[i]!);
    if (usage) {
      index = i;
      break;
    }
  }
  if (!usage) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usage);
  let trailingTokens = 0;
  for (let i = index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]!);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: index };
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | ReadonlyArray<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** One message's tokens by the character heuristic: characters / 4, 4800 characters an image. */
export function estimateTokens(message: EngineMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}

// ─── the cut point ───────────────────────────────────────────────────────────

/** A cut keeps whole Turns' worth of messages: it may start at a user or an assistant message,
 * never at a tool result, which needs the call before it. */
function findValidCutPoints(entries: readonly TranscriptEntry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i]!;
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/** The user message that starts the turn holding an entry, or -1. */
export function findTurnStartIndex(
  entries: readonly TranscriptEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i]!;
    if (entry.type === "message" && entry.message.role === "user") return i;
  }
  return -1;
}

export type CutPoint = { firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean };

/**
 * Where the cut goes so that about `keepRecentTokens` of the newest work survives: walk back and add
 * message tokens until the budget, then cut at the next valid cut point. The cut then moves back
 * over the entries before it that are not messages (a Submission's mark). A cut that is not at a
 * user message splits a turn: the turn's prefix gets its own summary.
 *
 * The move back over a Submission's mark is pi 0.82.1's behavior over the tool-set entry it wrote
 * before each prompt. It makes a cut at a prompt a split turn, whose prefix is the Submission before
 * it. jr2 keeps it, so the summary request does not change in this migration.
 */
export function findCutPoint(
  entries: readonly TranscriptEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPoint {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens >= keepRecentTokens) {
      for (const point of cutPoints) {
        if (point >= i) {
          cutIndex = point;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1]!;
    if (prevEntry.type === "compaction" || prevEntry.type === "message") break;
    cutIndex--;
  }
  const cutEntry = entries[cutIndex]!;
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}

// ─── the file lists ──────────────────────────────────────────────────────────

type FileOps = { read: Set<string>; written: Set<string>; edited: Set<string> };

/** The paths of the `read`, `write` and `edit` calls in an assistant message. */
function extractFileOpsFromMessage(message: EngineMessage, fileOps: FileOps): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    if (!args) continue;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    if (block.name === "read") fileOps.read.add(path);
    else if (block.name === "write") fileOps.written.add(path);
    else if (block.name === "edit") fileOps.edited.add(path);
  }
}

function computeFileLists(fileOps: FileOps): CompactionDetails {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// ─── the summary request ─────────────────────────────────────────────────────

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** A Compaction's summary as the user message the model reads after the cut. */
export function compactionSummaryText(summary: string): string {
  return COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX;
}

/** The summarizer's own role mapping (pi 0.82.1 `convertToLlm`): the summary becomes its user
 * message; user, assistant and tool result messages pass. It does not settle cut picks or re-tag an
 * aborted message, as the Turn's `convertToLlm` does: the summary request stays pi 0.82.1's. */
export function summaryLlmMessages(messages: readonly EngineMessage[]): Message[] {
  return messages.flatMap((m): Message[] => {
    if (m.role === "compactionSummary") {
      return [
        { role: "user", content: [{ type: "text", text: compactionSummaryText(m.summary) }], timestamp: m.timestamp },
      ];
    }
    if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") return [m];
    return [];
  });
}

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** The conversation as the summarizer reads it: plain text, one labelled part for each message. */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments as Record<string, unknown>)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (msg.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** The model, the level and the abort signal a summary request runs on: the Turn's own (ADR-0036). */
export type SummarySeat = {
  models: Models;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  retry: RetryPolicy;
  signal: AbortSignal | undefined;
};

/** One summary request: standalone (its own `sessionId`, no cache writes that nothing reuses),
 * retried on a transient provider error by the policy. */
async function summaryCall(seat: SummarySeat, promptText: string, maxTokens: number) {
  const base =
    seat.model.reasoning && seat.thinkingLevel && seat.thinkingLevel !== "off"
      ? { maxTokens, signal: seat.signal, reasoning: seat.thinkingLevel }
      : { maxTokens, signal: seat.signal };
  const options = { ...base, cacheRetention: "none" as const, sessionId: uuidv7() };
  const context = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: promptText }], timestamp: Date.now() },
    ],
  };
  return retryAssistantCall(() => seat.models.completeSimple(seat.model, context, options), seat.retry, seat.signal);
}

/** A model that states no `maxTokens` (0) puts no cap on the summary's budget. */
function capOf(model: Model<Api>): number {
  return model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
}

async function generateSummary(
  messages: readonly EngineMessage[],
  seat: SummarySeat,
  reserveTokens: number,
  previousSummary: string | undefined,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), capOf(seat.model));
  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  let promptText = `<conversation>\n${serializeConversation(summaryLlmMessages(messages))}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;
  const response = await summaryCall(seat, promptText, maxTokens);
  if (response.stopReason === "aborted") throw new Error(response.errorMessage || "Summarization aborted");
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return { text: contentText(response.content), usage: response.usage };
}

async function generateTurnPrefixSummary(
  messages: readonly EngineMessage[],
  seat: SummarySeat,
  reserveTokens: number,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), capOf(seat.model));
  const promptText = `<conversation>\n${serializeConversation(summaryLlmMessages(messages))}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const response = await summaryCall(seat, promptText, maxTokens);
  if (response.stopReason === "aborted") throw new Error(response.errorMessage || "Turn prefix summarization aborted");
  if (response.stopReason === "error") {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return { text: contentText(response.content), usage: response.usage };
}

function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

// ─── the cut ─────────────────────────────────────────────────────────────────

/** A cut, prepared: what to summarize, and where the kept work starts. */
export type PreparedCut = {
  /** The index in the whole transcript of the first entry the cut keeps. */
  firstKept: number;
  messagesToSummarize: EngineMessage[];
  turnPrefixMessages: EngineMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary: string | undefined;
  fileOps: FileOps;
};

/**
 * Prepare a cut over a branch (`EnginePart.branch()`), or answer undefined when there is nothing to
 * cut: an empty branch, or one whose newest entry is a Compaction. The cut starts at the previous
 * cut's first kept entry, so the next summary covers the work that the previous cut kept.
 */
export function prepareCompaction(
  branch: { start: number; entries: readonly TranscriptEntry[] },
  settings: CompactionSettings,
): PreparedCut | undefined {
  const { start, entries } = branch;
  if (entries.length === 0 || entries[entries.length - 1]!.type === "compaction") return undefined;
  let prevCompactionIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  const fileOps: FileOps = { read: new Set(), written: new Set(), edited: new Set() };
  if (prevCompactionIndex >= 0) {
    const prev = entries[prevCompactionIndex] as Extract<TranscriptEntry, { type: "compaction" }>;
    previousSummary = prev.summary;
    const firstKept = prev.firstKept - start;
    boundaryStart = firstKept >= 0 && firstKept < entries.length ? firstKept : prevCompactionIndex + 1;
    for (const f of prev.details?.readFiles ?? []) fileOps.read.add(f);
    for (const f of prev.details?.modifiedFiles ?? []) fileOps.edited.add(f);
  }
  const tokensBefore = estimateContextTokens(contextOf(entries, start)).tokens;
  const cutPoint = findCutPoint(entries, boundaryStart, entries.length, settings.keepRecentTokens);
  if (entries[cutPoint.firstKeptEntryIndex] === undefined) throw new Error("the cut keeps no entry of the transcript");
  const messageOf = (entry: TranscriptEntry): EngineMessage[] => (entry.type === "message" ? [entry.message] : []);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = entries.slice(boundaryStart, historyEnd).flatMap(messageOf);
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? entries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).flatMap(messageOf)
    : [];
  for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
  for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);
  return {
    firstKept: start + cutPoint.firstKeptEntryIndex,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
  };
}

/** The Compaction entry of a prepared cut: its summary, asked of the Turn's model. A failed summary
 * request throws with pi's words. */
export async function compact(
  prepared: PreparedCut,
  seat: SummarySeat,
  settings: CompactionSettings,
): Promise<{ summary: string; firstKept: number; tokensBefore: number; details: CompactionDetails; usage: Usage }> {
  let summary: string;
  let usage: Usage;
  if (prepared.isSplitTurn && prepared.turnPrefixMessages.length > 0) {
    let historyText = "No prior history.";
    let historyUsage: Usage | undefined;
    if (prepared.messagesToSummarize.length > 0) {
      const history = await generateSummary(
        prepared.messagesToSummarize,
        seat,
        settings.reserveTokens,
        prepared.previousSummary,
      );
      historyText = history.text;
      historyUsage = history.usage;
    }
    const prefix = await generateTurnPrefixSummary(prepared.turnPrefixMessages, seat, settings.reserveTokens);
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = historyUsage ? combineUsage(historyUsage, prefix.usage) : prefix.usage;
  } else {
    const whole = await generateSummary(
      prepared.messagesToSummarize,
      seat,
      settings.reserveTokens,
      prepared.previousSummary,
    );
    summary = whole.text;
    usage = whole.usage;
  }
  const details = computeFileLists(prepared.fileOps);
  summary += formatFileOperations(details.readFiles, details.modifiedFiles);
  return { summary, firstKept: prepared.firstKept, tokensBefore: prepared.tokensBefore, details, usage };
}
