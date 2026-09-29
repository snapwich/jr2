// The wrapped `bash` Working tool (ADR-0061): a signal death is an error that names the signal,
// never pi's `code ?? 0`; every command runs at oom_score_adj 1000; the memory guard's verdict is
// the call's answer. Driven through pi's real tool and a real shell, rooted in a temp directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { bashTool } from "../src/bash-tool.ts";
import type { GuardWatch } from "../src/memory-guard.ts";
import type { WorkingTool } from "../src/working-tools.ts";

const cwd = mkdtempSync(join(tmpdir(), "jr2-bash-tool-"));

async function run(tool: WorkingTool, command: string, timeout?: number): Promise<string> {
  const context = { env: new NodeExecutionEnv({ cwd }) } as never;
  const params = { command, ...(timeout ? { timeout } : {}) } as never;
  const result = await tool.execute("call-1", params, undefined, undefined, context);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return first.text.trimEnd();
}

async function failure(tool: WorkingTool, command: string, timeout?: number): Promise<string> {
  return run(tool, command, timeout).then(
    (out) => assert.fail(`expected an error, got: ${out}`),
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

test("a command that exits 0 answers its output, and a non-zero exit is pi's error", async () => {
  const bash = bashTool();
  assert.equal(await run(bash, "echo hi"), "hi");
  assert.match(await failure(bash, "echo partial; exit 3"), /partial[\s\S]*Command exited with code 3$/);
});

test("a command killed by a signal is an error that names the signal — never exit 0", async () => {
  const bash = bashTool();
  // The command's own process dies by SIGKILL: before the wrapper, `bash -c` exec'd it as pi's top
  // process and pi read `code ?? 0` as a pass.
  const message = await failure(bash, "echo started; sh -c 'kill -9 $$'");
  assert.match(message, /started/);
  assert.match(message, /Command killed by signal SIGKILL \(exit 137\)$/);
  assert.match(await failure(bash, "kill -TERM $BASHPID"), /killed by signal SIGTERM/);
});

test("a shell killed before it finished is an error, even though pi saw no exit code", async () => {
  // `$$` is the shell pi spawned: its death is pi's `code ?? 0`, and only the missing status
  // file says it did not finish.
  const message = await failure(bashTool(), "echo started; kill -9 $$");
  assert.match(message, /started/);
  assert.match(message, /killed by a signal before it finished$/);
});

test(
  "every command starts at oom_score_adj 1000, and its children inherit it",
  { skip: !existsSync("/proc/self/oom_score_adj") },
  async () => {
    const bash = bashTool();
    assert.equal(await run(bash, "cat /proc/self/oom_score_adj"), "1000");
    assert.equal(await run(bash, "sh -c 'cat /proc/$$/oom_score_adj'"), "1000");
  },
);

test("the wrapper leaves the command's shell as it was: no jr2 variables leak, syntax errors are the command's", async () => {
  const bash = bashTool();
  assert.equal(await run(bash, "env | grep JR2_BASH || echo clean"), "clean");
  assert.equal(await run(bash, "cd / && pwd"), "/");
  assert.match(await failure(bash, "echo 'unterminated"), /Command exited with code 2$/);
  assert.equal(await run(bash, "x=1\nif [ $x = 1 ]; then\n  echo multi\nfi"), "multi");
});

test("pi's timeout still reads as a timeout", async () => {
  assert.match(await failure(bashTool(), "sleep 5", 0.2), /timed out after 0.2 seconds/);
});

test("when the memory guard fired during the call, its verdict is the call's answer", async () => {
  const verdict = "killed: memory limit (peak 1.9Gi of 2Gi); use fewer workers or a larger Size";
  let ended = 0;
  const guard = {
    watch: (): GuardWatch => ({ end: () => void ended++, verdict: () => verdict }),
  };
  const message = await failure(bashTool({ guard }), "echo partial");
  assert.equal(message, `partial\n\n${verdict}`);
  assert.equal(ended, 1, "the watch ended with the call");
});
