// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/tools/bash.js and dist/harness/utils/shell-output.js
//
// The `bash` Working tool (ADR-0027, ADR-0061). The output the model reads is pi 0.82.1's, byte for
// byte: stdout and stderr together in arrival order, the control characters removed, the tail of
// 2000 lines or 50 KB, the full output in a temporary file past that bound, and pi's status lines.
// jr2 makes three claims in the tool itself:
//
//   1. A process killed by a signal is an error that names the signal, never exit 0. The command
//      runs in a subshell, so the shell sees the death as 128+n (`bash -c 'one command'` would exec
//      the command AS the shell); and a shell that was itself killed reports its own signal, read
//      from its exit (`shell.ts`).
//   2. Every command starts with `oom_score_adj=1000`, inherited by its children: no privilege
//      needed to raise it, and on a node with the kubelet's `singleProcessOOMKill: true` the
//      kernel then picks the Agent's process, not the Harness.
//   3. The memory guard (memory-guard.ts) watches while the call runs; when it fires, the call
//      answers its `killed: memory limit …` text, whatever else the shell reported.

import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { EngineTool } from "./engine.ts";
import type { MemoryGuard } from "./memory-guard.ts";
import { exec, isExecError, MAX_TIMEOUT_SECONDS, type ExecError, type ExecExit } from "./shell.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type TruncationResult } from "./truncate.ts";

/**
 * The script the shell runs in place of the Agent's command. The command itself rides the env
 * (`JR2_BASH_COMMAND`) and runs under `eval` in a subshell: a syntax error in it is `eval`'s exit 2,
 * not a broken wrapper, and the subshell drops the variable before the command's programs could
 * inherit it. `$$` in the command is still the shell that `shell.ts` spawned. Line 2 stays as it
 * was when the shell wrote a status file (its `unset` names `JR2_BASH_STATUS` too): when bash reports
 * that the subshell was killed, it prints the subshell's text, and the model reads that text.
 */
const WRAPPER = [
  "echo 1000 > /proc/self/oom_score_adj 2>/dev/null",
  '( __jr2_command=$JR2_BASH_COMMAND; unset JR2_BASH_COMMAND JR2_BASH_STATUS; eval "$__jr2_command" )',
  "__jr2_status=$?",
  'exit "$__jr2_status"',
].join("\n");

/** Signal numbers to names — 137 is 128 + 9, SIGKILL. */
const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([name, n]) => [n, name]));

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
}

/** The `bash` Working tool, rooted at `cwd`. `guard` is the process's memory guard (`main.ts`);
 * omitted, no guard watches — a host run, or a test. */
export function bashTool(opts: {
  cwd: string;
  guard?: Pick<MemoryGuard, "watch"> | undefined;
}): EngineTool<typeof bashSchema> {
  return {
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    async execute(_toolCallId, { command, timeout }, signal) {
      validateTimeout(timeout);
      const watch = opts.guard?.watch();
      let capture: Capture;
      try {
        capture = await executeShellWithCapture(WRAPPER, {
          cwd: opts.cwd,
          env: { JR2_BASH_COMMAND: command },
          ...(timeout === undefined ? {} : { timeout }),
          ...(signal ? { signal } : {}),
        });
      } finally {
        watch?.end();
      }

      let outputText = capture.output;
      if (capture.truncation.truncated) {
        const startLine = capture.truncation.totalLines - capture.truncation.outputLines + 1;
        const endLine = capture.truncation.totalLines;
        if (capture.truncation.lastLinePartial) {
          const lastLineSize = formatSize(capture.lastLineBytes);
          outputText += `\n\n[Showing last ${formatSize(capture.truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${capture.fullOutputPath}]`;
        } else if (capture.truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines}. Full output: ${capture.fullOutputPath}]`;
        } else {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${capture.fullOutputPath}]`;
        }
      }
      const withStatus = (output: string, text: string) => `${output ? `${output}\n\n` : ""}${text}`;
      const status = statusOf(capture, timeout);
      // The memory guard's verdict wins over every other status. Before it, the call answers what
      // the Agent saw of the command, trimmed, as jr2 answered it on pi 0.82.1: an exit code is not
      // said (the kill made it), and an abort or a timeout is.
      const verdict = watch?.verdict();
      if (verdict) {
        const seen =
          !status || status.exit ? outputText : status.alone ? status.text : withStatus(outputText, status.text);
        throw new Error(withStatus(seen.trimEnd(), verdict));
      }
      if (status === undefined) return { content: [{ type: "text", text: outputText || "(no output)" }] };
      // An execution error (the spawn failed, the working directory is gone) is its own text alone.
      if (status.alone) throw new Error(status.text);
      throw new Error(withStatus(outputText, status.text));
    },
  };
}

/**
 * The status line of a call that did not succeed, or undefined when it did. The first match wins:
 * an abort, then the timeout, then an execution error, then a signal death, then a non-zero exit —
 * pi 0.82.1's order (cancelled, timeout, execution error, code), with the signal before the code.
 * The memory guard's verdict comes before all of them (`execute`). The order matters: an abort and
 * a timeout kill the process group with SIGKILL, so the shell's exit names SIGKILL then too.
 * `exit` marks a status that the shell's exit gave.
 */
function statusOf(
  capture: Capture,
  timeout: number | undefined,
): { text: string; alone?: boolean; exit?: boolean } | undefined {
  if (capture.cancelled) return { text: "Command aborted" };
  if (capture.error?.kind === "timeout") return { text: `Command timed out after ${timeout} seconds` };
  if (capture.error) return { text: capture.error.message, alone: true };
  const exit = capture.exit!;
  // The shell itself died by a signal: it wrote no exit code.
  if (exit.signal !== null) return { text: `Command killed by signal ${exit.signal}`, exit: true };
  const code = exit.code ?? 0;
  // A command that a signal killed inside the subshell: the shell exits 128+n. The shell cannot tell
  // it from a program that exited 128+n itself; bash reports both the same way, and so does this.
  const name = code > 128 ? SIGNAL_NAMES.get(code - 128) : undefined;
  if (name) return { text: `Command killed by signal ${name} (exit ${code})`, exit: true };
  if (code !== 0) return { text: `Command exited with code ${code}`, exit: true };
  return undefined;
}

// ─── the capture (pi's `executeShellWithCapture`) ───────────────────────────

/** The output as the model reads it: the tail, its truncation, and the full output's file. */
type Tail = {
  output: string;
  truncation: TruncationResult;
  fullOutputPath: string | undefined;
  lastLineBytes: number;
};

type Capture = Tail & {
  /** The shell's exit, when it ran to one. */
  exit?: ExecExit;
  error?: ExecError;
  cancelled: boolean;
};

/** Remove the control characters except tab, newline and carriage return, and U+FFF9 to U+FFFB. */
export function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

function trimToLastUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

async function executeShellWithCapture(
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  },
): Promise<Capture> {
  let tailOutput = "";
  const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
  let totalBytes = 0;
  let completedLines = 0;
  let hasOpenLine = false;
  let currentLineBytes = 0;
  let fullOutputPath: string | undefined;
  let fullOutputRequested = false;
  let acceptingOutput = true;
  let writeChain: Promise<void> = Promise.resolve();
  let captureError: Error | undefined;
  const appendFullOutput = (text: string) => {
    if (!fullOutputRequested || captureError) return;
    writeChain = writeChain.then(async () => {
      if (!fullOutputPath) throw new Error("Full output path was not created");
      await appendFile(fullOutputPath, text);
    });
  };
  const ensureFullOutputFile = (initialContent: string) => {
    if (fullOutputRequested || captureError) return;
    fullOutputRequested = true;
    writeChain = writeChain.then(async () => {
      const dir = await mkdtemp(join(tmpdir(), "tmp-"));
      const path = join(dir, `bash-${randomUUID()}.log`);
      await writeFile(path, "");
      fullOutputPath = path;
      await appendFile(path, initialContent);
    });
  };
  const tailNow = (): Tail => {
    const tailTruncation = truncateTail(tailOutput);
    const totalLines = completedLines + (hasOpenLine ? 1 : 0);
    const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated
        ? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
        : null,
      totalLines,
      totalBytes,
    };
    return {
      output: truncated ? truncation.content : tailOutput,
      truncation,
      fullOutputPath,
      lastLineBytes: currentLineBytes,
    };
  };
  const onChunk = (chunk: string) => {
    if (!acceptingOutput) return;
    try {
      const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
      const textBytes = Buffer.byteLength(text, "utf8");
      totalBytes += textBytes;
      completedLines += text.split("\n").length - 1;
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const trailingText = text.slice(lastNewline + 1);
        currentLineBytes = Buffer.byteLength(trailingText, "utf8");
        hasOpenLine = trailingText.length > 0;
      } else if (text.length > 0) {
        currentLineBytes += textBytes;
        hasOpenLine = true;
      }
      tailOutput += text;
      const totalLines = completedLines + (hasOpenLine ? 1 : 0);
      if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
        ensureFullOutputFile(tailOutput);
      } else if (fullOutputRequested) {
        appendFullOutput(text);
      }
      tailOutput = trimToLastUtf8Bytes(tailOutput, maxOutputBytes);
    } catch (error) {
      captureError = error instanceof Error ? error : new Error(String(error));
    }
  };
  const result = await exec(command, {
    cwd: options.cwd,
    env: options.env,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.signal ? { signal: options.signal } : {}),
    onStdout: onChunk,
    onStderr: onChunk,
  });
  acceptingOutput = false;
  if (tailNow().truncation.truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
  // A failed write of the full output, or a failed capture, fails the call with its own words.
  await writeChain;
  if (captureError) throw captureError;
  const tail = tailNow();
  if (isExecError(result)) {
    if (result.kind === "aborted" || options.signal?.aborted) return { ...tail, cancelled: true };
    return { ...tail, error: result, cancelled: false };
  }
  const cancelled = options.signal?.aborted ?? false;
  return { ...tail, ...(cancelled ? {} : { exit: result }), cancelled };
}
