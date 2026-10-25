import { z } from "zod";
import { command, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";

const runInput = z.object({ branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

const body = jr2Setup({
  types: {} as { input: BodyInput },
  actors: {
    // python and pytest come from the Sandbox Image in ./python.
    tests: command(["python", "-m", "pytest"], { timeout: "15m" }),
  },
}).createMachine({
  id: "pytest",
  initial: "testing",
  states: {
    testing: {
      invoke: {
        src: "tests",
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
  // The docker context in the folder beside this file. jr2 up builds it.
  image: import.meta.resolve("./python"),
  repos: { app: "https://github.com/you/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
