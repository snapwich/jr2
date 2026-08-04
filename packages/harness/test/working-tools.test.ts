// Working tools (ADR-0027/0028): the assembled set per definition, the ADR-0028 workspace filter,
// and j2's own grep/glob against a real fixture tree. grep must not require ripgrep on PATH —
// the fallback test strips rg from PATH, so the plain-grep path is exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingToolsFor, type WorkingTool } from "../src/working-tools.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "working-tools");
const definition = { instructions: "test", model: "anthropic/claude-x" };

function names(tools: WorkingTool[]): string[] {
  return tools.map((t) => t.name);
}

function tool(name: string): WorkingTool {
  const found = workingToolsFor(definition, fixtures).find((t) => t.name === name);
  assert.ok(found, `no ${name} tool`);
  return found;
}

async function output(t: WorkingTool, params: unknown): Promise<string> {
  const result = await t.execute("call-1", params as never, undefined, undefined, undefined as never);
  const first = result.content[0];
  assert.ok(first && first.type === "text", "expected text content");
  return first.text;
}

test("the full set is read, write, edit, bash, grep, glob", () => {
  assert.deepEqual(names(workingToolsFor(definition, fixtures)), ["read", "write", "edit", "bash", "grep", "glob"]);
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "write" }, fixtures)), [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
  ]);
});

test('workspace "read" withholds write and edit — bash stays (ADR-0028)', () => {
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "read" }, fixtures)), [
    "read",
    "bash",
    "grep",
    "glob",
  ]);
});

test('workspace "none" withholds the entire set — the Menu-only Agent (ADR-0028)', () => {
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "none" }, fixtures)), []);
});

test("grep/glob schemas: pattern required, path optional", () => {
  for (const name of ["grep", "glob"]) {
    const schema = tool(name).parameters as { properties: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(schema.properties), ["pattern", "path"]);
    assert.deepEqual(schema.required, ["pattern"]);
  }
});

test("grep: matching lines come back as file:line:text", async () => {
  const out = await output(tool("grep"), { pattern: "needle" });
  const lines = out.split("\n").sort();
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /alpha\.ts:1:.*needle/);
  assert.match(lines[1]!, /sub\/bravo\.txt:1:a needle in sub/);
});

test("grep: path narrows the search", async () => {
  const out = await output(tool("grep"), { pattern: "needle", path: "sub" });
  assert.match(out, /bravo\.txt:1:/);
  assert.doesNotMatch(out, /alpha\.ts/);
});

test('grep: zero matches answers "no matches", not a failure', async () => {
  assert.equal(await output(tool("grep"), { pattern: "definitely-absent-token" }), "no matches");
});

test("grep: falls back to plain grep when rg is absent from PATH", async () => {
  const grepBin = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "grep"))
    .find(existsSync);
  assert.ok(grepBin, "no grep on PATH — cannot exercise the fallback");
  const bin = mkdtempSync(join(tmpdir(), "j2-no-rg-"));
  symlinkSync(grepBin, join(bin, "grep"));
  const path = process.env.PATH;
  process.env.PATH = bin; // execFile reads PATH at spawn time — rg now resolves to nothing
  try {
    const out = await output(tool("grep"), { pattern: "needle", path: "sub" });
    assert.match(out, /bravo\.txt:1:a needle in sub/);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("grep: a broken pattern throws — pi renders the message as the isError result", async () => {
  await assert.rejects(output(tool("grep"), { pattern: "[unclosed" }));
});

test("glob: a basename pattern matches at any depth", async () => {
  assert.equal(await output(tool("glob"), { pattern: "*.ts" }), "./alpha.ts");
  assert.equal(await output(tool("glob"), { pattern: "*.txt" }), "./sub/bravo.txt");
});

test("glob: a pattern with directories matches against the path", async () => {
  assert.equal(await output(tool("glob"), { pattern: "sub/*.txt" }), "./sub/bravo.txt");
  assert.equal(await output(tool("glob"), { pattern: "**/*.txt" }), "./sub/bravo.txt");
});

test('glob: path narrows the search; zero matches answers "no matches"', async () => {
  assert.equal(await output(tool("glob"), { pattern: "*.md", path: "sub" }), "no matches");
  assert.equal(await output(tool("glob"), { pattern: "*.ts", path: "sub" }), "no matches");
});

test("glob: a missing directory throws", async () => {
  await assert.rejects(output(tool("glob"), { pattern: "*", path: "no-such-dir" }));
});
