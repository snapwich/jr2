// Mock providers — the test doubles that fill the coding template's slots with
// NO infra (no k8s, no flue). They emit the SAME up-events the real providers
// would, so the template is exercised end-to-end; the mock↔real swap (later) is
// just substituting one entry. Agents are scripted but every pick is guarded by
// `assertInMenu` — proving the ADR-0006 invariant (the Agent only ever emits an
// event the current state's menu allows).

import { fromCallback, fromPromise } from "xstate";
import { CODER_MENU, REVIEWER_MENU, assertInMenu } from "../control-surface.ts";
import type {
  AgentTurnInput,
  AgentDown,
  SandboxHandle,
  WorktreeHandle,
  CreateSandboxInput,
  SetupWorktreeInput,
  CleanupSandboxInput,
  MemoryInput,
  MemoryResult,
} from "../slots.ts";
import { makeWorkSourceProviders } from "../work-source.ts";
import type { InMemoryWorkSource } from "./mock-work-source.ts";
import type { CodingProviders } from "../index.ts";

// --- observability ----------------------------------------------------------

export interface MockTracker {
  sandboxCreated: string[]; // featureIds
  sandboxCleaned: string[]; // sandbox ids
  /** Peak live Sandboxes (created − cleaned) — proves the maxConcurrent cap. */
  peakConcurrent: number;
  memoryInjected: { featureId: string; taskId: string }[];
  coderTurns: { taskId: string; round: number; instanceId: string }[];
  reviewerTurns: { taskId: string; round: number; instanceId: string }[];
}
export function newTracker(): MockTracker {
  return {
    sandboxCreated: [],
    sandboxCleaned: [],
    peakConcurrent: 0,
    memoryInjected: [],
    coderTurns: [],
    reviewerTurns: [],
  };
}

/** A releasable barrier — lets a test hold Agents busy to observe concurrency. */
export class Barrier {
  private resolvers: (() => void)[] = [];
  private opened = false;
  wait(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise((r) => this.resolvers.push(r));
  }
  release(): void {
    this.opened = true;
    this.resolvers.splice(0).forEach((r) => r());
  }
}

// --- readiness (poll vs push) ----------------------------------------------

/** Push readiness: fire `WORK_READY` whenever the ready-set becomes non-empty. */
export function pushReadiness(source: InMemoryWorkSource) {
  return fromCallback(({ sendBack }) => {
    const fire = () => sendBack({ type: "WORK_READY" });
    if (source.ready().length > 0) fire(); // already work waiting at subscribe time
    return source.onReady(fire); // unsubscribe on stop
  });
}

/** Poll readiness: the real-world default — poll the ready-set on an interval. */
export function pollReadiness(source: InMemoryWorkSource, intervalMs = 20) {
  return fromCallback(({ sendBack }) => {
    const tick = () => {
      if (source.ready().length > 0) sendBack({ type: "WORK_READY" });
    };
    tick();
    const h = setInterval(tick, intervalMs);
    return () => clearInterval(h);
  });
}

// --- Sandbox / worktree / memory -------------------------------------------

export function makeMockCreateSandbox(tracker?: MockTracker) {
  return fromPromise<SandboxHandle, CreateSandboxInput>(async ({ input }) => {
    if (tracker) {
      tracker.sandboxCreated.push(input.featureId);
      const live = tracker.sandboxCreated.length - tracker.sandboxCleaned.length;
      tracker.peakConcurrent = Math.max(tracker.peakConcurrent, live);
    }
    return { id: `sbx-${input.featureId}`, endpoint: `mock://sandbox/${input.featureId}` };
  });
}

export function makeMockCleanupSandbox(tracker?: MockTracker) {
  return fromPromise<void, CleanupSandboxInput>(async ({ input }) => {
    tracker?.sandboxCleaned.push(input.sandbox.id);
  });
}

export const mockWorktree = fromPromise<WorktreeHandle, SetupWorktreeInput>(async ({ input }) => ({
  path: `mock://worktree/${input.branch}`,
  defaultRepo: `mock://default`,
  branch: input.branch,
}));

/** An ACTIVE memory provider (vs the template's passthrough noop default). */
export function makeMockMemory(tracker?: MockTracker) {
  return fromPromise<MemoryResult, MemoryInput>(async ({ input }) => {
    tracker?.memoryInjected.push({ featureId: input.featureId, taskId: input.taskId });
    return { injected: true, note: `recalled memory for ${input.taskId}` };
  });
}

// --- scripted agents --------------------------------------------------------

export type CoderAction =
  | { emit: "request_review"; summary?: string }
  | { emit: "done"; summary?: string }
  | { emit: "report_blocked"; reason: string }
  | { emit: "request_approval"; action: string; reason?: string };

export type ReviewerAction = { emit: "approve" } | { emit: "request_changes"; notes: string };

/** Per-turn coder behavior. Receives the turn input (role/task/round/instanceId). */
export type CoderScript = (turn: AgentTurnInput) => CoderAction[];
export type ReviewerScript = (turn: AgentTurnInput) => ReviewerAction;

/**
 * A mock coder Actor — same `fromCallback` shape as the real `agentRunActor`.
 * Emits its scripted actions in order; a `request_approval` BLOCKS until the
 * Machine answers (APPROVE/DENY down), modelling the solicited gate.
 */
export function makeMockCoder(script: CoderScript, tracker?: MockTracker) {
  return fromCallback<AgentDown, AgentTurnInput>(({ sendBack, receive, input }) => {
    tracker?.coderTurns.push({ taskId: input.taskId, round: input.round, instanceId: input.instanceId });
    let resolveDown: ((e: AgentDown) => void) | null = null;
    receive((e) => {
      const r = resolveDown;
      resolveDown = null;
      r?.(e);
    });
    const waitDown = () => new Promise<AgentDown>((res) => (resolveDown = res));

    let stopped = false;
    void (async () => {
      for (const a of script(input)) {
        if (stopped) return;
        assertInMenu(CODER_MENU, a.emit); // ADR-0006: only menu picks
        switch (a.emit) {
          case "request_approval":
            sendBack({
              type: "agent.requestApproval",
              instanceId: input.instanceId,
              action: a.action,
              reason: a.reason,
            });
            await waitDown(); // block on the held decision
            break;
          case "request_review":
            sendBack({
              type: "agent.requestReview",
              instanceId: input.instanceId,
              summary: a.summary ?? `review ${input.taskId}`,
            });
            break;
          case "done":
            sendBack({ type: "agent.done", instanceId: input.instanceId, summary: a.summary });
            break;
          case "report_blocked":
            sendBack({ type: "agent.reportBlocked", instanceId: input.instanceId, reason: a.reason });
            break;
        }
      }
    })();

    return () => {
      stopped = true;
    };
  });
}

/** A mock reviewer Actor — emits one verdict from the reviewer menu. */
export function makeMockReviewer(script: ReviewerScript, tracker?: MockTracker) {
  return fromCallback<AgentDown, AgentTurnInput>(({ sendBack, input }) => {
    tracker?.reviewerTurns.push({ taskId: input.taskId, round: input.round, instanceId: input.instanceId });
    const a = script(input);
    assertInMenu(REVIEWER_MENU, a.emit);
    queueMicrotask(() => {
      if (a.emit === "approve") sendBack({ type: "agent.approve", instanceId: input.instanceId });
      else sendBack({ type: "agent.requestChanges", instanceId: input.instanceId, notes: a.notes });
    });
    return () => {};
  });
}

/**
 * A coder that BLOCKS on a `Barrier` before finishing — lets a test hold N
 * features in-flight at once to observe the bounded-pool cap, then release them.
 */
export function makeBarrierCoder(barrier: Barrier, tracker?: MockTracker) {
  return fromCallback<AgentDown, AgentTurnInput>(({ sendBack, input }) => {
    tracker?.coderTurns.push({ taskId: input.taskId, round: input.round, instanceId: input.instanceId });
    let stopped = false;
    void barrier.wait().then(() => {
      if (!stopped) sendBack({ type: "agent.done", instanceId: input.instanceId });
    });
    return () => {
      stopped = true;
    };
  });
}

// --- one-call bundle --------------------------------------------------------

export interface MockProvidersOptions {
  source: InMemoryWorkSource;
  coder: CoderScript;
  reviewer: ReviewerScript;
  tracker?: MockTracker;
  /** Provide to activate the (otherwise noop) memory slot. */
  memory?: boolean;
  readiness?: "push" | "poll";
}

/** The work-source write actions (status/comment) bound to a live source. */
export function workSourceActions(source: InMemoryWorkSource) {
  return {
    // A feature finished → mark it `done` (unblocks dependents).
    updateFeatureStatus: ((_a: any, p: { featureId: string; outcome: string }) =>
      source.updateStatus(p.featureId, "done")) as any,
    updateTaskStatus: (({ context }: any, p: { status: string }) =>
      source.updateStatus(context.taskId, p.status as any)) as any,
    comment: (({ context }: any, p: { body: string }) =>
      source.comment(context.taskId ?? context.featureId, p.body)) as any,
  };
}

/** Build a full `CodingProviders` wired to an in-memory Work Source. */
export function mockCodingProviders(opts: MockProvidersOptions): CodingProviders {
  const { source, tracker } = opts;
  const ws = makeWorkSourceProviders(source);
  return {
    readiness: opts.readiness === "poll" ? pollReadiness(source) : pushReadiness(source),
    claimNextFeature: ws.claimNextFeature,
    claimNextTask: ws.claimNextTask,
    createSandbox: makeMockCreateSandbox(tracker),
    setupWorktree: mockWorktree,
    cleanupSandbox: makeMockCleanupSandbox(tracker),
    injectMemory: opts.memory ? makeMockMemory(tracker) : undefined,
    coder: makeMockCoder(opts.coder, tracker),
    reviewer: makeMockReviewer(opts.reviewer, tracker),
    ...workSourceActions(source),
  };
}
