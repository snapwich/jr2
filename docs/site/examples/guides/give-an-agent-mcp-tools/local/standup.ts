import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup } from "@jr2/orchestrator";

// The Agent's one pick. Each MCP tool call before it is not a pick, and the Turn goes on.
const posted = defineEvent({
  name: "posted",
  description: "Call this after you posted the summary. Give the link to your message.",
  input: z.object({ link: z.string().describe("The link to the message that you posted.") }),
});

const door = z.object({ day: z.string().describe("The day of the stand-up, such as 2026-11-04.") });

type Input = z.infer<typeof door>;
type Ctx = Input & { link?: string; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: { link: string } },
  events: [posted],
  actors: {
    reporter: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You read what two teams said at their stand-up, and you post one short summary for both teams.",
      // No Sandbox and no Working tools. Its Turns run on the Instance Harness.
      workspace: "none",
      // The servers of the mcp block of jr2.config.ts, by name, each with the tools that the Agent can call.
      mcp: [
        { server: "slack-acme", tools: ["read_channel", "post_message"] },
        // Only read: the Agent cannot post to the partner's workspace.
        { server: "slack-partner", tools: ["read_channel"] },
      ],
    }),
    fail: fail(),
  },
}).createMachine({
  id: "standup",
  input: door,
  context: ({ input }) => ({ day: input.day }),
  initial: "summarizing",
  states: {
    summarizing: {
      invoke: {
        src: "reporter",
        input: ({ context }) => ({
          prompt: `Read #standup in the Acme and the partner workspaces for ${context.day}. Post one summary to #standup of Acme.`,
        }),
      },
      on: {
        posted: { target: "done", actions: assign({ link: ({ event }) => event.link }) },
        // A server that does not answer at the first Turn fails the Turn. The reason names the server.
        "agent.fault": { target: "failed", actions: assign({ fault: ({ event }) => event.reason }) },
      },
    },
    done: { type: "final" },
    // Not a final state: the run ends `failed`, with the reason of the Turn.
    failed: { invoke: { src: "fail", input: ({ context }) => ({ reason: context.fault ?? "the Turn failed" }) } },
  },
  output: ({ context }) => ({ link: context.link ?? "" }),
});
