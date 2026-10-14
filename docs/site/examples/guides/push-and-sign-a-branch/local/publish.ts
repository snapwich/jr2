import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, push, workspace, type PushOutput, type Workspaced } from "@jr2/orchestrator";

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

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished, approve, stop],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You fix failing tests. You change no test. You commit the fix.",
    }),
    // Push signed copies of the Agent's commits, with the key of the git.credentials entry.
    publish: push({ sign: true }),
  },
}).createMachine({
  id: "publish",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: context.workspace.repos.app }),
      },
      on: { finished: "review" },
    },
    // A person reads the branch, then answers.
    review: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { branch: context.workspace.branch } }) },
      on: { approve: "publishing", stop: "done" },
    },
    publishing: {
      invoke: {
        src: "publish",
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
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
