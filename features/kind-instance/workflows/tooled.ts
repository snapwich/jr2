// The kind tier's Agent-held MCP tools (ADR-0079): an Agent in a Sandbox names two servers of the
// `mcp` block, `lookup-a` and `lookup-b`, each with the one tool `lookup` allowlisted. The two are
// one fake server on the host (`features/steps/fake-mcp.ts`), and each has its own secret, bound to
// one host in one header. So the Sandbox's Custodian holds both values, the Harness container holds
// only their Stand-ins, and the Custodian chooses each value by the Stand-in that a call carries
// (ADR-0059). The scripted model calls each tool, reads each result, and then picks `finish`: an
// MCP call is no pick, and the Turn goes on after it.
//
// No Repo Slot (ADR-0051): the Workspace clones nothing, so the Sandbox is ready sooner.

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const door = z.object({ mode: z.enum(["agent"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type BodyInput = Workspaced<HostInjectedInput & z.infer<typeof door>, never>;
type BodyContext = BodyInput & { summary?: string };

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [finish],
  actors: {
    clerk: agent({
      ...coder,
      mcp: [
        { server: "lookup-a", tools: ["lookup"] },
        { server: "lookup-b", tools: ["lookup"] },
      ],
    }),
    fail: fail(),
  },
}).createMachine({
  id: "tooled",
  context: ({ input }) => input,
  initial: "working",
  on: { "workspace.lost": ".lost", "agent.fault": ".faulted" },
  states: {
    working: {
      invoke: { src: "clerk", input: { prompt: "look up the record in both services, then finish" } },
      on: { finish: { target: "settled", actions: assign({ summary: ({ event }) => event.summary }) } },
    },
    settled: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    faulted: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
  output: ({ context }: { context: BodyContext }) => ({ outcome: "finished", summary: context.summary }),
});

export const machine = workspace(body, { input: door });
