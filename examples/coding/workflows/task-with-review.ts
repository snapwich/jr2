// The MVP validation workflow: one run = one task prompt = one Workspace. Exists to exercise
// every j2 mechanism end to end (Sandbox provision/attach off the RO `default/` volume, agent
// turns, derived menus/accepts, Gate delivery, teardown-on-final) without jr.ts's Pool/Source/tk
// surface — the workflow-shaped equivalent of a smoke test. Filename → workflow "task-with-review".
//
// Input (all run input; repo must name a `j2.config.ts` catalog entry):
//   { prompt: string, repo: string, branch: string, baseRef?: string, reviewRounds?: number }
//
// Shape: coder ⇄ reviewer under a round cap, everything funneling into ONE `humanReview` Gate —
// the reviewer's approval, the cap running out, and a terminal agent.fault all park there (the
// park retains the Sandbox, so a human can exec in and inspect the diff — or push it — before
// deciding). `approve` reaches the final state, which is what tears the Workspace down; unpushed
// work is discarded by design. `request_changes` starts a fresh coder cycle.

import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, j2Setup, workspace } from "@j2/orchestrator";

// ---------------------------------------------------------------------------------------------
// Vocabulary: agent events become the invoking state's tool menu; external events become the
// gate's accepted set (ADR-0015 — derivation from transitions is j2's job).

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the completed (committed) work off for code review.",
  audience: "agent",
  input: z.object({ summary: z.string() }),
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
// The body. `workspace()` appends `workspace: { workdir, repos, branch }` to the run input.

type BodyInput = {
  prompt: string;
  repo: string;
  branch: string;
  baseRef?: string;
  reviewRounds?: number;
  workspace: { workdir: string; repos: Record<string, string>; branch: string };
};
type BodyCtx = BodyInput & {
  rounds: number;
  reviewNotes?: string;
  /** Why the run is parked at humanReview — rides the gate's meta. */
  gateReason?: "approved" | "review-cap" | "agent-fault";
  outcome?: "approved" | "lost";
};

const body = j2Setup({
  types: {} as { context: BodyCtx; input: BodyInput; output: { outcome: "approved" | "lost"; branch: string } },
  events: [requestReview, reviewVerdict, approve, requestChanges],
  guards: {
    underReviewCap: ({ context }: { context: BodyCtx }) => context.rounds < (context.reviewRounds ?? 3),
  },
}).createMachine({
  id: "task-with-review",
  context: ({ input }) => ({ ...input, rounds: 0 }),
  initial: "coding",

  // Sandbox reaped while we were down: the pod-local worktree is gone, nothing to resume into.
  on: { "workspace.lost": { target: ".done", actions: assign({ outcome: "lost" }) } },

  states: {
    // Each turn is a fresh conversation; revision coders read the notes + code, not the prior
    // agent's context. A terminal agent.fault (j2 already retried/nudged) parks for a human.
    coding: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "coder", prompt: coderPrompt(context) }),
      },
      on: {
        request_review: { target: "reviewing" },
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

    // The one park. Accepts derive from this state's external transitions; meta is what
    // `j2 status` / the inbox UI shows. While parked the Sandbox stays alive — inspect the
    // worktree (and push, if the work should outlive the run) BEFORE approving.
    humanReview: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          gate: "humanReview",
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

    // Reaching this is what tears the Workspace down (ADR-0012): approve means done with the pod.
    done: { type: "final" },
  },
  output: ({ context }) => ({ outcome: context.outcome ?? "approved", branch: context.workspace.branch }),
});

// ---------------------------------------------------------------------------------------------
// Workspace: the repo is run input (must match the instance's `j2.config.ts` catalog); a name
// with no `repos/<name>/default` volume fails at attach, not silently.

export const machine = workspace(body, ({ input }: { input: { repo: string; branch: string; baseRef?: string } }) => ({
  repos: [{ name: input.repo, baseRef: input.baseRef ?? "main" }],
  branch: input.branch,
}));

// --- Prompts (personas live in the Agent definitions; these are per-turn task framings) ------

function coderPrompt(c: BodyCtx): string {
  const feedback = c.reviewNotes ? `\n\nReview feedback to address:\n${c.reviewNotes}` : "";
  return (
    `${c.prompt}${feedback}\n\n` +
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
