// The Handoff loop (ADR-0080): a coder and a quick reviewer in one Workspace, and a final review of
// the coder's commit in a nested Workspace, a new Sandbox that takes the commit as a Handoff at its
// cut. The run's one Repo is a per-run LFS repository of the seed over ssh (`steps/seed.ts`), which
// the deploy key clones and pushes to (`jr2.config.ts`). Both Workspaces bind it.
//
//   parent  cutting      the coder's Worktree, of the door's branch
//           coding       the coder commits and picks `finished`
//           quick        the quick reviewer, in the same Sandbox: `fix_this` goes back to coding,
//                        `looks_good` goes on
//           reading      a cut of the same path: its `ready` output is the Handoff
//           final        a NEW nested Workspace for each round, with the Handoff and the notes of
//                        the earlier rounds. `revise` goes back to coding; `pass` goes on
//           lateCommit   mode "parent": the coder commits once more, after the review
//           publishing   mode "parent": `push({ pin: true })` of the Handoff's head, not of the
//                        coder's later commit
//   mode "child": the nested Workspace pushes its own Worktree when its reviewer passes it.
//   mode "forged": after the first read, the coder commits again and names that commit in its
//   pick. The parent then gives a nested Workspace a Handoff with that head (a commit that no cut
//   read), and then a Handoff with the branch `main`. Each nested cut is `refused`, and the nested
//   body routes it to its output.
//
// The Effectors run in this tier's own image (`images/effector`): the Sandbox Image has no ssh.
import { z } from "zod";
import { assign } from "xstate";
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
  type PushOutput,
  type Workspaced,
} from "@jr2/orchestrator";

const EFFECTOR = { image: import.meta.resolve("../images/effector") };

// --- the nested Workspace: the final review ----------------------------------------------------

const pass = defineEvent({ name: "pass", description: "The commit is correct.", input: z.object({}) });
const revise = defineEvent({
  name: "revise",
  description: "The commit is not correct. Say what to change.",
  input: z.object({ notes: z.string() }),
});

const finalDoor = z.object({ repo: z.string(), handoff, earlier: z.array(z.string()), publish: z.boolean() });
type FinalInput = Workspaced<z.infer<typeof finalDoor>, "app">;
type FinalOutput =
  | { verdict: "pass"; pushed?: PushOutput }
  | { verdict: "revise"; notes: string }
  | { verdict: "refused"; reason: string };
type FinalContext = FinalInput & { out?: FinalOutput };
const finalTree = (context: FinalInput) => `${context.workspace.repos.app}/final` as const;

const finalBody = jr2Setup({
  types: {} as { input: FinalInput; context: FinalContext; output: FinalOutput },
  events: [pass, revise],
  actors: {
    reviewer: agent({ model: "fake/model-x", instructions: "You are the final reviewer of one branch." }),
    cut: worktree(),
    publish: push({ pin: true }),
    fail: fail(),
  },
}).createMachine({
  id: "final",
  context: ({ input }) => input,
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: finalTree(context), handoff: context.handoff }),
        onDone: [
          { guard: ({ event }) => isReady(event.output), target: "reviewing" },
          {
            // A refused Handoff is the author's to route.
            target: "ended",
            actions: assign({
              out: ({ event }) => ({
                verdict: "refused" as const,
                reason: "reason" in event.output ? String(event.output.reason) : JSON.stringify(event.output),
              }),
            }),
          },
        ],
      },
    },
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
        pass: [
          { guard: ({ context }) => context.publish, target: "publishing" },
          { target: "ended", actions: assign({ out: { verdict: "pass" as const } }) },
        ],
        revise: {
          target: "ended",
          actions: assign({ out: ({ event }) => ({ verdict: "revise" as const, notes: event.notes }) }),
        },
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: finalTree(context), sha: context.handoff.head }),
        onDone: {
          target: "ended",
          actions: assign({ out: ({ event }) => ({ verdict: "pass" as const, pushed: event.output }) }),
        },
      },
    },
    ended: { type: "final" },
    failed: { invoke: { src: "fail", input: { reason: "the final reviewer's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the final review's Sandbox is gone" } } },
  },
  output: ({ context }): FinalOutput => context.out!,
});

const finalReview = workspace(finalBody, {
  input: finalDoor,
  effector: EFFECTOR,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});

// --- the parent Workspace: the coder's Sandbox -------------------------------------------------

const finished = defineEvent({
  name: "finished",
  description: "The work is committed. Name the commit when you are asked to.",
  input: z.object({ head: z.string().optional() }),
});
const looksGood = defineEvent({ name: "looks_good", description: "The commit is good.", input: z.object({}) });
const fixThis = defineEvent({
  name: "fix_this",
  description: "The commit is not good. Say what to change.",
  input: z.object({ notes: z.string() }),
});

const door = z.object({ repo: z.string(), branch: branchName, mode: z.enum(["parent", "child", "forged"]) });
type BodyInput = Workspaced<z.infer<typeof door>, "app">;
/** One round of the final review, as the parent saw it. */
type Round = { handoff: Handoff; out: FinalOutput };
type Output = { rounds: Round[]; pushed?: PushOutput };
type Context = BodyInput & {
  prompt: string;
  handoff?: Handoff;
  /** The head that the coder's last pick named: a forged head in mode "forged". */
  named?: string;
  earlier: string[];
  rounds: Round[];
  pushed?: PushOutput;
};
const coderTree = (context: BodyInput) => `${context.workspace.repos.app}/work` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context; output: Output },
  events: [finished, looksGood, fixThis],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You are the coder. You fix the bug and commit." }),
    quick: agent({ model: "fake/model-x", workspace: "read", instructions: "You are the quick reviewer." }),
    cut: worktree(),
    finalReview,
    publish: push({ pin: true }),
    fail: fail(),
  },
}).createMachine({
  id: "handoff",
  context: ({ input }) => ({ ...input, prompt: "Fix the bug.", earlier: [], rounds: [] }),
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
      on: { finished: "quick" },
    },
    quick: {
      invoke: {
        src: "quick",
        input: ({ context }) => ({ prompt: "Review the last commit.", cwd: coderTree(context), continue: true }),
      },
      on: {
        looks_good: "reading",
        fix_this: { target: "coding", actions: assign({ prompt: ({ event }) => `Change it: ${event.notes}` }) },
      },
    },
    reading: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event, context }) => isReady(event.output) && context.mode === "forged",
            target: "committingAgain",
            actions: assign({ handoff: ({ event }) => readyOf(event.output) }),
          },
          {
            guard: ({ event }) => isReady(event.output),
            target: "final",
            actions: assign({ handoff: ({ event }) => readyOf(event.output) }),
          },
          { target: "notCut" },
        ],
      },
    },
    final: {
      invoke: {
        src: "finalReview",
        input: ({ context }) => ({
          repo: context.repo,
          handoff: context.handoff!,
          earlier: context.earlier,
          publish: context.mode === "child",
        }),
        onDone: [
          {
            guard: ({ event, context }) => event.output.verdict === "pass" && context.mode === "parent",
            target: "lateCommit",
            actions: assign({
              rounds: ({ context, event }) => [...context.rounds, { handoff: context.handoff!, out: event.output }],
            }),
          },
          {
            guard: ({ event }) => event.output.verdict === "revise",
            target: "coding",
            actions: assign({
              rounds: ({ context, event }) => [...context.rounds, { handoff: context.handoff!, out: event.output }],
              earlier: ({ context, event }) =>
                event.output.verdict === "revise" ? [...context.earlier, event.output.notes] : context.earlier,
              prompt: ({ event }) =>
                event.output.verdict === "revise" ? `Change the fix as the review asks:\n\n${event.output.notes}` : "",
            }),
          },
          {
            target: "done",
            actions: assign({
              rounds: ({ context, event }) => [...context.rounds, { handoff: context.handoff!, out: event.output }],
            }),
          },
        ],
      },
    },
    // Mode "parent": a commit after the review, which the pin keeps off the remote.
    lateCommit: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: "Commit once more.", cwd: coderTree(context), continue: true }),
      },
      on: { finished: { target: "publishing", actions: assign({ named: ({ event }) => event.head }) } },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: coderTree(context), sha: context.handoff!.head }),
        onDone: { target: "done", actions: assign({ pushed: ({ event }) => event.output }) },
      },
    },
    // Mode "forged": the coder commits once more, and its pick names that commit.
    committingAgain: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: "Commit once more, and name the commit.",
          cwd: coderTree(context),
          continue: true,
        }),
      },
      on: { finished: { target: "forgedHead", actions: assign({ named: ({ event }) => event.head }) } },
    },
    // A Handoff whose head is the pick's word: no cut read that commit.
    forgedHead: {
      invoke: {
        src: "finalReview",
        input: ({ context }) => ({
          repo: context.repo,
          handoff: { ...context.handoff!, head: context.named ?? context.handoff!.head },
          earlier: [],
          publish: false,
        }),
        onDone: {
          target: "forgedBranch",
          actions: assign({
            rounds: ({ context, event }) => [
              ...context.rounds,
              { handoff: { ...context.handoff!, head: context.named ?? context.handoff!.head }, out: event.output },
            ],
          }),
        },
      },
    },
    // A Handoff whose branch is `main`: a nested push of it would publish to main.
    forgedBranch: {
      invoke: {
        src: "finalReview",
        input: ({ context }) => ({
          repo: context.repo,
          handoff: { ...context.handoff!, branch: "main" },
          earlier: [],
          publish: true,
        }),
        onDone: {
          target: "done",
          actions: assign({
            rounds: ({ context, event }) => [
              ...context.rounds,
              { handoff: { ...context.handoff!, branch: "main" }, out: event.output },
            ],
          }),
        },
      },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "an Agent's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
  output: ({ context }): Output => ({ rounds: context.rounds, ...(context.pushed ? { pushed: context.pushed } : {}) }),
});

export const machine = workspace(body, {
  input: door,
  effector: EFFECTOR,
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
});
