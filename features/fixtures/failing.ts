// An e2e fixture workflow that fails its run (ADR-0073): its one state invokes `fail`, and no state
// catches the Failure, so the run ends `failed` with the reason and the detail as its output, and
// `jr2 run` exits 1. It has no Agent and no Workspace, so it runs with no harness. Filename
// `failing.ts` → workflow "failing".

import { fail, jr2Setup } from "@jr2/orchestrator";

export const machine = jr2Setup({ actors: { fail: fail() } }).createMachine({
  id: "failing",
  initial: "checking",
  states: {
    // Not a final state: a final state means `done`, and this check did not pass.
    checking: { invoke: { src: "fail", input: { reason: "the check did not pass", detail: { failed: 2 } } } },
  },
});
