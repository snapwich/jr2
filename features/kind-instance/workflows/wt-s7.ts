// S7: one change across two Repo Slots, two pushes. One branch name, two Worktrees, and a
// static `slot` on each push, so that `jr2 up` places each slot's credential.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  push,
  workspace,
  worktree,
  type PushOutput,
  type Workspaced,
} from "@jr2/orchestrator";

const finished = defineEvent({ name: "finished", description: "Both changes are committed.", input: z.object({}) });
const retry = defineEvent({ name: "retry", description: "Push what did not go.", input: z.object({}) });

const runInput = z.object({ ticket: z.string(), prompt: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "api" | "web">;
type Context = BodyInput & { last?: PushOutput };

const apiTree = (context: BodyInput) => `${context.workspace.repos.api}/change` as const;
const webTree = (context: BodyInput) => `${context.workspace.repos.web}/change` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished, retry],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You change an API and its client together." }),
    cut: worktree(),
    pushApi: push({ slot: "api" }),
    pushWeb: push({ slot: "web" }),
    fail: fail(),
  },
}).createMachine({
  id: "two-slots",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cuttingApi",
  states: {
    cuttingApi: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: apiTree(context), branch: context.ticket }),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "ready", target: "cuttingWeb" },
          { target: "notCut" },
        ],
      },
    },
    cuttingWeb: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: webTree(context), branch: context.ticket }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: `${context.prompt}\nThe client is in ${webTree(context)}. Commit there too.`,
          cwd: apiTree(context),
        }),
      },
      on: { finished: "pushingApi" },
    },
    // Two remotes, so no push is atomic with the other. The API goes first; a client of a new API
    // is what must not be first. `unchanged: true` makes a second try of a done push harmless.
    pushingApi: {
      invoke: {
        src: "pushApi",
        input: ({ context }) => ({ worktree: apiTree(context) }),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "pushed", target: "pushingWeb" },
          { target: "notPushed", actions: assign({ last: ({ event }) => event.output }) },
        ],
      },
    },
    pushingWeb: {
      invoke: {
        src: "pushWeb",
        input: ({ context }) => ({ worktree: webTree(context) }),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "pushed", target: "done" },
          { target: "notPushed", actions: assign({ last: ({ event }) => event.output }) },
        ],
      },
    },
    notPushed: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { pushed: context.last } }) },
      on: { retry: "pushingApi" },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "a Worktree was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: {
    api: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" },
    web: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/gpg.git", ref: "main" },
  },
});
