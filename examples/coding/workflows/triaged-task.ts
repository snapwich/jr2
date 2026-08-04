// The ADR-0031 validation vehicle: task-with-review with a Menu-only triager in front. One
// conversation of decisions frames the whole run. The "triage" state runs BEFORE any workspace()
// exists — the triager's `workspace: "none"` places its Turn on the Instance Harness, the only
// Harness a Menu-only Agent ever sees — and either ANSWERS the task in place (the run finishes
// without a Sandbox ever existing) or routes to code. The "assess" state inside the body then
// CONTINUES that same conversation (`conversation: "triage"` pins one instance id across the two
// machines — the cross-machine continue, ADR-0016), and definition-wins placement is what makes
// the continuation sound: wherever the invocation sits, the Turn lands on the server that holds
// the history (ADR-0031). Filename → workflow "triaged-task".
//
// Input (all run input; repo must name a `j2.config.ts` catalog entry):
//   { prompt: string, repo: string, branch: string, baseRef?: string, reviewRounds?: number }
//
// Shape: triage → answer (done, no Workspace) | code (enter the workspace() body). Body:
// coder → assess (the triager again: ship | review) — ship goes straight to the humanReview
// gate; review runs the reviewer, whose verdict flows exactly as task-with-review's, everything
// funneling into the ONE gate under the same round cap. Reaching final tears the Workspace down.

import { assign, emit } from "xstate";
import { z } from "zod";
import { defineEvent, j2Setup, workspace } from "@j2/orchestrator";

// ---------------------------------------------------------------------------------------------
// Vocabulary (ADR-0015). ONE list serves both machines: the exported (top) machine's vocabulary
// is what the host binds for the whole run, so it takes the FULL set — the body's events
// included, or the body's menus would fail resolution at invoke time; the body's own j2Setup
// takes the subset its states handle.

const answer = defineEvent({
  name: "answer",
  description: "Answer the task outright; the run finishes and no Workspace is ever provisioned.",
  audience: "agent",
  input: z.object({ answer: z.string() }),
});
const code = defineEvent({
  name: "code",
  description: "The task needs code changes: provision a Workspace and hand it to the coder.",
  audience: "agent",
  input: z.object({ reason: z.string() }),
});
const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the completed (committed) work back for the triager's assessment.",
  audience: "agent",
  input: z.object({ summary: z.string() }),
});
const ship = defineEvent({
  name: "ship",
  description: "The committed work is ready as-is: skip machine review and park it for the human.",
  audience: "agent",
  input: z.object({}),
});
const review = defineEvent({
  name: "review",
  description: "Run a machine review round on the committed work before the human sees it.",
  audience: "agent",
  input: z.object({}),
});
const reviewVerdict = defineEvent({
  name: "review_verdict",
  description: "Deliver a review verdict on the branch.",
  audience: "agent",
  input: z.object({ verdict: z.enum(["approved", "changes_requested"]), notes: z.string().optional() }),
});
const approve = defineEvent({
  name: "approve",
  description: "Accept the work; the run finishes and the Workspace is torn down.",
  audience: "external",
  input: z.object({}),
});
const requestChanges = defineEvent({
  name: "request_changes",
  description: "Send the work back to the coder with notes; review rounds start fresh.",
  audience: "external",
  input: z.object({ notes: z.string() }),
});

// ---------------------------------------------------------------------------------------------
// The body — task-with-review's loop with the triager's "assess" seat between coder and
// reviewer. `workspace()` appends `workspace: { workdir, repos, branch }` to the run input.

type BodyInput = {
  prompt: string;
  repo: string;
  branch: string;
  baseRef?: string;
  reviewRounds?: number;
  /** Why the triager routed here — frames the coder's task alongside the prompt. */
  reason: string;
  workspace: { workdir: string; repos: Record<string, string>; branch: string };
};
type BodyCtx = BodyInput & {
  rounds: number;
  /** The coder's request_review summary — what the assess turn reports to the triager. */
  summary?: string;
  reviewNotes?: string;
  /** Why the run is parked at humanReview — rides the gate's meta. */
  gateReason?: "shipped" | "approved" | "review-cap" | "agent-fault";
  outcome?: "approved" | "lost";
};
type BodyOutput = { outcome: "approved" | "lost"; branch: string };

/** Exported for the mechanics test (jr precedent): the body is drivable under a fake Sandbox
 * port with a mock agent port, which the wrapped export's baked-in slots cannot offer. */
export const body = j2Setup({
  types: {} as { context: BodyCtx; input: BodyInput; output: BodyOutput },
  events: [requestReview, ship, review, reviewVerdict, approve, requestChanges],
  guards: {
    underReviewCap: ({ context }: { context: BodyCtx }) => context.rounds < (context.reviewRounds ?? 3),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, rounds: 0 }),
  initial: "coding",

  // Sandbox reaped while we were down: the pod-local worktree is gone, nothing to resume into.
  on: { "workspace.lost": { target: ".done", actions: assign({ outcome: "lost" }) } },

  states: {
    // Each coder turn is a fresh conversation (jr's lossy handoff); the triager's is the ONE
    // continued conversation in the run. A terminal agent.fault parks for a human.
    coding: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "coder", prompt: coderPrompt(context) }),
      },
      on: {
        request_review: { target: "assess", actions: assign({ summary: ({ event }) => event.summary }) },
        "agent.fault": {
          target: "humanReview",
          actions: assign({ gateReason: "agent-fault", reviewNotes: ({ event }) => event.reason }),
        },
      },
    },

    // The SAME triager, CONTINUING the triage conversation: the `conversation` pin derives the
    // identical instance id the triage state minted, so this prompt lands as the next user turn
    // of that conversation — on the Instance Harness, which held it all along (definition-wins;
    // an ambient Workspace endpoint would be a different server mid-conversation).
    assess: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "triager", prompt: assessPrompt(context), conversation: "triage" }),
      },
      on: {
        ship: { target: "humanReview", actions: assign({ gateReason: "shipped" }) },
        review: { target: "reviewing" },
        "agent.fault": {
          target: "humanReview",
          actions: assign({ gateReason: "agent-fault", reviewNotes: ({ event }) => event.reason }),
        },
      },
    },

    reviewing: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "reviewer", prompt: reviewerPrompt(context) }),
      },
      on: {
        review_verdict: [
          {
            guard: ({ event }) => event.verdict === "approved",
            target: "humanReview",
            actions: assign({ gateReason: "approved", reviewNotes: ({ event }) => event.notes }),
          },
          {
            guard: "underReviewCap",
            target: "coding",
            actions: assign({
              rounds: ({ context }) => context.rounds + 1,
              reviewNotes: ({ event }) => event.notes,
            }),
          },
          {
            target: "humanReview",
            actions: assign({ gateReason: "review-cap", reviewNotes: ({ event }) => event.notes }),
          },
        ],
        "agent.fault": {
          target: "humanReview",
          actions: assign({ gateReason: "agent-fault", reviewNotes: ({ event }) => event.reason }),
        },
      },
    },

    // The one park (task-with-review's): shipped, approved, cap-out and agent-fault all funnel
    // here; the park retains the Sandbox so a human can inspect (or push) before deciding.
    humanReview: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            reason: context.gateReason,
            notes: context.reviewNotes,
            branch: context.workspace.branch,
            workdir: context.workspace.workdir,
          },
        }),
      },
      on: {
        approve: { target: "done", actions: assign({ outcome: "approved" }) },
        request_changes: {
          target: "coding",
          actions: assign({ reviewNotes: ({ event }) => event.notes, rounds: 0, gateReason: undefined }),
        },
      },
    },

    // Reaching this is what tears the Workspace down (ADR-0012).
    done: { type: "final" },
  },
  output: ({ context }) => ({ outcome: context.outcome ?? "approved", branch: context.workspace.branch }),
});

// Workspace: the repo is run input (must match the instance's `j2.config.ts` catalog).
const work = workspace(body, ({ input }: { input: { repo: string; branch: string; baseRef?: string } }) => ({
  repos: [{ name: input.repo, baseRef: input.baseRef ?? "main" }],
  branch: input.branch,
}));

// ---------------------------------------------------------------------------------------------
// The top machine: triage OUTSIDE the workspace() — no Sandbox exists until the triager says
// the task needs one, and the "answer" route never provisions anything at all.

type RunInput = { prompt: string; repo: string; branch: string; baseRef?: string; reviewRounds?: number };
type TopCtx = RunInput & {
  answer?: string;
  reason?: string;
  outcome?: "answered" | "approved" | "lost" | "triage-fault";
};

export const machine = j2Setup({
  types: {} as {
    context: TopCtx;
    input: RunInput;
    output: { outcome: "answered" | "approved" | "lost" | "triage-fault"; answer?: string; branch: string };
    emitted: { type: "triage.decided"; route: "answer" | "code"; reason?: string };
  },
  events: [answer, code, requestReview, ship, review, reviewVerdict, approve, requestChanges],
  actors: { work },
}).createMachine({
  id: "triaged-task",
  context: ({ input }) => ({ ...input }),
  initial: "triage",
  states: {
    // The pinned conversation starts here; "assess" continues it from inside the body. Either
    // route lands "triage.decided" on the feed BEFORE the target state starts — so on the code
    // route it is already in the feed-so-far a Workspace attach replays as its log's preamble
    // (ADR-0023: why this Workspace exists).
    triage: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "triager", prompt: triagePrompt(context), conversation: "triage" }),
      },
      on: {
        answer: {
          target: "done",
          actions: [
            assign({ answer: ({ event }) => event.answer, outcome: "answered" }),
            emit({ type: "triage.decided", route: "answer" }),
          ],
        },
        code: {
          target: "working",
          actions: [
            assign({ reason: ({ event }) => event.reason }),
            emit(({ event }) => ({ type: "triage.decided" as const, route: "code" as const, reason: event.reason })),
          ],
        },
        // A triage fault settles the run: there is no Workspace to retain and nothing a park
        // would let a human inspect — re-running is the recovery.
        "agent.fault": { target: "done", actions: assign({ outcome: "triage-fault" }) },
      },
    },

    working: {
      invoke: {
        src: "work",
        // The wrapper is AnyStateMachine (its input is untyped at this seam), so the mapper
        // names its own context type.
        input: ({ context }: { context: TopCtx }) => ({
          prompt: context.prompt,
          repo: context.repo,
          branch: context.branch,
          baseRef: context.baseRef,
          reviewRounds: context.reviewRounds,
          reason: context.reason!,
        }),
        onDone: {
          target: "done",
          // The wrapper's output is the body's, verbatim (ADR-0012); untyped on the wire, so the
          // one cast names the body's own output type.
          actions: assign({ outcome: ({ event }) => (event.output as BodyOutput).outcome }),
        },
      },
    },

    done: { type: "final" },
  },
  output: ({ context }) => ({
    outcome: context.outcome ?? "answered",
    ...(context.answer !== undefined ? { answer: context.answer } : {}),
    branch: context.branch,
  }),
});

// --- Prompts (personas live in the Agent definitions; these are per-turn task framings) ------

function triagePrompt(c: RunInput): string {
  return (
    `Triage this task for repo ${c.repo}:\n\n${c.prompt}\n\n` +
    `If it can be answered outright — a question, a lookup, a judgment call — call answer with ` +
    `the complete answer. If it needs changes to the code, call code with a short reason: a ` +
    `coder then gets a Workspace on branch ${c.branch}, and your reason frames its task.`
  );
}
function assessPrompt(c: BodyCtx): string {
  return (
    `You routed this task to code (your reason: ${c.reason}). The coder has committed work on ` +
    `branch ${c.workspace.branch} and summarized it:\n\n${c.summary ?? "(no summary)"}\n\n` +
    `Decide how it reaches the human: call ship to park it for human review as-is, or review ` +
    `to run a machine review round first.`
  );
}
function coderPrompt(c: BodyCtx): string {
  const feedback = c.reviewNotes ? `\n\nReview feedback to address:\n${c.reviewNotes}` : "";
  return (
    `${c.prompt}\n\nTriage routed this to code: ${c.reason}${feedback}\n\n` +
    `Work in ${c.workspace.workdir} on branch ${c.workspace.branch}. ` +
    `Commit your work, then call request_review.`
  );
}
function reviewerPrompt(c: BodyCtx): string {
  return (
    `Review the work on branch ${c.workspace.branch} in ${c.workspace.workdir} ` +
    `(diff against ${c.baseRef ?? "main"}) for this task:\n\n${c.prompt}\n\n` +
    `Verify it builds/tests where possible. Call review_verdict.`
  );
}
