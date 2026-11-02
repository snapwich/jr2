// S9: a planner's Chart cuts a Worktree, a coder commits there, and a lent
// force push publishes it. The door's Chart field, a real Open body, a real Workspace.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  chartSchema,
  fail,
  jr2Setup,
  openBody,
  push,
  workspace,
  worktree,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const door = z.object({ chart: chartSchema });
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<Door, "app">;
type Ctx = BodyInput & { result?: unknown };

const body = jr2Setup({
  types: {} as { context: Ctx; input: BodyInput; output: unknown },
  events: [],
  actors: {
    coder: agent(coder),
    cut: worktree({ expect: "new" }),
    publish: push({ force: true }),
    fail: fail(),
    run: openBody({
      lends: { agents: ["coder"], effects: ["cut", "publish"], fail: true },
      allows: { models: [], workspace: ["write"] },
      ceilings: { turns: 5, wallClock: "30m", transitions: 200, fanOut: 2, size: 65536 },
    }),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input }),
  initial: "charted",
  on: { "workspace.lost": { target: ".lost" }, "agent.fault": { target: ".lost" } },
  states: {
    charted: {
      invoke: {
        id: "run",
        src: "run",
        input: ({ context }: { context: Ctx }) => ({ chart: context.chart }),
        onDone: {
          target: "done",
          actions: assign({ result: ({ event }: { event: { output: unknown } }) => event.output }),
        },
      },
    },
    done: { type: "final", output: ({ context }: { context: Ctx }) => context.result ?? null },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
  effector: { image: import.meta.resolve("../images/effector") },
});
