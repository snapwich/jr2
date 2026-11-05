// An e2e fixture (ADR-0017): the callee of the `issues` standing Pool. It parks on its `finish`
// Gate until a step answers it. Filename `ticket.ts` → workflow "ticket".

import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

const finish = defineEvent({ name: "finish", input: z.object({}) });
const door = z.object({ number: z.number(), title: z.string() });

export const machine = jr2Setup({
  types: {} as { context: { number: number }; input: z.infer<typeof door> },
  events: [finish],
}).createMachine({
  id: "ticket",
  input: door,
  context: ({ input }) => ({ number: input.number }),
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: { gate: "finish" } }, on: { finish: "done" } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ number: context.number }),
});
