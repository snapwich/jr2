import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, fail, isReady, jr2Setup, workspace, worktree, type Workspaced } from "@jr2/orchestrator";

const approve = defineEvent({
  name: "approve",
  description: "Call this when the change is complete and correct.",
  input: z.object({}),
});
const requestChanges = defineEvent({
  name: "request_changes",
  description: "Call this when the change is not complete or not correct. Say what to change.",
  input: z.object({ notes: z.string() }),
});
const finished = defineEvent({
  name: "finished",
  description: "Call this when you committed the changes. Say what you changed.",
  input: z.object({ summary: z.string() }),
});

// The run input: the branch, the commit to review, and an optional model for the coder's Turns.
const runInput = z.object({ branch: z.string(), sha: z.string(), model: z.string().optional() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { notes: string; summary: string };

// Two Worktrees of one clone: the coder's branch, and the commit that the reviewer reads.
const coderTree = (context: BodyInput) => `${context.workspace.repos.app}/work` as const;
const reviewTree = (context: BodyInput) => `${context.workspace.repos.app}/review` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [approve, requestChanges, finished],
  actors: {
    // "read": no write tool and no edit tool. It keeps bash.
    reviewer: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You review one commit. You do not change files.",
      workspace: "read",
    }),
    // No `workspace` field: "write", all the Working tools.
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You change code as the review asks, and you commit each change.",
    }),
    // "none": a Menu-only Agent. It has no Working tools, and it runs on the Instance Harness.
    checker: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You read review notes and the summary of a change, and you decide if the change is complete.",
      workspace: "none",
      thinkingLevel: "low",
    }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "review",
  context: ({ input }) => ({ ...input, notes: "", summary: "" }),
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    // The Workspace only clones. The Machine cuts the Worktree that the Agent works in.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "detaching" }, { target: "notCut" }],
      },
    },
    // The second cut has no branch: the Worktree holds the commit, detached.
    detaching: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: reviewTree(context), detach: context.sha }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "reviewing" }, { target: "notCut" }],
      },
    },
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({
          prompt: `Review commit ${context.sha}.`,
          // The review Worktree holds the commit, detached from the branch.
          cwd: reviewTree(context),
          // A Dial: this Turn thinks harder than the default of the model.
          thinkingLevel: "high",
        }),
      },
      on: {
        approve: "done",
        request_changes: { target: "fixing", actions: assign({ notes: ({ event }) => event.notes }) },
      },
    },
    fixing: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: `Change the code on the branch as the review asks:\n\n${context.notes}`,
          cwd: coderTree(context),
          // Each Turn of the coder continues the same conversation.
          continue: true,
          // A Dial: the model of this Turn, from the run input. Absent, the model of the definition.
          model: context.model,
        }),
      },
      on: { finished: { target: "checking", actions: assign({ summary: ({ event }) => event.summary }) } },
    },
    checking: {
      invoke: {
        src: "checker",
        input: ({ context }) => ({
          prompt: `The review asked for this:\n\n${context.notes}\n\nThe coder did this:\n\n${context.summary}`,
        }),
      },
      on: {
        approve: "done",
        request_changes: { target: "fixing", actions: assign({ notes: ({ event }) => event.notes }) },
      },
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
