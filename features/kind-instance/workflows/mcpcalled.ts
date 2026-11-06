// The kind tier's Machine-held MCP call (ADR-0079): an `mcp` Effect in the Instance Effector, with
// no Agent and no Workspace. It calls the tool `lookup` of `lookup-a`, the fake server on the host
// (`features/steps/fake-mcp.ts`), with the run's marker as the query. The server's secret,
// `MCP_A_KEY`, is an Effect secret of the Instance Effector, which sends its value as the bearer;
// no Custodian is on this path. The run's output IS the Effect's: `returned`, with the tool's text
// and its `structuredContent`.

import { z } from "zod";
import { assign } from "xstate";
import { defineEvent, jr2Setup, mcp, type HostInjectedInput, type McpCallOutput } from "@jr2/orchestrator";

const door = z.object({ mode: z.enum(["call"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type Context = HostInjectedInput & Door & { output?: McpCallOutput };

const unused = defineEvent({ name: "noop", input: z.object({}) });

export const machine = jr2Setup({
  types: {} as { context: Context; input: HostInjectedInput & Door; output: McpCallOutput | { outcome: "none" } },
  events: [unused],
  actors: { lookup: mcp.call("lookup-a", "lookup", { input: z.object({ query: z.string() }) }) },
}).createMachine({
  id: "mcpcalled",
  input: door,
  context: ({ input }) => input,
  initial: "calling",
  on: { noop: ".settled" },
  states: {
    calling: {
      invoke: {
        src: "lookup",
        input: ({ context }) => ({ query: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }) => context.output ?? { outcome: "none" },
});
