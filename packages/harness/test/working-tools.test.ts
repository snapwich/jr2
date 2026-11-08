// Working tools (ADR-0027/0028): the assembled set per definition, the ADR-0028 workspace filter,
// jr2's own grep and pi's find with jr2's glob against a real fixture tree, and the declarations
// that the model reads. Neither search requires ripgrep on PATH — the fallback tests strip rg from
// PATH, so the plain-grep and plain-find paths are exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// pi's ignore list for find: `node_modules` and `.git` (the checkout ignores a node_modules, so the
// copy gets them here).
for (const dir of ["node_modules/pkg", ".git/hooks"]) {
  mkdirSync(join(fixtures, dir), { recursive: true });
  writeFileSync(join(fixtures, dir, "index.js"), "ignored\n");
}
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

test("the full set is read, write, edit, bash, grep, find", () => {
  assert.deepEqual(names(workingToolsFor(definition, fixtures, { children })), [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
  ]);
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "write" }, fixtures, { children })), [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
  ]);
});

test('workspace "read" withholds write and edit — bash stays (ADR-0028)', () => {
  assert.deepEqual(names(workingToolsFor({ ...definition, workspace: "read" }, fixtures, { children })), [
    "read",
    "bash",
    "grep",
    "find",
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

test("grep's schema: pattern required, path optional", () => {
  const schema = tool("grep").parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties), ["pattern", "path"]);
  assert.deepEqual(schema.required, ["pattern"]);
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

/** A domain whose PATH holds `find` alone of the search programs: rg and fd resolve to nothing. */
function withoutRg(): { children: ReturnType<typeof testChildren>; done: () => void } {
  const bin = mkdtempSync(join(tmpdir(), "jr2-no-rg-"));
  for (const name of ["find", "sh"]) {
    const found = (process.env.PATH ?? "")
      .split(delimiter)
      .map((dir) => join(dir, name))
      .find(existsSync);
    assert.ok(found, `no ${name} on PATH — cannot exercise the fallback`);
    symlinkSync(found, join(bin, name));
  }
  return {
    children: testChildren({ work: fixtures, env: { PATH: bin } }),
    done: () => rmSync(bin, { recursive: true, force: true }),
  };
}

for (const [how, using] of [
  ["rg", () => ({ children, done: () => {} })],
  ["plain find, where rg is absent", withoutRg],
] as const) {
  test(`find (${how}): a basename pattern matches at any depth; a pattern with a / matches the path at any depth`, async () => {
    const { children: c, done } = using();
    try {
      assert.equal(await output(tool("find", c), { pattern: "*.ts" }), "alpha.ts");
      assert.equal(await output(tool("find", c), { pattern: "*.txt" }), "sub/bravo.txt");
      assert.equal(await output(tool("find", c), { pattern: "sub/*.txt" }), "sub/bravo.txt");
      assert.equal(await output(tool("find", c), { pattern: "**/*.txt" }), "sub/bravo.txt");
    } finally {
      done();
    }
  });

  test(`find (${how}): path narrows the search, the paths are relative to it, and pi's ignore list holds`, async () => {
    const { children: c, done } = using();
    try {
      assert.equal(await output(tool("find", c), { pattern: "*.txt", path: "sub" }), "bravo.txt");
      assert.equal(await output(tool("find", c), { pattern: "*.ts", path: "sub" }), "No files found matching pattern");
      assert.equal(await output(tool("find", c), { pattern: "*.js" }), "No files found matching pattern");
    } finally {
      done();
    }
  });
}

test("find: the limit bounds the results and says so", async () => {
  assert.equal(await output(tool("find"), { pattern: "*", limit: 1 }), "alpha.ts\n\n[1 results limit reached]");
});

test("find: a missing directory is pi's error", async () => {
  await assert.rejects(
    tool("find").execute("call-1", { pattern: "*", path: "no-such-dir" } as never),
    /^Error: Path not found: .*no-such-dir$/,
  );
});

test("each Working tool declares to the model what the capture holds, byte for byte (ADR-0027)", async () => {
  // The fixture is pi-coding-agent 1.5.0's declarations of read, write, edit, bash and find, and
  // jr2's grep, as the model reads them. JSON text, so the key order counts: it is part of what a
  // provider caches. A pin bump that changes what the model reads fails here: read the change, and
  // write the fixture again in the same commit.
  const { toToolDeclaration } = await import("@earendil-works/pi-ai");
  const { readFileSync } = await import("node:fs");
  const golden = JSON.parse(readFileSync(join(dirname(source), "working-tool-declarations.json"), "utf8")) as unknown[];
  const declared = workingToolsFor(definition, fixtures, { children }).map(toToolDeclaration);
  assert.deepEqual(
    declared.map((d) => d.name),
    ["read", "write", "edit", "bash", "grep", "find"],
  );
  assert.equal(JSON.stringify(declared), JSON.stringify(golden));
});
