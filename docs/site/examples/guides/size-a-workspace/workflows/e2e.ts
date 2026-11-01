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
    // JR2_CPUS holds the cpu limit of the container. Playwright does not read that limit.
    e2e: command(["sh", "-c", "npx playwright test --workers=$JR2_CPUS"], { timeout: "30m" }),
    fail: fail(),
  },
}).createMachine({
  id: "e2e",
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
        src: "e2e",
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
    failed: { invoke: { src: "fail", input: { reason: "the Playwright tests did not pass" } } },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  // The Size of the whole Sandbox: 4 GiB of memory and 2 cpus. jr2 reserves all of it on a node.
  resources: { limits: { memory: "4Gi", cpu: "2" } },
  repos: { app: "https://github.com/you/app.git" },
});
