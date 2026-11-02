import { z } from "zod";
import {
  agent,
  answer,
  arg,
  bearer,
  command,
  defineEvent,
  fail,
  fromPick,
  http,
  isReady,
  jr2Setup,
  secret,
  workspace,
  worktree,
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

// The Worktree that the coder and the command name.
const fixTree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;

const passed = (output: CommandOutput): boolean => output.outcome === "exited" && output.code === 0;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput },
  events: [runTest, finished],
  actors: {
    coder: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You fix failing tests. You change no test. You commit the fix.",
    }),
    // Cut the Worktree: an Effect too.
    cut: worktree(),
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
    // Fail the run: the end for work that did not succeed.
    fail: fail(),
  },
}).createMachine({
  id: "fix-and-report",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost" },
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
            // The `file` of the pick goes to the arg("file") of the command. The Machine gives `worktree`.
            input: fromPick(runTest, ({ context }) => ({ worktree: fixTree(context) })),
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
        input: fromPick(finished, ({ context }) => ({ branch: context.branch })),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "response" && event.output.status < 300, target: "done" },
          { target: "notReported" },
        ],
      },
    },
    done: { type: "final" },
    // Not final states: a final state means `done`. Each one fails the run, and the run ends `failed`.
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    notReported: { invoke: { src: "fail", input: { reason: "the report did not go out" } } },
    failed: { invoke: { src: "fail", input: { reason: "the coder could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/<you>/app.git" },
});
