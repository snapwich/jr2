// The kind tier's DEFINITION-WINS workflow (ADR-0031): `sandboxed`'s Workspace and Binding, with
// a Menu-only Agent invoked INSIDE the workspace() before the coder's turn. Nearest-wins would put
// the advisor's Turn on this run's Sandbox — the enclosing Workspace's Harness — and a continued
// advisor would then land on a different server per Workspace, silent amnesia. Definition-wins
// puts it on the Instance Harness regardless, and this workflow is where that is observable: the
// run HAS a Sandbox, and the advisor's conversation is not on it.
//
// Both Agents run under the run's instance id (`j2 status` reports it): one conversation per
// (agent, Harness), so the two never meet — the point.

import { z } from "zod";
import { agent, defineEvent, j2Setup, workspace, type HostInjectedInput, type Workspaced } from "@j2/orchestrator";
import { advisor, coder } from "./_agents.ts";

const advise = defineEvent({ name: "advise", input: z.object({ summary: z.string() }) });
const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

type BodyInput = Workspaced<HostInjectedInput, "app">;

const body = j2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [advise, finish],
  actors: { advisor: agent(advisor), coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "consulting",
  states: {
    consulting: {
      invoke: {
        src: "advisor",
        // Inside a workspace(), and STILL on the Instance Harness: `workspace: "none"` is read
        // off the slot's own definition, and it wins over the ambient handles (ADR-0031).
        input: ({ context }) => ({
          instanceId: context.instanceId,
          tools: [advise.name],
          prompt: "what should the coder do?",
        }),
      },
      on: { advise: { target: "coding" } },
    },
    coding: {
      invoke: {
        src: "coder",
        // Ambient (ADR-0016): the enclosing workspace()'s Sandbox — the nearest-wins case the
        // advisor above is the exception to.
        input: ({ context }) => ({
          instanceId: context.instanceId,
          tools: [finish.name],
          prompt: "implement the advice",
        }),
      },
      on: { finish: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.j2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
});
