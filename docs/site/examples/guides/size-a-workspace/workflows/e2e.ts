import { z } from "zod";
import { command, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";

const runInput = z.object({ branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

const body = jr2Setup({
  types: {} as { input: BodyInput },
  actors: {
    // JR2_CPUS holds the cpu limit of the container. Playwright does not read that limit.
    e2e: command(["sh", "-c", "npx playwright test --workers=$JR2_CPUS"], { timeout: "30m" }),
  },
}).createMachine({
  id: "e2e",
  initial: "testing",
  states: {
    testing: {
      invoke: {
        src: "e2e",
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
    failed: { type: "final" },
  },
});

export const machine = workspace(body, {
  input: runInput,
  // The Size of the whole Sandbox: 4 GiB of memory and 2 cpus. jr2 reserves all of it on a node.
  resources: { limits: { memory: "4Gi", cpu: "2" } },
  repos: { app: "https://github.com/you/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
