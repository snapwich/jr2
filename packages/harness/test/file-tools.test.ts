// The file Working tools (ADR-0027): the claims the replay fixtures do not carry. Most of what
// `read`, `write` and `edit` answer is pinned against pi 0.82.1's own answers in
// `replay-pi-0.82.1.test.ts`; here are the two changes the port makes on purpose, and the
// mutation queue, which only parallel calls can show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fileTools } from "../src/file-tools.ts";

function toolsIn(dir: string): Record<string, AgentTool> {
  return Object.fromEntries(fileTools(dir).map((t) => [t.name, t]));
}

async function text(tool: AgentTool, args: unknown): Promise<string> {
  const first = (await tool.execute("call-1", args as never)).content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

test("write reports UTF-8 bytes, which pi 0.82.1 counted as UTF-16 units (I-9)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  const { write } = toolsIn(dir);
  // "héllo ✓" is 7 UTF-16 units and 10 UTF-8 bytes. 0.82.1 said 7.
  assert.equal(await text(write!, { path: "u.txt", content: "héllo ✓" }), "Successfully wrote 10 bytes to u.txt");
  assert.equal(readFileSync(join(dir, "u.txt")).length, 10);
});

test("edit returns no diff details: nothing reads them (I-8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  const result = await toolsIn(dir).edit!.execute("call-1", {
    path: "a.txt",
    edits: [{ oldText: "one", newText: "1" }],
  } as never);
  assert.equal(result.details, undefined);
});

test("two parallel edits of one file run one after the other, and both land", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  writeFileSync(join(dir, "a.txt"), "alpha\nbeta\n");
  const { edit } = toolsIn(dir);
  const answers = await Promise.all([
    text(edit!, { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
    text(edit!, { path: join(dir, "a.txt"), edits: [{ oldText: "beta", newText: "BETA" }] }),
  ]);
  assert.deepEqual(answers, [
    "Successfully replaced 1 block(s) in a.txt.",
    `Successfully replaced 1 block(s) in ${join(dir, "a.txt")}.`,
  ]);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "ALPHA\nBETA\n");
});

test("a relative path resolves against the tools' cwd, the Frame's (ADR-0057)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  const { write, read } = toolsIn(dir);
  await text(write!, { path: "sub/f.txt", content: "here" });
  assert.equal(readFileSync(join(dir, "sub", "f.txt"), "utf8"), "here");
  assert.equal(await text(read!, { path: "sub/f.txt" }), "here");
});
