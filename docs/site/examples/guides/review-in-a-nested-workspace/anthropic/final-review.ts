import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  branchName,
  defineEvent,
  fail,
  handoff,
  isReady,
  jr2Setup,
  push,
  readyOf,
  workspace,
  worktree,
  type Handoff,
  type Workspaced,
} from "@jr2/orchestrator";

const APP = "https://github.com/<you>/app.git";

const finished = defineEvent({
  name: "finished",
  description: "Call this when you committed the fix.",
  input: z.object({}),
});
const pass = defineEvent({ name: "pass", description: "Call this when the commit is correct.", input: z.object({}) });
const revise = defineEvent({
  name: "revise",
  description: "Call this when the commit is not correct. Say what to change.",
  input: z.object({ notes: z.string() }),
});

// #region final
// The nested Workspace: a new Sandbox, which sees only the handed-off commit.
// #region door
const finalInput = z.object({ handoff, earlier: z.array(z.string()) });
// #endregion door
type FinalInput = Workspaced<z.infer<typeof finalInput>, "app">;
type FinalOutput = { verdict: "pass" } | { verdict: "revise"; notes: string };
const finalTree = (context: FinalInput) => `${context.workspace.repos.app}/final` as const;

const finalBody = jr2Setup({
  types: {} as { input: FinalInput; context: FinalInput & { notes?: string }; output: FinalOutput },
  events: [pass, revise],
  actors: {
    reviewer: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You review one branch. You run its tests. You change nothing.",
    }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "final-review",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    // #region cutting
    // The cut checks the Handoff against the run, and refuses one that the run did not make.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: finalTree(context), handoff: context.handoff }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "reviewing" }, { target: "notCut" }],
      },
    },
    // #endregion cutting
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({
          prompt: [
            `Review the branch ${context.handoff.branch} against main.`,
            ...context.earlier.map((notes, i) => `Your notes of round ${i + 1}:\n${notes}`),
          ].join("\n\n"),
          cwd: finalTree(context),
        }),
      },
      on: {
        pass: "approved",
        revise: { target: "changes", actions: assign({ notes: ({ event }) => event.notes }) },
      },
    },
    approved: { type: "final" },
    changes: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Handoff was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "the final reviewer's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the final review's Sandbox is gone" } } },
  },
  output: ({ context }): FinalOutput =>
    context.notes === undefined ? { verdict: "pass" } : { verdict: "revise", notes: context.notes },
});
// #endregion final

// The parent Workspace: the coder's Sandbox.
const runInput = z.object({ prompt: z.string(), branch: branchName });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { handoff?: Handoff; earlier: string[] };
const coderTree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [finished],
  actors: {
    coder: agent({ model: "anthropic/claude-haiku-5-5", instructions: "You fix the bug. You commit the fix." }),
    cut: worktree({ expect: "new" }),
    // #region actor
    finalReview: workspace(finalBody, { input: finalInput, repos: { app: APP } }),
    // #endregion actor
    publish: push({ pin: true }),
    fail: fail(),
  },
}).createMachine({
  id: "fix-with-final-review",
  context: ({ input }) => ({ ...input, earlier: [] }),
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "coding" }, { target: "notCut" }],
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: coderTree(context), continue: true }),
      },
      on: { finished: "reading" },
    },
    // #region reading
    // A cut of the same path reads the Worktree. Its `ready` output is the Handoff.
    reading: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => isReady(event.output),
            target: "finalReview",
            actions: assign({ handoff: ({ event }) => readyOf(event.output) }),
          },
          { target: "notCut" },
        ],
      },
    },
    // #endregion reading
    // #region round
    // Each round is a new nested Workspace. The notes of the earlier rounds go in through its door.
    finalReview: {
      invoke: {
        src: "finalReview",
        input: ({ context }) => ({ handoff: context.handoff!, earlier: context.earlier }),
        onDone: [
          { guard: ({ event }) => event.output.verdict === "pass", target: "publishing" },
          {
            target: "coding",
            actions: assign({
              earlier: ({ context, event }) =>
                event.output.verdict === "revise" ? [...context.earlier, event.output.notes] : context.earlier,
              prompt: ({ event }) =>
                event.output.verdict === "revise" ? `Change the fix as the review asks:\n\n${event.output.notes}` : "",
            }),
          },
        ],
      },
    },
    // #endregion round
    // #region publishing
    // The pin publishes exactly the commit that the last round approved.
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: coderTree(context), sha: context.handoff!.head }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "notPushed" }],
      },
    },
    // #endregion publishing
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    notPushed: { invoke: { src: "fail", input: { reason: "the push did not succeed" } } },
    failed: { invoke: { src: "fail", input: { reason: "an Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, { input: runInput, repos: { app: APP } });
