// The coding template, assembled. `assembleCodingMachine` is the ADR-0003 proof:
// ONE factory wires a set of providers into BOTH templates via `provide()` and
// returns a runnable Machine. A mock run and a real run call the SAME factory —
// the mock↔real swap is one substituted entry in `providers`, never a template
// edit.

import type { AnyActorLogic, ActionFunction } from "xstate";
import { topTemplate, type TopMachine } from "./top-machine.ts";
import { workspaceTemplate } from "./workspace-machine.ts";

export { topTemplate } from "./top-machine.ts";
export { workspaceTemplate } from "./workspace-machine.ts";
export * from "./work-source.ts";
export * from "./slots.ts";
export * from "./control-surface.ts";

/** The full set of providers that fill the coding template's slots. */
export interface CodingProviders {
  // --- top-level (worker pool) ---
  /** Emits `WORK_READY` when the ready-set becomes non-empty (poll or push). */
  readiness: AnyActorLogic;
  /** `fromPromise` → `ClaimedFeature | null` (atomic lease). */
  claimNextFeature: AnyActorLogic;
  /** Write a feature's status back to the Work Source on completion. */
  updateFeatureStatus?: ActionFunction<any, any, any, any, any, any, any, any, any>;

  // --- workspace-level (per feature) ---
  createSandbox: AnyActorLogic;
  setupWorktree: AnyActorLogic;
  /** `fromPromise` → `ClaimedTask | null`. */
  claimNextTask: AnyActorLogic;
  cleanupSandbox: AnyActorLogic;
  /** Optional pre-coding memory slot. Omit → the template's passthrough noop. */
  injectMemory?: AnyActorLogic;
  coder: AnyActorLogic;
  reviewer: AnyActorLogic;
  updateTaskStatus?: ActionFunction<any, any, any, any, any, any, any, any, any>;
  comment?: ActionFunction<any, any, any, any, any, any, any, any, any>;
  /** Approval policy for a coder's `request_approval`. Omit → auto-approve. */
  answerApproval?: ActionFunction<any, any, any, any, any, any, any, any, any>;
}

/** Wire providers into the Workspace template, then into the Top template. */
export function assembleCodingMachine(providers: CodingProviders): TopMachine {
  const workspaceActors: Record<string, AnyActorLogic> = {
    createSandbox: providers.createSandbox,
    setupWorktree: providers.setupWorktree,
    claimNextTask: providers.claimNextTask,
    cleanupSandbox: providers.cleanupSandbox,
    coder: providers.coder,
    reviewer: providers.reviewer,
  };
  if (providers.injectMemory) workspaceActors.injectMemory = providers.injectMemory;

  const workspaceActions: Record<string, ActionFunction<any, any, any, any, any, any, any, any, any>> = {};
  if (providers.updateTaskStatus) workspaceActions.updateTaskStatus = providers.updateTaskStatus;
  if (providers.comment) workspaceActions.comment = providers.comment;
  if (providers.answerApproval) workspaceActions.answerApproval = providers.answerApproval;

  const workspace = workspaceTemplate.provide({
    actors: workspaceActors as any,
    actions: workspaceActions as any,
  });

  const topActions: Record<string, ActionFunction<any, any, any, any, any, any, any, any, any>> = {};
  if (providers.updateFeatureStatus) topActions.updateFeatureStatus = providers.updateFeatureStatus;

  return topTemplate.provide({
    actors: {
      workspace: workspace as any,
      readiness: providers.readiness as any,
      claimNextFeature: providers.claimNextFeature as any,
    },
    actions: topActions as any,
  }) as TopMachine;
}
