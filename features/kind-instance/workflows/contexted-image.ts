// The image user's context (ADR-0062): this Workspace's Sandbox Image has `~/.pi/agent`
// (`images/user-context`), with a context file, a skill, a skill that links to `auth.json`, and
// `auth.json`. `jr2 up` records the folder, and the pod mounts it again from the image, read-only,
// at its own path and at `/run/jr2/user-context`. The command, in the domain as each of the Agent's
// programs, writes the Worktree's CLAUDE.md, then tries to change the folder in four ways, and
// writes what each did to `/work/ctx-image-writes.txt`. Then it moves `~/.pi` away and puts a
// folder of its own at `~/.pi/agent`, with a context file that says CTX-FAKE-RULE, and leaves it
// there: `MOVED` when it could, else the error. An overlay file system without `redirect_dir`
// refuses the move of an image's folder (EXDEV). The reader then starts. See `_contexted.ts`.

import { workspace } from "@jr2/orchestrator";
import { contextedBody } from "./_contexted.ts";

/** Where the command writes what each try did: a line `WROTE: <op>` for one that changed the folder,
 * and the shell's error for one that did not. */
export const WRITES_FILE = "/work/ctx-image-writes.txt";

const SEED = [
  "printf '%s\\n' 'CTX-WORKTREE-RULE' > CLAUDE.md",
  `r=${WRITES_FILE}`,
  ': > "$r"',
  'd="$HOME/.pi/agent"',
  "for op in 'printf x > \"$d/AGENTS.md\"' 'mkdir \"$d/skills/evil\"' 'rm \"$d/auth.json\"' 'touch \"$d/new.md\"'; do",
  '  if (eval "$op") 2>>"$r"; then echo "WROTE: $op" >> "$r"; fi',
  "done",
  'echo "home:$HOME" >> "$r"',
  // One rename(2), as an Agent's program can do it: `mv` would copy on EXDEV.
  `if node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$HOME/.pi" "$HOME/.pi-moved" 2>>"$r" \\`,
  `  && mkdir -p "$d" && printf '%s\\n' CTX-FAKE-RULE > "$d/AGENTS.md"; then`,
  '  echo "MOVED" >> "$r"',
  "fi",
].join("\n");

export const machine = workspace(contextedBody(SEED), {
  image: import.meta.resolve("../images/user-context"),
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
});
