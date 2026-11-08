// The child that loads an Agent's project context (ADR-0062, `project-context.ts`): pi-coding-agent's
// `AGENTS.md`/`CLAUDE.md` walk from the working directory up to `/`, its skills in
// `<cwd>/.pi/skills`, and, when the Harness names one, the image user's folder (pi's `agentDir`):
// its context file and its skills. It runs in the domain, started by the spawner, never in the
// Harness process: so each file that it reads, the kernel lets the domain read. A link from a
// Worktree's `AGENTS.md` to a file under `/run/jr2` fails here, at the open, and its content goes
// nowhere. The Harness keeps only the files within the Workspace's bound; this child does not know
// the bound, and need not.
//
//   node project-context-main.ts <cwd> [<agentDir>]
//
// It writes ONE JSON line to stdout, `{"files":[{"path","content"}],"skills":"<text>"}`, and pi's
// warnings to stderr. The Harness reads the line as untrusted data.
//
// A context file or a skill of the walk is loaded as git shows it to a reviewer (ADR-0062). An
// ignored file is in no diff and in no `git status`, so it is left out. A tracked file loads from
// the index, not from the work tree: git can hide a change of a tracked file from `git status` (an
// assume-unchanged or skip-worktree bit, or stat data that an Agent made the same as the old file's),
// but not a change of the index, which `git status` shows as staged. A file that is neither loads
// from the work tree, where `git status` shows it as untracked.
//
// git judges each file by the rules of the one repo of the working directory: its top, found once.
// Each question goes to git in that top with the path from the top, `./<path>`, so a name is never
// pathspec magic, a nested repo's file is judged by the outer repo's rules, and the folder of each
// file is its real folder (a link in the path goes to the file that it names, and a file outside
// the top is left out). A file in a folder above the top (the bound can be above a Worktree) is
// judged by that folder's repo. The env of git here is the domain's git config
// (`JR2_CONTEXT_GIT_ENV`: its HOME, so its global excludes, and its system file), never the
// Harness's, and no replace ref. A file is in no repo, and loads from the work tree, only when no
// folder from the working directory (or, above the top, from the file's own folder) up to `/` has a
// `.git`: a nested repo or a link in a Worktree does not make one. When git cannot say (git is not on the PATH, an error,
// or a `core.worktree` that puts the folder outside git's own), the file is left out. The image
// user's folder is the image's, and is not asked about.
//
// First, before any other module runs: node looks for modules in jr2's folders alone, as in the
// Harness (`module-paths.ts`). The Harness starts this child with HOME=/run/jr2/home.
import "./module-paths-guard.ts";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import {
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills,
  parseFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";

/**
 * pi's user-level folder (`~/.pi/agent`) when the Harness names none: a folder that does not
 * exist, in the path that the domain cannot reach. So no user-level context file and no user-level
 * skill loads, only what the working directory and the folders above it hold.
 */
const NO_AGENT_DIR = "/run/jr2/no-agent-dir";

const cwd = process.argv[2];
if (cwd === undefined || cwd === "") {
  console.error("jr2 project context: no folder to load from");
  process.exit(2);
}
const agentDir = process.argv[3] || NO_AGENT_DIR;

/** git's env: a PATH of the image's own folders, as jr2's sync has it, the domain's git config names
 * from the Harness (`JR2_CONTEXT_GIT_ENV`), and no replace ref, which would show another object for
 * an object id. */
const gitEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  ...(JSON.parse(process.env.JR2_CONTEXT_GIT_ENV || "{}") as Record<string, string>),
  GIT_NO_REPLACE_OBJECTS: "1",
};

/** git in `dir`: its exit code (null when it did not run, as when there is no git) and its stdout. */
function git(dir: string, args: string[]): { code: number | null; out: Buffer } {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], {
    env: gitEnv,
    timeout: 10_000,
    maxBuffer: 4 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { code: r.error === undefined ? r.status : null, out: r.stdout ?? Buffer.alloc(0) };
}

/** The repo that judges the files of a real folder: its top, or `"none"` when no folder from it up
 * to `/` has a `.git`, or `"unknown"` when git cannot say. */
type Repo = { top: string } | "none" | "unknown";

function hasGit(folder: string): boolean {
  for (let at = folder; ; at = dirname(at)) {
    try {
      lstatSync(join(at, ".git"));
      return true;
    } catch {
      if (dirname(at) === at) return false;
    }
  }
}

const repos = new Map<string, Repo>();
function repoOf(folder: string): Repo {
  const known = repos.get(folder);
  if (known !== undefined) return known;
  let repo: Repo = "none";
  if (hasGit(folder)) {
    const r = git(folder, ["rev-parse", "--show-toplevel"]);
    const top = r.out.toString("utf8").split("\n")[0]!;
    repo = r.code === 0 && top !== "" && within(folder, top) ? { top } : "unknown";
  }
  repos.set(folder, repo);
  return repo;
}

/** `path` is `folder` or in it. */
const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/** The real folder of the working directory, and its repo. */
let realCwd: string | undefined;
try {
  realCwd = realpathSync(cwd);
} catch {
  realCwd = undefined;
}
const cwdRepo: Repo = realCwd === undefined ? "unknown" : repoOf(realCwd);

/** The index entry of `rel` in `top`, stage 0: its mode and object id. `"conflict"` for a path with
 * only the stages of a merge, `undefined` for a path the index does not have. */
function indexEntry(top: string, rel: string): { mode: string; id: string } | "conflict" | "error" | undefined {
  const r = git(top, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", `./${rel}`]);
  if (r.code !== 0) return "error";
  let conflict = false;
  for (const record of r.out.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.slice(tab + 1) !== rel) continue;
    const [mode, id, stage] = record.slice(0, tab).split(" ");
    if (stage === "0") return { mode: mode!, id: id! };
    conflict = true;
  }
  return conflict ? "conflict" : undefined;
}

/** The text of a blob, as pi reads a file: UTF-8, with no byte order mark. */
function blob(top: string, id: string): string | undefined {
  const r = git(top, ["cat-file", "blob", id]);
  return r.code === 0 ? r.out.toString("utf8").replace(/^\uFEFF/, "") : undefined;
}

/** The work tree's text, or `undefined` when the file cannot be read now. */
function text(work: () => string): string | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

/**
 * What loads for the file at `path`, whose work-tree text is `work()`: the index's text for a
 * tracked file, the work tree's for a file that git neither tracks nor ignores, or `undefined` (left
 * out). `follow`: a link at `path` may be judged once more at the real path that it names.
 */
function judge(path: string, work: () => string, follow = true): string | undefined {
  if (cwdRepo === "none") return text(work);
  let real: string;
  try {
    real = join(realpathSync(dirname(path)), basename(path));
  } catch {
    return undefined;
  }
  let repo: Repo = cwdRepo;
  if (repo !== "unknown" && !within(real, repo.top)) {
    // Only a folder above the top, which the bound can reach, has a repo of its own here.
    repo = within(repo.top, dirname(real)) ? repoOf(dirname(real)) : "unknown";
    if (repo === "none") return text(work);
  }
  if (repo === "unknown") return undefined;
  const top = repo.top;
  const rel = relative(top, real);
  const entry = indexEntry(top, rel);
  if (entry === "error" || entry === "conflict") return undefined;
  if (entry !== undefined) {
    if (entry.mode === "100644" || entry.mode === "100755") return blob(top, entry.id);
    if (entry.mode !== "120000" || !follow) return undefined;
    // A tracked link: the file that the index's link names, as the index has it.
    const target = blob(top, entry.id);
    if (target === undefined || target.startsWith("/")) return undefined;
    const named = posix.normalize(posix.join(posix.dirname(rel), target));
    if (named.startsWith("../") || named === "..") return undefined;
    const file = join(top, named);
    return judge(file, () => readText(file), false);
  }
  let link = false;
  try {
    link = lstatSync(real).isSymbolicLink();
  } catch {
    return undefined;
  }
  if (link) {
    if (!follow) return undefined;
    try {
      const file = realpathSync(real);
      return judge(file, () => readText(file), false);
    } catch {
      return undefined;
    }
  }
  // Not tracked: it loads when git does not ignore it. Exit 1 is "not ignored".
  return git(top, ["check-ignore", "-q", "--", `./${rel}`]).code === 1 ? text(work) : undefined;
}

/** pi's context file names in one folder, in its order (`loadContextFileFromDir`, at the pin): it
 * reads the first that is a file it can read. */
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

const inUserDir = (path: string): boolean => path.startsWith(`${agentDir}/`);

const readText = (path: string): string => readFileSync(path, "utf8").replace(/^\uFEFF/, "");

/**
 * The context file of `f`'s folder, as git shows it: `f`, or else the next name after it in pi's
 * order, as pi goes on after a file that it cannot read. So an ignored `AGENTS.override.md` does
 * not hide the repo's own `AGENTS.md` beside it.
 */
function shown(f: { path: string; content: string }): { path: string; content: string } | undefined {
  if (inUserDir(f.path)) return f;
  const content = judge(f.path, () => f.content);
  if (content !== undefined) return { path: f.path, content };
  const dir = dirname(f.path);
  for (const name of CONTEXT_NAMES.slice(CONTEXT_NAMES.indexOf(basename(f.path)) + 1)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const next = judge(path, () => readText(path));
      if (next !== undefined) return { path, content: next };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** `skill` with its name and description from the text that git shows, by pi's rules
 * (`loadSkillFromFile`, at the pin), or `undefined` when that text is no skill. */
function shownSkill(skill: Skill): Skill | undefined {
  if (inUserDir(skill.filePath)) return skill;
  const text = judge(skill.filePath, () => readText(skill.filePath));
  if (text === undefined) return undefined;
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(text).frontmatter as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const { description, name } = frontmatter;
  if (typeof description !== "string" || description.trim() === "") return undefined;
  return {
    ...skill,
    name: typeof name === "string" && name !== "" ? name : basename(dirname(skill.filePath)),
    description,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

const files = loadProjectContextFiles({ cwd, agentDir }).flatMap((f) => shown(f) ?? []);
const { skills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
const kept = skills.flatMap((skill) => shownSkill(skill) ?? []);
process.stdout.write(`${JSON.stringify({ files, skills: formatSkillsForPrompt(kept, "read") })}\n`);
