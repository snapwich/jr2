// The `bash` Working tool (ADR-0027), wrapped (ADR-0061). pi's own tool runs the command; jr2 wraps
// it for three claims pi does not make:
//
//   1. A process killed by a signal is an error that names the signal, never exit 0. pi-agent-core
//      0.82.1 reports `exitCode: code ?? 0`, so a command whose top process died by a signal — and
//      `bash -c 'one command'` execs the command AS the top process — read as a pass, its output
//      cut off partway. The wrapper runs the command in a subshell, so the shell pi spawned sees
//      the death as 128+n; and the shell writes its status to a file as its last act, so a shell
//      that was itself killed (and so wrote nothing) is an error too, not pi's 0.
//   2. Every command starts with `oom_score_adj=1000`, inherited by its children: no privilege
//      needed to raise it, and on a node with the kubelet's `singleProcessOOMKill: true` the
//      kernel then picks the Agent's process, not the Harness.
//   3. The memory guard (memory-guard.ts) watches while the call runs; when it fires, the call
//      answers its `killed: memory limit …` text — whatever pi saw of the killed shell.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { MemoryGuard } from "./memory-guard.ts";
import type { WorkingTool } from "./working-tools.ts";

/**
 * The script pi's shell runs in place of the Agent's command. The command itself rides the env
 * (`JR2_BASH_COMMAND`) and runs under `eval` in a subshell: a syntax error in it is `eval`'s exit 2,
 * not a broken wrapper, and the subshell drops both variables before the command's programs could
 * inherit them. `$$` in the command is still the shell pi spawned, as it was.
 */
const WRAPPER = [
  "echo 1000 > /proc/self/oom_score_adj 2>/dev/null",
  '( __jr2_command=$JR2_BASH_COMMAND; unset JR2_BASH_COMMAND JR2_BASH_STATUS; eval "$__jr2_command" )',
  "__jr2_status=$?",
  '[ -z "$JR2_BASH_STATUS" ] || echo "$__jr2_status" > "$JR2_BASH_STATUS" 2>/dev/null',
  'exit "$__jr2_status"',
].join("\n");

/** The last line pi's error carries for a non-zero exit. */
const EXITED = /Command exited with code (\d+)$/;

/** Signal numbers to names — 137 is 128 + 9, SIGKILL. */
const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([name, n]) => [n, name]));

/** Where each call's status file lands: one private directory per process, made on first use. A
 * base with no writable tmpdir gets no status files and keeps the 128+n half of claim 1. */
let statusDir: string | null | undefined;
function statusDirOf(): string | null {
  if (statusDir === undefined) {
    try {
      statusDir = mkdtempSync(join(tmpdir(), "jr2-bash-"));
    } catch {
      statusDir = null;
    }
  }
  return statusDir;
}

/** The `bash` Working tool. `guard` is the process's memory guard (`main.ts`); omitted, no guard
 * watches — a host run, or a test. */
export function bashTool(opts: { guard?: Pick<MemoryGuard, "watch"> } = {}): WorkingTool {
  const shape = createBashTool();
  return {
    ...shape,
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      const dir = statusDirOf();
      const statusFile = dir === null ? undefined : join(dir, randomUUID());
      const inner = createBashTool({
        prepare: (execution) => {
          execution.env = {
            ...execution.env,
            JR2_BASH_COMMAND: execution.command,
            ...(statusFile ? { JR2_BASH_STATUS: statusFile } : {}),
          };
          execution.command = WRAPPER;
        },
      });
      const watch = opts.guard?.watch();
      let result: AgentToolResult<unknown> | undefined;
      let failure: unknown;
      try {
        result = await inner.execute(toolCallId, params as never, signal, onUpdate, context);
      } catch (err) {
        failure = err;
      } finally {
        watch?.end();
      }
      const status = statusFile === undefined ? undefined : takeStatus(statusFile);

      const killed = watch?.verdict();
      if (killed) throw new Error(withStatus(outputOf(result, failure), killed));
      if (failure !== undefined) throw named(failure);
      // pi said it finished; the shell never wrote its status, so it did not finish — pi's 0 is
      // `code ?? 0` for a shell killed by a signal it cannot name.
      if (statusFile !== undefined && status === undefined) {
        throw new Error(withStatus(outputOf(result, undefined), "Command was killed by a signal before it finished"));
      }
      return result!;
    },
  };
}

/** pi's non-zero-exit error, with an exit of 128+n read as the signal n that ended the command.
 * The shell cannot tell a signal death from a program that exited 128+n itself; bash reports both
 * the same way, and so does this. Aborts, timeouts and spawn errors pass through unchanged. */
function named(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const match = EXITED.exec(err.message);
  const code = match ? Number(match[1]) : NaN;
  const name = code > 128 ? SIGNAL_NAMES.get(code - 128) : undefined;
  if (!name) return err;
  return new Error(err.message.replace(EXITED, `Command killed by signal ${name} (exit ${code})`), { cause: err });
}

function takeStatus(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  } finally {
    rmSync(file, { force: true });
  }
}

/** What the Agent saw of the command before it ended: the result's text, or pi's error message
 * (which carries the output ahead of its status line). */
function outputOf(result: AgentToolResult<unknown> | undefined, failure: unknown): string {
  if (failure instanceof Error) return failure.message.replace(EXITED, "").trimEnd();
  const first = result?.content[0];
  const text = first && first.type === "text" ? first.text : "";
  return text === "(no output)" ? "" : text.trimEnd();
}

function withStatus(output: string, status: string): string {
  return `${output ? `${output}\n\n` : ""}${status}`;
}
