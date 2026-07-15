// coding.ts REWRITTEN against the proposed API — the success-bar exhibit.
// Every line is workflow: jr's semantics in xstate's grammar. What's gone: offsets/agent.offset,
// endpoint/sandbox/iid threading (turn()/iid()), retry accounting (retriesLeft/spendRetry/
// retryOrEscalate/reenter), the events manifest, EventFrom unions, every cast, the top-loop
// bookkeeping (active[]/spawnChild/stopChild/xstate.done.actor.*/discover/saturated/settling/
// idle), the spawnChild-placement footgun comment, the WorkspaceHandles alias apologia, stalled,
// and the GAP legend. ~200 lines vs 681.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent, j2Setup, pool, source, workspace } from "@j2/orchestrator";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// Events — the workflow's vocabulary. `audience` declares who may deliver: "agent" events become
// the invoking state's tool menu; "external" events become the gate's accepted set. Derivation
// from transitions is j2's job; MCP never appears here.

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the current task off for code review.",
  audience: "agent",
  input: z.object({ summary: z.string() }),
});
const reportBlocked = defineEvent({
  name: "report_blocked",
  description: "Cannot proceed (scope expansion or environment blocker). Escalates to a human.",
  audience: "agent",
  input: z.object({ reason: z.string() }),
});
const reviewVerdict = defineEvent({
  name: "review_verdict",
  description: "Deliver a review verdict on the current task or feature.",
  audience: "agent",
  input: z.object({ verdict: z.enum(["approved", "changes_requested"]), notes: z.string().optional() }),
});
const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });
const requestChanges = defineEvent({
  name: "request_changes",
  audience: "external",
  input: z.object({ notes: z.string() }),
});
const workReady = defineEvent({ name: "work_ready", audience: "external", input: z.object({}) });
const resume = defineEvent({ name: "resume", audience: "external", input: z.object({ note: z.string().optional() }) });
const dismiss = defineEvent({ name: "dismiss", audience: "external", input: z.object({}) });

// ---------------------------------------------------------------------------------------------
// tk actors — the workflow's own; jr's ticket hierarchy and semantics, unchanged.

type Ticket = {
  id: string;
  type: "task" | "feature";
  title: string;
  body: string;
  assignee: string;
  baseRef: string;
  branch: string;
};

const tk = async (...args: string[]) => (await exec("tk", args)).stdout;

/** The next ready task in THIS feature's linear chain; `stalled` when it's human-assigned. */
const claimNextTask = fromPromise<{ task: Ticket | null; stalled: boolean }, { featureId: string }>(
  async () => ({ task: null, stalled: false }), // sketch: tk ready filtered to parent
);
const closeTicket = fromPromise<void, { id: string }>(async ({ input }) => void (await tk("close", input.id)));
const escalateTicket = fromPromise<void, { id: string; reason: string }>(async ({ input }) => {
  await tk("assign", input.id, "human");
  await tk("add-note", input.id, `[orchestrator] Escalated to human: ${input.reason}`);
});
// Workflow-owned git: commits leave the Sandbox here, never via workspace().
const pushBranch = fromPromise<void, { workdir: string; branch: string }>(async () => {
  throw new Error("sketch: git push -u origin <branch>");
});
const openPr = fromPromise<{ url: string }, { workdir: string; branch: string; feature: Ticket }>(async () => {
  throw new Error("sketch: push + gh pr create");
});

// ---------------------------------------------------------------------------------------------
// The feature body: jr's per-ticket loop, sequential by construction. Runs inside a workspace,
// which appends `workspace: { workdir, repos, branch }` — the only handles a workflow needs.

type BodyInput = {
  feature: Ticket;
  reviewRounds: number; // JR_REVIEW_ROUNDS (5)
  workspace: { workdir: string; repos: Record<string, string>; branch: string };
};
type BodyCtx = BodyInput & {
  task?: Ticket;
  coderRounds: number;
  archRounds: number;
  reviewNotes?: string;
  prUrl?: string;
  escalateReason?: string;
  outcome?: "done" | "escalated";
};

export const body = j2Setup({
  types: {} as { context: BodyCtx; input: BodyInput; output: { status: "done" | "escalated"; feature: string } },
  events: [requestReview, reportBlocked, reviewVerdict, approve, requestChanges, resume, dismiss],
  actors: { claimNextTask, closeTicket, escalateTicket, pushBranch, openPr },
  guards: {
    underReviewCap: ({ context }: { context: BodyCtx }) => context.coderRounds < context.reviewRounds,
    underArchCap: ({ context }: { context: BodyCtx }) => context.archRounds < context.reviewRounds,
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, coderRounds: 0, archRounds: 0 }),
  initial: "working",

  // Sandbox reaped while we were down (jr policy): a human reopens via tk. Resuming would lie.
  on: { "workspace.lost": { target: ".escalated", actions: assign({ escalateReason: "workspace lost" }) } },

  states: {
    working: {
      initial: "claimTask",
      states: {
        claimTask: {
          invoke: {
            src: "claimNextTask",
            input: ({ context }) => ({ featureId: context.feature.id }),
            onDone: [
              {
                guard: ({ event }) => event.output.task !== null,
                target: "coding",
                actions: assign({
                  task: ({ event }) => event.output.task!,
                  coderRounds: 0, // jr: fresh review cycle per task
                  reviewNotes: undefined,
                }),
              },
              // Next task is human-assigned: hand the feature over rather than parking forever.
              {
                guard: ({ event }) => event.output.stalled,
                target: "#body.escalated",
                actions: assign({ escalateReason: "stalled on a human-assigned task" }),
              },
              // Chain complete → the feature itself is ready → architect (jr semantics).
              { target: "#body.architectReview" },
            ],
          },
        },

        // Each agent turn is a FRESH conversation (jr's lossy handoff: revision coders read the
        // notes + code, never the prior agent's context). Tools = this state's agent events.
        // A terminal agent.fault means j2 already retried infra faults and nudged silence.
        coding: {
          invoke: {
            src: "agentRun",
            input: ({ context }) => ({ agent: "coder", prompt: coderPrompt(context) }),
          },
          on: {
            request_review: { target: "reviewing" },
            report_blocked: {
              target: "#body.escalated",
              actions: assign({ escalateReason: ({ event }) => event.reason }),
            },
            "agent.fault": {
              target: "#body.escalated",
              actions: assign({ escalateReason: ({ event }) => event.reason }),
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
              { guard: ({ event }) => event.verdict === "approved", target: "closingTask" },
              {
                guard: "underReviewCap",
                target: "coding",
                actions: assign({
                  coderRounds: ({ context }) => context.coderRounds + 1,
                  reviewNotes: ({ event }) => event.notes,
                }),
              },
              {
                target: "#body.escalated",
                actions: assign({ escalateReason: "review-round cap reached" }),
              },
            ],
            report_blocked: {
              target: "#body.escalated",
              actions: assign({ escalateReason: ({ event }) => event.reason }),
            },
            "agent.fault": {
              target: "#body.escalated",
              actions: assign({ escalateReason: ({ event }) => event.reason }),
            },
          },
        },

        closingTask: {
          invoke: {
            src: "closeTicket",
            input: ({ context }) => ({ id: context.task!.id }),
            onDone: { target: "claimTask" }, // re-query the chain (jr: never materialize it)
          },
        },
      },
    },

    // The architect reviews the whole branch and edits the chain itself via tk (jr parity);
    // "changes requested" loops to working, which re-queries the chain it edited.
    architectReview: {
      invoke: {
        src: "agentRun",
        input: ({ context }) => ({ agent: "architect", prompt: architectPrompt(context) }),
      },
      on: {
        review_verdict: [
          {
            guard: ({ event }) => event.verdict === "approved",
            target: "openingPr",
            actions: assign({ archRounds: 0 }), // jr: counter resets on APPROVED
          },
          {
            guard: "underArchCap",
            target: "working",
            actions: assign({
              archRounds: ({ context }) => context.archRounds + 1,
              reviewNotes: ({ event }) => event.notes,
            }),
          },
          { target: "escalated", actions: assign({ escalateReason: "architect-round cap reached" }) },
        ],
        report_blocked: {
          target: "escalated",
          actions: assign({ escalateReason: ({ event }) => event.reason }),
        },
        "agent.fault": {
          target: "escalated",
          actions: assign({ escalateReason: ({ event }) => event.reason }),
        },
      },
    },

    openingPr: {
      invoke: {
        src: "openPr",
        input: ({ context }) => ({
          workdir: context.workspace.workdir,
          branch: context.workspace.branch,
          feature: context.feature,
        }),
        onDone: { target: "humanReview", actions: assign({ prUrl: ({ event }) => event.output.url }) },
        onError: { target: "escalated", actions: assign({ escalateReason: "failed to open PR" }) },
      },
    },

    // jr's exit-3 gate, parked and durable. Accepted events derive from this state's external
    // transitions; meta is what `j2 send`, the inbox UI, or a PR-merge webhook discovers.
    humanReview: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          gate: context.feature.id,
          meta: { prUrl: context.prUrl, title: context.feature.title },
        }),
      },
      on: {
        approve: { target: "closingFeature" },
        request_changes: {
          target: "architectReview", // jr: human rework starts a FRESH architect cycle
          actions: assign({ reviewNotes: ({ event }) => event.notes, archRounds: 0 }),
        },
      },
    },

    closingFeature: {
      invoke: {
        src: "closeTicket",
        input: ({ context }) => ({ id: context.feature.id }),
        onDone: { target: "settled", actions: assign({ outcome: "done" }) },
      },
    },

    // Escalation PARKS — jr ground truth: most escalations are environment issues the human
    // resolves INSIDE the environment, so the Sandbox must stay alive (parking-is-retention;
    // the User Container is the human's seat). Best-effort publish first, so a park reaped by
    // the idle-timeout GC still leaves the branch recoverable. `resume` re-enters the loop once
    // the human fixed the blocker (jr's coder re-entry protocol re-escalates if they didn't);
    // `dismiss` gives up and settles. Per-feature and non-halting — siblings keep running.
    escalated: {
      initial: "record",
      states: {
        record: {
          invoke: {
            src: "escalateTicket",
            input: ({ context }) => ({
              id: context.task?.id ?? context.feature.id,
              reason: context.escalateReason ?? "unspecified",
            }),
            onDone: { target: "publishBranch" },
          },
        },
        publishBranch: {
          invoke: {
            src: "pushBranch",
            input: ({ context }) => ({ workdir: context.workspace.workdir, branch: context.workspace.branch }),
            onDone: { target: "parked" },
            onError: { target: "parked" }, // nothing pushable — the live Sandbox is the only copy
          },
        },
        parked: {
          invoke: {
            src: "gate",
            input: ({ context }) => ({
              gate: context.feature.id,
              meta: { title: context.feature.title, reason: context.escalateReason },
            }),
          },
          on: {
            resume: { target: "#body.working" },
            dismiss: { target: "#body.settled", actions: assign({ outcome: "escalated" }) },
            // Sandbox reaped while parked: nothing left to inspect or resume into.
            "workspace.lost": { target: "#body.settled", actions: assign({ outcome: "escalated" }) },
          },
        },
      },
    },

    // One final state; reaching it is what tears the workspace down. Outcome rides context —
    // no done-event casts (the root output mapper's event is untyped by design in xstate).
    settled: { type: "final" },
  },
  output: ({ context }) => ({ status: context.outcome!, feature: context.feature.id }),
});

// ---------------------------------------------------------------------------------------------
// Workspace: j2 owns Sandbox lifecycle; the spec speaks workspace vocabulary only.

const feature = workspace(body, ({ input }: { input: { feature: Ticket } }) => ({
  repos: [{ name: "app", baseRef: input.feature.baseRef }],
  branch: input.feature.branch,
}));

// ---------------------------------------------------------------------------------------------
// The run: one feature body per ready item, at most `cap` at once. The source owns "what's
// ready" (tk's re-queried ready-set — never materialized); pool owns spawn/collect/wake/drain,
// finals when the source is drained and children settled (jr exit 0), and reports deadlock
// (open-but-never-ready work) distinctly from healthy parking.

const readyFeatures = source<Ticket>({
  next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
    void (await tk("ready"));
    void input.active;
    return null; // sketch: next feature with unblocked agent-assigned work, excluding active
  }),
  wake: workReady, // a work-source webhook or `j2 send` wakes discovery early
  pollEvery: 30_000, // the ready-set mutates underneath us — re-query
});

export const machine = pool(feature, {
  id: "coding",
  source: readyFeatures,
  itemId: (t: Ticket) => t.id,
  cap: ({ input }: { input: { maxConcurrent?: number } }) => input.maxConcurrent ?? 3, // JR_MAX_CONCURRENT
  itemInput: (t: Ticket, { input }: { input: { reviewRounds?: number } }) => ({
    feature: t,
    reviewRounds: input.reviewRounds ?? 5, // JR_REVIEW_ROUNDS
  }),
  onDrained: "final", // jr: runs terminate; pool output collects per-item {status, feature}
});

// --- Prompts (personas live in the Agent definitions; these are per-turn task framings) ------

function coderPrompt(c: BodyCtx): string {
  const feedback = c.reviewNotes ? `\n\nReview feedback to address:\n${c.reviewNotes}` : "";
  return `Implement task ${c.task!.id}: ${c.task!.title}\n\n${c.task!.body}${feedback}\n\nWork in ${c.workspace.workdir}. Commit with 'Tk-Task: ${c.task!.id}' trailers. Call request_review when done.`;
}
function reviewerPrompt(c: BodyCtx): string {
  return `Review task ${c.task!.id} (${c.task!.title}) on branch ${c.workspace.branch} in ${c.workspace.workdir}. Verify tests. Call review_verdict.`;
}
function architectPrompt(c: BodyCtx): string {
  return `Feature ${c.feature.id} (${c.feature.title}): all tasks closed. Review the full branch for coherence, acceptance criteria, regressions. You may reopen/create/re-chain tasks with tk, then call review_verdict.`;
}
