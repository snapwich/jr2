// An e2e fixture exercising the ADR-0011 mechanics tier end to end, with NO cluster: a
// workspace-less workflow whose Agent admits against the e2e tier's stub Harness (the
// endpoint arrives in run input — an endpoint is just a URL), parks, and is then driven from
// outside — the AGENT played over MCP (`/mcp/<iid>`), the HUMAN played over the gates API
// (`POST /runs/:id/gates/review-1/events`). Filename `review.ts` → workflow "review".
//
// Module contract (ADR-0011/0015): `export const machine`, authored via jr2Setup — the vocabulary
// rides the machine, `gate` is pre-registered and the Agent is a slot, mechanism events are in
// the union.
//
// The Turn says `continue`, which is the whole continuation surface (ADR-0057) and also what makes
// the conversation ADDRESSABLE from a step: jr2 mints the structural id
// `<runId>/<machine actor path>/<agent>`, and this Machine IS the run's root, so the steps drive
// `/agents/<runId>/root/coder/*`. A fresh Turn's id carries a random suffix nobody outside the
// Orchestrator ever sees.

import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup, type AgentTurnInput, type AgentTurnPlacement } from "@jr2/orchestrator";

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the work off for review.",
  input: z.object({ summary: z.string() }),
});
const approve = defineEvent({ name: "approve", input: z.object({}) });

type Input = { endpoint: string };
type Ctx = { endpoint: string; summary?: string };

/** The Agent this Machine carries (ADR-0049): a slot, so the name the Turn is admitted under is
 * the slot key. The definition's CONTENT is inert here — the tier's stub Harness never runs a
 * model — but a slot IS its definition, so it is stated. */
const coder = agent({
  model: "stub/model",
  instructions: "You are the coder. Do the work, then end your turn by calling one of your tools.",
});

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [requestReview, approve],
  actors: { coder },
}).createMachine({
  id: "review",
  context: ({ input }) => ({ endpoint: input.endpoint }),
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "coder",
        // The Frame, whether it continues, and — because this tier has no `workspace()` to
        // resolve from — the MECHANISM seat (ADR-0057): `endpoint` is `AgentTurnPlacement`, which
        // exists for exactly this fixture and no real run. No Menu is written: it derives from
        // this state's own transitions (ADR-0015), which is the `request_review` below.
        input: ({ context }): AgentTurnInput & AgentTurnPlacement => ({
          endpoint: context.endpoint,
          prompt: "Do the work, then call request_review.",
          continue: true,
        }),
      },
      on: {
        request_review: { target: "humanReview", actions: assign({ summary: ({ event }) => event.summary }) },
      },
    },
    humanReview: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          gate: "review-1",
          accepts: [approve.name],
          meta: { summary: context.summary },
        }),
      },
      on: { approve: "done" },
    },
    done: { type: "final" },
  },
});
