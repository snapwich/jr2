// The `bash` Working tool (ADR-0027, ADR-0061): a signal death is an error that names the signal,
// never exit 0, for the command and for the shell itself; every command runs at oom_score_adj 1000;
// the memory guard's verdict is the call's answer; and the statuses come in pi 0.82.1's order, so a
// timeout reads as a timeout although the group kill ends the shell by SIGKILL. Driven through a
// real shell, rooted in a temp directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, sanitizeBinaryOutput } from "../src/bash-tool.ts";
import type { GuardWatch } from "../src/memory-guard.ts";

const cwd = mkdtempSync(join(tmpdir(), "jr2-bash-tool-"));
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
  const bash = bashTool({ cwd });
  assert.equal(await run(bash, "echo out; echo err >&2"), "out\nerr\n");
  assert.equal(await run(bash, "true"), "(no output)");
  assert.equal(await failure(bash, "echo partial; exit 3"), "partial\n\n\nCommand exited with code 3");
});

test("a command killed by a signal is an error that names the signal — never exit 0", async () => {
  const bash = bashTool({ cwd });
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
  const message = await failure(bashTool({ cwd }), "echo started; kill -9 $$");
  assert.equal(message, "started\n\n\nCommand killed by signal SIGKILL");
});

test(
  "every command starts at oom_score_adj 1000, and its children inherit it",
  { skip: !existsSync("/proc/self/oom_score_adj") },
  async () => {
    const bash = bashTool({ cwd });
    assert.equal(await run(bash, "cat /proc/self/oom_score_adj"), "1000\n");
    assert.equal(await run(bash, "sh -c 'cat /proc/$$/oom_score_adj'"), "1000\n");
  },
);

test("the wrapper leaves the command's shell as it was: no jr2 variables leak, syntax errors are the command's", async () => {
  const bash = bashTool({ cwd });
  assert.equal(await run(bash, "env | grep JR2_BASH || echo clean"), "clean\n");
  assert.equal(await run(bash, "cd / && pwd"), "/\n");
  assert.match(await failure(bash, "echo 'unterminated"), /Command exited with code 2$/);
  assert.equal(await run(bash, "x=1\nif [ $x = 1 ]; then\n  echo multi\nfi"), "multi\n");
  assert.equal(await run(bash, "pwd"), `${cwd}\n`, "the command runs in the tool's cwd");
});

test("a timeout reads as a timeout, not as the SIGKILL that the group kill gave the shell", async () => {
  assert.equal(await failure(bashTool({ cwd }), "sleep 10", { timeout: 1 }), "Command timed out after 1 seconds");
  assert.match(
    await failure(bashTool({ cwd }), "echo before; sleep 5", { timeout: 0.2 }),
    /^before\n\n\nCommand timed out after 0.2 seconds$/,
  );
});

test("an abort reads as an abort", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  assert.equal(await failure(bashTool({ cwd }), "sleep 10", { signal: controller.signal }), "Command aborted");
});

test("an invalid timeout is refused with pi's words", async () => {
  assert.equal(
    await failure(bashTool({ cwd }), "true", { timeout: -1 }),
    "Invalid timeout: must be a finite number of seconds",
  );
});

test("a working directory that is gone is the execution error alone", async () => {
  const message = await failure(bashTool({ cwd: join(cwd, "missing") }), "echo hi");
  assert.equal(message, `Working directory does not exist: ${join(cwd, "missing")}\nCannot execute bash commands.`);
});

test("more than 2000 lines: the tail, and the whole output in a temporary file", async () => {
  const message = await run(bashTool({ cwd }), "seq 1 2500");
  const match = /\n\n\[Showing lines 501-2500 of 2500\. Full output: (.+)\]$/.exec(message);
  assert.ok(match, message.slice(-200));
  assert.ok(message.startsWith("501\n502\n"), "the kept text is the last 2000 lines");
  assert.equal(readFileSync(match[1]!, "utf8"), Array.from({ length: 2500 }, (_, i) => `${i + 1}\n`).join(""));
});

test("a background process that keeps the pipes open does not hold the call", async () => {
  const started = Date.now();
  assert.equal(await run(bashTool({ cwd }), "(sleep 5 &) ; echo done"), "done\n");
  assert.ok(Date.now() - started < 3000, "the call returned before the background process ended");
});

test("control characters and U+FFF9 to U+FFFB are removed; tab, newline and carriage return stay for the tool", () => {
  assert.equal(sanitizeBinaryOutput("a\u0000b\u0007c\td\ne\rf￹g￻h"), "abc\td\ne\rfgh");
});

test("when the memory guard fired during the call, its verdict is the call's answer", async () => {
  const verdict = "killed: memory limit (peak 1.9Gi of 2Gi); use fewer workers or a larger Size";
  let ended = 0;
  const guard = {
    watch: (): GuardWatch => ({ end: () => void ended++, verdict: () => verdict }),
  };
  const message = await failure(bashTool({ cwd, guard }), "echo partial");
  assert.equal(message, `partial\n\n${verdict}`);
  assert.equal(ended, 1, "the watch ended with the call");
});
