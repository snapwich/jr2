// The Frame claim (ADR-0057/0062): the Briefing's Turn part states the working directory, so a
// model that writes a RELATIVE path lands it in the Worktree — the failure ADR-0057 opens with,
// inverted. One coder Turn, told to create a file by a bare name and to say nothing about where;
// then a Gate, because the Sandbox is what holds the answer and a final state would tear it down
// (parking is retention, ADR-0012). The step reads the pod, then sends `done`.
//
// Filename `workdir.ts` → workflow "workdir".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  workspace,
  isReady,
  worktree,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
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
  actors: { cut: worktree(), coder: agent(coder), fail: fail() },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "cutting",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: { path: "/work/app/model-e2e", branch: "model-e2e" },
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "writing" }, { target: "notCut" }],
      },
    },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    writing: {
      invoke: {
        src: "coder",
        // The Frame states the Worktree, and the prompt does not (ADR-0057): the claim is that the
        // model learns where it works from the Briefing, so the prompt must not say it.
        input: ({ context }) => ({
          cwd: "/work/app/model-e2e",
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
          meta: { worktree: "/work/app/model-e2e", marker: context.marker, path: context.path },
        }),
      },
      on: { done: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
    lost: {
      invoke: {
        src: "fail",
        input: { reason: "the Sandbox was lost", detail: { outcome: "lost" } },
      },
    },
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

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  // A fixed branch is safe: nothing is pushed, and every trial cuts it in a pod of its own.
});
