// The ports against the original (the pi 1.x migration, I-11): `fixtures/pi-0.82.1/` holds a corpus
// of inputs and what pi-agent-core 0.82.1's OWN code answered for each (its README names the
// script). Each case here runs jr2's port over the same input and compares the answer byte for
// byte: the cut and the summary request (`compaction-summary.ts`), each file tool's text and the
// files after it (`file-tools.ts`), and each `bash` output and status (`bash-tool.ts`). A case the
// port answers differently is a change in what the model reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bashTool } from "../src/bash-tool.ts";
import { compact, prepareCompaction } from "../src/compaction-summary.ts";
import { fileTools } from "../src/file-tools.ts";
import { EnginePart, type TranscriptEntry } from "../src/pi-engine.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-0.82.1");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;

// ─── Compaction ──────────────────────────────────────────────────────────────

type CompactionCase = {
  name: string;
  entries: TranscriptEntry[];
  keepRecentTokens: number;
  thinkingLevel?: "off" | "high";
  model: Model<Api>;
  fail?: "error" | "aborted";
  output: Record<string, unknown>;
};

for (const c of load<CompactionCase[]>("compaction.json")) {
  test(`compaction, as pi 0.82.1 cut it: ${c.name}`, async () => {
    const part = new EnginePart("replay", structuredClone(c.entries), undefined, undefined);
    const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: c.keepRecentTokens };
    const prepared = prepareCompaction(part.branch(), settings);
    if (c.output.prepared === null) {
      assert.equal(prepared, undefined);
      return;
    }
    assert.ok(prepared);
    assert.deepEqual(
      { firstKept: prepared.firstKept, isSplitTurn: prepared.isSplitTurn, tokensBefore: prepared.tokensBefore },
      c.output.prepared,
    );
    const requests: unknown[] = [];
    let n = 0;
    const models = {
      completeSimple: async (m: Model<Api>, context: Context, options: Record<string, unknown>) => {
        n += 1;
        const { signal: _signal, sessionId: _sessionId, ...rest } = options;
        requests.push({
          systemPrompt: context.systemPrompt,
          messages: context.messages.map(({ timestamp: _t, ...message }) => message),
          options: rest,
        });
        const failing = c.fail && (c.name.includes("prefix") ? n === 1 : true);
        const answer: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: failing ? "" : `SUMMARY ${n}` }],
          api: m.api,
          provider: m.provider,
          model: m.id,
          usage: {
            input: 100 * n,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 100 * n + 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: failing ? c.fail! : "stop",
          ...(failing && c.fail === "error" ? { errorMessage: "400 scripted summary failure" } : {}),
          timestamp: 5,
        };
        return answer;
      },
    } as unknown as Models;
    const seat = {
      models,
      model: c.model,
      thinkingLevel: c.thinkingLevel ?? "off",
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      signal: undefined,
    } as const;
    let answer: Record<string, unknown>;
    try {
      const done = await compact(prepared, seat, settings);
      answer = {
        summary: done.summary,
        firstKept: done.firstKept,
        tokensBefore: done.tokensBefore,
        details: done.details,
        usage: done.usage,
      };
    } catch (err) {
      answer = { error: (err as Error).message };
    }
    const { prepared: _prepared, ...expected } = c.output;
    // JSON both ways: the fixture is JSON, so `Infinity` is `null` on both sides.
    assert.deepEqual(JSON.parse(JSON.stringify({ requests, ...answer })), expected);
  });
}

// ─── The file tools ──────────────────────────────────────────────────────────

type FileCase = {
  name: string;
  files: Record<string, string | { base64: string }>;
  tool: "read" | "write" | "edit";
  args: Record<string, unknown>;
  home?: boolean;
  output: { content?: unknown; error?: string; files?: Record<string, string> };
};

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else files[path] = readFileSync(join(dir, path), "utf8");
    }
  };
  walk("");
  return files;
}

for (const c of load<FileCase[]>("file-tools.json")) {
  test(`${c.tool}, as pi 0.82.1 answered: ${c.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr2-replay-"));
    const savedHome = process.env.HOME;
    if (c.home) process.env.HOME = dir;
    try {
      for (const [name, content] of Object.entries(c.files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), typeof content === "string" ? content : Buffer.from(content.base64, "base64"));
      }
      const tool = fileTools(dir).find((t) => t.name === c.tool) as AgentTool;
      const raw = JSON.parse(JSON.stringify(c.args).replaceAll("<dir>", dir)) as Record<string, unknown>;
      const args = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
      let output: { content?: unknown; error?: string; files?: Record<string, string> };
      try {
        output = { content: (await tool.execute("call-1", args as never)).content };
      } catch (err) {
        output = { error: (err as Error).message };
      }
      output = JSON.parse(JSON.stringify(output).replaceAll(dir, "<dir>")) as typeof output;
      if (c.tool !== "read") output.files = snapshot(dir);
      assert.deepEqual(output, c.output);
    } finally {
      if (c.home) process.env.HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ─── bash ────────────────────────────────────────────────────────────────────

type BashCase = {
  name: string;
  command: string;
  output: { text?: string; error?: string; fullOutputBytes?: number };
};

for (const c of load<BashCase[]>("bash.json")) {
  test(`bash, as pi 0.82.1 answered: ${c.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr2-replay-"));
    try {
      const output: BashCase["output"] = {};
      try {
        const first = (await bashTool({ cwd: dir }).execute("call-1", { command: c.command })).content[0];
        output.text = first && first.type === "text" ? first.text : "";
      } catch (err) {
        output.error = (err as Error).message;
      }
      const message = output.text ?? output.error ?? "";
      const full = /Full output: (\S+?)\]/.exec(message);
      if (full) {
        output.fullOutputBytes = statSync(full[1]!).size;
        if (output.text) output.text = output.text.replace(full[1]!, "<full-output>");
        if (output.error) output.error = output.error.replace(full[1]!, "<full-output>");
      }
      assert.deepEqual(output, c.output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
