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
 * discipline as `confirmOrBail` — injectable, and a non-tty answers "none" rather than hanging —
 * with one addition: anything that is not a listed number is ALSO "none". A menu whose dangerous
 * entries sit beside the recommended one must never resolve a typo into a pick, and the caller's
 * decline path (bail with the manual instructions) is the safe answer to an unreadable one.
 */
export async function chooseOrBail(io: Io, question: string, options: string[]): Promise<number | undefined> {
  if (io.choose) return io.choose(question, options);
  if (!process.stdin.isTTY) {
    activity(io, `${question} — not a tty; pass --yes to take the recommended option non-interactively`);
    return undefined;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // One question string, menu included: readline owns the line (see `confirmOrBail`), so a menu
    // written to stderr beforehand would be erased by its first refresh.
    const menu = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
    const answer = await rl.question(`${question}\n${menu}\n  (anything else cancels)\nchoice: `);
    const pick = Number.parseInt(answer.trim(), 10);
    return Number.isInteger(pick) && pick >= 1 && pick <= options.length ? pick - 1 : undefined;
  } finally {
    rl.close();
  }
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
