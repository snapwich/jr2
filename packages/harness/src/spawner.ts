// The spawner's client (ADR-0076): how the Harness of a Sandbox starts each process that a model
// drives, and does each file tool's I/O. The Harness starts ONE spawner at its start, confined:
//
//   effector confine <harness-rules> -- effector spawner
//
// A process inherits its parent's Landlock domain, so every process that the spawner starts is in
// the one domain, which the Harness is not in. The processes of the domain see, signal and trace
// each other, as one user's processes do; they cannot read `/run/jr2`, and they cannot trace the
// Harness or read its `/proc/<pid>/environ` or `mem`.
//
// The channel is the spawner's stdin and stdout. Node's `stdio: "pipe"` makes each a socket, and a
// socket cannot be opened again through `/proc/<spawner>/fd/N`, so no process of the domain can put
// a frame on it. A frame is one JSON object on one line, bytes in base64 (the spawner's package
// comment, `effector/internal/spawner`, is the contract).
//
// The spawner is in the domain, so each frame that it sends is DATA OF THE DOMAIN. The client
// checks each one against what it asked: a frame that is not JSON, names no call that is open, or
// has a wrong field ends that spawner. Each open call then fails with a clear error, and a new
// spawner starts. A process that the old spawner started runs on. Nothing that a frame holds can
// stop the Harness or put the client out of step.
//
// What the client sends is what the domain may hold: argv, cwd, the domain's env (`children.ts`,
// never the control Stand-in), and a file's bytes. It sends nothing else.

import { spawn, type ChildProcess } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";

/** How a spawned process ended: its own exit, never a code that it did not give. */
export type SpawnExit = { code: number | null; signal: NodeJS.Signals | null };

/** A process that did not start (no such program, a cwd it cannot enter): the errno, in Node's
 * words for a failed spawn (`spawn <file> ENOENT`). */
export class SpawnError extends Error {
  readonly code: string;
  readonly syscall: string;
  readonly path: string;
  readonly detail: string;
  constructor(file: string, code: string, detail: string) {
    super(`spawn ${file} ${code}`);
    this.code = code;
    this.syscall = `spawn ${file}`;
    this.path = file;
    this.detail = detail;
  }
}

/** A file op that failed: the errno, and the spawner's own words (Go's `<op> <path>: <text>`). */
export class FileOpError extends Error {
  readonly code: string;
  /** The system call that failed, by the spawner's words: `open`, `read`, `write`, `mkdir`, `stat`. */
  readonly syscall: string;
  /** The path the failed system call named, by the spawner's words, else the op's path. */
  readonly path: string;
  constructor(code: string, message: string, opPath: string) {
    super(message);
    this.code = code;
    const said = /^(\w+) (.*): [^:]*$/s.exec(message);
    this.syscall = said?.[1] ?? "open";
    this.path = said?.[2] ?? opPath;
  }
}

/** The spawner ended while a call was open: the call has no answer. A process that it started
 * may still run. */
export class SpawnerGoneError extends Error {
  readonly code = "ESPAWNER";
}

/** What a `stat` answers. It follows links. */
export type StatAnswer = {
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  realpath: string;
};

/** The file ops, done in the domain: the file tools' I/O, and each path of the Agent's that the
 * Harness reads, lists or removes (the sync's git dirs and its bundle). */
export type FileOps = {
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string): Promise<void>;
  stat(path: string): Promise<StatAnswer>;
  /** The names in a folder, sorted. */
  readdir(path: string): Promise<string[]>;
  /** Remove one name: never a folder, never what a link names. */
  unlink(path: string): Promise<void>;
};

/** One process to start: its whole argv (argv[0] found on `env.PATH`), its whole env, its cwd. */
export type SpawnRequest = {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** A pipe for its stdin; else /dev/null. */
  stdin?: boolean;
  /** A pseudo-terminal of this size, in characters, as its stdin, stdout and stderr and its
   * controlling terminal, in a session of its own: a person's shell (`workspace-shell.ts`). Its
   * output comes to `onStdout`, and `write` types on it. */
  tty?: { rows: number; cols: number };
};

/** A started process. Its output comes to the handlers; `exited` settles once, last. */
export interface Spawned {
  /** Its pid, once `started`. It leads its own process group. Rejects as `exited` does when it
   * never started. */
  readonly started: Promise<number>;
  /** Its exit. Rejects with `SpawnError` (it did not start) or `SpawnerGoneError`. */
  readonly exited: Promise<SpawnExit>;
  /** Bytes to its stdin (a spawn with `stdin: true`). */
  write(data: Buffer | string): void;
  /** Close its stdin. */
  end(): void;
  /** A signal to its whole process group. Nothing when the group has ended. */
  signal(signal: NodeJS.Signals): void;
  /** The size of its terminal (a spawn with `tty`). Nothing for a spawn without one, or that ended. */
  resize(rows: number, cols: number): void;
  /** Stop reading its output until `resume`: its pipes or its terminal fill, and its writes block.
   * The output that the spawner read before the pause still comes. Nothing for a spawn that ended. */
  pause(): void;
  /** Read its output again after `pause`. */
  resume(): void;
}

export type SpawnHandlers = {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

export type SpawnerOptions = {
  /** How the spawner starts: `[confiner, "confine", ...rules, "--", effector, "effector", "spawner"]`. */
  argv: readonly string[];
  /** The spawner's own env. Each spawn names its child's whole env, so the spawner needs none. */
  env?: Readonly<Record<string, string>>;
  /** Where the client says what went wrong. Default: `console.error`. */
  log?: (line: string) => void;
  /** The pause before a restart after a spawner that lived a short time, doubled to `maxRestartMs`. */
  restartMs?: number;
  maxRestartMs?: number;
};

/** The longest frame the client reads: the longest string that V8 holds. A longer one ends the spawner. */
const MAX_FRAME = bufferConstants.MAX_STRING_LENGTH;

/** A spawner that lived this long was healthy: the next restart starts from the first pause. */
const HEALTHY_MS = 10_000;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ERRNO = /^E[A-Z0-9]{1,20}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,10}$/;

type SpawnCall = {
  kind: "spawn";
  file: string;
  state: "starting" | "running";
  handlers: SpawnHandlers;
  proc: SpawnedProcess;
};
type FileCall = {
  kind: "read" | "write" | "stat" | "readdir" | "unlink";
  path: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};
type Call = SpawnCall | FileCall;

/** One spawner process and the calls open on it. */
type Live = {
  child: ChildProcess;
  calls: Map<string, Call>;
  chunks: Buffer[];
  length: number;
  dead: boolean;
  bornAt: number;
};

class SpawnedProcess implements Spawned {
  readonly started: Promise<number>;
  readonly exited: Promise<SpawnExit>;
  pid: number | undefined;
  #resolveStarted!: (pid: number) => void;
  #rejectStarted!: (err: Error) => void;
  #resolveExited!: (exit: SpawnExit) => void;
  #rejectExited!: (err: Error) => void;
  readonly #owner: Spawner;
  readonly #live: Live | undefined;
  readonly #id: string;

  constructor(owner: Spawner, live: Live | undefined, id: string) {
    this.#owner = owner;
    this.#live = live;
    this.#id = id;
    this.started = new Promise((resolve, reject) => {
      this.#resolveStarted = resolve;
      this.#rejectStarted = reject;
    });
    this.exited = new Promise((resolve, reject) => {
      this.#resolveExited = resolve;
      this.#rejectExited = reject;
    });
    // A caller that reads only `exited` leaves no rejection of `started` unhandled.
    this.started.catch(() => {});
    this.exited.catch(() => {});
  }

  markStarted(pid: number): void {
    this.pid = pid;
    this.#resolveStarted(pid);
  }

  markExited(exit: SpawnExit): void {
    this.#resolveExited(exit);
  }

  fail(err: Error): void {
    this.#rejectStarted(err);
    this.#rejectExited(err);
  }

  write(data: Buffer | string): void {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.length === 0) return;
    this.#owner.sendOn(this.#live, { op: "stdin", id: this.#id, data: bytes.toString("base64") });
  }

  end(): void {
    this.#owner.sendOn(this.#live, { op: "stdin-end", id: this.#id });
  }

  resize(rows: number, cols: number): void {
    // The spawner answers a wrong size with an error frame, which for a spawn breaks the channel:
    // a size that it refuses is not sent.
    if (!isTermSize(rows) || !isTermSize(cols)) return;
    this.#owner.sendOn(this.#live, { op: "resize", id: this.#id, rows, cols });
  }

  pause(): void {
    this.#owner.sendOn(this.#live, { op: "pause", id: this.#id });
  }

  resume(): void {
    this.#owner.sendOn(this.#live, { op: "resume", id: this.#id });
  }

  signal(signal: NodeJS.Signals): void {
    // On the spawner that started it, by its id: the spawner knows the group for some minutes
    // after its exit. When that spawner is gone, the Harness signals the group itself: a process
    // outside the domain may signal into it.
    if (this.#owner.sendOn(this.#live, { op: "signal", id: this.#id, signal })) return;
    if (this.pid === undefined) return;
    try {
      process.kill(-this.pid, signal);
    } catch {
      // The group has ended.
    }
  }
}

/**
 * The spawner, started once and started again when it ends. Calls are many at once: each has its
 * own id on the one channel.
 */
export class Spawner implements FileOps {
  readonly #opts: SpawnerOptions;
  readonly #log: (line: string) => void;
  #live: Live | undefined;
  #closed = false;
  #seq = 0;
  #restartMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SpawnerOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
    this.#restartMs = opts.restartMs ?? 100;
    this.#ensure();
  }

  /** The pid of the spawner that runs now, if one does. */
  get pid(): number | undefined {
    return this.#live?.child.pid;
  }

  /** Start `req` in the domain. */
  spawn(req: SpawnRequest, handlers: SpawnHandlers = {}): Spawned {
    const live = this.#ensure();
    const id = this.#nextId();
    const proc = new SpawnedProcess(this, live, id);
    const file = req.argv[0] ?? "";
    if (live === undefined) {
      proc.fail(new SpawnerGoneError("the spawner is closed: this Harness starts no process"));
      return proc;
    }
    if (req.tty && (!isTermSize(req.tty.rows) || !isTermSize(req.tty.cols))) {
      proc.fail(new SpawnError(file, "EINVAL", `${req.tty.rows}x${req.tty.cols} is no terminal size`));
      return proc;
    }
    live.calls.set(id, { kind: "spawn", file, state: "starting", handlers, proc });
    this.#hold(live);
    this.sendOn(live, {
      op: "spawn",
      id,
      argv: [...req.argv],
      env: { ...req.env },
      cwd: req.cwd,
      stdin: req.stdin === true,
      ...(req.tty ? { tty: { rows: req.tty.rows, cols: req.tty.cols } } : {}),
    });
    return proc;
  }

  read(path: string): Promise<Buffer> {
    return this.#fileOp("read", path) as Promise<Buffer>;
  }

  write(path: string, data: Buffer | string): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    return this.#fileOp("write", path, bytes.toString("base64")) as Promise<void>;
  }

  stat(path: string): Promise<StatAnswer> {
    return this.#fileOp("stat", path) as Promise<StatAnswer>;
  }

  readdir(path: string): Promise<string[]> {
    return this.#fileOp("readdir", path) as Promise<string[]>;
  }

  unlink(path: string): Promise<void> {
    return this.#fileOp("unlink", path) as Promise<void>;
  }

  /** End the channel: the spawner exits, and none starts again. Its processes run on. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    const live = this.#live;
    if (live === undefined) return;
    this.#gone(live, "the spawner was closed");
    live.child.stdin?.end();
  }

  /** Send one frame on `live`, when it is the spawner that runs now. False when it is not. */
  sendOn(live: Live | undefined, frame: Record<string, unknown>): boolean {
    if (live === undefined || live.dead || live !== this.#live) return false;
    const stdin = live.child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  #nextId(): string {
    this.#seq += 1;
    return `c${this.#seq}`;
  }

  #fileOp(kind: FileCall["kind"], path: string, data?: string): Promise<unknown> {
    const live = this.#ensure();
    if (live === undefined) return Promise.reject(new SpawnerGoneError("the spawner is closed"));
    const id = this.#nextId();
    return new Promise((resolve, reject) => {
      live.calls.set(id, { kind, path, resolve, reject });
      this.#hold(live);
      this.sendOn(live, { op: kind, id, path, ...(data !== undefined ? { data } : {}) });
    });
  }

  /** The spawner that runs now, started when none runs. Undefined once closed. */
  #ensure(): Live | undefined {
    if (this.#closed) return undefined;
    if (this.#live !== undefined && !this.#live.dead) return this.#live;
    // A spawner that broke the contract is killed, and its exit may not have come yet: a new one
    // starts now, and the old one's exit then starts nothing (`#ended`).
    this.#live = undefined;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const [file, ...args] = this.#opts.argv;
    // `pipe` is a socketpair for each of the three: the channel cannot be opened again by path.
    const child = spawn(file!, args, { env: { ...this.#opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    const live: Live = { child, calls: new Map(), chunks: [], length: 0, dead: false, bornAt: Date.now() };
    this.#live = live;
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(live, chunk));
    // Its stderr is its own words about the channel: to the pod log, a line at a time, bounded.
    let said = "";
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      said = (said + text).slice(-8192);
      const lines = said.split("\n");
      said = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") this.#log(`jr2 harness: ${line.slice(0, 1000)}`);
    });
    // A write to a spawner that has ended is the exit's to report.
    child.stdin?.on("error", () => {});
    child.on("error", (err) => this.#ended(live, `the spawner did not start (${err.message})`));
    child.on("exit", (code, signal) =>
      this.#ended(live, `the spawner exited (${signal !== null ? `signal ${signal}` : `code ${code}`})`),
    );
    this.#hold(live);
    return live;
  }

  /** The event loop waits for the spawner only while a call is open on it. */
  #hold(live: Live): void {
    live.child.unref();
    for (const s of [live.child.stdin, live.child.stderr]) (s as { unref?: () => void } | null)?.unref?.();
    const out = live.child.stdout as { ref?: () => void; unref?: () => void } | null;
    if (live.calls.size > 0 && !live.dead) out?.ref?.();
    else out?.unref?.();
  }

  #ended(live: Live, why: string): void {
    this.#gone(live, why);
    if (this.#live !== live) return;
    this.#live = undefined;
    if (this.#closed) return;
    // A spawner that lived a short time starts again after a pause that doubles; one that lived
    // long starts again at once. A call that comes before the pause ends starts it at once.
    const pause = Date.now() - live.bornAt >= HEALTHY_MS ? 0 : this.#restartMs;
    this.#restartMs =
      pause === 0 ? (this.#opts.restartMs ?? 100) : Math.min(this.#restartMs * 2, this.#opts.maxRestartMs ?? 5_000);
    this.#log(`jr2 harness: ${why}; a new spawner starts${pause > 0 ? ` in ${pause} ms` : ""} (ADR-0076)`);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#ensure();
    }, pause);
    this.#timer.unref?.();
  }

  /** Fail every call open on `live`: it gives no more answers. */
  #gone(live: Live, why: string): void {
    if (live.dead) return;
    live.dead = true;
    live.chunks = [];
    live.length = 0;
    const calls = [...live.calls.values()];
    live.calls.clear();
    this.#hold(live);
    for (const call of calls) {
      if (call.kind === "spawn") {
        const ran = call.state === "running" ? "; the process may still run" : "";
        call.proc.fail(new SpawnerGoneError(`${why} before the answer came${ran}`));
      } else {
        call.reject(new SpawnerGoneError(`${why} before the ${call.kind} of ${call.path} was answered`));
      }
    }
  }

  /** A frame that breaks the contract: this spawner ends, and a new one starts. */
  #broken(live: Live, why: string): void {
    if (live.dead) return;
    this.#log(`jr2 harness: the spawner sent ${why}: it is stopped, and its open calls fail (ADR-0076)`);
    this.#gone(live, `the spawner sent ${why}`);
    try {
      live.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }

  #onData(live: Live, chunk: Buffer): void {
    let rest = chunk;
    while (!live.dead) {
      const nl = rest.indexOf(0x0a);
      if (nl < 0) {
        live.chunks.push(rest);
        live.length += rest.length;
        if (live.length > MAX_FRAME) this.#broken(live, "a frame longer than the Harness reads");
        return;
      }
      const head = rest.subarray(0, nl);
      rest = rest.subarray(nl + 1);
      const line = live.chunks.length === 0 ? head : Buffer.concat([...live.chunks, head]);
      live.chunks = [];
      live.length = 0;
      if (line.length > MAX_FRAME) return this.#broken(live, "a frame longer than the Harness reads");
      this.#onFrame(live, line);
    }
  }

  #onFrame(live: Live, line: Buffer): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line.toString("utf8"));
    } catch {
      return this.#broken(live, "a frame that is not JSON");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return this.#broken(live, "a frame that is not an object");
    }
    const f = frame as Record<string, unknown>;
    if (typeof f.id !== "string") return this.#broken(live, "a frame with no id");
    const call = live.calls.get(f.id);
    if (call === undefined) return this.#broken(live, "a frame for no open call");
    const op = f.op;
    if (op === "error") {
      if (typeof f.code !== "string" || !ERRNO.test(f.code) || typeof f.message !== "string") {
        return this.#broken(live, "an error frame with wrong fields");
      }
      if (call.kind === "spawn") {
        if (call.state !== "starting") return this.#broken(live, "an error frame for a started process");
        this.#settle(live, f.id);
        call.proc.fail(new SpawnError(call.file, f.code, f.message.slice(0, 4096)));
        return;
      }
      this.#settle(live, f.id);
      call.reject(new FileOpError(f.code, f.message.slice(0, 4096), call.path));
      return;
    }
    if (call.kind === "spawn") return this.#onSpawnFrame(live, f.id, call, f);
    if (op !== "ok") return this.#broken(live, `a ${String(op).slice(0, 20)} frame for a file op`);
    if (call.kind === "read") {
      if (typeof f.data !== "string" || !BASE64.test(f.data)) return this.#broken(live, "a read answer with no data");
      this.#settle(live, f.id);
      call.resolve(Buffer.from(f.data, "base64"));
      return;
    }
    if (call.kind === "write" || call.kind === "unlink") {
      this.#settle(live, f.id);
      call.resolve(undefined);
      return;
    }
    if (call.kind === "readdir") {
      // Each name is one entry of one folder: never empty, `.` or `..`, and with no `/` or NUL, so
      // a join with the folder names a path in it and nowhere else.
      const names = f.names;
      if (!Array.isArray(names) || !names.every(isEntryName)) {
        return this.#broken(live, "a readdir answer with wrong names");
      }
      this.#settle(live, f.id);
      call.resolve([...names]);
      return;
    }
    const kind = f.kind;
    if (
      (kind !== "file" && kind !== "directory" && kind !== "other") ||
      !isCount(f.size) ||
      typeof f.mtimeMs !== "number" ||
      !Number.isFinite(f.mtimeMs) ||
      typeof f.realpath !== "string" ||
      !f.realpath.startsWith("/")
    ) {
      return this.#broken(live, "a stat answer with wrong fields");
    }
    this.#settle(live, f.id);
    call.resolve({ kind, size: f.size, mtimeMs: f.mtimeMs, realpath: f.realpath } satisfies StatAnswer);
  }

  #onSpawnFrame(live: Live, id: string, call: SpawnCall, f: Record<string, unknown>): void {
    switch (f.op) {
      case "started": {
        if (call.state !== "starting" || !isCount(f.pid) || f.pid < 2) {
          return this.#broken(live, "a started frame out of order or with no pid");
        }
        call.state = "running";
        call.proc.markStarted(f.pid);
        return;
      }
      case "out": {
        if (call.state !== "running") return this.#broken(live, "output before its process started");
        if ((f.stream !== "stdout" && f.stream !== "stderr") || typeof f.data !== "string" || !BASE64.test(f.data)) {
          return this.#broken(live, "an output frame with wrong fields");
        }
        const handler = f.stream === "stdout" ? call.handlers.onStdout : call.handlers.onStderr;
        const bytes = Buffer.from(f.data, "base64");
        try {
          handler?.(bytes);
        } catch (err) {
          this.#log(`jr2 harness: an output handler threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case "exit": {
        if (call.state !== "running") return this.#broken(live, "an exit before its process started");
        const code = f.code;
        const signal = f.signal;
        if (!(code === null || (Number.isInteger(code) && (code as number) >= 0 && (code as number) <= 255))) {
          return this.#broken(live, "an exit frame with a wrong code");
        }
        if (!(signal === null || (typeof signal === "string" && SIGNAL.test(signal)))) {
          return this.#broken(live, "an exit frame with a wrong signal");
        }
        this.#settle(live, id);
        call.proc.markExited({ code: code as number | null, signal: signal as NodeJS.Signals | null });
        return;
      }
      default:
        return this.#broken(live, `a ${String(f.op).slice(0, 20)} frame for a process`);
    }
  }

  #settle(live: Live, id: string): void {
    live.calls.delete(id);
    this.#hold(live);
  }
}

/** A terminal's rows or columns: what the spawner takes (1 to 65535). */
function isTermSize(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 0xffff;
}

function isEntryName(v: unknown): v is string {
  return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !v.includes("/") && !v.includes("\0");
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
