// S8: a Failure retry that takes over the same Sandbox, and an Orchestrator restart in the
// middle of a cut.
//
// What the Machine must write: the cut is the FIRST state of the body, and the Turn reads `found`.
// That is all. There is no spec to run again, and a restore re-runs no cut that settled.
//
//   Retry, the Failure ended a Machine ABOVE the Workspace (below: `budget` fails `attempt`). The
//   host keeps the Sandbox, the name is the same, attach finds the clone, and `cutting` finds the
//   Worktree: `found: "held"`. The commits and the uncommitted files stay.
//
//   Retry, the Failure came from the body itself (`gaveUp`). `workspace()` deletes the Sandbox
//   before the Failure goes up. The new pod has a new clone: `found: "remote"` when a push reached
//   the remote, else `found: "none"`. Commits that were not pushed are gone, and `found` says so.
//
//   Restart in the middle of a cut. The exec row is `intent`. The Harness lived: re-attach, and the
//   settled answer comes. The Harness died: `idempotent` sends the cut again under its id, and it
//   finishes, and answers the FIRST `found`: a restart is no resumed work. `unknown` falls in the last
//   branch. A stale fetch never reads `none`: a name that the remote cannot confirm is `refused`.
import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  isFailure,
  jr2Setup,
  workspace,
  worktree,
  type Workspaced,
  type WorktreeOutput,
} from "@jr2/orchestrator";

const finished = defineEvent({ name: "finished", description: "The work is committed.", input: z.object({}) });
const giveUp = defineEvent({ name: "give_up", description: "You cannot do this.", input: z.object({}) });

const door = z.object({ branch: z.string(), prompt: z.string() });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
type BodyContext = BodyInput & { cut?: WorktreeOutput };

const tree = (context: BodyInput) => `${context.workspace.repos.app}/run` as const;

/** What the Turn must know of the cut: the part of the Frame that a retry changes. */
function resumeLine(cut: WorktreeOutput | undefined): string {
  if (cut?.outcome !== "ready") return "";
  if (cut.found === "held") return `\nThis is a retry: your earlier work is in this Worktree, at ${cut.head}.`;
  if (cut.found === "remote") return `\nThis is a retry: what you pushed is here, at ${cut.head}.`;
  return "";
}

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyContext; output: { head?: string } },
  events: [finished, giveUp],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You commit your work on the branch." }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".gaveUp" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: tree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => event.output.outcome === "ready",
            target: "working",
            actions: assign({ cut: ({ event }) => event.output }),
          },
          { target: "notCut" },
        ],
      },
    },
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt + resumeLine(context.cut), cwd: tree(context) }),
      },
      on: { finished: "done", give_up: "gaveUp" },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    gaveUp: { invoke: { src: "fail", input: { reason: "the coder gave up" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

const unit = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
});

// The Machine above the Workspace. When its budget fails, the Failure ends `attempt` and not the
// Workspace's body, so the Sandbox stays for the same invoke id (ADR-0073).
const attempt = jr2Setup({
  types: {} as { input: z.infer<typeof door>; context: z.infer<typeof door> },
  actors: { unit, fail: fail() },
}).createMachine({
  id: "attempt",
  context: ({ input }) => input,
  initial: "running",
  states: {
    running: {
      invoke: { id: "unit", src: "unit", input: ({ context }) => context, onDone: "finished" },
      after: { 25000: "over" },
    },
    finished: { type: "final" },
    over: { invoke: { src: "fail", input: { reason: "the hour is over" } } },
  },
});

export const machine = jr2Setup({
  types: {} as { input: z.infer<typeof door>; context: z.infer<typeof door> & { tries: number; last?: string } },
  actors: { attempt, fail: fail() },
}).createMachine({
  id: "retrying",
  input: door,
  context: ({ input }) => ({ ...input, tries: 0 }),
  initial: "trying",
  states: {
    trying: {
      invoke: {
        id: "attempt",
        src: "attempt",
        input: ({ context }) => ({ branch: context.branch, prompt: context.prompt }),
        onDone: "done",
        onError: [
          {
            guard: ({ event, context }) => isFailure(event.error) && context.tries < 2,
            target: "trying",
            reenter: true,
            actions: assign({ tries: ({ context }) => context.tries + 1 }),
          },
          {
            target: "gaveUp",
            actions: assign({ last: ({ event }) => String((event.error as Error)?.message ?? event.error) }),
          },
        ],
      },
    },
    done: { type: "final" },
    gaveUp: { invoke: { src: "fail", input: ({ context }) => ({ reason: `tries failed: ${context.last}` }) } },
  },
});
