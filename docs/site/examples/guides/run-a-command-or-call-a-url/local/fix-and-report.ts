import { z } from "zod";
import {
  agent,
  answer,
  arg,
  bearer,
  command,
  defineEvent,
  fromPick,
  http,
  jr2Setup,
  secret,
  workspace,
  type CommandOutput,
  type Workspaced,
} from "@jr2/orchestrator";

const runTest = defineEvent({
  name: "run_test",
  description: "Run one test file. The answer tells if it passes.",
  input: z.object({ file: z.string() }),
});
const finished = defineEvent({
  name: "finished",
  description: "Call this when the tests pass and you committed the fix. Say what you changed.",
  input: z.object({ summary: z.string() }),
});

const runInput = z.object({ prompt: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

const passed = (output: CommandOutput): boolean => output.outcome === "exited" && output.code === 0;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput },
  events: [runTest, finished],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You fix failing tests. You change no test. You commit the fix.",
    }),
    // One program, with no shell. arg("file") is one argument, from the input of the Effect.
    test: command(["node", "--test", arg("file")], { timeout: "5m" }),
    // A call to a fixed URL. The Effector puts the value of the secret in the header.
    report: http({
      method: "POST",
      url: "https://hooks.example.com/jr2",
      auth: bearer(secret("hook-token")),
      input: z.object({ branch: z.string(), summary: z.string() }),
      request: ({ branch, summary }) => ({ json: { text: `${branch}: ${summary}` } }),
    }),
  },
}).createMachine({
  id: "fix-and-report",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: context.workspace.repos.app }),
      },
      on: {
        finished: "reporting",
        // A Turn of the coder failed with no pick. Without this route, the run stays in `coding`.
        "agent.fault": "failed",
      },
      initial: "ready",
      states: {
        ready: { on: { run_test: "testing" } },
        testing: {
          invoke: {
            src: "test",
            // The `file` of the pick goes to the arg("file") of the command.
            input: fromPick(runTest),
            onDone: {
              target: "ready",
              // The Agent reads this text as the answer to its run_test pick.
              actions: answer(({ event }) =>
                passed(event.output)
                  ? "The test passes."
                  : `The test fails:\n${"tail" in event.output ? event.output.tail : event.output.reason}`,
              ),
            },
          },
        },
      },
    },
    reporting: {
      invoke: {
        src: "report",
        // The Agent gives `summary`. The Machine gives `branch`.
        input: fromPick(finished, ({ context }) => ({ branch: context.workspace.branch })),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "response" && event.output.status < 300, target: "done" },
          { target: "notReported" },
        ],
      },
    },
    done: { type: "final" },
    notReported: { type: "final" },
    failed: { type: "final" },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
