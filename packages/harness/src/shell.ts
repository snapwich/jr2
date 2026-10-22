// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/env/nodejs.js (exec, its shell lookup and waitForChildProcess; Linux only)
//
// The shell that the `bash` Working tool runs (ADR-0027, ADR-0061). pi 1.x removed its execution
// environment, so jr2 owns the spawn. One change from pi: the result is the child's own exit,
// `{ code, signal }`. pi's `exec` reported `code ?? 0`, so a shell that a signal killed read as a
// pass; jr2's `bash` names the signal instead (`bash-tool.ts`).

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** The largest timeout, in seconds, that a timer can hold. */
export const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** After the shell exits, how long the call waits past the last output for the pipes to end. A
 * dev server that keeps the pipes open does not hold the call. */
const EXIT_STDIO_GRACE_MS = 100;

/** Why a command did not run to its own exit. The text is pi's for each kind. */
export type ExecError = { kind: "aborted" | "timeout" | "spawn_error" | "callback_error"; message: string };

/** How the shell ended: its own exit, never a code that it did not give. */
export type ExecExit = { code: number | null; signal: NodeJS.Signals | null };

export type ExecOptions = {
  cwd: string;
  /** Added over this process's environment. */
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

/** `/bin/bash`, else the first `bash` on `PATH`, else `sh`. */
async function shellOf(): Promise<string> {
  if (await pathExists("/bin/bash")) return "/bin/bash";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "bash");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return "sh";
}

/** Kill the command's whole process group, else the shell alone. */
function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The shell's exit, once both pipes ended, or `EXIT_STDIO_GRACE_MS` after the last output. */
function waitForChildProcess(child: ChildProcess): Promise<ExecExit> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let exited = false;
    let exit: ExecExit = { code: null, signal: null };
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (result: ExecExit) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(result);
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) finalize(exit);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exit), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      exit = { code, signal };
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finalize({ code, signal });
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
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
  const shell = await shellOf();
  if (!(await pathExists(cwd))) {
    return { kind: "spawn_error", message: `Working directory does not exist: ${cwd}\nCannot execute bash commands.` };
  }
  return await new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let callbackError: ExecError | undefined;
    let child: ChildProcess;
    let timeoutId: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (child?.pid) killProcessTree(child.pid);
    };
    const settle = (result: ExecExit | ExecError) => {
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    try {
      child = spawn(shell, ["-c", command], {
        cwd,
        detached: true,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ kind: "spawn_error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
      }, timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const relay = (callback: ((chunk: string) => void) | undefined) => (chunk: string) => {
      try {
        callback?.(chunk);
      } catch (error) {
        callbackError = { kind: "callback_error", message: error instanceof Error ? error.message : String(error) };
        onAbort();
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", relay(options.onStdout));
    child.stderr?.on("data", relay(options.onStderr));
    void waitForChildProcess(child).then(
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
