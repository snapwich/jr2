// An Agent's project context (ADR-0062): the context files (`AGENTS.md`, `CLAUDE.md`) from its
// Worktree and the folders above it, and the skills in `<cwd>/.pi/skills`, as pi-coding-agent finds
// them (`loadProjectContextFiles`, `loadSkills`, `formatSkillsForPrompt`). They go in the system
// prompt between the Agent's instructions and the Briefing's standing part.
//
// pi reads the files in the process that calls it. Here that is a child in the domain
// (`project-context-main.ts`), started by the spawner, never the Harness process: the Agent writes
// its Worktree, and a link from its `AGENTS.md` to a file under `/run/jr2` (the control Stand-in, a
// held secret's Stand-in, another Agent's conversation) must fail at the open, in the domain, as
// each of the Agent's own reads does (ADR-0076). The child's line is untrusted data: the Agent can
// write what the files say, so it can write what the line says. A line that is too long, or not in
// the shape, gives no project context, as a child that fails or does not end in time does. The Turn
// goes on without it, and the pod log has one line.
//
// It is loaded once for each conversation and folder, at the first Submission there, and kept in
// memory, so the system prompt is the same bytes on each later Submission and the provider's
// prefix cache holds (ADR-0029). A Harness restart loads it again.

import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_HOME, runIn, type ChildPolicy } from "./children.ts";
import type { AgentDefinition } from "./spec.ts";

/** The child's entry, beside this module: `/opt/jr2/src/project-context-main.ts` in a pod. */
export const PROJECT_CONTEXT_ENTRY = fileURLToPath(new URL("./project-context-main.ts", import.meta.url));
/** The longest line that the Harness reads from the child: each byte goes in every request of the
 * conversation. */
export const PROJECT_CONTEXT_MAX_BYTES = 256 * 1024;
/** How long the child may run. A node start and pi's import take about half a second. */
export const PROJECT_CONTEXT_TIMEOUT_MS = 20_000;
/** Where a Workspace's Repo Slots are (ADR-0075): `/work/<slot>/<folder>` is a clone or a Worktree. */
const WORK_ROOT = "/work";

/** One context file, as pi read it in the domain. */
export type ContextFile = { path: string; content: string };
/** The project context: the context files, outermost first, and pi's skills text ("" for none). */
export type ProjectContext = { files: ContextFile[]; skills: string };

/**
 * True when an Agent in `cwd` gets a project context: it has Working tools, and `cwd` is in a
 * Repo Slot's clone or Worktree (`/work/<slot>/<folder>`, ADR-0075). A Menu-only Agent has no
 * files. An Agent of a Workspace with no Repo Slot works in `/work`, which no repo's files frame.
 */
export function hasProjectContext(workspace: AgentDefinition["workspace"], cwd: string, workRoot = WORK_ROOT): boolean {
  if (workspace === "none") return false;
  const at = normalize(cwd);
  if (!at.startsWith(`${workRoot}/`)) return false;
  const [slot, folder] = at.slice(workRoot.length + 1).split("/");
  return slot !== undefined && slot !== "" && !slot.startsWith(".") && folder !== undefined && folder !== "";
}

/**
 * The project context as the system prompt carries it, in pi-coding-agent's frame (its
 * `project_context` and `skills` sections, at the pin): "" when there is none.
 */
export function projectContextText(ctx: ProjectContext): string {
  const sections: string[] = [];
  if (ctx.files.length > 0) {
    const body = [
      "Project-specific instructions and guidelines:",
      ...ctx.files.map(
        ({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
      ),
    ].join("\n\n");
    sections.push(`<project_context>\n${body}\n</project_context>`);
  }
  const skills = ctx.skills.trim();
  if (skills !== "") sections.push(`<skills>\n${skills}\n</skills>`);
  return sections.join("\n\n");
}

/** The child's line as a project context, or why it is not one. Untrusted: each field is checked. */
export function parseProjectContext(stdout: string): ProjectContext | { fault: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { fault: "its output is not one JSON line" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { fault: "its output is not an object" };
  const { files, skills } = data as Record<string, unknown>;
  if (!Array.isArray(files) || typeof skills !== "string")
    return { fault: "its output has no files list or no skills text" };
  const out: ContextFile[] = [];
  for (const f of files) {
    const { path, content } = (f ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || typeof content !== "string")
      return { fault: "a file in its output has no path or no content" };
    out.push({ path, content });
  }
  return { files: out, skills };
}

export type LoadOptions = {
  signal?: AbortSignal;
  /** The child's entry. Default {@link PROJECT_CONTEXT_ENTRY}; a test names another. */
  entry?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * Load the project context of `cwd` in the domain: the child, by the spawner, with this process's
 * node. Its env is HOME alone, the Harness's own (which the domain cannot reach), so the child's
 * node looks for modules in jr2's folders alone, and no `NODE_OPTIONS` of the image loads code
 * into it. An abort answers `aborted`.
 */
export async function loadProjectContext(
  children: ChildPolicy,
  cwd: string,
  opts: LoadOptions = {},
): Promise<ProjectContext | { fault: string } | "aborted"> {
  const maxBytes = opts.maxBytes ?? PROJECT_CONTEXT_MAX_BYTES;
  const r = await runIn(children, [process.execPath, opts.entry ?? PROJECT_CONTEXT_ENTRY, cwd], {
    cwd,
    env: { HOME: HARNESS_HOME },
    timeoutMs: opts.timeoutMs ?? PROJECT_CONTEXT_TIMEOUT_MS,
    maxBuffer: maxBytes,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (r.error?.name === "AbortError") return "aborted";
  if (r.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { fault: `its output is more than ${maxBytes} bytes` };
  }
  if (r.error !== undefined) {
    const why =
      r.code !== null ? `it exited ${r.code}` : r.signal !== null ? `it ended by ${r.signal}` : r.error.message;
    const said = r.stderr.trim().split("\n").at(-1)?.slice(0, 500);
    return { fault: said ? `${why}: ${said}` : why };
  }
  return parseProjectContext(r.stdout);
}

/**
 * The project context text for one conversation, by folder: each folder loads once, and its text
 * (or "" after a failure, which `log` says once) is the same on each later Submission. A load that
 * an abort stopped is not kept: no request carried it.
 */
export function projectContexts(
  children: ChildPolicy,
  log: (line: string) => void,
  opts: Omit<LoadOptions, "signal"> = {},
): (cwd: string, signal: AbortSignal) => Promise<string> {
  const kept = new Map<string, string>();
  return async (cwd, signal) => {
    const held = kept.get(cwd);
    if (held !== undefined) return held;
    const loaded = await loadProjectContext(children, cwd, { ...opts, signal });
    if (loaded === "aborted") return "";
    let text = "";
    if ("fault" in loaded) {
      log(`jr2 harness: no project context from ${cwd}: the child that loads it failed: ${loaded.fault} (ADR-0062)`);
    } else {
      text = projectContextText(loaded);
    }
    kept.set(cwd, text);
    return text;
  };
}
