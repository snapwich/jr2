// IO seam + output discipline (ADR-0009). The CLI keeps two streams strictly separated:
//   - STDOUT carries the one machine-readable RESULT (terminal RunStatus, a run list, a runId) as JSON,
//     so `j2 run ping | jq` and friends get clean data;
//   - STDERR carries human ACTIVITY (status deltas, author emits, notices, errors).
// Every command takes an `Io` rather than touching `process` directly, so dispatch + commands are
// unit-testable: tests pass buffers for out/err, a fixed cwd/env, and (optionally) a `fetch` bound to a
// hono app so the whole client path runs without a socket.

import type { FetchLike } from "./client.ts";

export type Io = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Override the HTTP transport (tests bind it to `app.request`); default → global `fetch`. */
  fetch?: FetchLike;
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
