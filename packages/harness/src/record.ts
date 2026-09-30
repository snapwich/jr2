// A conversation's directory (ADR-0031): jr2's own RECORD of it, written as it goes, and beside it
// the ENGINE PART — whatever the engine that runs the Turns keeps, opaque to jr2 and named by that
// engine. The record is the contract: it is written in the wire's shapes (wire.ts) and it is what
// a boot rebuilds the conversation from. The engine part is not: an engine that cannot read it
// (another engine, another version) continues from the record's history messages.
//
//   <root>/<agent>/<instance id>/conversation.json    who it is — the route's two parts, unencoded
//   <root>/<agent>/<instance id>/record/admitted.jsonl    one { submissionId } per Admission
//   <root>/<agent>/<instance id>/record/stream.jsonl      the stream log, one StreamEvent per line
//   <root>/<agent>/<instance id>/record/messages.jsonl    the history view's messages
//   <root>/<agent>/<instance id>/record/settlements.jsonl the history view's settlements
//   <root>/<agent>/<instance id>/engine/<engine>/         the engine part (pi's sessions: engine/pi)
//
// Append-only JSONL, written synchronously: the Conversation's appends are synchronous, and a line
// on disk before the append returns is what lets a rebuilt stream agree with every offset the
// Orchestrator was ever handed. A Harness writes a line per event, not per token, so the cost is
// small next to a Turn.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryMessage, Settlement, StreamEvent } from "./wire.ts";

/** What the Conversation writes as it goes (`conversation.ts`) — one call per record line. */
export type ConversationRecorder = {
  admitted(submissionId: string): void;
  appended(event: StreamEvent): void;
  said(message: HistoryMessage): void;
  settled(settlement: Settlement): void;
};

/**
 * The seam between jr2's record and the engine that runs the Turns (ADR-0031). The engine gets a
 * directory it owns, named by it, and the record's history messages — what it continues from when
 * its own part is missing or unreadable. jr2 never reads what the engine writes.
 */
export type EngineSeat = {
  /** The engine's own directory for this conversation (`engine/<engine>`, created), or undefined:
   * this Harness keeps no conversation on disk, so the engine keeps its state in memory. */
  dir(engine: string): string | undefined;
  /** What was said in the conversation, as the record holds it. */
  history(): HistoryMessage[];
};

/** A conversation as its record rebuilds it. */
export type RecordedConversation = {
  agentName: string;
  instanceId: string;
  admitted: string[];
  log: StreamEvent[];
  messages: HistoryMessage[];
  settlements: Settlement[];
};

/** A path segment for a route part. `encodeURIComponent` keeps `/` out (an iid is hierarchical —
 * ADR-0015) but leaves `.`, and a part spelled `..` must not name a parent directory. */
function segment(part: string): string {
  return encodeURIComponent(part).replaceAll(".", "%2E");
}

/** The directory of the conversation `(agentName, instanceId)` under `root`. */
export function conversationDir(root: string, agentName: string, instanceId: string): string {
  return join(root, segment(agentName), segment(instanceId));
}

/**
 * Start a conversation's record, empty. Whatever the directory held is stale by construction —
 * this Harness holds no conversation at that key, so a record there is one the boot could not
 * read — and a new record appended onto it would rebuild as neither.
 */
export function startRecord(root: string, agentName: string, instanceId: string): ConversationRecorder {
  const dir = conversationDir(root, agentName, instanceId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "record"), { recursive: true });
  writeFileSync(join(dir, "conversation.json"), `${JSON.stringify({ agentName, instanceId })}\n`);
  return recorderAt(dir);
}

/** The record's files, each one JSONL. */
const RECORD_FILES = ["admitted.jsonl", "stream.jsonl", "messages.jsonl", "settlements.jsonl"];

/** Append to an existing record — the one a boot rebuilt. The torn write a restart may have left
 * at a file's end is cut first: the read dropped it, and a line appended onto it would join the
 * two into a middle line that does not parse, so the NEXT boot could not read the conversation. */
export function recorderAt(dir: string): ConversationRecorder {
  for (const file of RECORD_FILES) cutTornTail(join(dir, "record", file));
  const line = (file: string, value: unknown) =>
    appendFileSync(join(dir, "record", file), `${JSON.stringify(value)}\n`);
  return {
    admitted: (submissionId) => line("admitted.jsonl", { submissionId }),
    appended: (event) => line("stream.jsonl", event),
    said: (message) => line("messages.jsonl", message),
    settled: (settlement) => line("settlements.jsonl", settlement),
  };
}

/** The engine seat over a conversation directory (or over none: memory only). */
export function engineSeat(dir: string | undefined, history: () => HistoryMessage[]): EngineSeat {
  return {
    dir: (engine) => {
      if (dir === undefined) return undefined;
      const own = join(dir, "engine", engine);
      mkdirSync(own, { recursive: true });
      return own;
    },
    history,
  };
}

/** Every conversation directory under `root`, whether or not its record reads. */
export function conversationDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const agent of entries(root)) {
    for (const instance of entries(join(root, agent))) dirs.push(join(root, agent, instance));
  }
  return dirs;
}

/** Read one conversation's record. Throws on a record that does not parse — the caller decides
 * what an unreadable conversation costs. */
export function readRecord(dir: string): RecordedConversation {
  const identity = JSON.parse(readFileSync(join(dir, "conversation.json"), "utf8")) as {
    agentName?: unknown;
    instanceId?: unknown;
  };
  if (typeof identity.agentName !== "string" || typeof identity.instanceId !== "string") {
    throw new Error(`${join(dir, "conversation.json")} names no conversation`);
  }
  return {
    agentName: identity.agentName,
    instanceId: identity.instanceId,
    admitted: jsonl<{ submissionId: string }>(join(dir, "record", "admitted.jsonl")).map((a) => a.submissionId),
    log: jsonl<StreamEvent>(join(dir, "record", "stream.jsonl")),
    messages: jsonl<HistoryMessage>(join(dir, "record", "messages.jsonl")),
    settlements: jsonl<Settlement>(join(dir, "record", "settlements.jsonl")),
  };
}

/** Remove a conversation's directory — record and engine part together — and its Agent's, once
 * that holds no other conversation. */
export function freeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  try {
    rmdirSync(dirname(dir));
  } catch {
    // Another conversation of the same Agent is still held.
  }
}

/** Truncate a JSONL file to its last newline — every line is written whole with its newline, so
 * whatever follows the last one is a torn write (see `jsonl`). A missing file has no tail. */
function cutTornTail(path: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const kept = bytes.lastIndexOf(0x0a) + 1;
  if (kept < bytes.length) truncateSync(path, kept);
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** One JSON value per line. A last line with no newline is a write the restart cut short: it was
 * never acknowledged, so it is dropped. Any other line that does not parse is a record that cannot
 * be trusted, and throws. A missing file is an empty one. */
function jsonl<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Every line is written whole with its newline, so whatever follows the last newline is the torn
  // write (or nothing).
  const lines = text.split("\n").slice(0, -1);
  return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}
