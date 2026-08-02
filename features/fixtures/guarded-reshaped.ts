// `guarded.ts` after an edit that changes its SHAPE (ADR-0030): the state a parked run is sitting
// in is renamed `working` → `implementing`. Same workflow name, same vocabulary, same everything a
// restore matches on today — which is the point. Installed OVER "guarded" by the drift scenario to
// play the one sequence that actually happens: edit a workflow, redeploy, meet the parked runs.

import { z } from "zod";
import { defineEvent, j2Setup } from "@j2/orchestrator";

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the work off for review. Needs a non-empty summary.",
  input: z.object({ summary: z.string() }),
});
const escalate = defineEvent({
  name: "escalate",
  description: "Give up and hand to a human. Only legal after an attempt.",
  input: z.object({ reason: z.string() }),
});

type Input = { instanceId: string; endpoint: string; attempts?: number };
type Ctx = { instanceId: string; endpoint: string; attempts: number };

export const machine = j2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [requestReview, escalate],
}).createMachine({
  id: "guarded",
  context: ({ input }) => ({
    instanceId: input.instanceId,
    endpoint: input.endpoint,
    attempts: input.attempts ?? 0,
  }),
  initial: "implementing",
  states: {
    implementing: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({
          agentName: "coder",
          instanceId: context.instanceId,
          endpoint: context.endpoint,
          prompt: "Do the work, then call request_review with a summary.",
          tools: [requestReview.name, escalate.name],
        }),
      },
      on: {
        request_review: { guard: ({ event }) => event.summary.trim().length > 0, target: "done" },
        escalate: { guard: ({ context }) => context.attempts > 0, target: "done" },
      },
    },
    done: { type: "final" },
  },
});
