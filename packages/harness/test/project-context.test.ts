// An Agent's project context (ADR-0062, `project-context.ts`): pi's context files and skills from
// the Worktree, loaded by a child in the domain, never in the Harness process. Every load here is
// through the real spawner and the real confiner (`support/children.ts`), so a link to a denied
// file fails in the kernel, as it does in a pod.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasProjectContext,
  loadProjectContext,
  parseProjectContext,
  projectContexts,
  projectContextText,
  type ProjectContext,
} from "../src/project-context.ts";
import { deniedDir, testChildren } from "./support/children.ts";

/** A Repo Slot's Worktree under a work root of its own: `<work>/app/default`. */
function worktree(): { work: string; dir: string } {
  const work = mkdtempSync(join(tmpdir(), "jr2-pc-work-"));
  const dir = join(work, "app", "default");
  mkdirSync(dir, { recursive: true });
  return { work, dir };
}

function skill(dir: string, name: string, description: string): string {
  const at = join(dir, ".pi", "skills", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nThe steps.\n`);
  return join(at, "SKILL.md");
}

const loaded = (r: Awaited<ReturnType<typeof loadProjectContext>>): ProjectContext => {
  assert.ok(r !== "aborted" && !("fault" in r), `a project context: ${JSON.stringify(r)}`);
  return r;
};

test("hasProjectContext: an Agent with Working tools in a Repo Slot's clone or Worktree, and no other", () => {
  assert.equal(hasProjectContext("write", "/work/app/default"), true);
  assert.equal(hasProjectContext(undefined, "/work/app/feat-1/src"), true);
  assert.equal(hasProjectContext("read", "/work/app/review"), true);
  assert.equal(hasProjectContext("none", "/work/app/default"), false, "a Menu-only Agent has no files");
  assert.equal(hasProjectContext("write", "/work"), false, "a Workspace with no Repo Slot works in /work");
  assert.equal(hasProjectContext("write", "/work/app"), false, "a slot's folder holds clones, it is not one");
  assert.equal(hasProjectContext("write", "/work/.jr2/x"), false, "jr2's own folder (ADR-0075)");
  assert.equal(hasProjectContext("write", "/work/app/../.jr2/x"), false);
  assert.equal(hasProjectContext("write", "/workx/app/default"), false);
  assert.equal(hasProjectContext("write", "/home/jr2/app/default"), false);
  assert.equal(hasProjectContext("write", "/tmp/w/app/default", "/tmp/w"), true);
});

test("projectContextText: pi's project_context and skills sections, outermost file first, and none for nothing", () => {
  assert.equal(projectContextText({ files: [], skills: "" }), "");
  assert.equal(
    projectContextText({
      files: [
        { path: "/work/AGENTS.md", content: "Outer." },
        { path: "/work/app/default/AGENTS.md", content: "Inner." },
      ],
      skills: "\n\nThe skills.",
    }),
    "<project_context>\nProject-specific instructions and guidelines:\n\n" +
      '<project_instructions path="/work/AGENTS.md">\nOuter.\n</project_instructions>\n\n' +
      '<project_instructions path="/work/app/default/AGENTS.md">\nInner.\n</project_instructions>\n' +
      "</project_context>\n\n<skills>\nThe skills.\n</skills>",
  );
  assert.equal(projectContextText({ files: [], skills: "Only skills." }), "<skills>\nOnly skills.\n</skills>");
});

test("parseProjectContext: the child's line is untrusted, and each field is checked", () => {
  assert.deepEqual(parseProjectContext('{"files":[{"path":"/a","content":"b"}],"skills":""}\n'), {
    files: [{ path: "/a", content: "b" }],
    skills: "",
  });
  // Only the two fields go on: nothing else the line holds reaches the prompt.
  assert.deepEqual(parseProjectContext('{"files":[{"path":"/a","content":"b","x":1}],"skills":"s","y":2}'), {
    files: [{ path: "/a", content: "b" }],
    skills: "s",
  });
  for (const bad of [
    "",
    "not json",
    "[]",
    "null",
    '{"files":{}, "skills":""}',
    '{"files":[]}',
    '{"files":[{"path":1,"content":"b"}],"skills":""}',
    '{"files":[null],"skills":""}',
  ]) {
    assert.ok("fault" in (parseProjectContext(bad) as object), `refused: ${bad}`);
  }
});

test("loadProjectContext: the Worktree's AGENTS.md, the context files above it, and its .pi/skills, as pi finds them", async () => {
  const { work, dir } = worktree();
  writeFileSync(join(work, "CLAUDE.md"), "The Workspace's rules.\n");
  writeFileSync(join(dir, "AGENTS.md"), "# Repo rules\nUse tabs.\n");
  const skillFile = skill(dir, "release-notes", "Write the release notes.");
  const ctx = loaded(await loadProjectContext(testChildren({ work }), dir));
  assert.deepEqual(ctx.files, [
    { path: join(work, "CLAUDE.md"), content: "The Workspace's rules.\n" },
    { path: join(dir, "AGENTS.md"), content: "# Repo rules\nUse tabs.\n" },
  ]);
  assert.match(ctx.skills, /Use the read tool to load a skill's file/);
  assert.ok(ctx.skills.includes(`<name>release-notes</name>`), ctx.skills);
  assert.ok(ctx.skills.includes(`<location>${skillFile}</location>`), ctx.skills);
  // An empty Worktree has none.
  const empty = worktree();
  assert.deepEqual(loaded(await loadProjectContext(testChildren({ work: empty.work }), empty.dir)), {
    files: [],
    skills: "",
  });
});

test("loadProjectContext: an AGENTS.md that links to a file under /run/jr2 fails in the domain, and its content goes nowhere", async () => {
  const secret = "the-control-stand-in-0f3c9d";
  const held = deniedDir("held-");
  writeFileSync(join(held, "standin"), `${secret}\n`);
  const { work, dir } = worktree();
  symlinkSync(join(held, "standin"), join(dir, "AGENTS.md"));
  // pi goes on to the next name: the Worktree's CLAUDE.md still loads.
  writeFileSync(join(dir, "CLAUDE.md"), "The repo's own rules.\n");
  // A skill whose file links there is not loaded either.
  mkdirSync(join(dir, ".pi", "skills", "leak"), { recursive: true });
  symlinkSync(join(held, "standin"), join(dir, ".pi", "skills", "leak", "SKILL.md"));
  const children = testChildren({ work, deny: [held] });
  const ctx = loaded(await loadProjectContext(children, dir));
  assert.deepEqual(ctx.files, [{ path: join(dir, "CLAUDE.md"), content: "The repo's own rules.\n" }]);
  assert.equal(ctx.skills, "");
  assert.ok(!JSON.stringify(ctx).includes(secret), "the Stand-in is nowhere in the project context");
  assert.ok(!projectContextText(ctx).includes(secret));
});

test("loadProjectContext: a child that fails, writes too much, writes no JSON or runs too long gives a fault, not a context", async () => {
  const { work, dir } = worktree();
  writeFileSync(join(dir, "AGENTS.md"), "x".repeat(4096));
  const children = testChildren({ work });
  const fault = (r: Awaited<ReturnType<typeof loadProjectContext>>): string => {
    assert.ok(r !== "aborted" && "fault" in r, `a fault: ${JSON.stringify(r)}`);
    return r.fault;
  };
  assert.match(fault(await loadProjectContext(children, dir, { maxBytes: 1024 })), /more than 1024 bytes/);
  const bin = mkdtempSync(join(tmpdir(), "jr2-pc-entry-"));
  const entry = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    return join(bin, name);
  };
  assert.match(
    fault(
      await loadProjectContext(children, dir, { entry: entry("fail.mjs", 'console.error("boom"); process.exit(3);') }),
    ),
    /^it exited 3: boom$/,
  );
  assert.match(
    fault(await loadProjectContext(children, dir, { entry: entry("text.mjs", 'console.log("hello");') })),
    /not one JSON line/,
  );
  assert.match(
    fault(
      await loadProjectContext(children, dir, {
        entry: entry("slow.mjs", "setTimeout(() => {}, 60_000);"),
        timeoutMs: 300,
      }),
    ),
    /SIGTERM|exited|timed out/,
  );
  const ac = new AbortController();
  ac.abort();
  assert.equal(await loadProjectContext(children, dir, { signal: ac.signal }), "aborted");
});

test("projectContexts: each folder loads once, so a later change of AGENTS.md does not move the text; a failure is said once", async () => {
  const { work, dir } = worktree();
  writeFileSync(join(dir, "AGENTS.md"), "First rules.\n");
  const lines: string[] = [];
  const of = projectContexts(testChildren({ work }), (line) => lines.push(line));
  const signal = new AbortController().signal;
  const first = await of(dir, signal);
  assert.match(first, /First rules\./);
  writeFileSync(join(dir, "AGENTS.md"), "Second rules.\n");
  assert.equal(await of(dir, signal), first, "byte-equal on the next Submission");

  const failing = projectContexts(testChildren({ work }), (line) => lines.push(line), {
    entry: join(work, "no-such-entry.mjs"),
  });
  assert.equal(await failing(dir, signal), "");
  assert.equal(await failing(dir, signal), "");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(
    lines[0]!,
    new RegExp(`^jr2 harness: no project context from ${dir}: the child that loads it failed: it exited 1`),
  );
  assert.match(lines[0]!, /\(ADR-0062\)$/);
});
