// The engine part (ADR-0031, `pi-engine.ts`): the transcript jr2 writes for pi — one append-only,
// versioned file that a restart reopens or plainly does not open, and the context and the branch
// that Compaction reads from it (ADR-0036).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import { EnginePart, openEnginePart, type TranscriptEntry } from "../src/pi-engine.ts";
import type { EngineSeat } from "../src/record.ts";
import type { HistoryMessage } from "../src/wire.ts";

const model = { id: "model-x", api: "openai-completions", provider: "fake" } as Model<Api>;
const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const said = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "fake",
  model: "model-x",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

/** A seat over a fresh directory, with the faults and the log lines it saw. */
function seatIn(history: HistoryMessage[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "jr2-engine-"));
  const faults: string[] = [];
  const said: string[] = [];
  const seat: EngineSeat = {
    dir: () => dir,
    history: () => history,
    fault: (err, path) => {
      faults.push(`${path}: ${(err as Error).message}`);
      throw new Error("faulted");
    },
  };
  const open = () => openEnginePart(seat, { cwd: "/work", model }, (line) => said.push(line));
  return { dir, seat, faults, said, open, file: join(dir, "transcript.jsonl") };
}

const texts = (part: EnginePart) =>
  part.context().map((m) => {
    if (m.role === "compactionSummary") return `summary: ${m.summary}`;
    const content = (m as { content: unknown }).content;
    return `${m.role}: ${typeof content === "string" ? content : (content as Array<{ text?: string }>)[0]?.text}`;
  });

test("append, then reopen in a new process seat: the same context, the same id", () => {
  const { open, said: logged, file } = seatIn();
  const first = open();
  first.appendSubmission();
  first.appendMessage(user("hello"));
  first.appendMessage(said("hi"));
  const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as Record<string, unknown>;
  assert.equal(header.type, "transcript");
  assert.equal(header.version, 1);
  assert.equal(header.cwd, "/work");
  assert.equal(header.id, first.id);
  const again = open();
  assert.equal(again.id, first.id);
  assert.deepEqual(again.context(), first.context());
  assert.deepEqual(texts(again), ["user: hello", "assistant: hi"]);
  assert.deepEqual(logged, [], "a part that opens logs nothing");
});

test("a torn last line is cut and ignored, and the next append makes a valid file", () => {
  const { open, file } = seatIn();
  const first = open();
  first.appendMessage(user("kept"));
  appendFileSync(file, '{"type":"message","message":{"role":"us');
  const again = open();
  assert.deepEqual(texts(again), ["user: kept"]);
  again.appendMessage(user("next"));
  assert.deepEqual(texts(open()), ["user: kept", "user: next"]);
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n")) JSON.parse(line);
});

const header = (version = 1) => JSON.stringify({ type: "transcript", version, id: "t-1", cwd: "/work", created: "x" });
const unreadable: Array<[string, string, string]> = [
  ["a bad middle line", `${header()}\nnot json\n${JSON.stringify({ type: "submission" })}\n`, "line 2 does not parse"],
  ["a missing header", `${JSON.stringify({ type: "submission" })}\n`, "line 1 is not a transcript header"],
  ["another version", `${header(2)}\n`, "version 2 is not this Harness's (1)"],
  [
    "an unknown entry type",
    `${header()}\n${JSON.stringify({ type: "leaf" })}\n`,
    'line 2 has an unknown type ("leaf")',
  ],
  [
    "a cut that keeps an entry after it",
    `${header()}\n${JSON.stringify({ type: "submission" })}\n${JSON.stringify({ type: "compaction", summary: "s", firstKept: 3, tokensBefore: 1, details: { readFiles: [], modifiedFiles: [] }, usage, timestamp: 0 })}\n`,
    "line 3 is a Compaction whose first kept entry is not before it",
  ],
];

for (const [name, text, why] of unreadable) {
  test(`${name}: the part does not open, the reason names it, and the record's history seeds a new one`, () => {
    const history: HistoryMessage[] = [
      { role: "user", text: "the question" },
      { role: "assistant", text: "the answer" },
    ];
    const { open, said: logged, file, dir } = seatIn(history);
    writeFileSync(file, text);
    const part = open();
    assert.equal(logged.length, 1);
    assert.equal(
      logged[0],
      `harness: the engine part at ${dir} does not open (${why}) — continuing from the record's messages (ADR-0031)`,
    );
    assert.deepEqual(texts(part), ["user: the question", "assistant: the answer"]);
    assert.notEqual(part.id, "t-1", "a new transcript gets a new id");
    // The new file replaced the old one whole, and it opens.
    assert.deepEqual(readdirSync(dir), ["transcript.jsonl"]);
    assert.equal(open().id, part.id);
  });
}

test("no history and no file: a new transcript, and no log line", () => {
  const { open, said: logged, file } = seatIn();
  const part = open();
  assert.deepEqual(part.context(), []);
  assert.deepEqual(logged, []);
  assert.ok(existsSync(file));
});

test("memory mode writes no file", () => {
  const part = openEnginePart(undefined, { cwd: "/work", model });
  part.appendMessage(user("in memory"));
  assert.deepEqual(texts(part), ["user: in memory"]);
});

test("a failed append is the record's fault: the seat hears the path, and the entry is not in the part", () => {
  const { open, faults, file, dir } = seatIn();
  const part = open();
  // A directory where the file was: the next append throws.
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => part.appendMessage(user("lost")), /faulted/);
  assert.equal(faults.length, 1);
  assert.ok(faults[0]!.startsWith(`${join(dir, "transcript.jsonl")}: `));
  assert.deepEqual(part.context(), []);
});

const cut = (summary: string, firstKept: number): TranscriptEntry => ({
  type: "compaction",
  summary,
  firstKept,
  tokensBefore: 100,
  details: { readFiles: [], modifiedFiles: [] },
  usage,
  timestamp: 0,
});
const msg = (message: Message): TranscriptEntry => ({ type: "message", message });

test("context: every message with no cut; the newest cut's summary, its kept tail and what came after", () => {
  const entries: TranscriptEntry[] = [
    { type: "submission" },
    msg(user("u0")),
    msg(said("a0")),
    msg(user("u1")),
    msg(said("a1")),
  ];
  assert.deepEqual(texts(new EnginePart("t", [...entries], undefined, undefined)), [
    "user: u0",
    "assistant: a0",
    "user: u1",
    "assistant: a1",
  ]);
  const once = [...entries, cut("first", 3), msg(said("a2"))];
  assert.deepEqual(texts(new EnginePart("t", once, undefined, undefined)), [
    "summary: first",
    "user: u1",
    "assistant: a1",
    "assistant: a2",
  ]);
  // A second cut that keeps part of what the first one kept. The kept range runs over the first cut's
  // entry, which reads as its summary there: pi 0.82.1's rule (`buildSessionContext`), kept.
  const twice = [...once, msg(said("a3")), cut("second", 4), msg(said("a4"))];
  const part = new EnginePart("t", twice, undefined, undefined);
  assert.deepEqual(texts(part), [
    "summary: second",
    "assistant: a1",
    "summary: first",
    "assistant: a2",
    "assistant: a3",
    "assistant: a4",
  ]);
  // The branch the next cut works on reaches back to the FIRST cut's kept tail (index 3): the
  // second cut's walk passes the first cut, whose `firstKept` moves the stop back.
  assert.equal(part.branch().start, 3);
});
