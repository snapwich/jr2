// A dead remote during a cut. The Gate lets a step remove the remote after the attach. A name that
// the clone holds is cut, and the cut says `stale`. A name that the clone does not hold is refused.
import { z } from "zod";
import { assign } from "xstate";
import { defineEvent, jr2Setup, workspace, worktree, type Workspaced, type WorktreeOutput } from "@jr2/orchestrator";

const go = defineEvent({ name: "go", input: z.object({}) });

const door = z.object({ repo: z.string(), held: z.string(), fresh: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type Answers = { heldCut?: WorktreeOutput; freshCut?: WorktreeOutput };
type Ctx = BodyInput & Answers;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Ctx; output: Answers },
  events: [go],
  actors: { cut: worktree() },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".done" },
  initial: "arming",
  states: {
    arming: { invoke: { src: "gate" }, on: { go: "cuttingHeld" } },
    cuttingHeld: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: `${context.workspace.repos.app}/held`, branch: context.held }),
        onDone: { target: "cuttingFresh", actions: assign({ heldCut: ({ event }) => event.output }) },
      },
    },
    cuttingFresh: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: `${context.workspace.repos.app}/fresh`, branch: context.fresh }),
        onDone: { target: "done", actions: assign({ freshCut: ({ event }) => event.output }) },
      },
    },
    done: { type: "final", output: ({ context }) => ({ heldCut: context.heldCut, freshCut: context.freshCut }) },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output as Answers,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
