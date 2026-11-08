// Git LFS in a cut (ADR-0075, ADR-0053). The run's one Repo is a per-run LFS repository of the seed
// (`steps/seed.ts`). The first Gate lets a step read default/ after the attach and time the cut. The
// first cut is of `branch`, a remote branch whose commit holds a large file that the attach did not
// get, so the cut asks the node cache for it. The second Gate lets a step read the Worktree. The
// second cut is of a new name on the base, whose large files the attach got, so it asks for none.
import { z } from "zod";
import { assign } from "xstate";
import { defineEvent, jr2Setup, workspace, worktree, type Workspaced, type WorktreeOutput } from "@jr2/orchestrator";

const go = defineEvent({ name: "go", input: z.object({}) });
const look = defineEvent({ name: "look", input: z.object({}) });

const door = z.object({ repo: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type Answers = { first?: WorktreeOutput; second?: WorktreeOutput };
type Ctx = BodyInput & Answers;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Ctx; output: Answers },
  events: [go, look],
  actors: { cut: worktree() },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".done" },
  initial: "arming",
  states: {
    arming: { invoke: { src: "gate" }, on: { go: "cuttingBranch" } },
    cuttingBranch: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: `${context.workspace.repos.app}/lfs`, branch: context.branch }),
        onDone: { target: "looking", actions: assign({ first: ({ event }) => event.output }) },
      },
    },
    looking: { invoke: { src: "gate" }, on: { look: "cuttingBase" } },
    cuttingBase: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: `${context.workspace.repos.app}/base`, branch: `${context.branch}-base` }),
        onDone: { target: "done", actions: assign({ second: ({ event }) => event.output }) },
      },
    },
    done: { type: "final", output: ({ context }) => ({ first: context.first, second: context.second }) },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output as Answers,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
