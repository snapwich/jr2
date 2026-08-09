// Working tools (ADR-0027/0028): the file and shell tools the Harness executes in its own
// container — what an Agent may DO (the Menu, served by the Adapter, is what it may SAY). pi
// ships read/write/edit/bash; grep and glob are j2-written (`rg` with a plain-`grep` fallback
// when rg is absent; `find`). `rg` is vendored into the image at /opt/j2/bin and reached off PATH,
// never by absolute path, so a user's own rg in a Sandbox Image wins (ADR-0037) and the plain-grep
// fallback still covers a host run. The definition's `workspace` filters the set: `"read"` withholds
// write and edit (ADR-0028) — bash stays, because the tool layer states intent and stops the
// honest path; the worktree layer is the containment. `"none"` withholds the whole set — the
// Menu-only Agent has no data plane at all.

import { execFile } from "node:child_process";
import {
  type AgentHarnessTool,
  type AgentToolResult,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./spec.ts";

/** A Working tool, in the shape the harness assembly consumes (`setTools`). The built-in file
 * tools draw cwd from the harness's `toolContext` (`NodeExecutionEnv`); grep/glob close over the
 * same cwd directly. */
export type WorkingTool = AgentHarnessTool<ExecutionToolContext>;

/** Output bound for grep/glob — a search that would flood the context truncates, loudly. */
const MAX_LINES = 200;

/**
 * The Working tools for one definition, rooted at the resolved cwd. Full set (default
 * `workspace: "write"`): read, write, edit, bash, grep, glob. `workspace: "read"` withholds write
 * and edit; `workspace: "none"` withholds everything — the Agent converses and picks from its
 * Menu alone (ADR-0028). The field is the definition's own (`spec.ts`, mirroring the
 * Orchestrator's `AgentDefinition`).
 */
export function workingToolsFor(definition: AgentDefinition, cwd: string): WorkingTool[] {
  if (definition.workspace === "none") return [];
  const search: WorkingTool[] = [grepTool(cwd), globTool(cwd)];
  if (definition.workspace === "read") return [createReadTool(), createBashTool(), ...search];
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool(), ...search];
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression to search file contents for" }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search, relative to the working directory (default: all of it)" }),
  ),
});

function grepTool(cwd: string): AgentHarnessTool<ExecutionToolContext, typeof grepSchema, undefined> {
  return {
    name: "grep",
    label: "grep",
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

function globTool(cwd: string): AgentHarnessTool<ExecutionToolContext, typeof globSchema, undefined> {
  return {
    name: "glob",
    label: "glob",
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

function text(t: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: t }], details: undefined };
}
