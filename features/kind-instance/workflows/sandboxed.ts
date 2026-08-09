// The kind tier's workflow (ADR-0012): a REAL workspace() — a real Sandbox, the instance's repos
// volume, a real worktree, and a real Harness endpoint the body's agent is admitted against. The
// body is deliberately thin: what the tier proves is the WRAPPER's contract with the cluster
// (provision → attach → run → destroy) plus its two durability claims (re-attach on restore;
// `workspace.lost` when the Sandbox was reaped while the orchestrator was down).
//
// The agent's instance id is the RUN's instanceId — the same iid `j2 status` reports — so the
// mechanics-tier steps (which play the agent over `/mcp/<iid>`) drive this workflow unchanged.
//
// The two final states carry DISTINCT outputs, and the root `output` forwards whichever settled
// the body: that is what lets a scenario assert which path was taken (finished vs lost) rather
// than infer it from the run merely being done.

import { z } from "zod";
import { defineEvent, j2Setup, workspace } from "@j2/orchestrator";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

type Ws = { workdir: string; repos: Record<string, string>; branch: string };
type BodyInput = { instanceId: string; workspace: Ws };

const body = j2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [finish],
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  // The wrapper emits, the body decides (ADR-0012). Our Sandbox is gone: the pod-local clone and
  // any unpushed commits went with it, so settle as `lost` rather than pretend we can resume.
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    coding: {
      invoke: {
        src: "agentRun",
        // No endpoint, no sandbox: both resolve AMBIENTLY from the enclosing workspace()
        // (ADR-0016) — and the registration records that Sandbox as its ADR-0013 token scope,
        // so only this pod's Adapter can deliver into this turn. Unforgettable by construction.
        input: ({ context }) => ({
          agentName: "coder",
          instanceId: context.instanceId,
          tools: [finish.name],
          // A plain prompt. The pod runs the STOCK Harness (ADR-0038), so what parks the Machine
          // here is the scripted MODEL: it holds the turn's provider request until the scenario
          // releases it with a tool call — exactly what an Agent that is still thinking looks like.
          prompt: "implement the thing",
        }),
      },
      on: { finish: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
    lost: { type: "final", output: { outcome: "lost" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, () => ({
  repos: [{ name: "app", baseRef: "main" }],
  branch: "feat-e2e",
}));
