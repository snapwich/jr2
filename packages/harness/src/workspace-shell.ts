// A person's shell in a Workspace (ADR-0076, ADR-0009). `jr2 workspace shell` runs the client
// (`workspace-shell-main.ts`) in the Harness container with `kubectl exec`, started as the Harness
// is started:
//
//   /opt/jr2/bin/effector nocore --harness-env -- /opt/jr2/bin/node --disable-sigusr1 \
//     /opt/jr2/src/workspace-shell-main.ts [-- <command>...]
//
// The client is not in the domain. It asks the Harness, on the shell socket, to start the shell, or
// the one command after `--`, and the Harness asks its one spawner. So the shell is a process of the
// domain, as each Agent's `bash` is: the same rules, which deny `/run/jr2`; the same env, which
// holds the Stand-ins that the `workspace()` grants and never the control Stand-in; the domain's
// umask and git identity; and the Workspace's folder. It sees, signals and traces the Agents'
// processes, as one user's processes do, so a person can stop a dev server that an Agent left. With
// a terminal, the spawner gives the shell a pseudo-terminal of its own (`tty`), and the client
// carries the bytes, the size and the hang-up.
//
// The socket is in `/run/jr2/shell`, an emptyDir of the Harness container's alone (sandbox-kube.ts).
// No process of the domain can make a file there, so none can listen in the Harness's place. A
// process of the domain can connect to the socket (Landlock does not govern a connect), so the
// client proves that it is not one: its first frame carries the digest of the control Stand-in,
// which it reads from its file, and which no process of the domain can read. The Stand-in itself
// never goes on the socket. A process of the domain that connects gets a refusal, and the shell it
// asked for would only have been in its own domain.
//
// A frame is one JSON object on one line, bytes in base64. From the client:
//
//   {"op":"start","proof":DIGEST,"argv":[...],"tty":{"rows":N,"cols":N}|null}   the first frame
//   {"op":"stdin","data":B64}   {"op":"stdin-end"}   {"op":"resize","rows":N,"cols":N}
//   {"op":"signal","signal":"SIGHUP"|"SIGINT"|"SIGTERM"|"SIGQUIT"}
//
// From the Harness: {"op":"out","stream":"stdout"|"stderr","data":B64}, then one of
// {"op":"exit","code":N|null,"signal":NAME|null} and {"op":"error","message":TEXT}, then the end.
// A connection that ends before the exit sends SIGHUP to the shell's process group.
//
// The output has flow control. When the socket's queue is full (`kubectl exec` carries the bytes to
// the person slower than the shell writes them), the Harness pauses the spawn, and resumes it at the
// socket's `drain`. While it is paused, the spawner does not read the shell's output: the terminal or
// the pipes fill, and the shell's writes block, as on a slow terminal. So the output does not collect
// in the memory of the Harness, which also serves the Agents' Turns.

import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { constants } from "node:os";
import { dirname } from "node:path";
import { lookPath, type ChildPolicy } from "./children.ts";
import { SpawnError, type Spawned } from "./spawner.ts";

/** Where the attach puts the Workspace's checkouts (ADR-0063): the shell's folder when it exists. */
export const WORK_ROOT = "/work";

/** The signals that a client may send to the shell. */
const SIGNALS: readonly string[] = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];

/** The longest frame that either side reads: a paste is many frames. */
const MAX_FRAME = 1 << 20;

/** The proof that a client read the control Stand-in: its sha-256, never the value. */
export function shellProof(control: string): string {
  return createHash("sha256").update(`jr2 workspace shell\n${control}`).digest("base64url");
}

/** The exit code of a child that ended: its own, or 128 + the signal's number. */
export function exitCode(code: number | null, signal: NodeJS.Signals | string | null): number {
  if (code !== null) return code;
  const n = signal ? constants.signals[signal as NodeJS.Signals] : undefined;
  return n !== undefined ? 128 + n : 1;
}

/** Read newline-delimited JSON frames from `sock`. A frame that is not a JSON object, or is too
 * long, ends the connection. */
function onFrames(sock: Socket, handle: (frame: Record<string, unknown>) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        sock.destroy();
        return;
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        sock.destroy();
        return;
      }
      handle(frame as Record<string, unknown>);
      if (sock.destroyed) return;
    }
    if (buf.length > MAX_FRAME) sock.destroy();
  });
}

/** Write one frame. False when the socket's queue is full: the caller waits for `drain`. */
function send(sock: Socket, frame: Record<string, unknown>): boolean {
  if (sock.destroyed || !sock.writable) return true;
  return sock.write(`${JSON.stringify(frame)}\n`);
}

const isSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 0xffff;

export type ShellServerOptions = {
  /** The domain. Read at each start, so a start gets the env as the Harness has it then. */
  children: () => ChildPolicy;
  /** The control Stand-in: a client proves that it read it (`shellProof`). */
  control: string;
  /** The socket's path. */
  socket: string;
  /** The shell's folder when it exists; else the domain's HOME. Default `/work`. */
  work?: string;
};

/**
 * Listen for shells on `opts.socket` (its folder is made when it is missing), owner-only. A socket
 * left by an earlier Harness of this container is removed first.
 */
export async function serveShells(opts: ShellServerOptions): Promise<{ server: Server; close: () => Promise<void> }> {
  const proof = Buffer.from(shellProof(opts.control));
  mkdirSync(dirname(opts.socket), { recursive: true, mode: 0o700 });
  rmSync(opts.socket, { force: true });
  /** The shell of each connection, once it started. */
  const current = new WeakMap<Socket, Spawned>();
  const server = createServer((sock) => {
    sock.on("error", () => {});
    let started = false;
    let hangUp: (() => void) | undefined;
    let ended = false;
    sock.on("close", () => {
      if (!ended) hangUp?.();
    });
    onFrames(sock, (f) => {
      if (!started) {
        started = true;
        const given = typeof f.proof === "string" ? Buffer.from(f.proof) : Buffer.alloc(0);
        if (f.op !== "start" || given.length !== proof.length || !timingSafeEqual(given, proof)) {
          ended = true;
          send(sock, {
            op: "error",
            message: "refused: the client did not prove that it reads the control Stand-in (ADR-0076)",
          });
          sock.end();
          return;
        }
        const proc = start(opts, f, sock, () => (ended = true));
        if (proc) hangUp = () => proc.signal("SIGHUP");
        return;
      }
      if (hangUp === undefined) return;
      // The frames after the start go to the shell. One that is wrong is dropped.
      const proc = current.get(sock);
      if (!proc) return;
      if (f.op === "stdin" && typeof f.data === "string") proc.write(Buffer.from(f.data, "base64"));
      else if (f.op === "stdin-end") proc.end();
      else if (f.op === "resize" && isSize(f.rows) && isSize(f.cols)) proc.resize(f.rows, f.cols);
      else if (f.op === "signal" && typeof f.signal === "string" && SIGNALS.includes(f.signal)) {
        proc.signal(f.signal as NodeJS.Signals);
      }
    });
  });

  /** Start the shell for one client; undefined when it is refused. */
  function start(
    o: ShellServerOptions,
    f: Record<string, unknown>,
    sock: Socket,
    markEnded: () => void,
  ): Spawned | undefined {
    const fail = (message: string) => {
      markEnded();
      send(sock, { op: "error", message });
      sock.end();
      return undefined;
    };
    const children = o.children();
    const env = children.env;
    let argv = Array.isArray(f.argv) && f.argv.every((a) => typeof a === "string") ? [...(f.argv as string[])] : [];
    if (argv.length === 0) {
      const shell = ["bash", "sh"].find((s) => lookPath(s, env.PATH) !== undefined);
      if (shell === undefined) return fail("the Sandbox Image has no bash and no sh on its PATH");
      argv = [shell];
    }
    let tty: { rows: number; cols: number } | undefined;
    if (f.tty !== undefined && f.tty !== null) {
      const t = f.tty as { rows?: unknown; cols?: unknown };
      if (!isSize(t.rows) || !isSize(t.cols))
        return fail("the terminal's size is not rows and columns from 1 to 65535");
      tty = { rows: t.rows, cols: t.cols };
    }
    const work = o.work ?? WORK_ROOT;
    const cwd = existsSync(work) ? work : (env.HOME ?? "/");
    let paused = false;
    const out = (stream: "stdout" | "stderr", b: Buffer) => {
      if (send(sock, { op: "out", stream, data: b.toString("base64") }) || paused) return;
      paused = true;
      proc.pause();
      sock.once("drain", () => {
        paused = false;
        proc.resume();
      });
    };
    const proc = children.spawner.spawn(
      { argv, env, cwd, stdin: true, ...(tty ? { tty } : {}) },
      { onStdout: (b) => out("stdout", b), onStderr: (b) => out("stderr", b) },
    );
    // A socket that closes while the spawn is paused never drains: resume it, so that the shell
    // reads its hang-up and its output is read to the end (and dropped).
    sock.once("close", () => {
      if (paused) proc.resume();
    });
    current.set(sock, proc);
    proc.exited.then(
      (exit) => {
        markEnded();
        send(sock, { op: "exit", code: exit.code, signal: exit.signal });
        sock.end();
      },
      (err: unknown) => {
        markEnded();
        const message =
          err instanceof SpawnError
            ? `${argv[0]}: ${err.code === "ENOENT" ? `not on the Workspace's PATH (${env.PATH ?? ""})` : err.detail || err.code}`
            : `the shell did not start: ${err instanceof Error ? err.message : String(err)}`;
        send(sock, { op: "error", message });
        sock.end();
      },
    );
    return proc;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Owner-only: the Harness's uid, which `kubectl exec` runs the client as. The folder is the
  // Harness's alone; this is a second lock.
  chmodSync(opts.socket, 0o600);
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The client's side, over its streams: the person's terminal, or a test's streams. */
export type ShellClientOptions = {
  socket: string;
  /** `shellProof` of the control Stand-in that the client read. */
  proof: string;
  /** The command; empty for the shell. */
  argv: readonly string[];
  /** The terminal's size, when the client has a terminal. */
  tty?: { rows: number; cols: number };
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

/** A started client: `resize` and `signal` send to the shell; `done` is the exit code. */
export type ShellClient = {
  resize(rows: number, cols: number): void;
  signal(signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGQUIT"): void;
  /** End the connection: the Harness sends SIGHUP to the shell. */
  close(): void;
  done: Promise<number>;
};

/** Connect to the Harness, start the shell, and carry the bytes until it exits. */
export function shellClient(opts: ShellClientOptions): ShellClient {
  const sock = createConnection(opts.socket);
  let settled = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    opts.stdin.removeListener("data", onData);
    opts.stdin.removeListener("end", onEnd);
    resolveDone(code);
  };
  const onData = (chunk: Buffer | string) => {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    send(sock, { op: "stdin", data: b.toString("base64") });
  };
  const onEnd = () => send(sock, { op: "stdin-end" });
  sock.on("connect", () => {
    send(sock, { op: "start", proof: opts.proof, argv: [...opts.argv], tty: opts.tty ?? null });
    opts.stdin.on("data", onData);
    opts.stdin.on("end", onEnd);
  });
  sock.on("error", (err) => {
    opts.stderr.write(`jr2 workspace shell: the Harness's shell socket ${opts.socket}: ${err.message}\n`);
    finish(1);
  });
  sock.on("close", () => {
    if (!settled) opts.stderr.write("jr2 workspace shell: the Harness ended the connection\n");
    finish(1);
  });
  // An output that cannot be written (EPIPE: `kubectl exec` went away) ends the connection, and so
  // the Harness hangs up the shell.
  const gone = () => {
    if (settled) return;
    finish(1);
    sock.destroy();
  };
  opts.stdout.on("error", gone);
  opts.stderr.on("error", gone);
  onFrames(sock, (f) => {
    if (f.op === "out" && typeof f.data === "string") {
      // Flow control, as in the Harness: while the output's queue is full, read no more frames. The
      // socket fills, and the Harness pauses the shell.
      const to = f.stream === "stderr" ? opts.stderr : opts.stdout;
      if (!to.write(Buffer.from(f.data, "base64")) && !sock.isPaused()) {
        sock.pause();
        to.once("drain", () => sock.resume());
      }
    } else if (f.op === "exit") {
      finish(exitCode(typeof f.code === "number" ? f.code : null, typeof f.signal === "string" ? f.signal : null));
      sock.end();
    } else if (f.op === "error") {
      opts.stderr.write(`jr2 workspace shell: ${typeof f.message === "string" ? f.message : "refused"}\n`);
      finish(f.message === undefined ? 1 : 126);
      sock.end();
    }
  });
  return {
    resize: (rows, cols) => send(sock, { op: "resize", rows, cols }),
    signal: (signal) => send(sock, { op: "signal", signal }),
    close: () => sock.end(),
    done,
  };
}
