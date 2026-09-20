// `guarded.ts` after an edit that changes its SHAPE (ADR-0030): the state a parked run is sitting
// in is renamed `working` → `implementing`. Same workflow name, same vocabulary, same everything a
// restore matches on today — which is the point. Installed OVER "guarded" by the drift scenario to
// play the one sequence that actually happens: edit a workflow, redeploy, meet the parked runs.

import { z } from "zod";
import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";

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

/** The Agent this Machine carries (ADR-0049): a slot, so the name the Turn is admitted under is
 * the slot key. The definition's CONTENT is inert here — the tier's stub Harness never runs a
 * model — but a slot IS its definition, so it is stated. */
const coder = agent({
  model: "stub/model",
  instructions: "You are the coder. Do the work, then end your turn by calling one of your tools.",
});

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [requestReview, escalate],
  actors: { coder },
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
        src: "coder",
        input: ({ context }) => ({
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
