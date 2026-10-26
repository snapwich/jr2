import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, push, workspace, type Workspaced } from "@jr2/orchestrator";

const finished = defineEvent({
  name: "finished",
  description: "Call this when your change is committed.",
  input: z.object({}),
});
const approve = defineEvent({
  name: "approve",
  description: "The change is good. Push it, and end the run.",
  input: z.object({}),
});

// The run input: what `jr2 run` gives with --input.
const runInput = z.object({ ticket: z.string(), prompt: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app" | "handbook">;

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [finished, approve],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You are a careful engineer. You commit your work on the branch.",
    }),
    // Two Repo Slots, so the push names the slot that it pushes.
    publish: push({ slot: "app" }),
    fail: fail(),
  },
}).createMachine({
  id: "docs-fix",
  context: ({ input }) => input,
  initial: "working",
  // The Sandbox is gone, and its unpushed commits with it. This body fails the run.
  on: { "agent.fault": ".failed", "workspace.lost": ".lost" },
  states: {
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: `${context.prompt}\nRead the style rules in ${context.workspace.repos.handbook}.`,
          // The Agent works in the Worktree of the app slot.
          cwd: context.workspace.repos.app,
        }),
      },
      on: { finished: "review" },
    },
    // The run waits here, and the Sandbox stays, until a person sends approve.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: { branch: context.workspace.branch, worktree: context.workspace.repos.app },
        }),
      },
      on: { approve: "publishing" },
    },
    // Push before the body ends: jr2 deletes the Sandbox, and its commits, at a final state.
    // A push that did not publish goes back to the Gate, so the Sandbox stays.
    publishing: {
      invoke: {
        src: "publish",
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "review" }],
      },
    },
    done: { type: "final" },
    // Not final states: a final state means `done`. Each one fails the run, and the run ends `failed`.
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  // The Size of the whole Sandbox. jr2 reserves all of it on the node.
  resources: { limits: { memory: "4Gi", cpu: "2" } },
  repos: {
    // Two Repo Slots. Each one becomes a folder under /work.
    app: { url: "https://github.com/you/app.git", ref: "main" },
    handbook: "https://github.com/you/handbook.git",
  },
  spec: ({ input }) => ({ branch: `docs/${input.ticket}` }),
});
