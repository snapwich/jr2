// An e2e fixture exercising the ADR-0011 mechanics tier end to end, with NO cluster: a
// workspace-less workflow whose Agent admits against the e2e tier's stub Harness (the
// endpoint arrives in run input — an endpoint is just a URL), parks, and is then driven from
// outside — the AGENT played over MCP (`/mcp/<iid>`), the HUMAN played over the gates API
// (`POST /runs/:id/gates/review-1/events`). Filename `review.ts` → workflow "review".
//
// Module contract (ADR-0011/0015): `export const machine`, authored via jr2Setup — the vocabulary
// rides the machine, `gate` is pre-registered and the Agent is a slot, mechanism events are in
// the union.

import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the work off for review.",
  input: z.object({ summary: z.string() }),
});
const approve = defineEvent({ name: "approve", input: z.object({}) });

type Input = { instanceId: string; endpoint: string };
type Ctx = { instanceId: string; endpoint: string; summary?: string };

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
  context: ({ input }) => ({ instanceId: input.instanceId, endpoint: input.endpoint }),
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          instanceId: context.instanceId,
          endpoint: context.endpoint,
          prompt: "Do the work, then call request_review.",
          tools: [requestReview.name],
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
