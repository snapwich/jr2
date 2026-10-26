import { z } from "zod";
import {
  agent,
  answer,
  command,
  defineEvent,
  fail,
  jr2Setup,
  push,
  workspace,
  type CommandOutput,
  type Workspaced,
} from "@jr2/orchestrator";

// The two picks of the Agent.
const runTests = defineEvent({
  name: "run_tests",
  description: "Run the tests. The result is the answer to this call.",
  input: z.object({}),
});
const finished = defineEvent({
  name: "finished",
  description: "Call this when the tests pass and your fix is committed.",
  input: z.object({}),
});

const runInput = z.object({ prompt: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

const passed = (output: CommandOutput): boolean => output.outcome === "exited" && output.code === 0;

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [runTests, finished],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You are a careful engineer. You commit your work on the branch.",
    }),
    // Two Effects. Each is an actor slot, beside the Agent.
    tests: command(["node", "--test"], { timeout: "5m" }),
    publish: push(),
    fail: fail(),
  },
}).createMachine({
  id: "test-and-push",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: context.workspace.repos.app }),
      },
      on: { finished: "publishing" },
      initial: "ready",
      states: {
        ready: { on: { run_tests: "testing" } },
        testing: {
          invoke: {
            src: "tests",
            onDone: {
              target: "ready",
              // The Agent reads this text as the answer to its run_tests pick.
              actions: answer(({ event }) =>
                passed(event.output)
                  ? "The tests pass."
                  : `The tests fail:\n${"tail" in event.output ? event.output.tail : event.output.reason}`,
              ),
            },
          },
        },
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "notPushed" }],
      },
    },
    done: { type: "final" },
    // A Failure ends the body, and jr2 deletes the Sandbox with its commits. To keep them, wait at
    // a Gate before this state.
    notPushed: { invoke: { src: "fail", input: { reason: "the push did not publish the fix" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  repos: { app: "https://github.com/you/app.git" },
  spec: ({ input }) => ({ branch: input.branch }),
});
