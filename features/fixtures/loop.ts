// An e2e fixture workflow that never reaches a final state — it sits in `working` indefinitely. Dropped
// into a scaffolded instance's `workflows/` so a run can be observed WHILE still live (the `ping` scaffold
// settles instantly and leaves the live registry, so it can't exercise `jr2 runs`). Filename `loop.ts` →
// workflow "loop". Mirrors the unit-test `loop` machine, but as a real named-export assembled Machine
// (`export const machine` — ADR-0011).

import { setup } from "xstate";

export const machine = setup({
  types: {} as { context: Record<string, never>; input: { message?: string } },
}).createMachine({
  id: "loop",
  context: {},
  initial: "working",
  states: { working: {} },
});
