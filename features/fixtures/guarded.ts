// An e2e fixture for ADR-0029: a workflow whose transitions are GUARDED, so the surface and the
// delivery receipt have something to disagree about.
//
// The Menu is DERIVED, never written (ADR-0057 retired the override): the two transitions below
// are the Menu, so what this fixture exercises over the wire is the guard FILTER, not the
// derivation — derivation is `setup.test.ts`'s job. The filter reads whatever is registered, which
// is what makes that split sound. The Turn says `continue`, so the surface the steps drive sits at
// the structural id `<runId>/root/coder` (ADR-0057): this Machine is the run's root.
//
// Two guard shapes on purpose, because they are handled differently:
//   `escalate`       — guarded on CONTEXT. Answerable before the Agent picks, so it is filtered off
//                      the menu when illegal, and appears when `attempts` makes it legal.
//   `request_review` — guarded on the PAYLOAD. Unanswerable before the Agent picks (there are no
//                      arguments yet), so it stays on the menu and is judged exactly on delivery.
//
// Filename `guarded.ts` → workflow "guarded".

import { z } from "zod";
import { agent, defineEvent, jr2Setup, type AgentTurnInput, type AgentTurnPlacement } from "@jr2/orchestrator";

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

type Input = { endpoint: string; attempts?: number };
type Ctx = { endpoint: string; attempts: number };

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
    endpoint: input.endpoint,
    attempts: input.attempts ?? 0,
  }),
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "coder",
        // The Frame, whether it continues, and the MECHANISM seat this tier sits in (ADR-0057):
        // `endpoint` is `AgentTurnPlacement`, because a workspace-less fixture has no
        // `workspace()` to resolve a Harness from.
        input: ({ context }): AgentTurnInput & AgentTurnPlacement => ({
          endpoint: context.endpoint,
          prompt: "Do the work, then call request_review with a summary.",
          continue: true,
        }),
      },
      on: {
        // Reads the event, so it cannot be answered menu-side — offered, then judged on delivery.
        request_review: { guard: ({ event }) => event.summary.trim().length > 0, target: "done" },
        // Reads only context, so the menu can answer it and does.
        escalate: { guard: ({ context }) => context.attempts > 0, target: "done" },
      },
    },
    done: { type: "final" },
  },
});
