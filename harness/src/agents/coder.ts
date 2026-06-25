// The `coder` Agent — a trivial worker persona for PoC #3.
//
// Served at `POST /agents/coder/<id>`. Uses the `local()` sandbox so its
// built-in file/command tools operate directly on the pod's filesystem — i.e.
// the worktree mounted at `cwd`. This is what proves co-location: the agent
// loop edits the same volume the Sandbox container holds.

import { defineAgent, type AgentRouteHandler } from "@flue/runtime";
import { local } from "@flue/runtime/node";

const MODEL = process.env.CODER_MODEL ?? "vllm/Qwen/Qwen3-Coder-Next-FP8";
const WORKTREE = process.env.WORKTREE_DIR ?? "/workspace";

// Exposes the Agent over HTTP at `POST /agents/coder/<id>` (and `GET` for the
// event stream). PoC #3 leaves access open; auth/authz is a later concern.
export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => ({
  model: MODEL,
  sandbox: local(),
  cwd: WORKTREE,
  instructions: [
    "You are a coding agent operating inside a worktree at the current working directory.",
    "Use your file and shell tools to inspect and edit files directly — do not just describe changes.",
    "When asked to modify a file, read it first, make the edit with your tools, then confirm what changed.",
    "Keep edits minimal and report the final file contents.",
  ].join(" "),
}));
