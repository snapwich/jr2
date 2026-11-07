// No image user's context (ADR-0062): this Workspace's Sandbox Image has a `USER` and no
// `~/.pi/agent` (`images/user-home`), so the pod mounts none and tells the Harness none. The
// command, in the domain, makes that folder with a context file in it, in the user's own writable
// home. The reader must not read it. See `_contexted.ts`.

import { workspace } from "@jr2/orchestrator";
import { contextedBody } from "./_contexted.ts";

const SEED = [
  "printf '%s\\n' 'CTX-WORKTREE-RULE' > CLAUDE.md",
  'mkdir -p "$HOME/.pi/agent"',
  "printf '%s\\n' 'CTX-MADE-RULE' > \"$HOME/.pi/agent/AGENTS.md\"",
].join("\n");

export const machine = workspace(contextedBody(SEED), {
  image: import.meta.resolve("../images/user-home"),
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
});
