// The `bash` Working tool (ADR-0027, ADR-0061): a signal death is an error that names the signal,
// never exit 0, for the command and for the shell itself; every command runs at oom_score_adj 1000;
// the memory guard's verdict is the call's answer; and the statuses come in pi 0.82.1's order, so a
// timeout reads as a timeout although the group kill ends the shell by SIGKILL. Driven through a
// real shell, rooted in a temp directory, confined by the real confiner (ADR-0076): the shell's env
// holds only what a child gets, and it reaches no Stand-in's file and no conversation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, sanitizeBinaryOutput } from "../src/bash-tool.ts";
import type { GuardWatch } from "../src/memory-guard.ts";
import { deniedDir, testChildren } from "./support/children.ts";

const cwd = mkdtempSync(join(tmpdir(), "jr2-bash-tool-"));
// The pod's secret folders in miniature: the control Stand-in's, the held Stand-ins', the
// conversations'.
const secrets = deniedDir("jr2-bash-secrets-");
const controlDir = join(secrets, "control");
const standInsDir = join(secrets, "standins");
const conversationsDir = join(secrets, "conversations");
for (const d of [controlDir, standInsDir, conversationsDir]) mkdirSync(d);
const CONTROL = "control-stand-in-0123456789abcdefghijklmnopq";
writeFileSync(join(controlDir, "standin"), CONTROL);
writeFileSync(join(standInsDir, "ANTHROPIC_API_KEY"), "jr2-held-ANTHROPIC_API_KEY.model-secret");
writeFileSync(join(standInsDir, "JIRA_TOKEN"), "jr2-held-JIRA_TOKEN.granted-secret");
writeFileSync(join(conversationsDir, "record.json"), "a conversation");
const children = testChildren({
  work: cwd,
  control: CONTROL,
  standIns: new Map([
    ["ANTHROPIC_API_KEY", "jr2-held-ANTHROPIC_API_KEY.model-secret"],
    ["JIRA_TOKEN", "jr2-held-JIRA_TOKEN.granted-secret"],
  ]),
  granted: ["JIRA_TOKEN"],
  deny: [secrets],
});
type Bash = ReturnType<typeof bashTool>;

async function run(
  tool: Bash,
  command: string,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const params = { command, ...(opts.timeout ? { timeout: opts.timeout } : {}) };
  const result = await tool.execute("call-1", params, opts.signal);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

async function failure(
  tool: Bash,
  command: string,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return run(tool, command, opts).then(
    (out) => assert.fail(`expected an error, got: ${out}`),
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

test("a command that exits 0 answers its output with stderr, and a non-zero exit is pi's error", async () => {
  const bash = bashTool({ cwd, children });
  assert.equal(await run(bash, "echo out; echo err >&2"), "out\nerr\n");
  assert.equal(await run(bash, "true"), "(no output)");
  assert.equal(await failure(bash, "echo partial; exit 3"), "partial\n\n\nCommand exited with code 3");
});

test("a command killed by a signal is an error that names the signal — never exit 0", async () => {
  const bash = bashTool({ cwd, children });
  // The command's own process dies by SIGKILL: `bash -c` alone would exec it as the top process.
  const message = await failure(bash, "echo started; sh -c 'kill -9 $$'");
  assert.match(message, /^started\n/);
  assert.match(message, /Command killed by signal SIGKILL \(exit 137\)$/);
  assert.match(await failure(bash, "kill -TERM $BASHPID"), /killed by signal SIGTERM \(exit 143\)$/);
});

test("a shell killed before it finished names its own signal (I-2)", async () => {
  // `$$` is the shell that `shell.ts` spawned. Its exit has no code, only the signal. pi 0.82.1
  // read this case as `code ?? 0`; jr2's status file then said `Command was killed by a signal
  // before it finished`. jr2 owns the spawn now, so the exit names the signal.
  const message = await failure(bashTool({ cwd, children }), "echo started; kill -9 $$");
  assert.equal(message, "started\n\n\nCommand killed by signal SIGKILL");
});

test(
  "every command starts at oom_score_adj 1000, and its children inherit it",
  { skip: !existsSync("/proc/self/oom_score_adj") },
  async () => {
    const bash = bashTool({ cwd, children });
    assert.equal(await run(bash, "cat /proc/self/oom_score_adj"), "1000\n");
    assert.equal(await run(bash, "sh -c 'cat /proc/$$/oom_score_adj'"), "1000\n");
  },
);

test("the wrapper leaves the command's shell as it was: no jr2 variables leak, syntax errors are the command's", async () => {
  const bash = bashTool({ cwd, children });
  assert.equal(await run(bash, "env | grep JR2_BASH || echo clean"), "clean\n");
  assert.equal(await run(bash, "cd / && pwd"), "/\n");
  assert.match(await failure(bash, "echo 'unterminated"), /Command exited with code 2$/);
  assert.equal(await run(bash, "x=1\nif [ $x = 1 ]; then\n  echo multi\nfi"), "multi\n");
  assert.equal(await run(bash, "pwd"), `${cwd}\n`, "the command runs in the tool's cwd");
});

test("a timeout reads as a timeout, not as the SIGKILL that the group kill gave the shell", async () => {
  assert.equal(
    await failure(bashTool({ cwd, children }), "sleep 10", { timeout: 1 }),
    "Command timed out after 1 seconds",
  );
  assert.match(
    await failure(bashTool({ cwd, children }), "echo before; sleep 5", { timeout: 0.2 }),
    /^before\n\n\nCommand timed out after 0.2 seconds$/,
  );
});

test("an abort reads as an abort", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  assert.equal(
    await failure(bashTool({ cwd, children }), "sleep 10", { signal: controller.signal }),
    "Command aborted",
  );
});

test("an invalid timeout is refused with pi's words", async () => {
  assert.equal(
    await failure(bashTool({ cwd, children }), "true", { timeout: -1 }),
    "Invalid timeout: must be a finite number of seconds",
  );
});

test("a working directory that is gone is the execution error alone", async () => {
  const message = await failure(bashTool({ cwd: join(cwd, "missing"), children }), "echo hi");
  assert.equal(message, `Working directory does not exist: ${join(cwd, "missing")}\nCannot execute bash commands.`);
});

test("more than 2000 lines: the tail, and the whole output in a temporary file", async () => {
  const message = await run(bashTool({ cwd, children }), "seq 1 2500");
  const match = /\n\n\[Showing lines 501-2500 of 2500\. Full output: (.+)\]$/.exec(message);
  assert.ok(match, message.slice(-200));
  assert.ok(message.startsWith("501\n502\n"), "the kept text is the last 2000 lines");
  assert.equal(readFileSync(match[1]!, "utf8"), Array.from({ length: 2500 }, (_, i) => `${i + 1}\n`).join(""));
});

test("a link the command puts in place of the full output's file is never followed: the Harness writes through its handle", async () => {
  const record = join(conversationsDir, "record.json");
  const before = readFileSync(record, "utf8");
  // More than 50 KB, so the Harness makes the file; then the command swaps it for a link to a
  // conversation's record, which the confiner denies it, and prints a line.
  const command = [
    `head -c 60000 /dev/zero | tr '\\0' 'a'; echo`,
    `for i in $(seq 1 50); do f=$(find "$TMPDIR" -name 'bash-*.log' 2>/dev/null | head -1); [ -n "$f" ] && break; sleep 0.1; done`,
    `rm -f "$f" && ln -s ${record} "$f" && echo swapped`,
    `sleep 0.3`,
    `echo '{"injected":"by the coder"}'`,
  ].join("\n");
  const message = await run(bashTool({ cwd, children }), command);
  assert.match(message, /swapped/, "the command found the file and put the link in its place");
  assert.equal(readFileSync(record, "utf8"), before, "the record is as it was");
});

test("a background process that keeps the pipes open does not hold the call", async () => {
  const started = Date.now();
  assert.equal(await run(bashTool({ cwd, children }), "(sleep 5 &) ; echo done"), "done\n");
  assert.ok(Date.now() - started < 3000, "the call returned before the background process ended");
});

test("control characters and U+FFF9 to U+FFFB are removed; tab, newline and carriage return stay for the tool", () => {
  assert.equal(sanitizeBinaryOutput("a\u0000b\u0007c\td\ne\rf￹g￻h"), "abc\td\ne\rfgh");
});

test("when the memory guard fired during the call, its verdict is the call's answer, and the watch is told (ADR-0062)", async () => {
  const verdict = "killed: memory limit (peak 1.9Gi of 2Gi); use fewer workers or a larger Size";
  let ended = 0;
  let told = 0;
  const guard = {
    watch: (): GuardWatch => ({ end: () => void ended++, verdict: () => verdict, told: () => void told++ }),
  };
  const message = await failure(bashTool({ cwd, children, guard }), "echo partial");
  assert.equal(message, `partial\n\n${verdict}`);
  assert.equal(ended, 1, "the watch ended with the call");
  assert.equal(told, 1, "the answer that carries the verdict tells its conversation");
});

test("a call is watched as its conversation's, so a kill knows whose call it told (ADR-0062)", async () => {
  const owners: unknown[] = [];
  const guard = {
    watch: (owner?: unknown): GuardWatch => (
      owners.push(owner),
      { end: () => {}, verdict: () => undefined, told: () => {} }
    ),
  };
  const owner = { agent: "coder", instanceId: "run/body/coder" };
  await run(bashTool({ cwd, children, guard, owner }), "true");
  assert.deepEqual(owners, [owner]);
});

// ADR-0076: the shell's env is explicit. It holds the Stand-in that the workspace() grants, under its
// own name, and not the control Stand-in, a model key's Stand-in the grant does not name, or any
// variable of the Harness's own env.
test("the shell's env holds the granted Stand-in and no control Stand-in, no ungranted Stand-in", async () => {
  const bash = bashTool({ cwd, children });
  const env = await run(bash, "env");
  assert.match(env, /^JIRA_TOKEN=jr2-held-JIRA_TOKEN\.granted-secret$/m);
  assert.doesNotMatch(env, /model-secret|ANTHROPIC_API_KEY/);
  assert.ok(!env.includes(CONTROL), "the control Stand-in is in no child's env");
  assert.doesNotMatch(env, /^JR2_(?!CUSTODIAN_URL)/m, "no jr2 variable of the Harness's own reaches the child");
  assert.match(env, new RegExp(`^HOME=${children.env.HOME}$`, "m"));
  assert.match(env, new RegExp(`^TMPDIR=${children.env.TMPDIR}$`, "m"));
});

// ADR-0076: the shell is confined. It reaches no Stand-in's file and no conversation, by any path, a
// grandchild included, and not the Harness's environ or memory through /proc. It lists the names
// there, as it lists each folder: the names are not secrets.
test("the confined shell reads no Stand-in's file, no conversation, and not the Harness's /proc", async () => {
  const bash = bashTool({ cwd, children });
  for (const command of [
    `cat ${join(controlDir, "standin")}`,
    `cat ${join(standInsDir, "ANTHROPIC_API_KEY")}`,
    `cat ${join(conversationsDir, "record.json")}`,
    `rm -f ${join(standInsDir, "ANTHROPIC_API_KEY")}`,
    `sh -c 'sh -c "cat ${join(controlDir, "standin")}"'`,
    `cat /proc/${process.pid}/environ`,
    `head -c 16 /proc/${process.pid}/mem`,
    `ln -s ${join(controlDir, "standin")} link && cat link`,
  ]) {
    const message = await failure(bash, command);
    assert.match(message, /Permission denied|Operation not permitted/, command);
    assert.ok(!message.includes(CONTROL) && !message.includes("model-secret"), command);
    assert.ok(!message.includes("a conversation"), command);
  }
  assert.match(await run(bash, `ls ${standInsDir}`), /^ANTHROPIC_API_KEY$/m);
});

test("the confined shell still runs what an Agent runs: process substitution, /dev/null, its HOME and TMPDIR", async () => {
  const bash = bashTool({ cwd, children });
  assert.equal(await run(bash, "cat <(echo sub) && echo x > /dev/null && echo ok"), "sub\nok\n");
  assert.equal(await run(bash, 'echo h > "$HOME/h" && cat "$HOME/h"'), "h\n");
  assert.equal(await run(bash, 'd=$(mktemp -d) && echo t > "$d/t" && cat "$d/t"'), "t\n");
  assert.equal(await run(bash, "echo w > w.txt && cat w.txt"), "w\n");
});
