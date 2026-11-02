// Working tools (ADR-0027/0028): the assembled set per definition, the ADR-0028 workspace filter,
// and jr2's own grep/glob against a real fixture tree. grep must not require ripgrep on PATH —
// the fallback test strips rg from PATH, so the plain-grep path is exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingToolsFor, type WorkingTool } from "../src/working-tools.ts";
import { testChildren } from "./support/children.ts";

// A copy outside the checkout: the tools run confined to their roots (ADR-0076), and rg reads the
// ignore files of each parent folder, which in the checkout are the repository's own.
const source = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "working-tools");
const fixtures = join(mkdtempSync(join(tmpdir(), "jr2-working-tools-")), "working-tools");
cpSync(source, fixtures, { recursive: true });
const definition = { instructions: "test", model: "anthropic/claude-x" };
const children = testChildren({ work: fixtures });

function names(tools: WorkingTool[]): string[] {
  return tools.map((t) => t.name);
}

function tool(name: string, using = children): WorkingTool {
  const found = workingToolsFor(definition, fixtures, { children: using }).find((t) => t.name === name);
  assert.ok(found, `no ${name} tool`);
  return found;
}

async function output(t: WorkingTool, params: unknown): Promise<string> {
  const result = await t.execute("call-1", params as never, undefined);
  const first = result.content[0];
  assert.ok(first && first.type === "text", "expected text content");
  return first.text;
}

test("the full set is read, write, edit, bash, grep, glob", () => {
  assert.deepEqual(names(workingToolsFor(definition, fixtures, { children })), [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
  ]);
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "write" }, fixtures, { children })), [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
  ]);
});

test('workspace "read" withholds write and edit — bash stays (ADR-0028)', () => {
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "read" }, fixtures, { children })), [
    "read",
    "bash",
    "grep",
    "glob",
  ]);
});

test("a Harness with no domain gives Working tools to no Agent (ADR-0076): it says so", () => {
  assert.throws(
    () => workingToolsFor(definition, fixtures),
    /has no domain to run a tool in, so it gives no Working tool/,
  );
  assert.deepEqual(workingToolsFor({ ...definition, workspace: "none" }, fixtures), []);
});

test('workspace "none" withholds the entire set — the Menu-only Agent (ADR-0028)', () => {
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "none" }, fixtures, { children })), []);
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
  const bin = mkdtempSync(join(tmpdir(), "jr2-no-rg-"));
  symlinkSync(grepBin, join(bin, "grep"));
  // The child's PATH holds grep alone: rg resolves to nothing.
  try {
    const out = await output(tool("grep", testChildren({ work: fixtures, env: { PATH: bin } })), {
      pattern: "needle",
      path: "sub",
    });
    assert.match(out, /bravo\.txt:1:a needle in sub/);
  } finally {
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

test("each Working tool declares to the model what pi 0.82.1 declared, byte for byte (ADR-0027)", async () => {
  // The fixture is the tools block of the golden capture made on pi 0.82.1 (`working-tools`), with
  // the Menu tools left out. JSON text, so the key order counts: it is part of what a provider caches.
  const { toToolDeclaration } = await import("@earendil-works/pi-ai");
  const { readFileSync } = await import("node:fs");
  const golden = JSON.parse(readFileSync(join(dirname(source), "working-tool-declarations.json"), "utf8")) as Array<{
    name: string;
    description: string;
    parameters: unknown;
    strict: boolean;
  }>;
  const declared = workingToolsFor(definition, fixtures, { children }).map(toToolDeclaration);
  assert.deepEqual(
    declared.map((d) => d.name),
    golden.map((g) => g.name),
  );
  for (const [i, tool] of declared.entries()) {
    const { strict: _strict, ...expected } = golden[i]!;
    assert.equal(JSON.stringify(tool), JSON.stringify(expected), `${tool.name}'s declaration changed`);
  }
});
