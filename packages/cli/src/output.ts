// IO seam + output discipline (ADR-0009). The CLI keeps two streams strictly separated:
//   - STDOUT carries the one machine-readable RESULT (terminal RunStatus, a run list, a runId) as JSON,
//     so `j2 run ping | jq` and friends get clean data;
//   - STDERR carries human ACTIVITY (status deltas, author emits, notices, errors).
// Every command takes an `Io` rather than touching `process` directly, so dispatch + commands are
// unit-testable: tests pass buffers for out/err, a fixed cwd/env, and (optionally) a `fetch` bound to a
// hono app so the whole client path runs without a socket.

import type { BuildPort } from "./build.ts";
import type { FetchLike } from "./client.ts";
import type { KubeAdmin, KubePort } from "./kube.ts";
import type { TypecheckPort } from "./typecheck.ts";

export type Io = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Override the HTTP transport (tests bind it to `app.request`); default → global `fetch`. */
  fetch?: FetchLike;
  /** Override the kube transport (tests inject a fake); default → `kubectl` subprocesses. */
  kube?: KubePort;
  /** Override the kube admin surface `j2 up`/`down` converge through; default → `kubectl`. */
  kubeAdmin?: KubeAdmin;
  /** Override the image build port; default → pnpm + docker + kind subprocesses. */
  build?: BuildPort;
  /** Override `j2 up`'s Instance typecheck (ADR-0050); default → the Instance's own `tsc`. */
  typecheck?: TypecheckPort;
  /** Where kit-checkout detection starts walking up from (ADR-0038); default → the CLI's own
   * module directory, which is the whole signal: a checkout resolves the kit sources, an npm
   * install does not. Exists so tests can drive both worlds instead of detecting the real repo
   * they happen to run inside. NOT user-facing — no flag and no env reads it. */
  kitDir?: string;
  /** Answer a yes/no confirmation; default → interactive TTY prompt (non-TTY answers no). */
  confirm?: (question: string) => Promise<boolean>;
  /** Pick one of several offered options (`j2 up`'s git-ssh key source, ADR-0047); default →
   * an interactive TTY menu. Returns the chosen index; `undefined` is "none of these", which
   * every caller must treat as a decline — a non-TTY always answers that. */
  choose?: (question: string, options: string[]) => Promise<number | undefined>;
  /** Read one VISIBLE line — a path, or the bare enter that ends a pause; default → TTY readline
   * (non-TTY reads nothing, never hangs). */
  prompt?: (question: string) => Promise<string>;
  /** Read key material with echo OFF; default → TTY readline with its own echo suppressed. */
  readSecret?: (question: string) => Promise<string>;
  /** Override deploy-keypair generation (`j2 up`'s ssh offer); default → `ssh-keygen`. */
  sshKeygen?: () => Promise<{ privateKey: string; publicKey: string }>;
  /** Derive `key.pub` from a private key the USER supplied, refusing a passphrase-protected one
   * by name (ADR-0047); default → `ssh-keygen -y -P ""`. */
  sshPublicKey?: (privateKey: string) => Promise<string>;
};

/** The real-process IO the `j2` bin runs with. */
export const defaultIo: Io = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
};

/** Emit the command's machine-readable result as a JSON line on stdout. */
export function result(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

/** Emit a human-facing activity/notice line on stderr. */
export function activity(io: Io, line: string): void {
  io.stderr(`${line}\n`);
}

/**
 * Ask a yes/no question on the terminal (ADR-0019: `up` prompts exactly when meeting a cluster
 * that isn't yet home; `down` always). Injectable via `io.confirm`; the default reads one line
 * from the tty — and a NON-tty (CI without `--yes`) answers no, never hangs.
 */
export async function confirmOrBail(io: Io, question: string): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!process.stdin.isTTY) {
    activity(io, `${question} — not a tty; pass --yes to proceed non-interactively`);
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // readline OWNS the line: pre-writing the prompt to stderr gets erased by its first
    // line-refresh on a tty, leaving a question-less cursor that reads as a hang.
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Ask which of several offered options to take (ADR-0047: the git-ssh key source). The same
 * discipline as `confirmOrBail` — injectable, and a non-tty answers "none" rather than hanging.
 * Interactively it is an arrow-key menu: the highlight moves, ENTER commits it, and everything
 * else that resolves (esc, q, ctrl-c) is "none". No keystroke but enter can pick, because this
 * menu's entries are not interchangeable — the dangerous ones sit beside the recommended one, so
 * a stray key must never resolve into a pick, and the caller's decline path (bail with the manual
 * instructions) is the safe answer to an unreadable one.
 */
export async function chooseOrBail(io: Io, question: string, options: string[]): Promise<number | undefined> {
  if (io.choose) return io.choose(question, options);
  if (!process.stdin.isTTY) {
    activity(io, `${question} — not a tty; pass --yes to take the recommended option non-interactively`);
    return undefined;
  }
  return menu(question, options);
}

/** The menu's own drawing and key handling. It writes to stderr directly rather than through
 * `activity`, because cursor moves and highlights are not activity lines — the block is redrawn
 * in place and then collapsed to the one line worth keeping in the scrollback. */
async function menu(question: string, options: string[]): Promise<number | undefined> {
  const input = process.stdin;
  const out = process.stderr;
  const color = !process.env.NO_COLOR;
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  out.write(`${question}\n\u001b[?25l`); // question stays; cursor hidden while the block moves

  let cursor = 0;
  let drawn = false;
  const hint = "  (↑/↓ move · enter selects · esc cancels)";
  const draw = (): void => {
    if (drawn) out.write(`\u001b[${options.length + 1}A`); // back to the block's first line
    for (const [i, option] of options.entries()) {
      const line = clip(i === cursor ? `❯ ${option}` : `  ${option}`, out.columns);
      out.write(`\u001b[2K${color && i === cursor ? `\u001b[36m${line}\u001b[0m` : line}\n`);
    }
    out.write(`\u001b[2K${clip(hint, out.columns)}\n`);
    drawn = true;
  };

  return new Promise<number | undefined>((resolve) => {
    const finish = (pick: number | undefined): void => {
      input.off("keypress", onKey);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      // Collapse the block to its outcome: a menu that scrolled past should still say what was
      // chosen, and a redrawn one must not leave N stale lines behind.
      out.write(`\u001b[${options.length + 1}A\u001b[0J`);
      out.write(`${pick === undefined ? "  (cancelled)" : clip(`  ❯ ${options[pick]}`, out.columns)}\n\u001b[?25h`);
      resolve(pick);
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(undefined);
      if (key.name === "up" || key.name === "k") cursor = (cursor + options.length - 1) % options.length;
      else if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % options.length;
      else if (str !== undefined && /^[1-9]$/.test(str) && Number(str) <= options.length) cursor = Number(str) - 1;
      else if (key.name === "return" || key.name === "enter") return finish(cursor);
      else if (key.name === "escape" || key.name === "q") return finish(undefined);
      else return; // an unmapped key changes nothing — no redraw, no pick
      draw();
    };
    input.on("keypress", onKey);
    draw();
  });
}

/** One rendered menu line, kept to one terminal row: a wrapped line would break the cursor
 * arithmetic the redraw depends on. A width of 0 is a terminal that never reported one (a pty
 * opened without a size), not a zero-wide screen — assume 80 rather than clip every line away. */
function clip(line: string, columns: number | undefined): string {
  const width = (columns && columns > 0 ? columns : 80) - 1;
  return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
}

/** Read one visible line — a path to type, or the bare enter that ends a pause. A non-tty reads
 * nothing and returns "", so a scripted run never blocks on a human. */
export async function promptLine(io: Io, question: string): Promise<string> {
  if (io.prompt) return io.prompt(question);
  if (!process.stdin.isTTY) return "";
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Read pasted key material with the terminal's echo OFF (ADR-0047) — a private key must not land
 * in the scrollback or the shell's history of whoever is watching the screen. Multi-line by
 * nature: lines are collected until the key's own `-----END …-----` trailer (or EOF, ctrl-D).
 * Echo suppression is readline's own writer, silenced — which is also why the prompt may be
 * written before the interface exists: with nothing echoed, nothing refreshes over it.
 */
export async function readSecretInput(io: Io, question: string): Promise<string> {
  if (io.readSecret) return io.readSecret(question);
  if (!process.stdin.isTTY) return "";
  activity(io, question);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      lines.push(line);
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) break;
    }
  } finally {
    rl.close();
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
