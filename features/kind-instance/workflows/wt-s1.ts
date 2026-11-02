// S1: one coder, a read-only handbook slot, a Gate, a push.
import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, push, workspace, worktree, type Workspaced } from "@jr2/orchestrator";

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

// The Worktree of the coder: a constant folder word. The branch is a door value, and no path holds it.
const worktreeOf = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;
const branchOf = (context: BodyInput) => `docs/${context.ticket}`;

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [finished, approve],
  actors: {
    coder: agent({
      model: "fake/model-x",
      instructions: "You are a careful engineer. You commit your work on the branch.",
    }),
    cut: worktree(),
    // Two Repo Slots, so the push names the slot that it pushes.
    publish: push({ slot: "app" }),
    fail: fail(),
  },
}).createMachine({
  id: "docs-fix",
  context: ({ input }) => input,
  initial: "cutting",
  // The Sandbox is gone, and its unpushed commits with it. This body fails the run.
  on: { "agent.fault": ".failed", "workspace.lost": ".lost" },
  states: {
    // A slot that is only read needs nothing: its default/ is on the Binding's base.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: worktreeOf(context), branch: branchOf(context) }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: `${context.prompt}\nRead the style rules in ${context.workspace.repos.handbook}/default.`,
          // The Agent works in the Worktree of the app slot.
          cwd: worktreeOf(context),
        }),
      },
      on: { finished: "review" },
    },
    // The run waits here, and the Sandbox stays, until a person sends approve.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({ meta: { branch: branchOf(context), worktree: worktreeOf(context) } }),
      },
      on: { approve: "publishing" },
    },
    // Push before the body ends: jr2 deletes the Sandbox, and its commits, at a final state.
    // A push that did not publish goes back to the Gate, so the Sandbox stays.
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: worktreeOf(context) }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "review" }],
      },
    },
    done: { type: "final" },
    // Not final states: a final state means `done`. Each one fails the run, and the run ends `failed`.
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  effector: { image: import.meta.resolve("../images/effector") },
  // The Size of the whole Sandbox. jr2 reserves all of it on the node.
  repos: {
    // Two Repo Slots. Each one becomes a folder under /work.
    app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" },
    handbook: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" },
  },
});
