import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";

const finish = defineEvent({
  name: "finish",
  description: "Call this when `node --test` passes and you committed the fix. Say what you changed.",
  input: z.object({ summary: z.string() }),
});
const approve = defineEvent({
  name: "approve",
  description: "Call this when the summary shows a complete fix.",
  input: z.object({}),
});
const requestChanges = defineEvent({
  name: "request_changes",
  description: "Call this when the fix is not complete. Say what is missing.",
  input: z.object({ notes: z.string() }),
});

const runInput = z.object({ branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { summary: string; notes: string };

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finish, approve, requestChanges],
  actors: {
    // The definition: who the Agent is. It is the same on every Turn.
    coder: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You fix failing tests. You change no test.",
    }),
    // A Menu-only Agent: no Working tools. It reads its prompt and picks.
    checker: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You read the summary of a fix, and you decide if the fix is complete.",
      workspace: "none",
      thinkingLevel: "low",
    }),
  },
}).createMachine({
  id: "fix",
  context: ({ input }) => ({ ...input, summary: "", notes: "" }),
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        // The Frame (prompt and cwd) and continue. This Turn starts the coder's conversation.
        input: ({ context }) => ({
          prompt: "Make `node --test` pass, then commit.",
          cwd: context.workspace.repos.app,
          continue: true,
        }),
      },
      on: { finish: { target: "checking", actions: assign({ summary: ({ event }) => event.summary }) } },
    },
    checking: {
      invoke: { src: "checker", input: ({ context }) => ({ prompt: `Is this fix complete?\n\n${context.summary}` }) },
      on: {
        approve: "done",
        request_changes: { target: "fixing", actions: assign({ notes: ({ event }) => event.notes }) },
      },
    },
    fixing: {
      invoke: {
        src: "coder",
        // The same conversation as in coding, with a Dial: the coder thinks harder on this Turn.
        input: ({ context }) => ({
          prompt: `The fix is not complete: ${context.notes}\nFix it, then commit.`,
          cwd: context.workspace.repos.app,
          continue: true,
          thinkingLevel: "high",
        }),
      },
      on: { finish: { target: "checking", actions: assign({ summary: ({ event }) => event.summary }) } },
    },
    done: { type: "final" },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/you/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
