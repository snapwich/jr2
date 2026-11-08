// The shell of the `bash` Working tool (ADR-0027, ADR-0061, ADR-0076): pi's `BashOperations.exec`,
// done in the domain. pi's `bash` tool (`pi-tools.ts`) takes the output, truncates it and writes
// its status lines; this module only starts the shell and tells how it ended. The shell lookup and
// the wait for the pipes follow pi-agent-core 0.82.1's `dist/harness/env/nodejs.js` (MIT, see
// PI-LICENSE). jr2 makes three claims here:
//
//   1. The shell runs in the domain, started by the spawner, with the domain's env (`children.ts`):
//      never the env that pi passes, which is this process's own.
//   2. Every command starts with `oom_score_adj=1000`, inherited by its children: no privilege
//      needed to raise it, and on a node with the kubelet's `singleProcessOOMKill: true` the kernel
//      then picks the Agent's process, not the Harness (ADR-0061).
//   3. A process killed by a signal is never exit 0. The command runs in a subshell, so the shell
//      sees the death as 128+n (`bash -c 'one command'` would exec the command AS the shell); and a
//      shell that was itself killed exits 128+n here, by pi's own rule for a signal death.
//
// The spawner keeps pi's wait for the pipes: the exit comes once both pipes end, or 100 ms after
// the last output, so a dev server that keeps the pipes open does not hold the call.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { lookPath, type ChildPolicy } from "./children.ts";
import type { Spawned } from "./spawner.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** The largest timeout, in seconds, that a timer can hold. */
export const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * The script the shell runs in place of the Agent's command. The command itself rides the env
 * (`JR2_BASH_COMMAND`) and runs under `eval` in a subshell: a syntax error in it is `eval`'s exit 2,
 * not a broken wrapper, and the subshell drops the variable before the command's programs could
 * inherit it. `$$` in the command is still the shell that this module spawned.
 */
export const WRAPPER = [
  "echo 1000 > /proc/self/oom_score_adj 2>/dev/null",
  '( __jr2_command=$JR2_BASH_COMMAND; unset JR2_BASH_COMMAND; eval "$__jr2_command" )',
  "__jr2_status=$?",
  'exit "$__jr2_status"',
].join("\n");

/** What pi's `bash` gives its operations, less the env, which jr2 does not use. */
export type ExecOptions = {
  onData: (data: Buffer) => void;
  signal?: AbortSignal | undefined;
  /** Seconds. */
  timeout?: number | undefined;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `/bin/bash`, else the first `bash` on the domain's `PATH`, else `sh`. */
async function shellOf(path: string | undefined): Promise<string> {
  if (await pathExists("/bin/bash")) return "/bin/bash";
  return lookPath("bash", path) ?? "sh";
}

/** The timeout in milliseconds, refused with pi's words when it is no valid number of seconds. */
function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const ms = timeout * 1000;
  if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return ms;
}

/**
 * Run `command` in the domain, in `cwd`, under the wrapper, in its own process group, with stdin
 * closed. pi's protocol: the exit code, `128 + n` for a shell that signal n killed; a throw of
 * `aborted` for an abort and `timeout:<seconds>` for the timeout, each of which kills the group.
 */
export async function execInDomain(
  children: ChildPolicy,
  command: string,
  cwd: string,
  options: ExecOptions,
): Promise<{ exitCode: number }> {
  const ms = timeoutMs(options.timeout);
  if (options.signal?.aborted) throw new Error("aborted");
  const env: Record<string, string> = { ...children.env, JR2_BASH_COMMAND: command };
  const shell = await shellOf(env.PATH);
  // In the domain: a working directory that the domain cannot reach is one that is not there.
  const there = await children.spawner.stat(cwd).then(
    (s) => s.kind === "directory",
    () => false,
  );
  if (!there) throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let child: Spawned | undefined;
    // The command's whole process group, by the spawner.
    const killTree = () => child?.signal("SIGKILL");
    const settle = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", killTree);
    };
    child = children.spawner.spawn(
      { argv: [shell, "-c", WRAPPER], env, cwd },
      { onStdout: options.onData, onStderr: options.onData },
    );
    if (ms !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, ms);
    }
    if (options.signal) {
      if (options.signal.aborted) killTree();
      else options.signal.addEventListener("abort", killTree, { once: true });
    }
    child.exited.then(
      (exit) => {
        settle();
        if (options.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${options.timeout}`));
        if (exit.code !== null) return resolve({ exitCode: exit.code });
        const n = exit.signal === null ? undefined : osConstants.signals[exit.signal];
        resolve({ exitCode: 128 + (n ?? 0) });
      },
      (error: Error) => {
        settle();
        reject(error);
      },
    );
  });
}
