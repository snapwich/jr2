// Working tools (ADR-0027/0028): the file and shell tools the Harness executes in its own
// container — what an Agent may DO (the Menu, read through the Custodian, is what it may SAY). All
// six are jr2's: read/write/edit (`file-tools.ts`) and bash (`bash-tool.ts`, ADR-0061) are ports of
// pi-agent-core 0.82.1's, which pi 1.x removed, and keep the text the model reads; grep and glob are
// jr2-written (`rg` with a plain-`grep` fallback when rg is absent; `find`). `rg` is vendored into
// the image at /opt/jr2/bin and reached off PATH, never by absolute path, so a user's own rg in a
// Sandbox Image wins (ADR-0037) and the plain-grep fallback still covers a host run. Each tool
// closes over the Frame's `cwd` (ADR-0057). The definition's `workspace` filters the set: `"read"`
// withholds write and edit (ADR-0028) — bash stays, because the tool layer states intent and stops
// the honest path; the worktree layer is the containment. `"none"` withholds the whole set — the
// Menu-only Agent has no data plane at all.

import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { bashTool } from "./bash-tool.ts";
import type { EngineTool, EngineToolResult } from "./engine.ts";
import { fileTools } from "./file-tools.ts";
import type { GuardOwner, MemoryGuard } from "./memory-guard.ts";
import type { AgentDefinition } from "./spec.ts";

/** A Working tool, in the shape the engine runs (`engine.ts`). */
export type WorkingTool = EngineTool;

/** Output bound for grep/glob — a search that would flood the context truncates, loudly. */
const MAX_LINES = 200;

/**
 * The Working tools for one definition, rooted at `cwd` — the Turn's Frame, resolved (ADR-0057:
 * where a Turn works rides the Turn, never the definition, because a worktree path exists only
 * once a run does). Full set (default `workspace: "write"`): read, write, edit, bash, grep, glob.
 * `workspace: "read"` withholds write and edit; `workspace: "none"` withholds everything — the
 * Agent converses and picks from its Menu alone (ADR-0028). That field IS the definition's own
 * (`spec.ts`, mirroring the Orchestrator's `AgentDefinition`): what an Agent may do is identity.
 * `guard` is the process's memory guard, which watches every `bash` call (ADR-0061); `owner` is
 * the conversation the tools serve (ADR-0062).
 */
export function workingToolsFor(
  definition: AgentDefinition,
  cwd: string,
  opts: { guard?: MemoryGuard | undefined; owner?: GuardOwner | undefined } = {},
): WorkingTool[] {
  if (definition.workspace === "none") return [];
  const search: WorkingTool[] = [grepTool(cwd), globTool(cwd)];
  const bash = bashTool({ cwd, guard: opts.guard, owner: opts.owner }) as WorkingTool;
  return [...fileTools(cwd, { readOnly: definition.workspace === "read" }), bash, ...search];
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression to search file contents for" }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search, relative to the working directory (default: all of it)" }),
  ),
});

function grepTool(cwd: string): EngineTool<typeof grepSchema> {
  return {
    name: "grep",
    description:
      "Search file contents for a regular expression. Answers matching lines as file:line:text, " +
      `first ${MAX_LINES} matches.`,
    parameters: grepSchema,
    execute: async (_id, { pattern, path }, signal) => {
      const target = path ?? ".";
      let r = await run("rg", ["-n", "--no-heading", "--", pattern, target], cwd, signal);
      if (spawnFailed(r)) r = await run("grep", ["-rn", "--", pattern, target], cwd, signal);
      if (r.code === 0) return text(bounded(r.stdout));
      if (r.code === 1 && !r.stderr) return text("no matches");
      throw new Error(r.stderr.trim() || r.error?.message || `search exited ${r.code}`);
    },
  };
}

const globSchema = Type.Object({
  pattern: Type.String({ description: "Filename pattern, e.g. `*.ts` or `src/**/*.test.ts`" }),
  path: Type.Optional(
    Type.String({ description: "Directory to search, relative to the working directory (default: all of it)" }),
  ),
});

function globTool(cwd: string): EngineTool<typeof globSchema> {
  return {
    name: "glob",
    description: `Find files by name pattern. Answers matching paths, first ${MAX_LINES}.`,
    parameters: globSchema,
    execute: async (_id, { pattern, path }, signal) => {
      // A slash-less pattern matches basenames anywhere (-name); a pattern with directories
      // matches against the whole path — find's `*` spans `/`, so `**` collapses to `*`.
      const matcher = pattern.includes("/") ? ["-path", `*/${pattern.replaceAll("**", "*")}`] : ["-name", pattern];
      const r = await run("find", [path ?? ".", "-type", "f", ...matcher], cwd, signal);
      if (r.code !== 0) throw new Error(r.stderr.trim() || r.error?.message || `find exited ${r.code}`);
      const found = r.stdout.split("\n").filter(Boolean).sort().join("\n");
      return text(found ? bounded(found) : "no matches");
    },
  };
}

type RunResult = { code: number | null; stdout: string; stderr: string; error?: Error };

function run(file: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error == null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr, ...(error ? { error } : {}) });
    });
  });
}

/** The command never ran (code is a string like ENOENT, not an exit code) and was not aborted —
 * the rg-absent case the grep fallback exists for. */
function spawnFailed(r: RunResult): boolean {
  return r.code === null && !(r.error && r.error.name === "AbortError");
}

function bounded(out: string): string {
  const lines = out.split("\n").filter(Boolean);
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines truncated — narrow the search`].join(
    "\n",
  );
}

function text(t: string): EngineToolResult {
  return { content: [{ type: "text", text: t }] };
}
