// The Frame claim (ADR-0057/0062): the Briefing's Turn part states the working directory, so a
// model that writes a RELATIVE path lands it in the Worktree — the failure ADR-0057 opens with,
// inverted. One coder Turn, told to create a file by a bare name and to say nothing about where;
// then a Gate, because the Sandbox is what holds the answer and a final state would tear it down
// (parking is retention, ADR-0012). The step reads the pod, then sends `done`.
//
// Filename `workdir.ts` → workflow "workdir".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const wrote = defineEvent({
  name: "wrote",
  description: "The file exists. Say the path you wrote it at.",
  audience: "agent",
  input: z.object({ path: z.string() }),
});
const done = defineEvent({ name: "done", audience: "external", input: z.object({}) });

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  /** The bare file name the Turn is told to create — unique per trial, so the pod scan finds
   * this trial's file and nothing older. */
  marker: z.string(),
});

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { path?: string; fault?: string };

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [wrote, done],
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "writing",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    writing: {
      invoke: {
        src: "coder",
        // No `cwd`: one Repo Slot, so the actor frames `app`'s Worktree itself (ADR-0057) — the
        // claim is that the model learns it from the Briefing, so the prompt must not say it.
        input: ({ context }) => ({
          prompt:
            `Create a file named \`${context.marker}.txt\` containing the single line \`hello\`. ` +
            `Then call \`wrote\` with the path you wrote it at.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        wrote: { target: "inspecting", actions: assign({ path: ({ event }) => event.path }) },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    // The inspection window: the step scans the pod for the marker while the Sandbox is alive.
    inspecting: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: { worktree: context.workspace.repos.app, marker: context.marker, path: context.path },
        }),
      },
      on: { done: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
    lost: { type: "final", output: { outcome: "lost" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  // A fixed branch is safe: nothing is pushed, and every trial cuts it in a pod of its own.
  spec: () => ({ branch: "model-e2e" }),
});
