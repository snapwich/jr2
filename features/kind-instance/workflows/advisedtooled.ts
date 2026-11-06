// The kind tier's Menu-only Agent with an MCP tool (ADR-0079, ADR-0031): `advised`, but its
// advisor names `lookup-b` with the one tool `lookup` allowlisted. The Turn runs on the Instance
// Harness, which all Menu-only Agents share. So the Instance Harness's Custodian holds the value of
// `MCP_B_KEY`, the Harness container holds only its Stand-in, and the Custodian puts the value on
// the call (ADR-0059). The scripted model calls the tool, reads the result, and then picks
// `advise`: an MCP call is no pick.

import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";

const advise = defineEvent({ name: "advise", input: z.object({ summary: z.string() }) });

export const machine = jr2Setup({
  types: {} as { context: HostInjectedInput; input: HostInjectedInput },
  events: [advise],
  actors: {
    advisor: agent({ ...advisor, mcp: [{ server: "lookup-b", tools: ["lookup"] }] }),
    fail: fail(),
  },
}).createMachine({
  id: "advisedtooled",
  context: ({ input }) => input,
  on: { "agent.fault": { target: ".faulted" } },
  initial: "advising",
  states: {
    advising: {
      invoke: { src: "advisor", input: () => ({ prompt: "look up the record, then advise the team" }) },
      on: { advise: { target: "advised" } },
    },
    advised: { type: "final", output: { outcome: "advised" } },
    faulted: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
