// A minimal driving Machine — the smallest thing that drives the duplex Actor
// through a human-in-the-loop approval (ADR-0002). Every real Machine (the coding
// template, etc.) is a richer version of this same shape.
//
//   active ─ invoke(agentRunActor) ───────────────────────────────┐
//     │  running ──agent.requestApproval──▶ waitingForApproval     │
//     │     ▲                                   │ APPROVE / DENY    │
//     │     └───────────────────────────────────┘ (sendTo agent)   │
//     ├─ agent.done ───────────────────────────────────▶ done      │
//     ├─ agent.reportBlocked ──────────────────────────▶ blocked   │
//     └─ CANCEL (sendTo agent) ─────────────────────────▶ cancelled┘
//
// The invoke lives on `active` so the Actor stays alive across the approval gate;
// substates only model the gate. APPROVE/DENY/STEER/CANCEL are sent DOWN to the
// invoked Actor via `sendTo('agent', …)`.

import { setup, sendTo, assign } from "xstate";
import { agentRunActor, type AgentRunInput } from "./actor.ts";

export interface DriveContext extends AgentRunInput {
  /** Persisted durable handle: resume the run by `(agentName, instanceId) + offset`. */
  offset?: string;
  /** Last approval the Agent solicited — kept for assertions / audit. */
  pendingApproval?: { action: string; reason?: string };
  /** Terminal summary / blocked reason, whichever ended the run. */
  outcome?: string;
}

export type DriveExternalEvent =
  | { type: "APPROVE"; decision?: string }
  | { type: "DENY"; decision?: string }
  | { type: "STEER"; message: string; mode?: "prompt" | "inbox" }
  | { type: "CANCEL" };

export const driveMachine = setup({
  types: {
    context: {} as DriveContext,
    input: {} as AgentRunInput,
    events: {} as
      | DriveExternalEvent
      | { type: "agent.requestApproval"; instanceId: string; action: string; reason?: string }
      | { type: "agent.requestReview"; instanceId: string; summary: string }
      | { type: "agent.reportBlocked"; instanceId: string; reason: string }
      | { type: "agent.done"; instanceId: string; summary?: string }
      | { type: "actor.admitted"; instanceId: string; offset: string; submissionId: string }
      | { type: "actor.telemetry"; instanceId: string; kind: string; detail?: string }
      | { type: "actor.settled"; instanceId: string; outcome: string }
      | { type: "actor.error"; instanceId: string; message: string },
  },
  actors: { agent: agentRunActor },
}).createMachine({
  id: "drive",
  context: ({ input }) => ({ ...input }),
  initial: "active",
  states: {
    active: {
      invoke: {
        id: "agent",
        src: "agent",
        input: ({ context }) => ({
          controlPlane: context.controlPlane,
          harnessBase: context.harnessBase,
          agentName: context.agentName,
          instanceId: context.instanceId,
          prompt: context.prompt,
          attachOffset: context.attachOffset,
        }),
      },
      // Persist the durable handle the moment the prompt is admitted.
      on: {
        "actor.admitted": { actions: assign({ offset: ({ event }) => event.offset }) },
        "agent.done": { target: "done", actions: assign({ outcome: ({ event }) => event.summary ?? "done" }) },
        "agent.reportBlocked": { target: "blocked", actions: assign({ outcome: ({ event }) => event.reason }) },
        STEER: { actions: sendTo("agent", ({ event }) => event) },
        CANCEL: { target: "cancelled", actions: sendTo("agent", { type: "CANCEL" }) },
      },
      initial: "running",
      states: {
        running: {
          on: {
            "agent.requestApproval": {
              target: "waitingForApproval",
              actions: assign({ pendingApproval: ({ event }) => ({ action: event.action, reason: event.reason }) }),
            },
          },
        },
        waitingForApproval: {
          on: {
            APPROVE: {
              target: "running",
              actions: sendTo("agent", ({ event }) => ({ type: "APPROVE", decision: event.decision })),
            },
            DENY: {
              target: "running",
              actions: sendTo("agent", ({ event }) => ({ type: "DENY", decision: event.decision })),
            },
          },
        },
      },
    },
    done: { type: "final" },
    blocked: { type: "final" },
    cancelled: { type: "final" },
  },
});
