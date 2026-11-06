// The MCP claim (ADR-0079, ADR-0062): a Menu-only Agent with one MCP tool calls it, reads its
// answer, and then makes its pick. The Briefing's standing part says that a call of an MCP tool is
// not a pick and does not end the Turn. The task needs the tool's answer: the prompt names an
// order, and only the order system knows its payment status, which the step sets for each trial on
// the fake server. The tier reads the order of the calls off the Instance Harness's printed
// conversation (ADR-0023): `orders/lookup_order`, then `ship` or `hold`.
//
// Filename `mcp-then-pick.ts` → workflow "mcp-then-pick".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { clerk } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const ship = defineEvent({
  name: "ship",
  description: "Release the order to the warehouse for shipping today.",
  input: z.object({ note: z.string() }),
});
const hold = defineEvent({
  name: "hold",
  description: "Keep the order back, and tell the customer why.",
  input: z.object({ reason: z.string() }),
});

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
  order: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
type Ctx = Input & { said?: string; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [ship, hold],
  actors: { clerk: agent(clerk), fail: fail() },
}).createMachine({
  id: "mcp-then-pick",
  input: door,
  context: ({ input }) => input,
  initial: "handling",
  states: {
    handling: {
      invoke: {
        src: "clerk",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] A customer asks whether order ${context.order} can ship today. Look up the ` +
            `order in the order system. If its payment status is "paid", ship it with \`ship\`. If not, ` +
            `keep it back with \`hold\` and give the reason.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        ship: { target: "shipped", actions: assign({ said: ({ event }) => event.note }) },
        hold: { target: "held", actions: assign({ said: ({ event }) => event.reason }) },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    shipped: { type: "final", output: ({ context }) => ({ outcome: "shipped", said: context.said }) },
    held: { type: "final", output: ({ context }) => ({ outcome: "held", said: context.said }) },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
