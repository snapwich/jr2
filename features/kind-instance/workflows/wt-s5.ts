// S5: start from an existing remote branch whose name has a slash (feature/auth, an
// open PR), add commits, push to it.
import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, push, workspace, worktree, type Workspaced } from "@jr2/orchestrator";

const committed = defineEvent({ name: "committed", description: "The commits are made.", input: z.object({}) });

const runInput = z.object({ pr: z.string(), prompt: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;

function parts() {
  return {
    coder: agent({ model: "fake/model-x", instructions: "You add commits to an open pull request." }),
    cut: worktree({ expect: "existing" }),
    publish: push(),
    fail: fail(),
  };
}

// The folder is a word of the Machine: /work/app/pr. The door's name reaches git as a ref, and never
// reaches a path. `expect: "existing"` refuses a typo at the door's word, with nothing made.

const withBranch = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput },
  events: [committed],
  actors: parts(),
}).createMachine({
  id: "resume-branch",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: "/work/app/pr", branch: context.pr }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notFound" }],
      },
    },
    working: {
      invoke: { src: "coder", input: ({ context }) => ({ prompt: context.prompt, cwd: "/work/app/pr" }) },
      on: { committed: "publishing" },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: { worktree: "/work/app/pr" },
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "notPushed" }],
      },
    },
    done: { type: "final" },
    notFound: { invoke: { src: "fail", input: { reason: "no such branch on the remote" } } },
    notPushed: { invoke: { src: "fail", input: { reason: "the push did not go" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(withBranch, {
  input: runInput,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
});
