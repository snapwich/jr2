// An Agent's project context (ADR-0062): the context files (`AGENTS.md`, `CLAUDE.md`) from its
// working directory and the folders above it, up to a bound that the Workspace sets, and the skills
// in `<cwd>/.pi/skills`, as pi-coding-agent finds them (`loadProjectContextFiles`, `loadSkills`,
// `formatSkillsForPrompt`). And, when the Sandbox Image has one, the image user's context
// (`~/.pi/agent`): its context file and its skills. They go in the system prompt between the
// Agent's instructions and the Briefing's standing part.
//
// The image user's context is read from one place only: the folder that the pod mounts read-only
// from the Sandbox Image (`JR2_USER_CONTEXT`). Each Agent of the Workspace runs as the image's
// user, so a folder in its HOME that the image's user owns is one that each Agent writes, and what
// one Agent writes there would be in each later Agent's system prompt. The kernel refuses a write
// to the mount. The Harness checks, at its start and around each load, that the path is still that
// mount (`/proc/self/mountinfo`, and the device of the folder); else that load has no user context.
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
// The bound is the Harness's, not pi's: pi's walk goes up to `/`, and it has no option to stop. So
// the Harness keeps only the files that the child names in a folder from the working directory up
// to the bound (`contextBound`), and drops the rest. The walk reads the folders above in the domain,
// which can read them anyway, and their text goes nowhere.
//
// It is loaded once for each conversation and folder, at the first Submission there, and kept in
// memory, so the system prompt is the same bytes on each later Submission and the provider's
// prefix cache holds (ADR-0029). A Harness restart loads it again.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_HOME, harnessRules, runIn, type ChildPolicy } from "./children.ts";
import type { AgentDefinition } from "./spec.ts";

/** The child's entry, beside this module: `/opt/jr2/src/project-context-main.ts` in a pod. */
export const PROJECT_CONTEXT_ENTRY = fileURLToPath(new URL("./project-context-main.ts", import.meta.url));
/** The longest line that the Harness reads from the child: each byte goes in every request of the
 * conversation. */
export const PROJECT_CONTEXT_MAX_BYTES = 256 * 1024;
/** How long the child may run. A node start and pi's import take about half a second. */
export const PROJECT_CONTEXT_TIMEOUT_MS = 20_000;
/** Where a Workspace's Repo Slots are (ADR-0075): `/work/<slot>/<name>` is a clone or a Worktree. */
const WORK_ROOT = "/work";

/** How far up the context files are read: to the Agent's Worktree, or to `/work` (the
 * `workspace()`'s `projectContext`, which the pod's `JR2_PROJECT_CONTEXT` carries). */
export type ContextScope = "worktree" | "workspace";

/** The scope that `JR2_PROJECT_CONTEXT` names. Any other value, or none, is `"worktree"`: the
 * narrower one. */
export function contextScopeOf(value: string | undefined): ContextScope {
  return value === "workspace" ? "workspace" : "worktree";
}

/**
 * The names in the image user's folder that pi's loaders read (`loadProjectContextFiles` and
 * `loadSkills`, at the pin): its context file, by pi's order of names, and its skills folder. The
 * child may read these and nothing else there: not `auth.json`, `settings.json` or `models.json`.
 */
export const USER_CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "skills"];

/** One context file, as pi read it in the domain. */
export type ContextFile = { path: string; content: string };
/** The project context: the context files, outermost first, and pi's skills text ("" for none). */
export type ProjectContext = { files: ContextFile[]; skills: string };

/**
 * True when an Agent in `cwd` gets a project context: it has Working tools, and `cwd` is `/work` or
 * a folder in it (ADR-0075), not in jr2's own `/work/.jr2`. A Menu-only Agent has no files.
 */
export function hasProjectContext(workspace: AgentDefinition["workspace"], cwd: string, workRoot = WORK_ROOT): boolean {
  if (workspace === "none") return false;
  const at = normalize(cwd).replace(/\/+$/, "");
  if (at === workRoot) return true;
  if (!at.startsWith(`${workRoot}/`)) return false;
  return !at.slice(workRoot.length + 1).startsWith(".");
}

/**
 * The folder where the walk of the context files stops (ADR-0062), from a `cwd` that
 * {@link hasProjectContext} accepts. `"workspace"`: `/work`. `"worktree"`: the Worktree's root,
 * `/work/<slot>/<name>`, when `cwd` is in one (ADR-0075 cuts each Worktree, and clones each slot's
 * `default`, at exactly that depth); in `/work` or in a slot's folder, which no Worktree holds,
 * `cwd` itself. The rule reads the path, not the folder: a `.git` that the Agent removes or makes
 * does not move it.
 */
export function contextBound(cwd: string, scope: ContextScope, workRoot = WORK_ROOT): string {
  const at = normalize(cwd).replace(/\/+$/, "");
  if (scope === "workspace") return workRoot;
  const [slot, name] = relative(workRoot, at).split(sep);
  return slot && name ? join(workRoot, slot, name) : at;
}

/** The folders from `cwd` up to `bound`, both in: where a kept context file is. */
function foldersUpTo(cwd: string, bound: string): Set<string> {
  const out = new Set<string>();
  let at = normalize(cwd).replace(/\/+$/, "");
  for (;;) {
    out.add(at);
    if (at === bound || dirname(at) === at) return out;
    at = dirname(at);
  }
}

/**
 * The context files of `ctx` that are in a folder from `cwd` up to `bound`, or in the image user's
 * folder (`userDir`): the Harness's bound on pi's walk, which goes up to `/`. The order stays pi's.
 */
export function withinBound(ctx: ProjectContext, cwd: string, bound: string, userDir?: string): ProjectContext {
  const folders = foldersUpTo(cwd, bound);
  return {
    files: ctx.files.filter(
      ({ path }) => folders.has(dirname(path)) || (userDir !== undefined && dirname(path) === userDir),
    ),
    skills: ctx.skills,
  };
}

/** The image user's context mount, as the Harness saw it at its start (ADR-0062). */
export type UserContextMount = {
  /** The folder: `<home>/.pi/agent` of the image's user, its own real path. */
  dir: string;
  /** The mount's ID in `/proc/self/mountinfo`. */
  mountId: string;
  /** Its device, `major:minor`, which the folder's `stat` gives too. */
  device: string;
};

/** One line of `/proc/<pid>/mountinfo` (proc(5)): what this module reads of it. */
type MountLine = { id: string; device: string; mountPoint: string; options: string[] };

/** The mount point of a mountinfo line, with its octal escapes (`\040` for a space) undone. */
const unescapeMount = (field: string): string =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

function mountLines(text: string): MountLine[] {
  return text
    .split("\n")
    .map((line) => line.split(" "))
    .filter((f) => f.length >= 6)
    .map((f) => ({ id: f[0]!, device: f[2]!, mountPoint: unescapeMount(f[4]!), options: f[5]!.split(",") }));
}

/** `major:minor` of a `stat` device number, as Linux's `makedev` packs it. */
function deviceOf(path: string): string {
  const dev = statSync(path, { bigint: true }).dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

/** This process's mounts. Read in the Harness process: no process of the domain writes it. */
export const readMountInfo = (): string => readFileSync("/proc/self/mountinfo", "utf8");

/**
 * Why `dir` is not a read-only mount that is its own real path and the newest mount there, or the
 * mount when it is. The newest line for a mount point is the one that a path there reaches.
 */
function mountAt(dir: string, mountinfo: string): MountLine | { fault: string } {
  let real: string;
  try {
    real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return { fault: `${dir} is not a folder` };
  } catch (err) {
    return { fault: `${dir} cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` };
  }
  if (real !== dir) return { fault: `${dir} is not its own real path (${real})` };
  const line = mountLines(mountinfo)
    .reverse()
    .find((m) => m.mountPoint === dir);
  if (line === undefined) return { fault: `${dir} is no mount` };
  if (!line.options.includes("ro")) return { fault: `the mount at ${dir} is not read-only` };
  const device = deviceOf(dir);
  if (device !== line.device) return { fault: `${dir} is on device ${device}, not on its mount's ${line.device}` };
  return line;
}

/**
 * The image user's context mount that the pod announces (`JR2_USER_CONTEXT`, ADR-0062), checked:
 * `undefined` for none (`""`, or no value), a fault when the folder is not a read-only mount at its
 * own real path. Call it once, at the start, before any Agent runs.
 */
export function userContextMount(
  announced: string | undefined,
  mountinfo: () => string = readMountInfo,
): UserContextMount | { fault: string } | undefined {
  if (announced === undefined || announced === "") return undefined;
  if (!announced.startsWith("/") || announced.endsWith("/") || normalize(announced) !== announced) {
    return { fault: `${JSON.stringify(announced)} is not an absolute folder` };
  }
  const at = mountAt(announced, mountinfo());
  if ("fault" in at) return at;
  return { dir: announced, mountId: at.id, device: at.device };
}

/** Why `m` is no longer the mount that the Harness saw at its start, or `undefined` when it is:
 * the same mount ID is the newest mount at the folder, read-only, and the folder is on its device. */
export function userContextChanged(m: UserContextMount, mountinfo: () => string = readMountInfo): string | undefined {
  const at = mountAt(m.dir, mountinfo());
  if ("fault" in at) return at.fault;
  if (at.id !== m.mountId) return `the mount at ${m.dir} is mount ${at.id}, not ${m.mountId}`;
  return undefined;
}

/** The paths of {@link USER_CONTEXT_NAMES} in `userDir` that are there and are no link: each gets
 * a read rule. A link gets none, so a read through it fails, as Landlock checks the path that the
 * link names. Read without following a link. */
function userContextReads(userDir: string): string[] {
  return USER_CONTEXT_NAMES.map((name) => join(userDir, name)).filter((p) => {
    try {
      return !lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  });
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
  /** How far up the context files are read. Default `"worktree"`. */
  scope?: ContextScope;
  /** Where the Repo Slots are. Default `/work` (ADR-0075); a test names its own folder. */
  workRoot?: string;
  /** The image user's context folder, checked as a mount ({@link userContextMount}), or none. */
  userDir?: string;
};

/**
 * Load the project context of `cwd` in the domain: the child, by the spawner, with this process's
 * node. Its env is HOME alone, the Harness's own (which the domain cannot reach), so the child's
 * node looks for modules in jr2's folders alone, and no `NODE_OPTIONS` of the image loads code
 * into it. Its `oom_score_adj` is 1000, as each process of the Agent's (ADR-0061). With an image
 * user's folder, the child is confined further: in that folder it reads only the names that pi's
 * loaders read ({@link USER_CONTEXT_NAMES}), and writes nothing. The files are kept within the
 * scope's bound ({@link withinBound}). An abort answers `aborted`.
 */
export async function loadProjectContext(
  children: ChildPolicy,
  cwd: string,
  opts: LoadOptions = {},
): Promise<ProjectContext | { fault: string } | "aborted"> {
  const maxBytes = opts.maxBytes ?? PROJECT_CONTEXT_MAX_BYTES;
  const userDir = opts.userDir;
  const child = [process.execPath, opts.entry ?? PROJECT_CONTEXT_ENTRY, cwd, ...(userDir ? [userDir] : [])];
  let argv = child;
  if (userDir !== undefined) {
    try {
      argv = [
        children.confiner,
        "confine",
        ...harnessRules(children.confiner, [userDir], userContextReads(userDir)),
        // `effector confine`'s form: the path that execve runs, then the whole argv.
        "--",
        process.execPath,
        ...child,
      ];
    } catch (err) {
      return { fault: `its rules for ${userDir} could not be made: ${(err as Error).message.split("\n")[0]}` };
    }
  }
  const r = await runIn(children, argv, {
    cwd,
    env: { HOME: HARNESS_HOME },
    timeoutMs: opts.timeoutMs ?? PROJECT_CONTEXT_TIMEOUT_MS,
    maxBuffer: maxBytes,
    oomScoreAdj: 1000,
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
  const parsed = parseProjectContext(r.stdout);
  if ("fault" in parsed) return parsed;
  const workRoot = opts.workRoot ?? WORK_ROOT;
  return withinBound(parsed, cwd, contextBound(cwd, opts.scope ?? "worktree", workRoot), userDir);
}

/** What {@link projectContexts} loads with: {@link LoadOptions}, with the image user's context as
 * the mount that the Harness checked at its start. */
export type ContextOptions = Omit<LoadOptions, "signal" | "userDir"> & {
  /** The image user's context mount ({@link userContextMount}), or none. */
  userContext?: UserContextMount;
  /** This process's mounts. Default `/proc/self/mountinfo`; a test gives its own. */
  mountinfo?: () => string;
};

/**
 * The project context text for one conversation, by folder: each folder loads once, and its text
 * (or "" after a failure, which `log` says once) is the same on each later Submission. A load that
 * an abort stopped is not kept: no request carried it.
 *
 * The image user's context is read only while its folder is the mount that the Harness saw at its
 * start, checked before the load and after it. Changed before: the load reads no user context, and
 * `log` says why. Changed during the load: the folder gives no project context, as a failed load.
 */
export function projectContexts(
  children: ChildPolicy,
  log: (line: string) => void,
  opts: ContextOptions = {},
): (cwd: string, signal: AbortSignal) => Promise<string> {
  const { userContext, mountinfo, ...load } = opts;
  const changed = (m: UserContextMount) => userContextChanged(m, mountinfo);
  const kept = new Map<string, string>();
  return async (cwd, signal) => {
    const held = kept.get(cwd);
    if (held !== undefined) return held;
    let userDir: string | undefined;
    if (userContext !== undefined) {
      const why = changed(userContext);
      if (why === undefined) userDir = userContext.dir;
      else log(`jr2 harness: no user context for ${cwd}: ${why} (ADR-0062)`);
    }
    const loaded = await loadProjectContext(children, cwd, { ...load, ...(userDir ? { userDir } : {}), signal });
    if (loaded === "aborted") return "";
    const after = userDir !== undefined && userContext !== undefined ? changed(userContext) : undefined;
    let text = "";
    if ("fault" in loaded) {
      log(`jr2 harness: no project context from ${cwd}: the child that loads it failed: ${loaded.fault} (ADR-0062)`);
    } else if (after !== undefined) {
      log(
        `jr2 harness: no project context from ${cwd}: the image user's context changed during the load: ${after} (ADR-0062)`,
      );
    } else {
      text = projectContextText(loaded);
    }
    kept.set(cwd, text);
    return text;
  };
}
