// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/env/nodejs.js (exec, its shell lookup and waitForChildProcess; Linux only)
//
// The shell that the `bash` Working tool runs (ADR-0027, ADR-0061). pi 1.x removed its execution
// environment, so jr2 owns the spawn. Two changes from pi: the result is the child's own exit,
// `{ code, signal }` — pi's `exec` reported `code ?? 0`, so a shell that a signal killed read as a
// pass, and jr2's `bash` names the signal instead (`bash-tool.ts`); and the shell runs in the
// domain, started by the spawner, with the domain's env, never this process's (`children.ts`,
// `spawner.ts`, ADR-0076). The spawner keeps pi's wait for the pipes: the exit comes once both pipes
// end, or 100 ms after the last output, so a dev server that keeps the pipes open does not hold the
// call.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { lookPath, type ChildPolicy } from "./children.ts";
import type { Spawned } from "./spawner.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** The largest timeout, in seconds, that a timer can hold. */
export const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/** Why a command did not run to its own exit. The text is pi's for each kind. */
export type ExecError = { kind: "aborted" | "timeout" | "spawn_error" | "callback_error"; message: string };

/** How the shell ended: its own exit, never a code that it did not give. */
export type ExecExit = { code: number | null; signal: NodeJS.Signals | null };

export type ExecOptions = {
  cwd: string;
  /** How the shell starts: in the domain, with its env (ADR-0076). */
  children: ChildPolicy;
  /** Added over the domain's env — never this process's. */
  env?: Record<string, string>;
  /** Seconds. Validated by the caller; an invalid value is refused here too. */
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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

/**
 * Run `command` with `<shell> -c`, in its own process group, with stdin closed. An abort or the
 * timeout kills the group. The output streams to the callbacks as UTF-8 text.
 */
export async function exec(command: string, options: ExecOptions): Promise<ExecExit | ExecError> {
  if (options.signal?.aborted) return { kind: "aborted", message: "aborted" };
  let timeoutMs: number | undefined;
  if (options.timeout !== undefined) {
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
      return { kind: "timeout", message: "Invalid timeout: must be a finite number of seconds" };
    }
    timeoutMs = options.timeout * 1000;
    if (timeoutMs > MAX_TIMEOUT_MS) {
      return { kind: "timeout", message: `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds` };
    }
  }
  const cwd = options.cwd;
  const env = { ...options.children.env, ...options.env };
  const shell = await shellOf(env.PATH);
  if (!(await pathExists(cwd))) {
    return { kind: "spawn_error", message: `Working directory does not exist: ${cwd}\nCannot execute bash commands.` };
  }
  return await new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let callbackError: ExecError | undefined;
    let timeoutId: NodeJS.Timeout | undefined;
    let child: Spawned | undefined;
    // The command's whole process group, by the spawner.
    const killTree = () => child?.signal("SIGKILL");
    const settle = (result: ExecExit | ExecError) => {
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", killTree);
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const relay = (callback: ((chunk: string) => void) | undefined) => {
      const decoder = new StringDecoder("utf8");
      return (bytes: Buffer) => {
        const chunk = decoder.write(bytes);
        if (chunk === "") return;
        try {
          callback?.(chunk);
        } catch (error) {
          callbackError = { kind: "callback_error", message: error instanceof Error ? error.message : String(error) };
          killTree();
        }
      };
    };
    child = options.children.spawner.spawn(
      { argv: [shell, "-c", command], env, cwd },
      { onStdout: relay(options.onStdout), onStderr: relay(options.onStderr) },
    );
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) killTree();
      else options.signal.addEventListener("abort", killTree, { once: true });
    }
    child.exited.then(
      (exit) => {
        if (callbackError) return settle(callbackError);
        if (timedOut) return settle({ kind: "timeout", message: `timeout:${options.timeout}` });
        if (options.signal?.aborted) return settle({ kind: "aborted", message: "aborted" });
        settle(exit);
      },
      (error: Error) => settle({ kind: "spawn_error", message: error.message }),
    );
  });
}

/** True for an `exec` result that is an error, not an exit. */
export function isExecError(result: ExecExit | ExecError): result is ExecError {
  return "kind" in result;
}
