// Working tools (ADR-0027/0028): the file and shell tools the Harness executes in its own
// container — what an Agent may DO (the Menu, read through the Custodian, is what it may SAY).
// `read`, `write`, `edit`, `bash` and `find` are pi-coding-agent's (`pi-tools.ts`), with jr2's
// operations (`tool-ops.ts`): their declarations and their texts are upstream's, at the pin. `grep`
// is jr2's: pi's own `grep` starts `rg` in this process, outside the domain, and can download rg.
// jr2's runs `rg` in the domain, with a plain-`grep` fallback when rg is absent. `rg` is vendored
// into the image at /opt/jr2/bin and reached off PATH, never by absolute path, so a user's own rg
// in a Sandbox Image wins (ADR-0037). Each tool closes over the Frame's `cwd` (ADR-0057). The
// definition's `workspace` filters the set: `"read"` withholds write and edit (ADR-0028) — bash
// stays, because the tool layer states intent and stops the honest path; the worktree layer keeps a
// stray write off the branch. Neither is a boundary between Agents: the Sandbox is. `"none"` withholds the whole set — the Menu-only Agent has no data plane at all.
//
// Every process a tool starts, and every file op, runs in the domain, started by the spawner with
// the domain's env (`children.ts`, `spawner.ts`, ADR-0076): the kernel applies the domain's rules to
// each.

import { join } from "node:path";
import { Type } from "typebox";
import type { TextContent } from "@earendil-works/pi-ai";
import { runIn, type ChildPolicy, type RunResult } from "./children.ts";
import type { EngineTool, EngineToolResult } from "./engine.ts";
import type { GuardOwner, MemoryGuard } from "./memory-guard.ts";
import type { OutputFolder } from "./output-folder.ts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type PiToolDefinition,
} from "./pi-tools.ts";
import type { AgentDefinition } from "./spec.ts";
import { bashOps, editOps, findOps, ImageOmitted, readOps, writeOps } from "./tool-ops.ts";

/** A Working tool, in the shape the engine runs (`engine.ts`). */
export type WorkingTool = EngineTool;

/** Output bound for grep — a search that would flood the context truncates, loudly. */
const MAX_LINES = 200;

/**
 * The Working tools for one definition, rooted at `cwd` — the Turn's Frame, resolved (ADR-0057:
 * where a Turn works rides the Turn, never the definition, because a worktree path exists only
 * once a run does). Full set (default `workspace: "write"`): read, write, edit, bash, grep, find.
 * `workspace: "read"` withholds write and edit; `workspace: "none"` withholds everything — the
 * Agent converses and picks from its Menu alone (ADR-0028). That field IS the definition's own
 * (`spec.ts`, mirroring the Orchestrator's `AgentDefinition`): what an Agent may do is identity.
 * `guard` is the process's memory guard, which watches every `bash` call (ADR-0061); `owner` is
 * the conversation the tools serve (ADR-0062). `children` is the domain: where the tools start a
 * process and do their file I/O (ADR-0076). `output` is the Harness's output folder, which each
 * `bash` call prunes when it ends (`output-folder.ts`, ADR-0076). A Harness with none (the Instance Harness) gives Working
 * tools to no Agent, and says so.
 */
export function workingToolsFor(
  definition: AgentDefinition,
  cwd: string,
  opts: {
    guard?: MemoryGuard | undefined;
    owner?: GuardOwner | undefined;
    children?: ChildPolicy | undefined;
    output?: OutputFolder | undefined;
  } = {},
): WorkingTool[] {
  if (definition.workspace === "none") return [];
  const children = opts.children;
  if (children === undefined) {
    throw new Error(
      `this Harness has no domain to run a tool in, so it gives no Working tool: workspace "${definition.workspace ?? "write"}" ` +
        "needs the Harness of a Sandbox (ADR-0031, ADR-0076)",
    );
  }
  const files = children.spawner;
  const home = children.env.HOME ?? "/";
  // No resize: pi's resize decodes the whole image in this process (ADR-0061).
  const read = omitting(
    engineTool(createReadToolDefinition(cwd, { operations: readOps(files), autoResizeImages: false }), home),
  );
  const write = engineTool(createWriteToolDefinition(cwd, { operations: writeOps(files) }), home);
  const edit = engineTool(createEditToolDefinition(cwd, { operations: editOps(files) }), home);
  const bash = pruning(
    guarded(
      engineTool(
        createBashToolDefinition(cwd, { operations: bashOps(children), exposeSessionEnvironment: false }),
        home,
      ),
      opts.guard,
      opts.owner,
    ),
    opts.output,
  );
  const find = engineTool(createFindToolDefinition(cwd, { operations: findOps(children) }), home);
  const grep = grepTool(cwd, children);
  return definition.workspace === "read" ? [read, bash, grep, find] : [read, write, edit, bash, grep, find];
}

const UNICODE_SPACES = /[  -   　]/g;

/**
 * `~` in a tool's `path` as the domain's HOME (ADR-0076). pi expands `~` to this process's HOME,
 * which is the Harness's own under `/run/jr2`: the domain cannot reach it, and `bash` expands `~`
 * to the domain's. So jr2 expands it first, after pi's own two rules that come before `~` (the
 * Unicode spaces become a plain space, and a leading `@` goes).
 */
export function homePath(path: string, home: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  const bare = spaced.startsWith("@") ? spaced.slice(1) : spaced;
  if (bare === "~") return home;
  if (bare.startsWith("~/")) return join(home, bare.slice(2));
  return path;
}

/**
 * pi's tool definition in the shape the engine runs. The model reads the name, the description and
 * the parameters; `prepareArguments` stays (`edit`'s legacy form). The label, the renderers, the
 * prompt snippet and guidelines (jr2's system prompt is its own, ADR-0062) and
 * `constrainedSampling` go: each provider request keeps its shape, with no strict tool schema. A
 * result that pi marks `isError` is a throw with its text, which the engine makes the error result
 * that the model reads.
 */
function engineTool(definition: PiToolDefinition, home: string): EngineTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    async execute(toolCallId, params, signal) {
      const args = params as Record<string, unknown>;
      const at = typeof args.path === "string" ? { ...args, path: homePath(args.path, home) } : args;
      // pi's tools read the context only for its cwd and its model, and fall back on their own.
      const result = await definition.execute(toolCallId, at, signal, undefined, undefined as never);
      const content = result.content as EngineToolResult["content"];
      if (result.isError) throw new Error(textOf(content));
      return { content };
    },
  };
}

/** `read` with a BMP's answer: the text alone, and no image (`ImageOmitted`). */
function omitting(read: EngineTool): EngineTool {
  return {
    ...read,
    async execute(toolCallId, params, signal) {
      try {
        return await read.execute(toolCallId, params, signal);
      } catch (err) {
        if (err instanceof ImageOmitted) return { content: [{ type: "text", text: err.message }] };
        throw err;
      }
    },
  };
}

function textOf(content: EngineToolResult["content"]): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** `bash` that prunes the Harness's output folder when it ends (`output-folder.ts`, ADR-0076). */
export function pruning(bash: EngineTool, output: OutputFolder | undefined): EngineTool {
  if (output === undefined) return bash;
  return {
    ...bash,
    async execute(toolCallId, params, signal) {
      const end = output.call();
      try {
        return await bash.execute(toolCallId, params, signal);
      } finally {
        end();
      }
    },
  };
}

/** The status lines of pi's `bash` that a memory kill makes: the exit code is the kill's. */
const KILLED_STATUS =
  /(?:^|\n\n)(?:\(no output\)\n\n)?Command (?:exited with code \d+|terminated without an exit code)$/;

/**
 * `bash` under the memory guard (ADR-0061): the guard watches while the call runs; when it fires,
 * the call answers its `killed: memory limit …` text, after what the Agent saw of the command. The
 * exit status goes (the kill made it); an abort or a timeout stays. The answer is the model's
 * now: its conversation was told of the kill (ADR-0062).
 */
export function guarded(
  bash: EngineTool,
  guard: Pick<MemoryGuard, "watch"> | undefined,
  owner: GuardOwner | undefined,
): EngineTool {
  if (guard === undefined) return bash;
  return {
    ...bash,
    async execute(toolCallId, params, signal) {
      const watch = guard.watch(owner);
      let outcome: { result: EngineToolResult } | { error: unknown };
      try {
        outcome = { result: await bash.execute(toolCallId, params, signal) };
      } catch (error) {
        outcome = { error };
      } finally {
        watch.end();
      }
      const verdict = watch.verdict();
      if (verdict === undefined) {
        if ("error" in outcome) throw outcome.error;
        return outcome.result;
      }
      const seen =
        "error" in outcome
          ? outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
          : textOf(outcome.result.content);
      const kept = seen
        .replace(KILLED_STATUS, "")
        .replace(/^\(no output\)$/, "")
        .trimEnd();
      watch.told();
      throw new Error(kept ? `${kept}\n\n${verdict}` : verdict);
    },
  };
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression to search file contents for" }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search, relative to the working directory (default: all of it)" }),
  ),
});

function grepTool(cwd: string, children: ChildPolicy): EngineTool<typeof grepSchema> {
  return {
    name: "grep",
    description:
      "Search file contents for a regular expression. Answers matching lines as file:line:text, " +
      `first ${MAX_LINES} matches.`,
    parameters: grepSchema,
    execute: async (_id, { pattern, path }, signal) => {
      const target = path ?? ".";
      let r = await run(children, "rg", ["-n", "--no-heading", "--", pattern, target], cwd, signal);
      if (spawnFailed(r)) r = await run(children, "grep", ["-rn", "--", pattern, target], cwd, signal);
      if (r.code === 0) return text(bounded(r.stdout));
      if (r.code === 1 && !r.stderr) return text("no matches");
      throw new Error(r.stderr.trim() || r.error?.message || `search exited ${r.code}`);
    },
  };
}

/** One search process, in the domain (ADR-0076), as `execFile` ran it: a program the domain's PATH
 * does not hold is a spawn that never ran. */
function run(
  children: ChildPolicy,
  file: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  return runIn(children, [file, ...args], { cwd, ...(signal ? { signal } : {}), maxBuffer: 8 * 1024 * 1024 });
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
