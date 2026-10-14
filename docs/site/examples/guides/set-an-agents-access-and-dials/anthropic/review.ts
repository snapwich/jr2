import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";

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

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [approve, requestChanges, finished],
  actors: {
    // "read": no write tool and no edit tool. It keeps bash.
    reviewer: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You review one commit. You do not change files.",
      workspace: "read",
    }),
    // No `workspace` field: "write", all the Working tools.
    coder: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You change code as the review asks, and you commit each change.",
    }),
    // "none": a Menu-only Agent. It has no Working tools, and it runs on the Instance Harness.
    checker: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You read review notes and the summary of a change, and you decide if the change is complete.",
      workspace: "none",
      thinkingLevel: "low",
    }),
  },
}).createMachine({
  id: "review",
  context: ({ input }) => ({ ...input, notes: "", summary: "" }),
  initial: "reviewing",
  states: {
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({
          prompt: `Review commit ${context.sha}.`,
          // The review Worktree holds the commit of `reviewSha`, detached from the branch.
          cwd: context.workspace.review?.app ?? context.workspace.repos.app,
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
          cwd: context.workspace.repos.app,
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
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
  spec: ({ input }) => ({ branch: input.branch, reviewSha: input.sha }),
});
