// The file Working tools (ADR-0027): the claims the replay fixtures do not carry. Most of what
// `read`, `write` and `edit` answer is pinned against pi 0.82.1's own answers in
// `replay-pi-0.82.1.test.ts`; here are the two changes the port makes on purpose, and the
// mutation queue, which only parallel calls can show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineTool } from "../src/engine.ts";
import { fileTools } from "../src/file-tools.ts";
import { deniedDir, testChildren } from "./support/children.ts";

// The pod's `/run/jr2` in miniature: what the domain may not reach.
const secret = deniedDir("jr2-file-tools-secret-");
writeFileSync(join(secret, "standin"), "control-stand-in-value");
const children = testChildren({ deny: [secret] });

function toolsIn(dir: string): Record<string, EngineTool> {
  return Object.fromEntries(
    fileTools(dir, { files: children.spawner, home: children.env.HOME! }).map((t) => [t.name, t]),
  );
}

async function text(tool: EngineTool, args: unknown): Promise<string> {
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

test("edit returns its text alone, no diff details: nothing reads them (I-8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  const result = await toolsIn(dir).edit!.execute("call-1", {
    path: "a.txt",
    edits: [{ oldText: "one", newText: "1" }],
  } as never);
  assert.deepEqual(Object.keys(result), ["content"]);
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

// ADR-0076: the tools' I/O runs in the domain, so they reach what `bash` reaches — a path outside
// the Worktree, by `..`, by an absolute path or by a link — and fail where the domain is denied, as
// an unreadable file fails.
test("the file tools reach what bash reaches: outside the Worktree, by `..`, by an absolute path, by a link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  const outside = mkdtempSync(join(tmpdir(), "jr2-file-tools-outside-"));
  writeFileSync(join(outside, "notes"), "outside\n");
  symlinkSync(join(outside, "notes"), join(dir, "to-notes"));
  symlinkSync(outside, join(dir, "to-folder"));
  const { read, write } = toolsIn(dir);
  for (const path of [
    "../" + outside.split("/").pop() + "/notes",
    join(outside, "notes"),
    "to-notes",
    "to-folder/notes",
  ]) {
    assert.equal(await text(read!, { path }), "outside\n", path);
  }
  assert.equal(
    await text(write!, { path: "to-folder/new", content: "x" }),
    "Successfully wrote 1 bytes to to-folder/new",
  );
  assert.equal(readFileSync(join(outside, "new"), "utf8"), "x");
});

test("a path under the denied folder, or a link to one, fails as an unreadable file fails, and its bytes never show", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  symlinkSync(join(secret, "standin"), join(dir, "to-standin"));
  symlinkSync(secret, join(dir, "to-secret"));
  const { read, write, edit } = toolsIn(dir);
  for (const path of [join(secret, "standin"), "to-standin", "to-secret/standin"]) {
    const refused = await read!.execute("call-1", { path } as never).then(
      () => assert.fail(`read ${path} was not refused`),
      (err: Error) => err.message,
    );
    assert.match(refused, /^EACCES: permission denied, open '/, path);
    assert.doesNotMatch(refused, /control-stand-in-value/);
  }
  await assert.rejects(write!.execute("call-1", { path: "to-secret/new", content: "x" } as never), /^Error: EACCES/);
  await assert.rejects(write!.execute("call-1", { path: "to-standin", content: "x" } as never), /EACCES/);
  await assert.rejects(
    edit!.execute("call-1", { path: "to-standin", edits: [{ oldText: "control", newText: "x" }] } as never),
    /Could not edit file: to-standin\. Error code: permission_denied\./,
  );
  assert.equal(readFileSync(join(secret, "standin"), "utf8"), "control-stand-in-value");
  assert.ok(!existsSync(join(secret, "new")));
});

test("a link works, and write makes its folders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "AGENTS.md"), "the rules\n");
  symlinkSync("real/AGENTS.md", join(dir, "CLAUDE.md"));
  symlinkSync(join(dir, "real"), join(dir, "abs-link"));
  const { read, write, edit } = toolsIn(dir);
  assert.equal(await text(read!, { path: "CLAUDE.md" }), "the rules\n");
  assert.equal(await text(read!, { path: "abs-link/AGENTS.md" }), "the rules\n");
  assert.equal(
    await text(write!, { path: "abs-link/n/e/w.txt", content: "w" }),
    "Successfully wrote 1 bytes to abs-link/n/e/w.txt",
  );
  assert.equal(readFileSync(join(dir, "real", "n", "e", "w.txt"), "utf8"), "w");
  // A link to a folder is a link for `edit`, as pi's `lstat` named it: the read then fails.
  assert.equal(
    await edit!.execute("call-1", { path: "abs-link", edits: [{ oldText: "a", newText: "b" }] } as never).then(
      () => "edited",
      (err: Error) => err.message,
    ),
    "Could not edit file: abs-link. Error code: is_directory.",
  );
});

test("the bash tool's full output in TMPDIR is a file that `read` reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  const { bashTool } = await import("../src/bash-tool.ts");
  const bash = bashTool({ cwd: dir, children });
  const first = (await bash.execute("call-1", { command: "seq 1 2500" })).content[0];
  assert.ok(first && first.type === "text");
  const full = /Full output: (\S+?)\]/.exec(first.text)?.[1];
  assert.ok(full, first.text.slice(-200));
  assert.ok(full.startsWith(children.env.TMPDIR!), full);
  const read = await text(toolsIn(dir).read!, { path: full, offset: 2499 });
  assert.equal(read, "2499\n2500\n");
});

// ADR-0076: the Harness process has a HOME of its own, which the domain cannot write. `~` in a file
// tool's path is the domain's HOME, the folder that `bash` expands `~` to, so the tools do not
// change for the model.
test("~ in a path is the domain's HOME, not the Harness process's own (ADR-0076)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-file-tools-"));
  const home = children.env.HOME!;
  const own = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "jr2-harness-own-home-"));
  try {
    const { read, write, edit } = toolsIn(dir);
    await text(write!, { path: "~/notes/tilde.txt", content: "in the domain's HOME\n" });
    assert.equal(readFileSync(join(home, "notes", "tilde.txt"), "utf8"), "in the domain's HOME\n");
    assert.equal(existsSync(join(process.env.HOME, "notes")), false, "nothing in the Harness's HOME");
    await text(edit!, { path: "~/notes/tilde.txt", edits: [{ oldText: "domain's", newText: "Agent's" }] });
    assert.match(await text(read!, { path: "~/notes/tilde.txt" }), /in the Agent's HOME/);
  } finally {
    process.env.HOME = own;
  }
});
