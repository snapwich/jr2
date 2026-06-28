// The coding template's slots — the named actors/actions the templates
// reference abstractly and `provide()` fills (ADR-0003). This file is the
// CONTRACT every provider (mock or real) satisfies; the templates depend only
// on these shapes, never on a concrete implementation.
//
// Agent slots (`coder`, `reviewer`) take a SEMANTIC turn input — role, a fresh
// per-turn Instance ID, the prompt. Real adapters (`providers/real-coder.ts`)
// map it onto `agentRunActor`'s `AgentRunInput`, injecting infra (control plane,
// harness base) from an assemble-time closure; mocks read a script. So the
// Workspace Machine stays agnostic to whether an Agent is real or scripted.

import type { AgentDownEvent } from "../actor.ts";
import type { InnerLoopEvent } from "./control-surface.ts";

// --- Sandbox lifecycle ------------------------------------------------------

export interface SandboxHandle {
  id: string;
  /** Reachable base URL (a real Sandbox's `status.endpoint`). */
  endpoint: string;
}
export interface CreateSandboxInput {
  featureId: string;
}
export interface CleanupSandboxInput {
  sandbox: SandboxHandle;
}

// --- Worktree (ADR-0004) ----------------------------------------------------

export interface WorktreeHandle {
  /** The branch worktree working dir the Agent operates in. */
  path: string;
  /** The per-Sandbox `git clone --shared` dir (holds the pod-local `.git`). */
  defaultRepo: string;
  branch: string;
}
export interface SetupWorktreeInput {
  sandbox: SandboxHandle;
  featureId: string;
  branch: string;
}

// --- Memory (optional slot; default is a passthrough noop in the template) ---

export interface MemoryInput {
  featureId: string;
  taskId: string;
}
export interface MemoryResult {
  /** false for the noop default; true once a real memory provider is injected. */
  injected: boolean;
  note?: string;
}

// --- Agents (coder / reviewer) ----------------------------------------------

export type AgentRole = "coder" | "reviewer";

/** The semantic input the Workspace builds for an agent turn. */
export interface AgentTurnInput {
  role: AgentRole;
  /** Distinct per role+round → the reviewer never shares the coder's session. */
  instanceId: string;
  prompt: string;
  featureId: string;
  taskId: string;
  /** Review round (0 = first coding pass). */
  round: number;
}

/** Agent actors emit `InnerLoopEvent`s UP and accept `AgentDownEvent`s DOWN. */
export type AgentUp = InnerLoopEvent;
export type AgentDown = AgentDownEvent;

// --- Slot registry (names referenced by the templates) ----------------------

export const SLOTS = {
  actors: [
    "readiness",
    "claimNextFeature",
    "claimNextTask",
    "workspace",
    "createSandbox",
    "setupWorktree",
    "injectMemory",
    "coder",
    "reviewer",
    "cleanupSandbox",
  ],
  actions: ["updateFeatureStatus", "updateTaskStatus", "comment"],
} as const;
