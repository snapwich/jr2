// Git LFS in an Agent's own git (ADR-0053). The run's one Repo is a per-run LFS repository of the seed
// (`steps/seed.ts`) with two commits on `main`, each with its own large file. The cut gets the base's
// large file. The Agent then checks out the older commit in its Worktree: git-lfs's smudge asks jr2's
// transfer agent, which asks the node cache for that one object by its oid.
import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, workspace, worktree, type Workspaced } from "@jr2/orchestrator";

const finished = defineEvent({ name: "finished", description: "The work is done.", input: z.object({}) });

const door = z.object({ repo: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;

const tree = (context: BodyInput) => `${context.workspace.repos.app}/work` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput },
  events: [finished],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You look at old versions of large files." }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: { src: "coder", input: ({ context }) => ({ prompt: "check out the older commit", cwd: tree(context) }) },
      on: { finished: "done" },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Turn could not go on" } } },
  },
});

export const machine = workspace(body, {
  input: door,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
