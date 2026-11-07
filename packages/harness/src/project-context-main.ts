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
// A context file or a skill of the walk that git ignores is left out (ADR-0062): an ignored file is
// in no diff and in no `git status`, so a reviewer would not see text that an Agent put in its
// system prompt. git decides, as the Agents' own git does: the env of git here is the domain's git
// config (`JR2_CONTEXT_GIT_ENV`: its HOME, so its global excludes, and its system file), never the
// Harness's. A file in a folder that is in no repo is in no diff anyway, and loads. When git cannot
// say (an error, or a `core.worktree` that puts the file outside git's own folder), the file is
// left out. The image user's folder is the image's, and is not asked about.
//
// First, before any other module runs: node looks for modules in jr2's folders alone, as in the
// Harness (`module-paths.ts`). The Harness starts this child with HOME=/run/jr2/home.
import "./module-paths-guard.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";

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

/** git's env: the domain's git config names, from the Harness (`JR2_CONTEXT_GIT_ENV`), and a PATH of
 * the image's own folders, as jr2's sync has it. */
const gitEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  ...(JSON.parse(process.env.JR2_CONTEXT_GIT_ENV || "{}") as Record<string, string>),
};

/** git in `dir`: its exit code (null when it did not run) and its first line out. */
function git(dir: string, args: string[]): { code: number | null; out: string; err: string; missing: boolean } {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], {
    env: gitEnv,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { code: r.status, out: (r.stdout ?? "").split("\n")[0] ?? "", err: r.stderr ?? "", missing };
}

/** True when git ignores `path`, or cannot say; false when it does not, or `path` is in no repo. */
function ignored(path: string): boolean {
  const dir = dirname(path);
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return false;
  if (top.code !== 0) return !/not a git repository/.test(top.err);
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return true;
  }
  if (real !== top.out && !real.startsWith(`${top.out}/`)) return true;
  const check = git(dir, ["check-ignore", "-q", "--", basename(path)]);
  return check.code !== 1;
}

/** pi's context file names in one folder, in its order (`loadContextFileFromDir`, at the pin): it
 * reads the first that is a file it can read. */
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

const inUserDir = (path: string): boolean => path.startsWith(`${agentDir}/`);

/**
 * The context file of `f`'s folder that is not ignored: `f`, or else the next name after it in pi's
 * order, as pi goes on after a file that it cannot read. So an ignored `AGENTS.override.md` does
 * not hide the repo's own `AGENTS.md` beside it.
 */
function notIgnored(f: { path: string; content: string }): { path: string; content: string } | undefined {
  if (inUserDir(f.path) || !ignored(f.path)) return { path: f.path, content: f.content };
  const dir = dirname(f.path);
  for (const name of CONTEXT_NAMES.slice(CONTEXT_NAMES.indexOf(basename(f.path)) + 1)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile() || ignored(path)) continue;
      return { path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") };
    } catch {
      continue;
    }
  }
  return undefined;
}

const files = loadProjectContextFiles({ cwd, agentDir }).flatMap((f) => notIgnored(f) ?? []);
const { skills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
const kept = skills.filter((skill) => inUserDir(skill.filePath) || !ignored(skill.filePath));
process.stdout.write(`${JSON.stringify({ files, skills: formatSkillsForPrompt(kept, "read") })}\n`);
