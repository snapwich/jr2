// An e2e fixture with two Gates open at once in one run (ADR-0011, ADR-0078): `legal` and
// `security`, each in its own region of a parallel state, each with an authored invoke id, which is
// the Gate's name in a Caller's per-Gate `answer` scope. Each Gate takes its own event, so one
// answer moves one region, and the run ends when both are answered. No Agent: nothing here needs a
// Harness. Filename `signoff.ts` → workflow "signoff".

import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

const clear = defineEvent({ name: "clear", description: "Legal clears the change.", input: z.object({}) });
const pass = defineEvent({ name: "pass", description: "Security passes the change.", input: z.object({}) });

export const machine = jr2Setup({
  types: {} as { context: { secret: string }; input: { change?: string } },
  events: [clear, pass],
}).createMachine({
  id: "signoff",
  // The context is the run's own: the Gate inbox never carries it (ADR-0014).
  context: { secret: "s3cret" },
  initial: "review",
  states: {
    review: {
      type: "parallel",
      states: {
        legal: {
          initial: "open",
          states: {
            open: {
              invoke: {
                id: "legal",
                src: "gate",
                input: { gate: "L-1", accepts: [clear.name], meta: { team: "legal" } },
              },
              on: { clear: "done" },
            },
            done: { type: "final" },
          },
        },
        security: {
          initial: "open",
          states: {
            open: {
              invoke: { id: "security", src: "gate", input: { gate: "S-1", accepts: [pass.name] } },
              on: { pass: "done" },
            },
            done: { type: "final" },
          },
        },
      },
      onDone: "done",
    },
    done: { type: "final" },
  },
});
