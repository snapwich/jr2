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

import { setup } from "xstate";
import { z } from "zod";
import { defineEvent, type EventFrom } from "@j2/agent-protocol";
import { agentRun, workspace } from "@j2/orchestrator";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });
export const events = [finish];

type Ws = { endpoint: string; workdir: string; repos: Record<string, string>; branch: string };
type BodyInput = { instanceId: string; workspace: Ws };

const body = setup({
  types: {} as {
    context: BodyInput;
    input: BodyInput;
    events:
      | EventFrom<typeof finish>
      | { type: "agent.offset"; instanceId: string; offset: string }
      | { type: "agent.fault"; instanceId: string; reason: string }
      | { type: "workspace.lost" };
  },
  actors: { agentRun },
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
        input: ({ context }) => ({
          agentName: "coder",
          instanceId: context.instanceId,
          endpoint: context.workspace.endpoint,
          workdir: context.workspace.workdir,
          tools: [finish.name],
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
