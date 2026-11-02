import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  isReady,
  jr2Setup,
  push,
  workspace,
  worktree,
  type PushOutput,
  type Workspaced,
} from "@jr2/orchestrator";

const finished = defineEvent({
  name: "finished",
  description: "Call this when the tests pass and you committed the fix.",
  input: z.object({}),
});
// The Gate's two answers.
const approve = defineEvent({ name: "approve", description: "Push the branch.", input: z.object({}) });
const stop = defineEvent({ name: "stop", description: "End the run without a push.", input: z.object({}) });

const runInput = z.object({ prompt: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { pushed?: PushOutput };

// The Worktree of the coder. The push names it, and jr2 reads its branch from the cut.
const fixTree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished, approve, stop],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You fix failing tests. You change no test. You commit the fix.",
    }),
    cut: worktree(),
    // Push signed copies of the Agent's commits, with the key of the git.credentials entry.
    publish: push({ sign: true }),
    fail: fail(),
  },
}).createMachine({
  id: "publish",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    // The Workspace only clones. The Machine cuts the Worktree that the Agent works in.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: fixTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "coding" }, { target: "notCut" }],
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: fixTree(context) }),
      },
      on: { finished: "review" },
    },
    // A person reads the branch, then answers.
    review: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { branch: context.branch } }) },
      on: { approve: "publishing", stop: "done" },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: fixTree(context) }),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "pushed", target: "done" },
          // rejected, diverged or unknown: the run waits, so that the Sandbox and its commits stay.
          { target: "notPushed", actions: assign({ pushed: ({ event }) => event.output }) },
        ],
      },
    },
    notPushed: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { pushed: context.pushed } }) },
      on: { approve: "publishing", stop: "done" },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
});
