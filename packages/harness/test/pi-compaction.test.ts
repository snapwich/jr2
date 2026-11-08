// The import of pi's Compaction and the adapter (`pi-compaction.ts`, ADR-0036): the private files
// are where this pin has them, the import adds no signal listener, and the flat transcript shown to
// pi as a linear session gives the context that jr2's own port of pi 0.82.1 gave.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { compactIfOver, compactionSettingsFor } from "../src/compaction.ts";
import type { EngineMessage } from "../src/engine.ts";
import { contextOf, PRIVATE_FILES, sessionChain, transcriptCompaction } from "../src/pi-compaction.ts";
import type { EngineSeat } from "../src/record.ts";
import { openEnginePart, type TranscriptEntry } from "../src/transcript.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

test("the private files of pi's Compaction are where this pin has them, with the names jr2 calls", async () => {
  // The package root does not export `prepareCompaction` or `estimateProjectedContextTokens`, so
  // `pi-compaction.ts` imports these files by a file URL. A pin bump that moves one fails here.
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  const names: Record<keyof typeof PRIVATE_FILES, string[]> = {
    compaction: ["prepareCompaction", "estimateProjectedContextTokens", "shouldCompact", "estimateTokens", "compact"],
    session: ["buildSessionProjection"],
    messages: ["convertToLlm"],
  };
  for (const [file, wanted] of Object.entries(names)) {
    const module = (await import(new URL(PRIVATE_FILES[file as keyof typeof PRIVATE_FILES], root).href)) as Record<
      string,
      unknown
    >;
    for (const name of wanted) assert.equal(typeof module[name], "function", `${file}: ${name}`);
  }
  // `compact` takes its stream function and its retry policy at these places (`pi-compaction.ts`).
  const compaction = (await import(new URL(PRIVATE_FILES.compaction, root).href)) as { compact: { length: number } };
  assert.equal(compaction.compact.length, 12);
});

test("the import adds no SIGINT or SIGTERM listener: the Harness's own drain is the only one", () => {
  // The package root loads signal-exit, which listens for both. The private files do not.
  const module = join(here, "..", "src", "pi-compaction.ts");
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(module)}); console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.trim(), "0 0");
});

type ContextCase = { name: string; entries: TranscriptEntry[]; context: unknown[] };

// `transcript-contexts.json` holds the transcripts of the old replay corpus (each case, and each
// case with the cut that pi 0.82.1 took appended) and the context that jr2's port of 0.82.1 gave.
for (const c of JSON.parse(readFileSync(join(fixtures, "transcript-contexts.json"), "utf8")) as ContextCase[]) {
  test(`the adapter gives the context of the old port: ${c.name}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(contextOf(c.entries))), c.context);
  });
}

test("the chain is linear: the id is the index, the parent is the entry before it", () => {
  const entries: TranscriptEntry[] = [
    { type: "submission" },
    { type: "message", message: { role: "user", content: "hi", timestamp: 7 } },
    {
      type: "compaction",
      summary: "s",
      firstKept: 1,
      tokensBefore: 9,
      details: { readFiles: ["a"], modifiedFiles: [] },
      usage: { ...NO_USAGE },
      timestamp: 11,
    },
  ];
  const chain = sessionChain(entries);
  assert.deepEqual(
    chain.map((e) => [e.id, e.parentId, e.type]),
    [
      ["0", null, "custom"],
      ["1", "0", "message"],
      ["2", "1", "compaction"],
    ],
  );
  assert.equal((chain[2] as { firstKeptEntryId: string }).firstKeptEntryId, "1");
  assert.equal(chain[2]!.timestamp, new Date(11).toISOString());
  // And back: pi's result names its first kept entry by the id, which is the index.
  const back = transcriptCompaction(
    { summary: "s", firstKeptEntryId: "1", tokensBefore: 9, details: { readFiles: ["a"], modifiedFiles: [] } },
    11,
  );
  assert.deepEqual({ type: "compaction", ...back, usage: NO_USAGE }, entries[2]);
  assert.throws(
    () => transcriptCompaction({ summary: "s", firstKeptEntryId: "x", tokensBefore: 0 }, 0),
    /not in the transcript/,
  );
});

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("a transcript that the earlier Harness wrote opens and compacts: the format did not change", async () => {
  // `transcript-v1.jsonl` was written by the Harness before this change (its port of pi 0.82.1). It
  // holds a Compaction already, so the next cut is an update of that summary.
  const dir = mkdtempSync(join(tmpdir(), "jr2-pi-compaction-"));
  try {
    cpSync(join(fixtures, "transcript-v1.jsonl"), join(dir, "transcript.jsonl"));
    const seat: EngineSeat = {
      dir: () => dir,
      history: () => [],
      fault: (err) => {
        throw err;
      },
    };
    const model = {
      id: "model-x",
      name: "model-x",
      api: "openai-completions",
      provider: "fake",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    } as Model<Api>;
    const part = openEnginePart(seat, ".", { cwd: "/work", model }, () => assert.fail("the transcript opens"));
    const before = part.all().length;
    assert.equal(part.context()[0]!.role, "compactionSummary");
    // A reading over the window, after the cut.
    part.appendMessage({ role: "user", content: [{ type: "text", text: "go on" }], timestamp: 20 });
    part.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      api: "openai-completions",
      provider: "fake",
      model: "model-x",
      usage: { ...NO_USAGE, input: 190_000 },
      stopReason: "stop",
      timestamp: 21,
    });
    const prompts: string[] = [];
    const models = {
      streamSimple: (_m: unknown, context: unknown) => {
        prompts.push(JSON.stringify(context));
        return {
          result: async () =>
            ({
              role: "assistant",
              content: [{ type: "text", text: "UPDATED" }],
              usage: NO_USAGE,
              stopReason: "stop",
            }) as unknown as AssistantMessage,
        };
      },
    } as unknown as Models;
    const cut = await compactIfOver({
      part,
      models,
      model,
      thinkingLevel: "off",
      settings: compactionSettingsFor(model, 3),
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      signal: undefined,
    });
    assert.ok(cut);
    assert.ok(
      prompts.some((p) => p.includes("<previous-summary>")),
      "the cut updates the earlier summary",
    );
    // The new entry is on disk, in the same format, and the file opens again with it.
    const reopened = openEnginePart(seat, ".", { cwd: "/work", model }, () => assert.fail("the transcript opens"));
    assert.equal(reopened.all().length, before + 3);
    const summary = reopened.context()[0] as Extract<EngineMessage, { role: "compactionSummary" }>;
    assert.match(summary.summary, /^UPDATED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
