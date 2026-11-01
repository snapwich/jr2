import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  arg,
  branchName,
  command,
  defineEvent,
  fail,
  isReady,
  jr2Setup,
  push,
  readyOf,
  workspace,
  worktree,
  type Workspaced,
} from "@jr2/orchestrator";

const finished = defineEvent({
  name: "finished",
  description: "Call this when you committed the fix.",
  input: z.object({}),
});
const pass = defineEvent({ name: "pass", description: "Call this when the commit is correct.", input: z.object({}) });
const revise = defineEvent({
  name: "revise",
  description: "Call this when the commit is not correct. Say what to change.",
  input: z.object({ notes: z.string() }),
});

// The run input. `branchName` refuses a name that the cut and the push refuse.
const runInput = z.object({ prompt: z.string(), branch: branchName });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { reviewed?: string };

// #region paths
// Your Machine names each folder. So it knows each path before the cut.
const coderTree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;
const reviewTree = (context: BodyInput) => `${context.workspace.repos.app}/review` as const;
const cloneTree = (context: BodyInput) => `${context.workspace.repos.app}/default` as const;
// #endregion paths

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished, pass, revise],
  actors: {
    coder: agent({ model: "anthropic/claude-haiku-5-5", instructions: "You fix the bug. You commit the fix." }),
    reviewer: agent({
      model: "anthropic/claude-haiku-5-5",
      workspace: "read",
      instructions: "You review one commit. You change nothing.",
    }),
    // #region cuts
    // Each run gets a new branch: the cut refuses a branch that exists.
    cut: worktree({ expect: "new" }),
    // #endregion cuts
    // #region remove
    // No `--force`: git refuses a Worktree with changes, and the output holds its exit code.
    // The state below goes on with either result: a Worktree that stays does no harm here.
    remove: command(["git", "worktree", "remove", arg("path")], { timeout: "1m" }),
    // #endregion remove
    publish: push({ pin: true }),
    fail: fail(),
  },
}).createMachine({
  id: "fix-a-bug",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    // #region cutting
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        // The last arm has no guard: it takes `refused`, `unknown` and each later outcome.
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "coding" }, { target: "notCut" }],
      },
    },
    // #endregion cutting
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: coderTree(context), continue: true }),
      },
      on: { finished: "reading" },
    },
    // #region reading
    // A cut of the same path reads the Worktree. `head` is the tip of the branch, whatever HEAD the coder left.
    reading: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => isReady(event.output),
            target: "detaching",
            actions: assign({ reviewed: ({ event }) => readyOf(event.output).head }),
          },
          { target: "notCut" },
        ],
      },
    },
    // #endregion reading
    // #region detaching
    // Each round forces this folder to the commit, and cleans it.
    detaching: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: reviewTree(context), detach: context.reviewed! }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "reviewing" }, { target: "notCut" }],
      },
    },
    // #endregion detaching
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({ prompt: `Review ${context.reviewed}.`, cwd: reviewTree(context) }),
      },
      on: {
        pass: "removing",
        revise: {
          target: "coding",
          actions: assign({ prompt: ({ event }) => `Change the fix as the review asks:\n\n${event.notes}` }),
        },
      },
    },
    // #region removing
    // The clone is not the Worktree that goes, so the command runs there.
    removing: {
      invoke: {
        src: "remove",
        input: ({ context }) => ({ path: reviewTree(context), worktree: cloneTree(context) }),
        onDone: "publishing",
      },
    },
    // #endregion removing
    // #region publishing
    // The input names the Worktree and the commit. jr2 reads the branch from the cut of that path.
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: coderTree(context), sha: context.reviewed! }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "notPushed" }],
      },
    },
    // #endregion publishing
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    notPushed: { invoke: { src: "fail", input: { reason: "the push did not succeed" } } },
    failed: { invoke: { src: "fail", input: { reason: "an Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
});
