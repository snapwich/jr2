// pi's Working tools with jr2's operations (ADR-0027, ADR-0061, ADR-0076): the claims that jr2
// makes over upstream's tools. Every file op and every shell runs in the domain, through the real
// spawner and the real confiner, so a path under the denied folder, or a link to one, fails as an
// unreadable file fails, and the shell has the domain's env alone. A signal death is never exit 0;
// the memory guard's verdict is the call's answer; the bash tool's whole output is a file in TMPDIR
// that `read` reads, and a command that replaces that file gets no read of what the link names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineTool } from "../src/engine.ts";
import type { GuardOwner, GuardWatch } from "../src/memory-guard.ts";
import { workingToolsFor } from "../src/working-tools.ts";
import { deniedDir, testChildren } from "./support/children.ts";

// The pod's secret folders in miniature: the control Stand-in's, the held Stand-ins', the
// conversations'.
const secrets = deniedDir("jr2-tool-ops-secrets-");
const controlDir = join(secrets, "control");
const standInsDir = join(secrets, "standins");
const conversationsDir = join(secrets, "conversations");
for (const d of [controlDir, standInsDir, conversationsDir]) mkdirSync(d);
const CONTROL = "control-stand-in-0123456789abcdefghijklmnopq";
writeFileSync(join(controlDir, "standin"), CONTROL);
writeFileSync(join(standInsDir, "ANTHROPIC_API_KEY"), "jr2-held-ANTHROPIC_API_KEY.model-secret");
writeFileSync(join(standInsDir, "JIRA_TOKEN"), "jr2-held-JIRA_TOKEN.granted-secret");
writeFileSync(join(conversationsDir, "record.json"), "a conversation");
const cwd = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
// The domain's TMPDIR is this process's own, as the start check makes it in a pod
// (`harnessTmpFault`): pi's bash writes its whole output there.
const children = testChildren({
  work: cwd,
  tmp: realpathSync(tmpdir()),
  control: CONTROL,
  standIns: new Map([
    ["ANTHROPIC_API_KEY", "jr2-held-ANTHROPIC_API_KEY.model-secret"],
    ["JIRA_TOKEN", "jr2-held-JIRA_TOKEN.granted-secret"],
  ]),
  granted: ["JIRA_TOKEN"],
  deny: [secrets],
});
const definition = { instructions: "test", model: "anthropic/claude-x" };

function toolsIn(
  dir: string,
  opts: { guard?: { watch: (owner?: GuardOwner) => GuardWatch }; owner?: GuardOwner } = {},
): Record<string, EngineTool> {
  const tools = workingToolsFor(definition, dir, { children, ...opts } as Parameters<typeof workingToolsFor>[2]);
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

async function text(tool: EngineTool, args: unknown, signal?: AbortSignal): Promise<string> {
  const first = (await tool.execute("call-1", args as never, signal)).content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

async function failure(tool: EngineTool, args: unknown, signal?: AbortSignal): Promise<string> {
  return text(tool, args, signal).then(
    (out) => assert.fail(`expected an error, got: ${out}`),
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

const bash = (command: string, timeout?: number) => ({ command, ...(timeout === undefined ? {} : { timeout }) });

// ─── the file tools ──────────────────────────────────────────────────────────

test("a relative path resolves against the tools' cwd, the Frame's (ADR-0057), and write makes its folders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  const { write, read } = toolsIn(dir);
  assert.equal(await text(write!, { path: "sub/f.txt", content: "here" }), "Successfully wrote to sub/f.txt");
  assert.equal(readFileSync(join(dir, "sub", "f.txt"), "utf8"), "here");
  assert.equal(await text(read!, { path: "sub/f.txt" }), "here");
});

test("the file tools reach what bash reaches: outside the Worktree, by `..`, by an absolute path, by a link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  const outside = mkdtempSync(join(tmpdir(), "jr2-tool-ops-outside-"));
  writeFileSync(join(outside, "notes"), "outside\n");
  symlinkSync(join(outside, "notes"), join(dir, "to-notes"));
  symlinkSync(outside, join(dir, "to-folder"));
  const { read, write } = toolsIn(dir);
  for (const path of [`../${outside.split("/").pop()}/notes`, join(outside, "notes"), "to-notes", "to-folder/notes"]) {
    assert.equal(await text(read!, { path }), "outside\n", path);
  }
  await text(write!, { path: "to-folder/new", content: "x" });
  assert.equal(readFileSync(join(outside, "new"), "utf8"), "x");
});

test("read, write and edit through a link to a denied file fail as an unreadable file fails, and its bytes never show (ADR-0076)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  symlinkSync(join(controlDir, "standin"), join(dir, "to-standin"));
  symlinkSync(secrets, join(dir, "to-secret"));
  const { read, write, edit } = toolsIn(dir);
  for (const path of [join(controlDir, "standin"), "to-standin", "to-secret/control/standin"]) {
    const refused = await failure(read!, { path });
    // Landlock does not stop a `stat`, so pi's `access` passes, and the open in the domain fails.
    assert.match(refused, /^EACCES: permission denied, open '/, path);
    assert.ok(!refused.includes(CONTROL), path);
  }
  assert.match(await failure(write!, { path: "to-secret/new", content: "x" }), /^EACCES: permission denied, open '/);
  assert.match(await failure(write!, { path: "to-standin", content: "x" }), /^EACCES: permission denied, open '/);
  assert.match(
    await failure(edit!, { path: "to-standin", edits: [{ oldText: "control", newText: "x" }] }),
    /^EACCES: permission denied, open '.*\/to-standin'$/,
  );
  assert.equal(readFileSync(join(controlDir, "standin"), "utf8"), CONTROL);
  assert.ok(!existsSync(join(secrets, "new")));
});

test("read sends an image as an image, from bytes read in the domain; a link to a denied image fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(join(dir, "dot.png"), png);
  writeFileSync(join(secrets, "secret.png"), png);
  symlinkSync(join(secrets, "secret.png"), join(dir, "to-secret.png"));
  const { read } = toolsIn(dir);
  const result = await read!.execute("call-1", { path: "dot.png" } as never);
  assert.deepEqual(
    result.content.map((c) => c.type),
    ["text", "image"],
  );
  assert.match((result.content[0] as { text: string }).text, /^Read image file \[image\/png\]/);
  assert.match(await failure(read!, { path: "to-secret.png" }), /^EACCES: permission denied, open '/);
});

test("two parallel edits of one file run one after the other, and both land", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  writeFileSync(join(dir, "a.txt"), "alpha\nbeta\n");
  const { edit } = toolsIn(dir);
  await Promise.all([
    text(edit!, { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
    text(edit!, { path: join(dir, "a.txt"), edits: [{ oldText: "beta", newText: "BETA" }] }),
  ]);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "ALPHA\nBETA\n");
});

// ADR-0076: the Harness process has a HOME of its own, which the domain cannot reach. pi expands
// `~` to this process's HOME, so jr2 expands it first: `~` is the domain's HOME, the folder that
// `bash` expands `~` to.
test("~ in a path is the domain's HOME, not the Harness process's own (ADR-0076)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-tool-ops-"));
  const home = children.env.HOME!;
  const own = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "jr2-harness-own-home-"));
  try {
    const { read, write, edit, find } = toolsIn(dir);
    await text(write!, { path: "~/notes/tilde.txt", content: "in the domain's HOME\n" });
    assert.equal(readFileSync(join(home, "notes", "tilde.txt"), "utf8"), "in the domain's HOME\n");
    assert.equal(existsSync(join(process.env.HOME, "notes")), false, "nothing in the Harness's HOME");
    await text(edit!, { path: "@~/notes/tilde.txt", edits: [{ oldText: "domain's", newText: "Agent's" }] });
    assert.match(await text(read!, { path: "~/notes/tilde.txt" }), /in the Agent's HOME/);
    assert.equal(await text(find!, { pattern: "*.txt", path: "~/notes" }), "tilde.txt");
  } finally {
    process.env.HOME = own;
  }
});

// ─── bash ────────────────────────────────────────────────────────────────────

test("a command that exits 0 answers its output with stderr, and a non-zero exit is pi's error", async () => {
  const t = toolsIn(cwd).bash!;
  assert.equal(await text(t, bash("echo out; echo err >&2")), "out\nerr\n");
  assert.equal(await text(t, bash("true")), "(no output)");
  assert.equal(await failure(t, bash("echo partial; exit 3")), "partial\n\n\nCommand exited with code 3");
});

test("a command killed by a signal is an error, never exit 0 (ADR-0061): the command's, and the shell's own", async () => {
  const t = toolsIn(cwd).bash!;
  // The command's own process dies by SIGKILL: `bash -c` alone would exec it as the top process.
  const message = await failure(t, bash("echo started; sh -c 'kill -9 $$'"));
  assert.match(message, /^started\n/);
  assert.match(message, /Command exited with code 137$/);
  assert.match(await failure(t, bash("kill -TERM $BASHPID")), /Command exited with code 143$/);
  // `$$` is the shell that `shell.ts` spawned: its exit has no code, only the signal.
  assert.equal(await failure(t, bash("echo started; kill -9 $$")), "started\n\n\nCommand exited with code 137");
});

test(
  "every command starts at oom_score_adj 1000, and its children inherit it",
  { skip: !existsSync("/proc/self/oom_score_adj") },
  async () => {
    const t = toolsIn(cwd).bash!;
    assert.equal(await text(t, bash("cat /proc/self/oom_score_adj")), "1000\n");
    assert.equal(await text(t, bash("sh -c 'cat /proc/$$/oom_score_adj'")), "1000\n");
  },
);

test("the wrapper leaves the command's shell as it was: no jr2 variables leak, syntax errors are the command's", async () => {
  const t = toolsIn(cwd).bash!;
  assert.equal(await text(t, bash("env | grep JR2_BASH || echo clean")), "clean\n");
  assert.equal(await text(t, bash("cd / && pwd")), "/\n");
  assert.match(await failure(t, bash("echo 'unterminated")), /Command exited with code 2$/);
  assert.equal(await text(t, bash("x=1\nif [ $x = 1 ]; then\n  echo multi\nfi")), "multi\n");
  assert.equal(await text(t, bash("pwd")), `${cwd}\n`, "the command runs in the tool's cwd");
});

test("a timeout, an abort, an invalid timeout and a missing working directory read in pi's words", async () => {
  const t = toolsIn(cwd).bash!;
  assert.equal(await failure(t, bash("sleep 10", 0.3)), "Command timed out after 0.3 seconds");
  assert.match(
    await failure(t, bash("echo before; sleep 5", 0.3)),
    /^before\n\n\nCommand timed out after 0.3 seconds$/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  assert.equal(await failure(t, bash("sleep 10"), controller.signal), "Command aborted");
  assert.equal(await failure(t, bash("true", -1)), "Invalid timeout: must be a finite number of seconds");
  const gone = join(cwd, "missing");
  assert.equal(
    await failure(toolsIn(gone).bash!, bash("echo hi")),
    `Working directory does not exist: ${gone}\nCannot execute bash commands.`,
  );
});

test("a background process that keeps the pipes open does not hold the call", async () => {
  const started = Date.now();
  assert.equal(await text(toolsIn(cwd).bash!, bash("(sleep 5 &) ; echo done")), "done\n");
  assert.ok(Date.now() - started < 3000, "the call returned before the background process ended");
});

// ADR-0076: pi passes this process's env to the shell; jr2's shell has the domain's env alone. It
// holds the Stand-in that the workspace() grants, under its own name, and not the control Stand-in,
// a model key's Stand-in the grant does not name, or any variable of the Harness's own env.
test("bash's shell has the domain's env alone: a name that only the Harness process holds is absent", async () => {
  process.env.HARNESS_ONLY_NAME = "harness-only-value";
  try {
    const env = await text(toolsIn(cwd).bash!, bash("env"));
    assert.doesNotMatch(env, /HARNESS_ONLY_NAME|harness-only-value/);
    assert.doesNotMatch(env, /^PI_/m, "no pi session variable");
    assert.match(env, /^JIRA_TOKEN=jr2-held-JIRA_TOKEN\.granted-secret$/m);
    assert.doesNotMatch(env, /model-secret|ANTHROPIC_API_KEY/);
    assert.ok(!env.includes(CONTROL), "the control Stand-in is in no child's env");
    assert.doesNotMatch(env, /^JR2_(?!CUSTODIAN_URL)/m, "no jr2 variable of the Harness's own reaches the child");
    assert.match(env, new RegExp(`^HOME=${children.env.HOME}$`, "m"));
    assert.match(env, new RegExp(`^TMPDIR=${children.env.TMPDIR}$`, "m"));
  } finally {
    delete process.env.HARNESS_ONLY_NAME;
  }
});

test("the confined shell reads no Stand-in's file, no conversation, and not the Harness's /proc", async () => {
  const t = toolsIn(cwd).bash!;
  for (const command of [
    `cat ${join(controlDir, "standin")}`,
    `cat ${join(standInsDir, "ANTHROPIC_API_KEY")}`,
    `cat ${join(conversationsDir, "record.json")}`,
    `rm -f ${join(standInsDir, "ANTHROPIC_API_KEY")}`,
    `sh -c 'sh -c "cat ${join(controlDir, "standin")}"'`,
    `cat /proc/${process.pid}/environ`,
    `head -c 16 /proc/${process.pid}/mem`,
  ]) {
    const message = await failure(t, bash(command));
    assert.match(message, /Permission denied|Operation not permitted/, command);
    assert.ok(!message.includes(CONTROL) && !message.includes("model-secret"), command);
    assert.ok(!message.includes("a conversation"), command);
  }
  assert.match(await text(t, bash(`ls ${standInsDir}`)), /^ANTHROPIC_API_KEY$/m);
});

test("more than 2000 lines: the tail, and the whole output in a file in TMPDIR that `read` reads", async () => {
  const { bash: t, read } = toolsIn(cwd);
  const message = await text(t!, bash("seq 1 2500"));
  const match = /\n\n\[Showing lines 501-2500 of 2500\. Full output: (.+)\]$/.exec(message);
  assert.ok(match, message.slice(-200));
  assert.ok(message.startsWith("501\n502\n"), "the kept text is the last 2000 lines");
  const full = match[1]!;
  assert.ok(full.startsWith(`${children.env.TMPDIR}/`), full);
  assert.equal(await text(read!, { path: full, offset: 2499 }), "2499\n2500\n");
});

test("a command that replaces the whole output's file with a link gets no read of what the link names (ADR-0076)", async () => {
  const record = join(conversationsDir, "record.json");
  const before = readFileSync(record, "utf8");
  // More than 50 KB, so pi makes the file; then the command swaps it for a link to a conversation's
  // record, which the confiner denies it, and prints a line.
  const command = [
    `before=$(ls "$TMPDIR" | grep '^pi-bash-')`,
    `head -c 60000 /dev/zero | tr '\\0' 'a'; echo`,
    `for i in $(seq 1 50); do f=$(ls "$TMPDIR" | grep '^pi-bash-' | grep -vxF "$before" | head -1); [ -n "$f" ] && break; sleep 0.1; done`,
    `f="$TMPDIR/$f"; rm -f "$f" && ln -s ${record} "$f" && echo swapped`,
  ].join("\n");
  const message = await failure(toolsIn(cwd).bash!, bash(command));
  assert.match(message, /that holds the command's whole output was moved or replaced while the command ran/);
  assert.ok(!message.includes("a conversation"));
  assert.equal(readFileSync(record, "utf8"), before, "the record is as it was");
});

// ─── the memory guard (ADR-0061, ADR-0062) ──────────────────────────────────

test("when the memory guard fired during the call, its verdict is the call's answer, and the watch is told", async () => {
  const verdict = "killed: memory limit (peak 1.9Gi of 2Gi); use fewer workers or a larger Size";
  let ended = 0;
  let told = 0;
  const guard = {
    watch: (): GuardWatch => ({ end: () => void ended++, verdict: () => verdict, told: () => void told++ }),
  };
  const t = toolsIn(cwd, { guard }).bash!;
  assert.equal(await failure(t, bash("echo partial")), `partial\n\n${verdict}`);
  // The exit code is the kill's: it goes. The output stays.
  assert.equal(await failure(t, bash("echo partial; exit 137")), `partial\n\n${verdict}`);
  assert.equal(await failure(t, bash("exit 137")), verdict);
  // A timeout stays: the kill did not make it.
  assert.equal(await failure(t, bash("sleep 5", 0.2)), `Command timed out after 0.2 seconds\n\n${verdict}`);
  assert.equal(ended, 4, "the watch ended with each call");
  assert.equal(told, 4, "each answer that carries the verdict tells its conversation");
});

test("a call is watched as its conversation's, so a kill knows whose call it told", async () => {
  const owners: unknown[] = [];
  const guard = {
    watch: (owner?: GuardOwner): GuardWatch => (
      owners.push(owner),
      { end: () => {}, verdict: () => undefined, told: () => {} }
    ),
  };
  const owner = { agent: "coder", instanceId: "run/body/coder" } as GuardOwner;
  assert.equal(await text(toolsIn(cwd, { guard, owner }).bash!, bash("echo ok")), "ok\n");
  assert.deepEqual(owners, [owner]);
});
