// The @kind tier's one Agent (ADR-0018/0049). A definition is plain data a MACHINE carries: both
// fixture workflows (`sandboxed`, `handoff`) declare it as their `coder` slot, so the name the
// Harness routes on (`/agents/coder/<iid>`, which the kind steps read history from) is the slot
// key and nothing else names it.
//
// It is REQUIRED, not decoration: the pod runs the stock Harness (ADR-0038), which needs a
// definition for the name it is admitted under, and `j2 up`'s provider preflight probes exactly
// the models the definitions name — so this is also what makes the converge exercise the fake
// endpoint.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.
//
// The instructions are honest prose rather than a script. What this Agent does on a turn is
// decided by the scripted MODEL (`features/steps/fake-provider.ts`), which parks until a scenario
// releases it — a real Agent that is still thinking, from the Machine's side.

import type { AgentDefinition } from "@j2/orchestrator";

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
  mcp__j2__<name>). Do not end your turn without calling one — an uncalled tool parks the
  whole workflow.`,
} satisfies AgentDefinition;
