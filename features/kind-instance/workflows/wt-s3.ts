// S3: a coder, a detached reviewer in several rounds, a signed push of exactly the reviewed commit.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  push,
  readyOf,
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
const pass = defineEvent({ name: "pass", description: "The commit is good.", input: z.object({}) });
const revise = defineEvent({
  name: "revise",
  description: "Send the work back. Say what is wrong.",
  input: z.object({ notes: z.string() }),
});
// The Gate's two answers.
const approve = defineEvent({ name: "approve", description: "Push the branch.", input: z.object({}) });
const stop = defineEvent({ name: "stop", description: "End the run without a push.", input: z.object({}) });

const runInput = z.object({ prompt: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { reviewed?: string; notes?: string; pushed?: PushOutput; rounds: number };

const coderTree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;
const reviewTree = (context: BodyInput) => `${context.workspace.repos.app}/review` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished, pass, revise, approve, stop],
  actors: {
    coder: agent({
      model: "fake/model-x",
      instructions: "You fix failing tests. You change no test. You commit the fix.",
    }),
    reviewer: agent({
      model: "fake/model-x",
      workspace: "read",
      instructions: "You review one commit. You run the tests. You change nothing.",
    }),
    cut: worktree(),
    // Push signed copies of the commit that the reviewer read, with the key of the git.credentials entry.
    publish: push({ sign: true, pin: true }),
    fail: fail(),
  },
}).createMachine({
  id: "publish",
  context: ({ input }) => ({ ...input, rounds: 0 }),
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "coding" }, { target: "notCut" }],
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: context.notes ?? context.prompt,
          cwd: coderTree(context),
          continue: true,
        }),
      },
      on: { finished: "reading" },
    },
    // The cut is idempotent, so it also reads a Worktree: `head` is the tip of the recorded branch,
    // whatever HEAD the coder left.
    reading: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => event.output.outcome === "ready",
            target: "detaching",
            actions: assign({ reviewed: ({ event }) => readyOf(event.output).head }),
          },
          { target: "notCut" },
        ],
      },
    },
    // The same folder each round. The cut forces it to the commit and cleans it.
    detaching: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: reviewTree(context), detach: context.reviewed! }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "reviewing" }, { target: "notCut" }],
      },
    },
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({
          prompt: `Review commit ${context.reviewed}: it is checked out in your working directory.`,
          cwd: reviewTree(context),
        }),
      },
      on: {
        pass: "review",
        revise: {
          target: "coding",
          actions: assign({ notes: ({ event }) => event.notes, rounds: ({ context }) => context.rounds + 1 }),
        },
      },
    },
    // A person reads the reviewed commit, then answers.
    review: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { commit: context.reviewed, branch: context.branch } }) },
      on: { approve: "publishing", stop: "done" },
    },
    publishing: {
      invoke: {
        src: "publish",
        // The coder's Worktree, for the sync: after a signed push jr2 moves that branch to the copies.
        input: ({ context }) => ({ worktree: coderTree(context), sha: context.reviewed! }),
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
    notCut: { invoke: { src: "fail", input: { reason: "a Worktree was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
});
