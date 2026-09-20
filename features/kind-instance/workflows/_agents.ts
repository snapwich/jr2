// The @kind tier's Agents (ADR-0018/0049). A definition is plain data a MACHINE carries: the
// fixture workflows declare `coder` as their `coder` slot, so the name the Harness routes on
// (`/agents/coder/<iid>`, which the kind steps read history from) is the slot key and nothing
// else names it.
//
// They are REQUIRED, not decoration: the pod runs the stock Harness (ADR-0038), which needs a
// definition for the name it is admitted under, and `jr2 up`'s provider preflight probes exactly
// the models the definitions name — so this is also what makes the converge exercise the fake
// endpoint.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.
//
// The instructions are honest prose rather than a script. What an Agent does on a turn is
// decided by the scripted MODEL (`features/steps/fake-provider.ts`), which parks until a scenario
// releases it — a real Agent that is still thinking, from the Machine's side.

import type { AgentDefinition } from "@jr2/orchestrator";

export const coder = {
  model: "fake/model-x",
  description: "The @kind tier's worker: works in its Workspace worktree and picks from its Menu.",
  // Explicit, though `/work` is also the default (ADR-0037): it is the worktree volume's root, and
  // every Working tool takes its cwd from HERE rather than from the Harness process's own — which
  // is why the image is free to put its WORKDIR wherever its author wants.
  cwd: "/work",
  instructions: `You are the worker on a small autonomous team. Each conversation names a
worktree and a branch to work in.

- Work only inside the named worktree; your Working tools run in that container.
- You MUST end your turn by calling exactly one of the tools your Menu offers (surfaced as
  mcp__jr2__<name>). Do not end your turn without calling one — an uncalled tool parks the
  whole workflow.`,
} satisfies AgentDefinition;

/**
 * The tier's MENU-ONLY Agent (ADR-0028/0031): `workspace: "none"` withholds the whole Working
 * toolset and places every Turn of it on the Instance Harness — the Deployment `jr2 up` converges
 * for this instance because this definition exists, and where the Turn lands even when the
 * Machine invoking it sits inside a `workspace()`. No `cwd`: nothing of its consumes one.
 */
export const advisor = {
  model: "fake/model-x",
  description: "The @kind tier's advisor: converses and picks from its Menu; touches no Workspace.",
  workspace: "none",
  instructions: `You advise a small autonomous team. You have no worktree and no tools but your
Menu.

- You MUST end your turn by calling exactly one of the tools your Menu offers (surfaced as
  mcp__jr2__<name>). Do not end your turn without calling one — an uncalled tool parks the
  whole workflow.`,
} satisfies AgentDefinition;
