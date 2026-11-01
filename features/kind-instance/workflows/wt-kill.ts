// A kill during a cut. The Gates let a step arm its kill before the cut, and read the pod after it.
// The Machine cuts on whatever the killed cut answers: the next cut in the clone repairs it, and a
// cut of the same path and branch then makes the Worktree.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  workspace,
  worktree,
  type Workspaced,
  type WorktreeOutput,
} from "@jr2/orchestrator";

const go = defineEvent({ name: "go", input: z.object({}) });
const look = defineEvent({ name: "look", input: z.object({}) });
const check = defineEvent({ name: "check", input: z.object({}) });
const finished = defineEvent({ name: "finished", description: "The work is committed.", input: z.object({}) });

const door = z.object({ repo: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type Answers = { first?: WorktreeOutput; next?: WorktreeOutput; again?: WorktreeOutput };
type Ctx = BodyInput & Answers;

const tree = (context: BodyInput) => `${context.workspace.repos.app}/run` as const;
const nextTree = (context: BodyInput) => `${context.workspace.repos.app}/next` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Ctx; output: Answers },
  events: [go, look, check, finished],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You commit your work on the branch." }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "arming",
  states: {
    arming: { invoke: { src: "gate" }, on: { go: "cutting" } },
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: { target: "looking", actions: assign({ first: ({ event }) => event.output }) },
      },
    },
    looking: { invoke: { src: "gate" }, on: { look: "repairing" } },
    repairing: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: nextTree(context), branch: `${context.branch}-next` }),
        onDone: { target: "checking", actions: assign({ next: ({ event }) => event.output }) },
      },
    },
    checking: { invoke: { src: "gate" }, on: { check: "again" } },
    again: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => event.output.outcome === "ready",
            target: "working",
            actions: assign({ again: ({ event }) => event.output }),
          },
          { target: "notCut", actions: assign({ again: ({ event }) => event.output }) },
        ],
      },
    },
    working: {
      invoke: { src: "coder", input: ({ context }) => ({ prompt: "work", cwd: tree(context) }) },
      on: { finished: "done" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ first: context.first, next: context.next, again: context.again }),
    },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Turn could not go on" } } },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output as Answers,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
