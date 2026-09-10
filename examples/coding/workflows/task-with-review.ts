// The MVP validation workflow: one run = one task prompt = one Workspace. Exists to exercise
// every j2 mechanism end to end (Sandbox provision/attach off the RO `default/` volume, agent
// turns, derived menus/accepts, Gate delivery, teardown-on-final) without jr.ts's Pool/Source/tk
// surface — the workflow-shaped equivalent of a smoke test. Filename → workflow "task-with-review".
//
// Input: the `runInput` schema below IS the contract — declared once, served as JSON Schema at
// `GET /workflows/task-with-review`, enforced at the door, and the source of every type here.
//
// Shape: coder ⇄ reviewer under a round cap, everything funneling into ONE `humanReview` Gate —
// the reviewer's approval, the cap running out, and a terminal agent.fault all park there (the
// park retains the Sandbox, so a human can exec in and inspect the diff — or push it — before
// deciding). `approve` reaches the final state, which is what tears the Workspace down; unpushed
// work is discarded by design. `request_changes` starts a fresh coder cycle.

import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, j2Setup, workspace, type Workspaced } from "@j2/orchestrator";
import { coder, reviewer } from "./_agents.ts";

// ---------------------------------------------------------------------------------------------
// The door (ADR-0033): what a caller sends to start a run, declared on the `workspace()` that is
// this workflow's root. One source of truth — the TypeScript types below derive from it, the
// Console generates its start form from it, and it types the spec mapper. `workspace` is
// deliberately absent: the handles are injected by the wrapper and no caller can send them.

const runInput = z.object({
  prompt: z.string().describe("The task for the coder, in prose."),
  repo: z.string().describe("A repo name from the instance's j2.config.ts catalog."),
  branch: z.string().describe("The branch to cut and work on."),
  baseRef: z.string().optional().describe("What the branch is cut from and reviewed against. Default: main."),
  reviewRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Coder⇄reviewer rounds before the run parks for a human. Default: 3."),
});
type RunInput = z.infer<typeof runInput>;

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
// The body. It receives the run input PLUS the handles `workspace()` injects — that composition
// is `Workspaced<RunInput>`, and it is exactly why the door is declared on the wrapper.
//
// `branch` appears on both halves and they are not the same claim: the door's is what the caller
// ASKED for, `workspace.branch` is the branch the attach actually made. The body reads
// `workspace.branch`, always — it is the fact.

type BodyCtx = Workspaced<RunInput> & {
  rounds: number;
  reviewNotes?: string;
  /** Why the run is parked at humanReview — rides the gate's meta. */
  gateReason?: "approved" | "review-cap" | "agent-fault";
  outcome?: "approved" | "lost";
};

const body = j2Setup({
  types: {} as {
    context: BodyCtx;
    input: Workspaced<RunInput>;
    output: { outcome: "approved" | "lost"; branch: string };
  },
  events: [requestReview, reviewVerdict, approve, requestChanges],
  // The two Agents this Machine carries (ADR-0049) — the slot key is the Agent's name.
  actors: { coder: agent(coder), reviewer: agent(reviewer) },
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
        src: "coder",
        input: ({ context }) => ({ prompt: coderPrompt(context) }),
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
        src: "reviewer",
        input: ({ context }) => ({ prompt: reviewerPrompt(context) }),
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

    // The one park. The gate id derives from the actor path (leaf = this state's key), so the
    // machine stays fan-out-safe if it is ever nested under a pool; accepts derive from this
    // state's external transitions; meta is what `j2 status` / the inbox UI shows. While parked
    // the Sandbox stays alive — inspect the worktree (and push, if the work should outlive the
    // run) BEFORE approving.
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

    // Reaching this is what tears the Workspace down (ADR-0012): approve means done with the pod.
    done: { type: "final" },
  },
  output: ({ context }) => ({ outcome: context.outcome ?? "approved", branch: context.workspace.branch }),
});

// ---------------------------------------------------------------------------------------------
// Workspace: the wrapper is this workflow's root, so its `input` is the run's door (ADR-0033) and
// `spec`'s argument is typed by it — nothing here restates a shape. The repo must match the
// instance's `j2.config.ts` catalog; a name with no `repos/<name>/default` volume fails at attach,
// not silently.

export const machine = workspace(body, {
  input: runInput,
  spec: ({ input }) => ({
    repos: [{ name: input.repo, baseRef: input.baseRef ?? "main" }],
    branch: input.branch,
  }),
});

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
