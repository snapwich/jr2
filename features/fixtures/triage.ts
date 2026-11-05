// An e2e fixture (ADR-0017): the callee of the `alerts` standing Pool. It parks on its `finish`
// Gate until a step answers it, so a step can see it live and end it. Filename `triage.ts` →
// workflow "triage".

import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

const finish = defineEvent({ name: "finish", input: z.object({}) });
const door = z.object({ issue: z.string(), title: z.string() });

export const machine = jr2Setup({
  types: {} as { context: { issue: string }; input: z.infer<typeof door> },
  events: [finish],
}).createMachine({
  id: "triage",
  input: door,
  context: ({ input }) => ({ issue: input.issue }),
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: { gate: "finish" } }, on: { finish: "done" } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ issue: context.issue }),
});
