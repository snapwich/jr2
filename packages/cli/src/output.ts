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
  /** Override deploy-keypair generation (`j2 up`'s ssh offer); default → `ssh-keygen`. */
  sshKeygen?: () => Promise<{ privateKey: string; publicKey: string }>;
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
