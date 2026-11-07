// The child that loads an Agent's project context (ADR-0062, `project-context.ts`): pi-coding-agent's
// `AGENTS.md`/`CLAUDE.md` walk from the Worktree up to `/`, and its skills in `<cwd>/.pi/skills`. It
// runs in the domain, started by the spawner, never in the Harness process: so each file that it
// reads, the kernel lets the domain read. A link from a Worktree's `AGENTS.md` to a file under
// `/run/jr2` fails here, at the open, and its content goes nowhere.
//
//   node project-context-main.ts <cwd>
//
// It writes ONE JSON line to stdout, `{"files":[{"path","content"}],"skills":"<text>"}`, and pi's
// warnings to stderr. The Harness reads the line as untrusted data.
//
// First, before any other module runs: node looks for modules in jr2's folders alone, as in the
// Harness (`module-paths.ts`). The Harness starts this child with HOME=/run/jr2/home.
import "./module-paths-guard.ts";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";

/**
 * pi's user-level folder (`~/.pi/agent`) for this load: a folder that does not exist, in the path
 * that the domain cannot reach. So no user-level context file and no user-level skill loads, only
 * what the Worktree and the folders above it hold.
 */
const NO_AGENT_DIR = "/run/jr2/no-agent-dir";

const cwd = process.argv[2];
if (cwd === undefined || cwd === "") {
  console.error("jr2 project context: no folder to load from");
  process.exit(2);
}
const files = loadProjectContextFiles({ cwd, agentDir: NO_AGENT_DIR }).map((f) => ({
  path: f.path,
  content: f.content,
}));
const { skills } = loadSkills({ cwd, agentDir: NO_AGENT_DIR, skillPaths: [], includeDefaults: true });
process.stdout.write(`${JSON.stringify({ files, skills: formatSkillsForPrompt(skills, "read") })}\n`);
