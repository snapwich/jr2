// An e2e fixture exercising the ADR-0011 mechanics tier end to end, with NO cluster: a
// workspace-less workflow whose `agentRun` admits against the `j2 dev` stub Harness (the
// endpoint arrives in run input — an endpoint is just a URL), parks, and is then driven from
// outside — the AGENT played over MCP (`/mcp/<iid>`), the HUMAN played over the gates API
// (`POST /runs/:id/gates/review-1/events`). Filename `review.ts` → workflow "review".
//
// Module contract (ADR-0011): all named exports — `machine` + the `events` manifest.

import { setup, assign } from "xstate";
import { z } from "zod";
import { defineEvent, type EventFrom } from "@j2/agent-protocol";
import { agentRun, gate } from "@j2/orchestrator";

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the work off for review.",
  input: z.object({ summary: z.string() }),
});
const approve = defineEvent({ name: "approve", input: z.object({}) });

export const events = [requestReview, approve];

type Input = { instanceId: string; endpoint: string };
type Ctx = { instanceId: string; endpoint: string; offsets: Record<string, string>; summary?: string };

export const machine = setup({
  types: {} as {
    context: Ctx;
    input: Input;
    events:
      | EventFrom<typeof requestReview | typeof approve>
      | { type: "agent.offset"; instanceId: string; offset: string }
      | { type: "agent.fault"; instanceId: string; reason: string };
  },
  actors: { agentRun, gate },
}).createMachine({
  id: "review",
  context: ({ input }) => ({ instanceId: input.instanceId, endpoint: input.endpoint, offsets: {} }),
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({
          agentName: "coder",
          instanceId: context.instanceId,
          endpoint: context.endpoint,
          prompt: "Do the work, then call request_review.",
          tools: [requestReview.name],
        }),
      },
      on: {
        "agent.offset": {
          actions: assign({
            offsets: ({ context, event }) => ({ ...context.offsets, [event.instanceId]: event.offset }),
          }),
        },
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
