// The ports against the original (the pi 1.x migration, I-11): `fixtures/pi-0.82.1/` holds a corpus
// of inputs and what pi-agent-core 0.82.1's OWN code answered for each (its README names the
// script). Each case here runs jr2's port over the same input and compares the answer byte for
// byte: each file tool's text and the files after it (`file-tools.ts`), and each `bash` output and
// status (`bash-tool.ts`). A case the port answers differently is a change in what the model reads.
// Compaction is not here: it is pi's own code now (`pi-compaction.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bashTool } from "../src/bash-tool.ts";
import type { EngineTool } from "../src/engine.ts";
import { fileTools } from "../src/file-tools.ts";
import { testChildren } from "./support/children.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-0.82.1");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;

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

// One domain for every file case: the tools' I/O runs in it, as in a pod (ADR-0076).
const fileChildren = testChildren();

for (const c of load<FileCase[]>("file-tools.json")) {
  test(`${c.tool}, as pi 0.82.1 answered: ${c.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr2-replay-"));
    try {
      for (const [name, content] of Object.entries(c.files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), typeof content === "string" ? content : Buffer.from(content.base64, "base64"));
      }
      // A case `under ~` has the case folder as its HOME: the domain's HOME, which `~` names (ADR-0076).
      const home = c.home ? dir : fileChildren.env.HOME!;
      const tool = fileTools(dir, { files: fileChildren.spawner, home }).find((t) => t.name === c.tool) as EngineTool;
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
        const first = (
          await bashTool({ cwd: dir, children: testChildren({ work: dir }) }).execute("call-1", { command: c.command })
        ).content[0];
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
