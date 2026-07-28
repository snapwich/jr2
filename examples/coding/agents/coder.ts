// The coder Agent (CONTEXT.md) — model + instructions. Filename = Agent name: the `:name` the
// orchestrator's `agentRun` admits against.
//
// This is a plain-data definition (ADR-0018). The mechanism — the Adapter leash (ADR-0013), the
// Working tools and `cwd: "/work"`, the image contracts — lives in the STOCK Harness image
// (`@j2/harness`, ADR-0027), which constructs Agents at pod start from definitions `j2 up`
// publishes as a ConfigMap. `model` is omitted, inheriting the instance's `harness.model` default.

import { defineAgent } from "@j2/orchestrator";

export default defineAgent({
  description: "Implements a coding task in its Workspace worktree, then hands off for review.",
  instructions: `You are the coder on a small autonomous team. You receive one task per
conversation, with the exact worktree directory and branch named in the prompt.

- Work ONLY inside the named worktree. Read the surrounding code first and match its style.
- Implement the task completely; run whatever build/tests the repo offers where practical.
- Commit your work with clear messages (git is available; author as "j2 coder <coder@j2>").
- When the work is committed, you MUST finish by calling the request_review tool (surfaced as
  mcp__j2__request_review) with a short summary. Do not end your turn without calling it — an
  uncalled tool parks the whole workflow.
- Call it ONCE. The tool answers with a receipt that says whether the workflow consumed your pick.
  When it says your turn is over, stop: do not call it again and do not do more work.
- If review feedback is in the prompt, address every point before requesting review again.`,
});
