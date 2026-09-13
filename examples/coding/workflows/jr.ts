// jr's `start-work` orchestration (~/repos/jr) as a j2 Machine, on the ADR-0015..0017 surface.
// Every line is workflow: jr's semantics in xstate's grammar. The mechanism residue the previous
// revision carried is gone — offsets/agent.offset, endpoint/sandbox/iid threading (turn()/iid()),
// retry accounting (retriesLeft/spendRetry/retryOrEscalate/reenter), the events manifest,
// EventFrom unions, every cast, the hand-rolled top loop (active[]/spawnChild/stopChild/
// xstate.done.actor.*/discover/saturated/settling/idle), the spawnChild-placement footgun
// comment, the WorkspaceHandles alias apologia, and `stalled`. ~200 lines vs 681.
//
// Status: the Machine and all j2 wiring are REAL (this registers, visualizes, and runs against a
// live orchestrator with a Sandbox backend); the tk actors and openPr/pushBranch remain sketches
// — the workflow's own code, blocked on the tk consistency loop noted at the bottom.
//
//   jr                                         j2
//   -----------------------------------------  --------------------------------------------------
//   `just start-work` bash loop                pool(feature, { source: readyFeatures, cap })
//   discover(): tk ready each pass             the Source port re-querying tk (never materialized)
//   one-agent-per-worktree symlink lock        structural: one sequential body per feature
//   signals parsed from ticket notes           workflow-defined events, menus derived per state
//   `just approve` / `request-changes`         the humanReview gate's derived accepts
//   session-history.jsonl resume prompts       fresh sessions by default (jr's lossy handoff)
//   handle_no_signal budgeted resume           absorbed into the Agent actor; ONE terminal agent.fault
//   JR_MAX_CONCURRENT / REVIEW_ROUNDS          knobs on the run's input
//   exit 0 / 2 / 3                             pool triage: drained / deadlocked / waiting
//   env blockers fixed in the worktree         escalation PARKS a gate; resume re-enters the loop

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { agent, defineEvent, j2Setup, pool, source, workspace } from "@j2/orchestrator";
import { architect, coder, reviewer } from "./_agents.ts";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// Events — the workflow's vocabulary. `audience` declares who may deliver: agent events become
// the invoking state's tool menu; external events become the gate's accepted set. Derivation
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
  /** The repository the work is in — its url, which IS its identity (ADR-0051). The `workspace()`
   * below binds its per-run slot from this, and `j2.config.ts`'s credentials fence is what admits
   * it at attach: a ticket cannot point the cluster's token at an arbitrary host. */
  repo: string;
  baseRef: string;
  branch: string;
};

const tk = async (...args: string[]) => (await exec("tk", args)).stdout;

/** The next ready task in THIS feature's linear chain; null when the chain is complete. A
 * human-assigned next task surfaces as `stalled` — the body escalates rather than parks blind. */
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
// which appends `workspace: { workdir, repos, branch }` — the only handles a workflow needs;
// `repos.target` is the feature's repository, under the one slot the wrapper declares.

type BodyInput = {
  feature: Ticket;
  reviewRounds: number; // JR_REVIEW_ROUNDS (5)
  workspace: { workdir: string; repos: Record<"target", string>; branch: string };
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
  // Agents and Work-Source actors sit in ONE map: an Agent is an actor slot like any other
  // (ADR-0049), and `src` typing is what checks both.
  actors: {
    coder: agent(coder),
    reviewer: agent(reviewer),
    architect: agent(architect),
    claimNextTask,
    closeTicket,
    escalateTicket,
    pushBranch,
    openPr,
  },
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
            src: "coder",
            input: ({ context }) => ({ prompt: coderPrompt(context) }),
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
            src: "reviewer",
            input: ({ context }) => ({ prompt: reviewerPrompt(context) }),
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
        src: "architect",
        input: ({ context }) => ({ prompt: architectPrompt(context) }),
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
// Workspace: j2 owns Sandbox lifecycle; the spec speaks workspace vocabulary only, and the one
// Repo Slot is PER-RUN — the ticket names the repository (ADR-0051).

// No `input` schema: this wrapper is a pool WORKER, fed per-item by `itemInput` below and never
// by a caller (ADR-0033 — the pool declares the run's door), so there is no door to declare here.
// Permissive means j2 knows nothing about what starts it (`unknown`), so the mappers' parameter
// states what the pool feeds it — a claim about a private seam, not a door anything serves. State
// it in full: this is `itemInput`'s result below, which is also what `body` is fed, so a partial
// annotation would describe a seam neither end actually has.
type Item = { feature: Ticket; reviewRounds: number };
const feature = workspace(body, {
  repos: { target: ({ input }: { input: Item }) => ({ url: input.feature.repo, ref: input.feature.baseRef }) },
  spec: ({ input }: { input: Item }) => ({ branch: input.feature.branch }),
});

// ---------------------------------------------------------------------------------------------
// The run: one feature body per ready item, at most `cap` at once. The source owns "what's
// ready" (tk's re-queried ready-set — never materialized); pool owns spawn/collect/wake/drain,
// finals when the source is drained and children settled (jr exit 0), and reports deadlock
// (open-but-never-ready work) distinctly from healthy parking.

// The door (ADR-0033): jr's two env knobs, declared once on the machine a caller actually starts
// — served as JSON Schema, enforced at the door, and the source of the mapper types below. Both
// stay optional so a bare `j2 run` keeps jr's defaults.
const runInput = z.object({
  maxConcurrent: z.number().int().positive().optional().describe("Features worked at once. Default: 3."),
  reviewRounds: z.number().int().positive().optional().describe("Coder⇄reviewer rounds per task. Default: 5."),
});

const readyFeatures = source<Ticket>({
  next: fromPromise<Ticket | null, { active: string[] }>(async ({ input }) => {
    void (await tk("ready"));
    void input.active;
    return null; // sketch: next feature with unblocked agent-assigned work, excluding active
  }),
  wake: workReady, // a work-source webhook or `j2 send` wakes discovery early
  pollEvery: 30_000, // the ready-set mutates underneath us — re-query
});

export const machine = pool(feature, {
  id: "coding",
  input: runInput,
  source: readyFeatures,
  itemId: (t: Ticket) => t.id,
  // Both mappers read the PARSED door — inferred from the schema, annotated nowhere.
  cap: ({ input }) => input.maxConcurrent ?? 3, // JR_MAX_CONCURRENT
  itemInput: (t: Ticket, { input }) => ({
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

// ---------------------------------------------------------------------------------------------
// Deliberately open (unchanged from the previous revision):
//  - the tk consistency loop: the orchestrator's tk actors and the architect's in-Sandbox tk
//    edits must see each other's writes — the blocker behind the sketched actors above;
//  - stacked in-flight features (B branches off unmerged A) under the PR flow (jr had merge-all);
//  - investigator/triage as a shipped persona vs a docs pattern (it slots in as a consumer state
//    on the agent.fault route, receiving the reason).
