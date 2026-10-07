// The exec (ADR-0067): where a Machine's `command` Effect runs — the Harness container of its
// Workspace's Sandbox, as a child of this process. That placement is the whole security story: the
// child is the Agent's user, sees the Sandbox Image's tools, and inherits this process's
// environment — the same Stand-ins the Agent's `bash` holds (ADR-0059), and no credential of its own.
//
// Five claims, each a test in exec.test.ts:
//
//   1. argv, never shell text. `spawn(argv[0], argv.slice(1))` with no shell: a metacharacter in an
//      argument is that argument's bytes. `sh -c` is the author's explicit choice, in the argv.
//   2. One id runs once IN THIS PROCESS. The Orchestrator names each exec by its Effect's id; a
//      second start of a known id runs nothing. This is the Harness's half of "no second fire" — the
//      ledger is the Orchestrator's, and so is the other half: a restarted Harness knows no id, so
//      the Orchestrator never sends a start again that may have reached one (it reads by id instead).
//   3. The process group ends with the exec. Each exec leads its own group (`detached`); its timeout,
//      a kill, and its top process's exit each SIGKILL the whole group, so nothing it started
//      outlives the Effect — there is no fire-and-forget form (ADR-0067).
//   4. A bounded tail is the output; the full stream is read by offset. stdout and stderr in arrival
//      order, kept up to a cap the Orchestrator reads behind, and the last `tail` characters ride
//      the output the Machine routes on.
//   5. A kill holds whatever order it arrives in. The Effect's state can exit while its start is
//      still on the wire, so a kill can reach this process first: it then marks the id killed, and
//      the start that arrives after it runs nothing (D1, ADR-0067).
//
// What it does NOT keep: anything across a Harness restart. A restarted Harness knows no exec, and
// the Orchestrator settles one it cannot find `unknown` — it never runs it again.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { ExecOutcome, ExecRead, ExecRequest } from "./wire.ts";

/** Characters of stream an exec keeps for a reader behind it: past this the oldest are dropped. */
const DEFAULT_MAX_STREAM = 1 << 20;
/** Settled execs kept for a reader that has not read them yet; past this the oldest go. */
const DEFAULT_KEEP_SETTLED = 64;

type Exec = {
  child?: ChildProcess;
  /** The stream kept, starting at character `base` of the whole. */
  stream: string;
  base: number;
  tailMax: number;
  tail: string;
  output?: ExecOutcome;
  /** Why the group was killed, if this side killed it. */
  ended?: "timeout" | "killed";
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
};

export type ExecsOptions = {
  /** The environment every exec inherits. Default: this process's, the Agent's Stand-ins included. */
  env?: NodeJS.ProcessEnv;
  maxStream?: number;
  keepSettled?: number;
};

/** Every exec this Harness process runs or has settled, by the Effect id the Orchestrator named. */
export class Execs {
  private readonly execs = new Map<string, Exec>();
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly maxStream: number;
  private readonly keepSettled: number;

  constructor(opts: ExecsOptions = {}) {
    this.env = opts.env;
    this.maxStream = opts.maxStream ?? DEFAULT_MAX_STREAM;
    this.keepSettled = opts.keepSettled ?? DEFAULT_KEEP_SETTLED;
  }

  /** Start an exec under `id`, or nothing when `id` is known — running or settled. */
  start(id: string, req: ExecRequest): "started" | "exists" {
    if (this.execs.has(id)) return "exists";
    const exec: Exec = { stream: "", base: 0, tailMax: Math.max(0, req.tail), tail: "", waiters: new Set() };
    this.execs.set(id, exec);
    let child: ChildProcess;
    try {
      child = spawn(req.argv[0]!, req.argv.slice(1), {
        ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        env: this.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.append(exec, `jr2: could not start ${req.argv[0]}: ${err instanceof Error ? err.message : String(err)}\n`);
      this.settle(exec, { outcome: "exited", code: 127, tail: exec.tail });
      return "started";
    }
    exec.child = child;
    // The Agent's processes are the kernel's first choice at the memory limit, never the Harness
    // (ADR-0061) — the same mark the `bash` wrapper gives each command. Best effort: a child that
    // forks before this write leaves its early children at the default.
    if (child.pid !== undefined) {
      try {
        writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000");
      } catch {
        // Not Linux, or no /proc: nothing to mark.
      }
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.append(exec, chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => this.append(exec, chunk));
    exec.timer = setTimeout(() => {
      exec.ended ??= "timeout";
      killGroup(child);
    }, req.timeoutMs);
    exec.timer.unref?.();
    // Its top process ended: end the group with it, so a straggler holding the pipes cannot keep the
    // exec open, and nothing it started outlives it.
    child.on("exit", () => killGroup(child));
    child.on("error", (err) => {
      // Spawn failed (ENOENT, EACCES): the shell's exit 127, with the reason in the stream.
      if (exec.output !== undefined) return;
      this.append(exec, `jr2: could not start ${req.argv[0]}: ${err.message}\n`);
      clearTimeout(exec.timer);
      this.settle(exec, { outcome: "exited", code: 127, tail: exec.tail });
    });
    child.on("close", (code, signal) => {
      if (exec.output !== undefined) return;
      clearTimeout(exec.timer);
      const tail = exec.tail;
      if (exec.ended === "timeout") this.settle(exec, { outcome: "timeout", tail });
      else if (signal !== null) this.settle(exec, { outcome: "killed", signal, tail });
      else this.settle(exec, { outcome: "exited", code: code ?? 0, tail });
    });
    return "started";
  }

  /**
   * Read `id`'s stream from `offset` (absent: from the end) and its output once settled. With
   * `waitMs`, a read that has nothing new parks until something arrives, it settles, or the wait
   * ends. Undefined for an unknown id.
   */
  async read(id: string, opts: { offset?: number; waitMs?: number } = {}): Promise<ExecRead | undefined> {
    const exec = this.execs.get(id);
    if (!exec) return undefined;
    const end = exec.base + exec.stream.length;
    const offset = opts.offset ?? end;
    if (offset >= end && exec.output === undefined && (opts.waitMs ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          exec.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, opts.waitMs);
        exec.waiters.add(wake);
      });
    }
    const from = Math.max(offset, exec.base);
    const next = exec.base + exec.stream.length;
    return {
      state: exec.output === undefined ? "running" : "settled",
      stream: exec.stream.slice(Math.min(from - exec.base, exec.stream.length)),
      next: Math.max(next, offset),
      ...(from > offset ? { dropped: from - offset } : {}),
      ...(exec.output !== undefined ? { output: exec.output } : {}),
    };
  }

  /**
   * Kill `id`'s process group (the Effect's state exited, ADR-0067). True when this kill ended it,
   * or kept it from running; false when it had already settled. An id this process does not know
   * is killed before its start arrived: it is kept as settled `killed`, so that start runs nothing.
   */
  kill(id: string): boolean {
    const exec = this.execs.get(id);
    if (!exec) {
      const killed: Exec = { stream: "", base: 0, tailMax: 0, tail: "", ended: "killed", waiters: new Set() };
      this.execs.set(id, killed);
      this.append(killed, "jr2: killed before it started; nothing ran\n");
      this.settle(killed, { outcome: "killed", signal: "SIGKILL", tail: "" });
      return true;
    }
    if (exec.output !== undefined || exec.child === undefined) return false;
    exec.ended ??= "killed";
    killGroup(exec.child);
    return true;
  }

  /** Drop a settled exec — its reader has its output. A running one is kept: false. */
  forget(id: string): boolean {
    const exec = this.execs.get(id);
    if (!exec || exec.output === undefined) return false;
    this.execs.delete(id);
    return true;
  }

  private append(exec: Exec, chunk: string): void {
    exec.stream += chunk;
    if (exec.stream.length > this.maxStream) {
      const drop = exec.stream.length - this.maxStream;
      exec.stream = exec.stream.slice(drop);
      exec.base += drop;
    }
    exec.tail = exec.tailMax === 0 ? "" : (exec.tail + chunk).slice(-exec.tailMax);
    this.wake(exec);
  }

  private settle(exec: Exec, output: ExecOutcome): void {
    exec.output = output;
    exec.child = undefined;
    this.wake(exec);
    // Keep the newest settled ones for a reader behind; the oldest go first.
    const settled = [...this.execs].filter(([, e]) => e.output !== undefined);
    for (const [id] of settled.slice(0, Math.max(0, settled.length - this.keepSettled))) this.execs.delete(id);
  }

  private wake(exec: Exec): void {
    for (const wake of [...exec.waiters]) wake();
  }
}

/** SIGKILL the group `child` leads. A group already gone is nothing to do. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH: the group is gone.
  }
}
