// Git LFS in a push (ADR-0067). The run's one Repo is a per-run LFS repository of the seed over ssh
// (`steps/seed.ts`), which the deploy key clones and pushes to (`jr2.config.ts`). The Agent commits a
// new large file: the clone's clean filter stores its object in the clone's `.git/lfs/objects` and
// commits its pointer. The push uploads the object to the LFS server that `.lfsconfig` names at the
// Binding's base, and then moves the branch. The Effector runs in this tier's own image
// (`images/effector`): the Sandbox Image has no ssh.
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

const finished = defineEvent({ name: "finished", description: "The large file is committed.", input: z.object({}) });

const door = z.object({ repo: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type Ctx = BodyInput & { pushed?: PushOutput };

const tree = (context: BodyInput) => `${context.workspace.repos.app}/work` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Ctx; output: { pushed?: PushOutput } },
  events: [finished],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You commit a large file on the branch." }),
    cut: worktree(),
    publish: push(),
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
      invoke: { src: "coder", input: ({ context }) => ({ prompt: "add the large file", cwd: tree(context) }) },
      on: { finished: "publishing" },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: tree(context) }),
        onDone: { target: "done", actions: assign({ pushed: ({ event }) => event.output }) },
      },
    },
    done: { type: "final", output: ({ context }) => ({ pushed: context.pushed }) },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Turn could not go on" } } },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output as { pushed?: PushOutput },
});

export const machine = workspace(body, {
  input: door,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
