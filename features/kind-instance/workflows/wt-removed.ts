// The removal recipe of the docs, in a real Harness: a `command` at `/work/<slot>/default` runs
// `git worktree remove`, a second cut makes the same path again, and a push publishes the branch.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  arg,
  command,
  defineEvent,
  fail,
  jr2Setup,
  push,
  workspace,
  worktree,
  type CommandOutput,
  type PushOutput,
  type Workspaced,
  type WorktreeOutput,
} from "@jr2/orchestrator";

const finished = defineEvent({ name: "finished", description: "The work is committed.", input: z.object({}) });

const door = z.object({ branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type BodyContext = BodyInput & { removed?: CommandOutput; again?: WorktreeOutput; pushed?: PushOutput };

const tree = (context: BodyInput) => `${context.workspace.repos.app}/run` as const;
const clone = (context: BodyInput) => `${context.workspace.repos.app}/default` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyContext; output: Omit<BodyContext, keyof BodyInput> },
  events: [finished],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You commit your work on the branch." }),
    cut: worktree(),
    remove: command(["git", "worktree", "remove", arg("path")], { timeout: "1m" }),
    publish: push(),
    fail: fail(),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  output: ({ context }) => ({ removed: context.removed, again: context.again, pushed: context.pushed }),
  on: { "workspace.lost": ".lost", "agent.fault": ".faulted" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: { src: "coder", input: ({ context }) => ({ prompt: "Commit your work.", cwd: tree(context) }) },
      on: { finished: "removing" },
    },
    removing: {
      invoke: {
        src: "remove",
        input: ({ context }) => ({ path: tree(context), worktree: clone(context) }),
        onDone: { target: "cuttingAgain", actions: assign({ removed: ({ event }) => event.output }) },
      },
    },
    cuttingAgain: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: { target: "publishing", actions: assign({ again: ({ event }) => event.output }) },
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: tree(context) }),
        onDone: { target: "done", actions: assign({ pushed: ({ event }) => event.output }) },
      },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    faulted: { invoke: { src: "fail", input: { reason: "the Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: door,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
});
