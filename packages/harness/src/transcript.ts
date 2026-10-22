// Ported in part from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): the context rule and the branch walk of dist/harness/session/session.js and memory-storage.js
//
// The transcript (ADR-0031, ADR-0036): jr2's own store of what the model read, which an engine
// adapter opens as its engine part, under a directory named for the engine (`engine/<name>`). Its
// format is jr2's, not the engine's: the Turn and Compaction (`compaction.ts`) read and write it.
// The adapter chooses the directory, so a Harness on another engine opens another directory and
// does not read this one; it continues from the record's history instead. Nothing outside this
// module, the Turn and Compaction reads what is written there.
//
// One append-only file, `engine/<name>/transcript.jsonl`. It holds the pi-ai messages the model
// read, a mark where each Submission starts, and each Compaction (ADR-0036). One JSON value on each
// line, never changed:
//
//   {"type":"transcript","version":1,"id":"<uuid>","cwd":"<the first Turn's cwd>","created":"<ISO time>"}
//   {"type":"message","message":<a pi-ai message: user, assistant or toolResult>}
//   {"type":"submission"}
//   {"type":"compaction","summary":"…","firstKept":<entry index>,"tokensBefore":<n>,"details":{…},"usage":{…},"timestamp":<ms>}
//
// Entry indexes count from 0, after the header line. Each line is appended synchronously, before
// the loop goes on, as the record is: the transcript holds a message before the printer prints it.
// A Harness that restarts reopens it, and the model reads every message, tool result and Compaction
// it read before. When the part is missing or does not open — another engine wrote it, another
// version, a damaged line — the conversation continues from the record's history messages instead:
// best effort, because the record keeps what was SAID (role and text), not the tool calls between.
// The model then reads the conversation's words without its tool traffic, which is enough to
// continue a decision and says nothing false.

import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7, type Api, type AssistantMessage, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import type { CompactionSummaryMessage, EngineMessage } from "./engine.ts";
import { cutTornTail, type EngineSeat } from "./record.ts";
import type { HistoryMessage } from "./wire.ts";

/** The transcript format this Harness writes and reads. Another version does not open. */
export const TRANSCRIPT_VERSION = 1;

const TRANSCRIPT = "transcript.jsonl";

/** The files a Compaction's summary names, carried to the next cut. */
export type CompactionDetails = { readFiles: string[]; modifiedFiles: string[] };

/** One entry of the transcript. */
export type TranscriptEntry =
  | { type: "message"; message: Message }
  /** A Submission starts here. The cut reads it as pi 0.82.1 read the tool-set entry it wrote at
   * the same place (`compaction-summary.ts`, `findCutPoint`). */
  | { type: "submission" }
  | {
      type: "compaction";
      summary: string;
      /** The index of the first entry the cut keeps. Always before this entry. */
      firstKept: number;
      tokensBefore: number;
      details: CompactionDetails;
      usage: Usage;
      timestamp: number;
    };

type Header = { type: "transcript"; version: number; id: string; cwd: string; created: string };

/** The engine part of one conversation: the transcript, on disk or in memory. */
export class EnginePart {
  /** The transcript's identity. The loop passes it to pi-ai as `sessionId` (a prompt cache key). */
  readonly id: string;
  private readonly entries: TranscriptEntry[];
  /** Undefined in memory mode. */
  private readonly path: string | undefined;
  private readonly fault: EngineSeat["fault"] | undefined;

  constructor(
    id: string,
    entries: TranscriptEntry[],
    path: string | undefined,
    fault: EngineSeat["fault"] | undefined,
  ) {
    this.id = id;
    this.entries = entries;
    this.path = path;
    this.fault = fault;
  }

  /** Every entry, in order. */
  all(): readonly TranscriptEntry[] {
    return this.entries;
  }

  /** Append a message the loop completed. A system message is never appended: the adapter makes
   * a leading one for each run, if it needs one (`pi-engine.ts`). */
  appendMessage(message: Message): void {
    this.append({ type: "message", message });
  }

  /** Mark the start of a Submission, before its prompt. */
  appendSubmission(): void {
    this.append({ type: "submission" });
  }

  /** Append a Compaction. */
  appendCompaction(entry: Omit<Extract<TranscriptEntry, { type: "compaction" }>, "type">): void {
    this.append({ type: "compaction", ...entry });
  }

  /** The file first, then the array: an entry is in `context()` only when it is on disk. A failed
   * write is the record's fault (ADR-0031): the process ends, and the boot cuts the torn tail. */
  private append(entry: TranscriptEntry): void {
    if (this.path !== undefined) {
      try {
        appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        this.fault!(err, this.path);
      }
    }
    this.entries.push(entry);
  }

  /** The entries the next cut works on: back from the newest entry to the first entry the oldest
   * reached Compaction keeps. `start` is the index of the first one. */
  branch(): { start: number; entries: TranscriptEntry[] } {
    const start = branchStart(this.entries);
    return { start, entries: this.entries.slice(start) };
  }

  /** The messages the model reads, without the system message. */
  context(): EngineMessage[] {
    const { start, entries } = this.branch();
    return contextOf(entries, start);
  }
}

/** pi 0.82.1's walk to the root or a Compaction (`getPathToRootOrCompaction`) over a linear log:
 * at each Compaction the stop moves to its `firstKept`, and the walk stops there. */
export function branchStart(entries: readonly TranscriptEntry[]): number {
  let stop: number | undefined;
  let i = entries.length - 1;
  for (; i > 0; i--) {
    if (stop !== undefined && i === stop) break;
    const entry = entries[i]!;
    if (entry.type === "compaction") stop = entry.firstKept;
  }
  return Math.max(i, 0);
}

/** A Compaction's summary as a context message. */
export function summaryMessage(entry: Extract<TranscriptEntry, { type: "compaction" }>): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    timestamp: entry.timestamp,
  };
}

/**
 * pi 0.82.1's context over a branch (`buildSessionContext`): every message when no Compaction is
 * in it; else the newest Compaction's summary, then the entries it keeps before it, then every entry
 * after it. `start` is the index of the branch's first entry in the whole transcript.
 */
export function contextOf(entries: readonly TranscriptEntry[], start: number): EngineMessage[] {
  let newest = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      newest = i;
      break;
    }
  }
  const messagesOf = (entry: TranscriptEntry): EngineMessage[] => {
    if (entry.type === "message") return [entry.message];
    if (entry.type === "compaction") return [summaryMessage(entry)];
    return [];
  };
  if (newest < 0) return entries.flatMap(messagesOf);
  const cut = entries[newest] as Extract<TranscriptEntry, { type: "compaction" }>;
  // A first kept entry before the branch is not on it, and pi then kept nothing before the cut.
  const kept = cut.firstKept >= start ? cut.firstKept - start : newest;
  return [
    summaryMessage(cut),
    ...entries.slice(kept, newest).flatMap(messagesOf),
    ...entries.slice(newest + 1).flatMap(messagesOf),
  ];
}

/**
 * The engine part a conversation's Turns run on. In memory when the Harness persists nothing;
 * otherwise the transcript under the engine's directory, or — when there is none that opens — a
 * new one there, seeded with the record's history. `cwd` and `model` are the first Turn's: the
 * transcript's own header, and the identity a seeded assistant message is written under.
 */
export function openEnginePart(
  engine: EngineSeat | undefined,
  name: string,
  first: { cwd: string; model: Model<Api> },
  say: (line: string) => void = (line) => console.error(line),
): EnginePart {
  const dir = engine?.dir(name);
  const history = engine?.history() ?? [];
  if (dir === undefined) {
    return new EnginePart(uuidv7(), seeded(history, first.model), undefined, undefined);
  }
  const path = join(dir, TRANSCRIPT);
  const opened = readTranscript(path);
  if ("part" in opened) return new EnginePart(opened.part.id, opened.part.entries, path, engine!.fault);
  // A conversation with nothing said is new, and has no part to lose. One with history is the
  // fallback, and the pod log says so: the model reads its words without its tool traffic.
  if (history.length > 0) {
    say(
      `harness: the engine part at ${dir} does not open (${opened.why}) — continuing from the record's messages (ADR-0031)`,
    );
  }
  const header: Header = {
    type: "transcript",
    version: TRANSCRIPT_VERSION,
    id: uuidv7(),
    cwd: first.cwd,
    created: new Date().toISOString(),
  };
  const entries = seeded(history, first.model);
  // The new file replaces the old one whole: written beside it, then renamed over it.
  const next = `${path}.new`;
  try {
    writeFileSync(next, [header, ...entries].map((line) => `${JSON.stringify(line)}\n`).join(""));
    renameSync(next, path);
  } catch (err) {
    engine!.fault(err, path);
  }
  return new EnginePart(header.id, entries, path, engine!.fault);
}

/** The transcript at `path`, or why it does not open. The torn last line a restart may have left is
 * cut first, as the record's is: it was never acknowledged, and a line appended onto it would make a
 * middle line that does not parse. */
export function readTranscript(path: string): { part: { id: string; entries: TranscriptEntry[] } } | { why: string } {
  let text: string;
  try {
    cutTornTail(path);
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { why: "no transcript there" };
    return { why: err instanceof Error ? err.message : String(err) };
  }
  const lines = text.split("\n").slice(0, -1);
  if (lines.length === 0) return { why: "the transcript is empty" };
  const values: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch {
      return { why: `line ${i + 1} does not parse` };
    }
  }
  const header = values[0] as Partial<Header> | null;
  if (!header || typeof header !== "object" || header.type !== "transcript" || typeof header.id !== "string") {
    return { why: "line 1 is not a transcript header" };
  }
  if (header.version !== TRANSCRIPT_VERSION) {
    return { why: `version ${String(header.version)} is not this Harness's (${TRANSCRIPT_VERSION})` };
  }
  const entries: TranscriptEntry[] = [];
  for (const [i, value] of values.slice(1).entries()) {
    const line = i + 2;
    const entry = value as Partial<TranscriptEntry> | null;
    const type = entry && typeof entry === "object" ? entry.type : undefined;
    if (type === "message") {
      const role = (entry as { message?: { role?: unknown } }).message?.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") {
        return { why: `line ${line} holds no user, assistant or tool result message` };
      }
    } else if (type === "compaction") {
      const firstKept = (entry as { firstKept?: unknown }).firstKept;
      if (typeof firstKept !== "number" || !Number.isInteger(firstKept) || firstKept < 0 || firstKept >= i) {
        return { why: `line ${line} is a Compaction whose first kept entry is not before it` };
      }
    } else if (type !== "submission") {
      return { why: `line ${line} has an unknown type (${JSON.stringify(type ?? null)})` };
    }
    entries.push(entry as TranscriptEntry);
  }
  return { part: { id: header.id, entries } };
}

/** The record's history as transcript entries, so the next prompt continues it. */
function seeded(history: HistoryMessage[], model: Model<Api>): TranscriptEntry[] {
  return history.map((message) => ({ type: "message", message: providerMessage(message, model) }));
}

/** A history message as pi-ai carries one. An assistant message needs the model's identity and a
 * usage; it is written under the model that continues it, with nothing spent. */
function providerMessage(message: HistoryMessage, model: Model<Api>): Message {
  const timestamp = Date.now();
  if (message.role === "user") return { role: "user", content: message.text, timestamp };
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
  return assistant;
}
