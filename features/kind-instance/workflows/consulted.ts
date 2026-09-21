// The kind tier's DEFINITION-WINS workflow (ADR-0031): `sandboxed`'s Workspace and Binding, with
// a Menu-only Agent invoked INSIDE the workspace() before the coder's turn. Nearest-wins would put
// the advisor's Turn on this run's Sandbox — the enclosing Workspace's Harness — and a continued
// advisor would then land on a different server per Workspace, silent amnesia. Definition-wins
// puts it on the Instance Harness regardless, and this workflow is where that is observable: the
// run HAS a Sandbox, and the advisor's conversation is not on it.
//
// Both Turns say `continue`, so each Agent has exactly ONE conversation in this Machine instance
// and its id carries the Agent's own name (ADR-0057) — so the two never meet, whichever Harness
// holds them. That is the point: the advisor's is on the Instance Harness and the coder's is on
// the Sandbox, and the steps address both by the same derivation.

import { z } from "zod";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { advisor, coder } from "./_agents.ts";

const advise = defineEvent({ name: "advise", input: z.object({ summary: z.string() }) });
const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

type BodyInput = Workspaced<HostInjectedInput, "app">;

const body = jr2Setup({
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
        // off the slot's own definition, and it wins over the ambient handles (ADR-0031). It frames
        // no `cwd` either — a Menu-only Agent has no Working tools to root (ADR-0028/0057).
        input: () => ({
          prompt: "what should the coder do?",
          continue: true,
        }),
      },
      on: { advise: { target: "coding" } },
    },
    coding: {
      invoke: {
        src: "coder",
        // Ambient (ADR-0016): the enclosing workspace()'s Sandbox — the nearest-wins case the
        // advisor above is the exception to. The one Repo Slot's Worktree is the Frame's `cwd`,
        // resolved by the actor because there is nothing to privilege (ADR-0057).
        input: () => ({
          prompt: "implement the advice",
          continue: true,
        }),
      },
      on: { finish: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
});
