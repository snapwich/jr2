// The Workspace child Machine — a TEMPLATE (ADR-0003). One per claimed feature;
// its lifecycle IS the Sandbox's life (CONTEXT.md: Workspace).
//
//   creatingSandbox → settingUpWorktree → ┌─ claimingTask ──(none)──▶ cleanup
//                                         │     │ task
//                                         │  injectingMemory   (noop slot, in place)
//                                         │     │
//                                         │   coding ──requestReview──▶ reviewing
//                                         │     │  ▲ requestApproval        │
//                                         │     │  └ waitingForApproval      │ approve → close+loop
//                                         │     ├ done ─────────▶ close task + loop
//                                         │     └ reportBlocked ─▶ cleanup   │ requestChanges
//                                         └───────◀── coding (round+1, while round<max) ─┘
//                                                                  else escalate → loop
//   cleanup → done(final) ─entry▶ sendParent FEATURE_DONE
//
// Invariants: ONE Agent at a time per Workspace (ADR-0004 inv. 2 — coder and
// reviewer take strictly sequential turns; never concurrent). The reviewer runs
// on a FRESH Instance ID (separate session, not the coder's). Context is plain
// serializable data — ids/counters/handles, no live actor refs (#7 seam).

import { setup, assign, sendTo, sendParent, fromPromise, fromCallback } from "xstate";
import type { Feature, Lease, TaskStatus, ClaimedTask, ClaimTaskInput } from "./work-source.ts";
import type {
  SandboxHandle,
  WorktreeHandle,
  CreateSandboxInput,
  SetupWorktreeInput,
  CleanupSandboxInput,
  AgentTurnInput,
  AgentDown,
} from "./slots.ts";
import type { InnerLoopEvent } from "./control-surface.ts";

export interface WorkspaceInput {
  feature: Feature;
  /** Holder identity presented when claiming this feature's tasks (the lease). */
  holder: string;
  branch: string;
  /** Max change-request cycles before a task is escalated (cf. jr's JR_REVIEW_ROUNDS). */
  reviewRoundsMax: number;
}

export interface WorkspaceContext {
  featureId: string;
  holder: string;
  branch: string;
  reviewRoundsMax: number;
  // filled as the run progresses (all plain data):
  sandbox?: SandboxHandle;
  worktree?: WorktreeHandle;
  taskId?: string;
  taskLease?: Lease;
  reviewRound: number;
  reviewNotes?: string;
  memoryInjected?: boolean;
  pendingApproval?: { action: string; reason?: string };
  outcome: string;
}

type WorkspaceEvent =
  | InnerLoopEvent
  | { type: "actor.admitted"; instanceId: string; offset: string; submissionId: string }
  | { type: "actor.telemetry"; instanceId: string; kind: string; detail?: string }
  | { type: "actor.settled"; instanceId: string; outcome: string }
  | { type: "actor.error"; instanceId: string; message: string };

// Placeholder slot defaults — referenced by the template, overridden by
// `provide()`. Required slots throw if left unfilled (fail-fast capability
// check); the memory slot's default is the meaningful NOOP that sits in place.
const unfilled = <TOut, TIn>(slot: string) =>
  fromPromise<TOut, TIn>(async () => {
    throw new Error(`coding slot "${slot}" was not provided`);
  });
const unfilledAgent = fromCallback<AgentDown, AgentTurnInput>(({ input }) => {
  throw new Error(`agent slot "${input.role}" was not provided`);
});

export const workspaceTemplate = setup({
  types: {
    context: {} as WorkspaceContext,
    input: {} as WorkspaceInput,
    events: {} as WorkspaceEvent,
  },
  actors: {
    createSandbox: unfilled<SandboxHandle, CreateSandboxInput>("createSandbox"),
    setupWorktree: unfilled<WorktreeHandle, SetupWorktreeInput>("setupWorktree"),
    claimNextTask: unfilled<ClaimedTask | null, ClaimTaskInput>("claimNextTask"),
    cleanupSandbox: unfilled<void, CleanupSandboxInput>("cleanupSandbox"),
    // Optional pre-coding memory slot. DEFAULT = passthrough noop, sitting in
    // the right position. Inject a real provider to activate it in place,
    // WITHOUT changing this template (the ADR-0003 property).
    injectMemory: fromPromise(async () => ({ injected: false }) as { injected: boolean }),
    coder: unfilledAgent,
    reviewer: unfilledAgent,
  },
  actions: {
    // Work-source writes — fire-and-ack. Overridden by `provide()` to hit the
    // injected port; default is a noop so the bare template still runs.
    updateTaskStatus: (_e, _p: { status: TaskStatus }) => {},
    comment: (_e, _p: { body: string }) => {},
    // The approval policy answers a coder's `request_approval`. Default =
    // auto-approve, so the gate round-trips without a human in mock runs.
    answerApproval: sendTo("coder", { type: "APPROVE", decision: "APPROVED" } as AgentDown),
  },
  guards: {
    // Another change-request cycle is allowed while under the cap.
    canRetryReview: ({ context }) => context.reviewRound < context.reviewRoundsMax,
  },
}).createMachine({
  id: "workspace",
  context: ({ input }) => ({
    featureId: input.feature.id,
    holder: input.holder,
    branch: input.branch,
    reviewRoundsMax: input.reviewRoundsMax,
    reviewRound: 0,
    outcome: "pending",
  }),
  initial: "creatingSandbox",
  states: {
    creatingSandbox: {
      invoke: {
        src: "createSandbox",
        input: ({ context }) => ({ featureId: context.featureId }),
        onDone: {
          target: "settingUpWorktree",
          actions: assign({ sandbox: ({ event }) => event.output as SandboxHandle }),
        },
        onError: { target: "cleanup", actions: assign({ outcome: "sandbox-failed" }) },
      },
    },

    settingUpWorktree: {
      invoke: {
        src: "setupWorktree",
        input: ({ context }) => ({
          sandbox: context.sandbox!,
          featureId: context.featureId,
          branch: context.branch,
        }),
        onDone: {
          target: "claimingTask",
          actions: assign({ worktree: ({ event }) => event.output as WorktreeHandle }),
        },
        onError: { target: "cleanup", actions: assign({ outcome: "worktree-failed" }) },
      },
    },

    // Re-query the work source for the next task (never materialize the list).
    claimingTask: {
      invoke: {
        src: "claimNextTask",
        input: ({ context }) => ({ featureId: context.featureId, holder: context.holder }),
        onDone: [
          {
            guard: ({ event }) => event.output !== null,
            target: "injectingMemory",
            actions: assign({
              taskId: ({ event }) => event.output!.task.id,
              taskLease: ({ event }) => event.output!.lease,
              reviewRound: 0,
              reviewNotes: undefined,
            }),
          },
          // No more tasks → the feature is complete. Tear down the Sandbox.
          { target: "cleanup", actions: assign({ outcome: "feature-complete" }) },
        ],
        onError: { target: "cleanup", actions: assign({ outcome: "claim-failed" }) },
      },
    },

    // The optional memory slot, in its fixed position. Noop default passes
    // straight through; a real provider does work here without a template edit.
    injectingMemory: {
      invoke: {
        src: "injectMemory",
        input: ({ context }) => ({ featureId: context.featureId, taskId: context.taskId! }),
        onDone: {
          target: "coding",
          actions: assign({ memoryInjected: ({ event }) => (event.output as { injected: boolean }).injected }),
        },
        onError: { target: "coding" },
      },
    },

    coding: {
      invoke: {
        id: "coder",
        src: "coder",
        input: ({ context }): AgentTurnInput => ({
          role: "coder",
          instanceId: `${context.featureId}:${context.taskId}:coder`,
          prompt:
            context.reviewRound === 0
              ? `Implement task ${context.taskId}.`
              : `Address review feedback for task ${context.taskId}: ${context.reviewNotes ?? ""}`,
          featureId: context.featureId,
          taskId: context.taskId!,
          round: context.reviewRound,
        }),
      },
      on: {
        "agent.requestReview": "reviewing",
        "agent.done": {
          target: "claimingTask",
          actions: [{ type: "updateTaskStatus", params: { status: "done" } }],
        },
        "agent.reportBlocked": {
          target: "cleanup",
          actions: [
            { type: "updateTaskStatus", params: { status: "blocked" } },
            assign({ outcome: ({ event }) => `blocked: ${event.reason}` }),
          ],
        },
      },
      initial: "working",
      states: {
        working: {
          on: {
            "agent.requestApproval": {
              target: "waitingForApproval",
              actions: assign({
                pendingApproval: ({ event }) => ({ action: event.action, reason: event.reason }),
              }),
            },
          },
        },
        // Solicited approval gate. The injected `answerApproval` policy sends the
        // decision DOWN to the coder; the coder's next pick bubbles to `coding`.
        waitingForApproval: {
          entry: "answerApproval",
        },
      },
    },

    reviewing: {
      invoke: {
        id: "reviewer",
        src: "reviewer",
        // FRESH reviewer Instance ID (per round) — never the coder's session.
        input: ({ context }): AgentTurnInput => ({
          role: "reviewer",
          instanceId: `${context.featureId}:${context.taskId}:reviewer:${context.reviewRound}`,
          prompt: `Review task ${context.taskId} (round ${context.reviewRound}).`,
          featureId: context.featureId,
          taskId: context.taskId!,
          round: context.reviewRound,
        }),
      },
      on: {
        "agent.approve": {
          target: "claimingTask",
          actions: [{ type: "updateTaskStatus", params: { status: "done" } }],
        },
        "agent.requestChanges": [
          {
            guard: "canRetryReview",
            target: "coding",
            actions: assign({
              reviewRound: ({ context }) => context.reviewRound + 1,
              reviewNotes: ({ event }) => event.notes,
            }),
          },
          // Cap exceeded → escalate: mark the task blocked and move on. The
          // daemon never spins forever on one task.
          {
            target: "claimingTask",
            actions: [
              { type: "updateTaskStatus", params: { status: "blocked" } },
              { type: "comment", params: { body: "review-round cap exceeded; escalating" } },
              assign({ outcome: "review-cap-exceeded" }),
            ],
          },
        ],
      },
    },

    cleanup: {
      invoke: {
        src: "cleanupSandbox",
        input: ({ context }) => ({ sandbox: context.sandbox! }),
        onDone: "done",
        onError: "done", // teardown is best-effort
      },
    },

    done: {
      type: "final",
      entry: sendParent(({ context }) => ({
        type: "FEATURE_DONE" as const,
        featureId: context.featureId,
        outcome: context.outcome,
      })),
    },
  },
});

export type WorkspaceMachine = typeof workspaceTemplate;
