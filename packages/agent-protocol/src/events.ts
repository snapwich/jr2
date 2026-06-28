// The up-channel: the domain events an Agent's tool calls translate into (ADR-0002).
//
// Each event carries the `instanceId` that addresses the run (see addressing.ts). The
// Orchestrator-side Actor receives these and forwards them into the Machine; a Harness or a
// test types what it emits against the same union. The input *schemas* live in tools.ts —
// this is the post-validation event shape.
//
// Note the one asymmetry: `request_approval` both emits `agent.requestApproval` AND awaits a
// result (the `deferred` tool). The awaited result is the tool's output schema, not an event;
// the Machine's answer travels back as the held tool result, never as an up-event.

export type ControlEvent =
  | { type: "agent.done"; instanceId: string; summary?: string }
  | { type: "agent.requestReview"; instanceId: string; summary: string }
  | { type: "agent.reportBlocked"; instanceId: string; reason: string }
  | { type: "agent.requestApproval"; instanceId: string; action: string; reason?: string };

export type ControlEventType = ControlEvent["type"];
