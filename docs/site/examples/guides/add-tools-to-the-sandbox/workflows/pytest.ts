import { z } from "zod";
import { command, fail, isReady, jr2Setup, workspace, worktree, type Workspaced } from "@jr2/orchestrator";

const runInput = z.object({ branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

// The Worktree that the tests run in.
const testTree = (context: BodyInput) => `${context.workspace.repos.app}/test` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput },
  actors: {
    cut: worktree(),
    // python and pytest come from the Sandbox Image in ./python.
    tests: command(["python", "-m", "pytest"], { timeout: "15m" }),
    fail: fail(),
  },
}).createMachine({
  id: "pytest",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: testTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "testing" }, { target: "notCut" }],
      },
    },
    testing: {
      invoke: {
        src: "tests",
        input: ({ context }) => ({ worktree: testTree(context) }),
        onDone: [
          {
            guard: ({ event }) => event.output.outcome === "exited" && event.output.code === 0,
            target: "passed",
          },
          { target: "failed" },
        ],
      },
    },
    passed: { type: "final" },
    // Not final states: each one fails the run, and the run ends `failed`.
    failed: { invoke: { src: "fail", input: { reason: "pytest did not pass" } } },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  // The docker context in the folder beside this file. jr2 up builds it.
  image: import.meta.resolve("./python"),
  repos: { app: "https://github.com/you/app.git" },
});
