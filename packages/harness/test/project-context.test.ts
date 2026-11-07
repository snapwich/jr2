// An Agent's project context (ADR-0062, `project-context.ts`): pi's context files and skills from
// the Worktree, loaded by a child in the domain, never in the Harness process. Every load here is
// through the real spawner and the real confiner (`support/children.ts`), so a link to a denied
// file fails in the kernel, as it does in a pod.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextBound,
  contextScopeOf,
  hasProjectContext,
  loadProjectContext,
  parseProjectContext,
  projectContexts,
  projectContextText,
  USER_CONTEXT_NAMES,
  asImagePaths,
  userContextMount,
  withinBound,
  type ProjectContext,
  type UserContextMount,
} from "../src/project-context.ts";
import { runIn } from "../src/children.ts";
import { deniedDir, testChildren } from "./support/children.ts";

/** A Repo Slot's Worktree under a work root of its own: `<root>/work/app/default`. `root` stands
 * for `/`: a file there is above the work root. */
function worktree(): { root: string; work: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "jr2-pc-root-"));
  const work = join(root, "work");
  const dir = join(work, "app", "default");
  mkdirSync(dir, { recursive: true });
  return { root, work, dir };
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

test("hasProjectContext: an Agent with Working tools in /work or a folder in it, and no other", () => {
  assert.equal(hasProjectContext("write", "/work/app/default"), true);
  assert.equal(hasProjectContext(undefined, "/work/app/feat-1/src"), true);
  assert.equal(hasProjectContext("read", "/work/app/review"), true);
  assert.equal(hasProjectContext("write", "/work"), true, "a Workspace with no Repo Slot works in /work");
  assert.equal(hasProjectContext("write", "/work/"), true);
  assert.equal(hasProjectContext("write", "/work/app"), true);
  assert.equal(hasProjectContext("none", "/work/app/default"), false, "a Menu-only Agent has no files");
  assert.equal(hasProjectContext("write", "/work/.jr2/x"), false, "jr2's own folder (ADR-0075)");
  assert.equal(hasProjectContext("write", "/work/app/../.jr2/x"), false);
  assert.equal(hasProjectContext("write", "/workx/app/default"), false);
  assert.equal(hasProjectContext("write", "/home/jr2/app/default"), false);
  assert.equal(hasProjectContext("write", "/"), false);
  assert.equal(hasProjectContext("write", "/tmp/w/app/default", "/tmp/w"), true);
});

test("contextBound: a Worktree's root under worktree, /work under workspace; the path decides, not a .git", () => {
  for (const [cwd, bound] of [
    ["/work/app/fix", "/work/app/fix"],
    ["/work/app/fix/", "/work/app/fix"],
    ["/work/app/fix/packages/core", "/work/app/fix"],
    ["/work/app/default", "/work/app/default"],
    ["/work/app/review/src", "/work/app/review"],
    // No Worktree holds these: the folder itself.
    ["/work/app", "/work/app"],
    ["/work", "/work"],
  ] as const) {
    assert.equal(contextBound(cwd, "worktree"), bound, cwd);
    assert.equal(contextBound(cwd, "workspace"), "/work", cwd);
  }
  assert.equal(contextBound("/tmp/w/app/x/y", "worktree", "/tmp/w"), "/tmp/w/app/x");
  assert.equal(contextScopeOf("workspace"), "workspace");
  for (const v of [undefined, "", "worktree", "Workspace", "user"]) assert.equal(contextScopeOf(v), "worktree");
});

test("withinBound: only files from cwd up to the bound, or in the image user's folder, stay, in pi's order", () => {
  const f = (path: string) => ({ path, content: path });
  const ctx = {
    files: [
      f("/home/u/.pi/agent/AGENTS.md"),
      f("/AGENTS.md"),
      f("/work/AGENTS.md"),
      f("/work/app/AGENTS.md"),
      f("/work/app/fix/AGENTS.md"),
      f("/work/app/fix/src/CLAUDE.md"),
    ],
    skills: "s",
  };
  const kept = (bound: string, user?: string) =>
    withinBound(ctx, "/work/app/fix/src", bound, user).files.map((x) => x.path);
  assert.deepEqual(kept("/work/app/fix"), ["/work/app/fix/AGENTS.md", "/work/app/fix/src/CLAUDE.md"]);
  assert.deepEqual(kept("/work"), [
    "/work/AGENTS.md",
    "/work/app/AGENTS.md",
    "/work/app/fix/AGENTS.md",
    "/work/app/fix/src/CLAUDE.md",
  ]);
  assert.deepEqual(kept("/work/app/fix", "/home/u/.pi/agent"), [
    "/home/u/.pi/agent/AGENTS.md",
    "/work/app/fix/AGENTS.md",
    "/work/app/fix/src/CLAUDE.md",
  ]);
  assert.equal(withinBound(ctx, "/work/app/fix/src", "/work").skills, "s");
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

test("loadProjectContext: the Worktree's AGENTS.md and its .pi/skills; a file above the Worktree only under workspace, and none above /work", async () => {
  const { root, work, dir } = worktree();
  writeFileSync(join(root, "AGENTS.md"), "Above the work root.\n");
  writeFileSync(join(work, "CLAUDE.md"), "The Workspace's rules.\n");
  writeFileSync(join(work, "app", "AGENTS.md"), "The slot's rules.\n");
  writeFileSync(join(dir, "AGENTS.md"), "# Repo rules\nUse tabs.\n");
  const skillFile = skill(dir, "release-notes", "Write the release notes.");
  const children = testChildren({ work });
  const ctx = loaded(await loadProjectContext(children, dir, { workRoot: work }));
  assert.deepEqual(ctx.files, [{ path: join(dir, "AGENTS.md"), content: "# Repo rules\nUse tabs.\n" }]);
  assert.match(ctx.skills, /Use the read tool to load a skill's file/);
  assert.ok(ctx.skills.includes(`<name>release-notes</name>`), ctx.skills);
  assert.ok(ctx.skills.includes(`<location>${skillFile}</location>`), ctx.skills);
  // Under "workspace", up to the work root, and never above it.
  const wide = loaded(await loadProjectContext(children, dir, { workRoot: work, scope: "workspace" }));
  assert.deepEqual(wide.files, [
    { path: join(work, "CLAUDE.md"), content: "The Workspace's rules.\n" },
    { path: join(work, "app", "AGENTS.md"), content: "The slot's rules.\n" },
    { path: join(dir, "AGENTS.md"), content: "# Repo rules\nUse tabs.\n" },
  ]);
  // A Workspace with no Repo Slot: its Agents work in /work, which reads its own file alone.
  const job = loaded(await loadProjectContext(children, work, { workRoot: work }));
  assert.deepEqual(job.files, [{ path: join(work, "CLAUDE.md"), content: "The Workspace's rules.\n" }]);
  // Removing the Worktree's .git file, or making one, moves no bound: the path decides.
  writeFileSync(join(dir, ".git"), "gitdir: /nowhere\n");
  assert.deepEqual(loaded(await loadProjectContext(children, dir, { workRoot: work })).files, ctx.files);
  // An empty Worktree has none.
  const empty = worktree();
  assert.deepEqual(
    loaded(await loadProjectContext(testChildren({ work: empty.work }), empty.dir, { workRoot: empty.work })),
    {
      files: [],
      skills: "",
    },
  );
});

/** `major:minor` of a folder's device, as `/proc/self/mountinfo` writes it. */
function deviceOf(dir: string): string {
  const dev = statSync(dir, { bigint: true }).dev;
  return `${((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)}:${(dev & 0xffn) | ((dev >> 12n) & ~0xffn)}`;
}

/** A mountinfo line for a mount at `dir` (proc(5)), with a space in the path escaped as the kernel
 * does. */
const mountLine = (id: string, device: string, dir: string, options = "ro,relatime") =>
  `${id} 25 ${device} /home/u/.pi/agent ${dir.replace(/ /g, "\\040")} ${options} - overlay overlay ro`;

/** An image user's context folder in a test's own root, and a mount table that names it as the
 * pod's read-only mount. */
function userMount(): { root: string; dir: string; table: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jr2-pc-user-")));
  const dir = join(root, "home u", ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const table = ["22 1 0:21 / / rw - overlay overlay rw", mountLine("4021", deviceOf(dir), dir)].join("\n");
  return { root, dir, table };
}

test("userContextMount: a read-only mount at its own real path, when the pod announces the image's folder; none when none is announced", () => {
  const { root, dir, table } = userMount();
  const image = "/home/u/.pi/agent";
  const at = (announced: string | undefined, t = table, d = dir) => userContextMount(announced, () => t, d);
  assert.equal(at(undefined), undefined);
  assert.equal(at(""), undefined, "the pod announces none");
  assert.deepEqual(at(image), { dir, image });
  const fault = (r: ReturnType<typeof userContextMount>): string => {
    assert.ok(r !== undefined && "fault" in r, JSON.stringify(r));
    return r.fault;
  };
  assert.match(fault(at("home/.pi/agent")), /not an absolute folder/);
  assert.match(fault(at(`${image}/`)), /not an absolute folder/);
  assert.match(fault(at("/home//u/.pi/agent")), /not an absolute folder/);
  assert.match(fault(at(image, table, join(root, "nothing"))), /cannot be read: ENOENT/);
  assert.match(fault(at(image, "22 1 0:21 / / rw - overlay overlay rw")), /is no mount/);
  assert.match(fault(at(image, mountLine("4021", deviceOf(dir), dir, "rw,relatime"))), /not read-only/);
  assert.match(fault(at(image, mountLine("4021", "0:9999", dir))), /on device .*, not on its mount's 0:9999/);
  symlinkSync(dir, join(root, "link"));
  assert.match(
    fault(at(image, mountLine("4021", deviceOf(dir), join(root, "link")), join(root, "link"))),
    /own real path/,
  );
});

test("asImagePaths: a file and a skill of the mount are named at the image's folder, where the model reads them; others stay", () => {
  const m = { dir: "/run/jr2/user-context", image: "/home/a&b/.pi/agent" };
  const skills = [
    "<location>/run/jr2/user-context/skills/deploy/SKILL.md</location>",
    "<location>/work/app/fix/.pi/skills/x/SKILL.md</location>",
  ].join("\n");
  assert.deepEqual(
    asImagePaths(
      {
        files: [
          { path: "/run/jr2/user-context/AGENTS.md", content: "image" },
          { path: "/work/app/fix/AGENTS.md", content: "repo" },
        ],
        skills,
      },
      m,
    ),
    {
      files: [
        { path: "/home/a&b/.pi/agent/AGENTS.md", content: "image" },
        { path: "/work/app/fix/AGENTS.md", content: "repo" },
      ],
      skills: [
        "<location>/home/a&amp;b/.pi/agent/skills/deploy/SKILL.md</location>",
        "<location>/work/app/fix/.pi/skills/x/SKILL.md</location>",
      ].join("\n"),
    },
  );
});

test("loadProjectContext: the image user's AGENTS.md and skills load first; the child reads nothing else in that folder", async () => {
  const { root, work, dir } = worktree();
  writeFileSync(join(dir, "AGENTS.md"), "The repo's rules.\n");
  const userDir = join(root, "home", "u", ".pi", "agent");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "AGENTS.md"), "The image's rules.\n");
  mkdirSync(join(userDir, "skills", "deploy"), { recursive: true });
  writeFileSync(
    join(userDir, "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship it.\n---\nSteps.\n",
  );
  // auth.json holds what a skill file would hold; a skill that links to it is read through the
  // link, at auth.json's own path, which the child may not read.
  const secret = "image-auth-token-9a1b";
  writeFileSync(join(userDir, "auth.json"), `---\nname: leak\ndescription: ${secret}\n---\n${secret}\n`);
  mkdirSync(join(userDir, "skills", "leak"), { recursive: true });
  symlinkSync(join(userDir, "auth.json"), join(userDir, "skills", "leak", "SKILL.md"));
  const children = testChildren({ work });
  const userContext = { dir: userDir, image: "/home/u/.pi/agent" };
  const ctx = loaded(await loadProjectContext(children, dir, { workRoot: work, userContext }));
  assert.deepEqual(ctx.files, [
    { path: "/home/u/.pi/agent/AGENTS.md", content: "The image's rules.\n" },
    { path: join(dir, "AGENTS.md"), content: "The repo's rules.\n" },
  ]);
  assert.ok(ctx.skills.includes("<name>deploy</name>"), ctx.skills);
  assert.ok(ctx.skills.includes("<location>/home/u/.pi/agent/skills/deploy/SKILL.md</location>"), ctx.skills);
  assert.ok(!JSON.stringify(ctx).includes(secret), "auth.json is nowhere in the project context");
  // Without the user folder, the same domain reads auth.json through the link: the further rules
  // are what keep it out.
  writeFileSync(join(dir, "AGENTS.md"), "");
  mkdirSync(join(dir, ".pi", "skills", "leak"), { recursive: true });
  symlinkSync(join(userDir, "auth.json"), join(dir, ".pi", "skills", "leak", "SKILL.md"));
  const open = loaded(await loadProjectContext(children, dir, { workRoot: work }));
  assert.ok(JSON.stringify(open).includes(secret), "the domain itself can read the image's home");
  // An AGENTS.md there that is a link gets no read rule of its own: a read through it is a read of
  // the file that it names, so a link to auth.json fails, and the child reads the next name.
  rmSync(join(userDir, "AGENTS.md"));
  symlinkSync(join(userDir, "auth.json"), join(userDir, "AGENTS.md"));
  writeFileSync(join(userDir, "CLAUDE.md"), "The image's CLAUDE.md.\n");
  rmSync(join(dir, ".pi"), { recursive: true });
  const linked = loaded(await loadProjectContext(children, dir, { workRoot: work, userContext }));
  assert.deepEqual(linked.files[0], { path: "/home/u/.pi/agent/CLAUDE.md", content: "The image's CLAUDE.md.\n" });
  assert.ok(!JSON.stringify(linked).includes(secret));
  assert.deepEqual(USER_CONTEXT_NAMES, [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
    "skills",
  ]);
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

test("projectContexts: the image user's context from its mount, first, at the image's paths", async () => {
  const { work, dir } = worktree();
  writeFileSync(join(dir, "AGENTS.md"), "The repo's rules.\n");
  const { dir: userDir, table } = userMount();
  writeFileSync(join(userDir, "AGENTS.md"), "The image's rules.\n");
  const m = userContextMount("/home/u/.pi/agent", () => table, userDir) as UserContextMount;
  const read = projectContexts(testChildren({ work }), () => assert.fail("no line"), {
    workRoot: work,
    userContext: m,
  });
  const text = await read(dir, new AbortController().signal);
  assert.ok(text.indexOf("The image's rules.") < text.indexOf("The repo's rules."), text);
  assert.ok(text.includes('<project_instructions path="/home/u/.pi/agent/AGENTS.md">'), text);
  assert.ok(!text.includes(userDir), text);
});

test("the domain reads the user context mount under the denied folder, and moves and writes nothing there", async () => {
  const { work, dir } = worktree();
  const run = deniedDir("run-");
  const userDir = join(run, "user-context");
  mkdirSync(join(userDir, "skills", "deploy"), { recursive: true });
  writeFileSync(join(userDir, "AGENTS.md"), "The image's rules.\n");
  writeFileSync(join(userDir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
  const userContext = { dir: userDir, image: "/home/u/.pi/agent" };
  const children = testChildren({ work, deny: [run], read: [userDir] });
  const ctx = loaded(await loadProjectContext(children, dir, { workRoot: work, userContext }));
  assert.deepEqual(ctx.files, [{ path: "/home/u/.pi/agent/AGENTS.md", content: "The image's rules.\n" }]);
  assert.ok(ctx.skills.includes("<location>/home/u/.pi/agent/skills/deploy/SKILL.md</location>"), ctx.skills);
  for (const argv of [
    ["mv", userDir, join(run, "moved")],
    ["mv", run, `${run}-moved`],
    ["sh", "-c", `printf x > ${join(userDir, "AGENTS.md")}`],
    ["mkdir", join(userDir, "new")],
  ]) {
    const r = await runIn(children, argv, { cwd: work, timeoutMs: 10_000 });
    assert.notEqual(r.code, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
  }
  assert.deepEqual(readdirSync(run), ["user-context"]);
  assert.equal(readFileSync(join(userDir, "AGENTS.md"), "utf8"), "The image's rules.\n");
});

test("projectContexts: with no announced mount, a ~/.pi/agent in the domain's HOME is never read", async () => {
  const { root, work, dir } = worktree();
  const home = join(root, "home", "u");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "An Agent wrote this.\n");
  writeFileSync(join(dir, "AGENTS.md"), "The repo's rules.\n");
  const of = projectContexts(testChildren({ work, home }), () => assert.fail("no line"), { workRoot: work });
  const text = await of(dir, new AbortController().signal);
  assert.match(text, /The repo's rules\./);
  assert.doesNotMatch(text, /An Agent wrote this/);
});

test("projectContextText is pi's own frame at the pin: the project_context and skills sections that pi's system prompt builds", async () => {
  // jr2 copies pi's frame (`renderProjectContext` and the section tags in `system-prompt.js`,
  // which the package root does not export). This compares the copy with pi's own sections, so a
  // pin bump that moves the frame fails here (ADR-0062).
  const { formatSkillsForPrompt, loadSkills } = await import("@earendil-works/pi-coding-agent");
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  const pi = (await import(new URL("./core/system-prompt.js", root).href)) as {
    buildSystemPromptSections: (input: unknown) => Record<string, string>;
  };
  const { dir } = worktree();
  skill(dir, "release-notes", "Write the release notes.");
  skill(dir, "deploy", 'Ship <it> & "say" so.');
  const { skills } = loadSkills({
    cwd: dir,
    agentDir: join(dir, "no-agent-dir"),
    skillPaths: [],
    includeDefaults: true,
  });
  const files = [
    { path: "/home/u/.pi/agent/AGENTS.md", content: "The image's rules." },
    { path: "/work/app/fix/AGENTS.md", content: "# Rules\n\nUse tabs.\n" },
  ];
  const sections = pi.buildSystemPromptSections({ cwd: dir, contextFiles: files, skills, selectedTools: ["read"] });
  assert.equal(
    projectContextText({ files, skills: formatSkillsForPrompt(skills, "read") }),
    `${sections.project_context}\n\n${sections.skills}`,
  );
  const none = pi.buildSystemPromptSections({ cwd: dir, contextFiles: files, skills: [], selectedTools: ["read"] });
  assert.equal(none.skills, undefined);
  assert.equal(projectContextText({ files, skills: "" }), none.project_context);
});
