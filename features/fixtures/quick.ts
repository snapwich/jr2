// An e2e fixture (ADR-0017): the callee of the `burst` standing Pool. It ends by itself after
// 150 ms, so a burst drains with no step in the loop. Filename `quick.ts` → workflow "quick".

import { z } from "zod";
import { jr2Setup } from "@jr2/orchestrator";

const door = z.object({ issue: z.string() });

export const machine = jr2Setup({
  types: {} as { context: { issue: string }; input: z.infer<typeof door> },
}).createMachine({
  id: "quick",
  input: door,
  context: ({ input }) => ({ issue: input.issue }),
  initial: "working",
  states: {
    working: { after: { 150: "done" } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ issue: context.issue }),
});
