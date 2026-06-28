// The MCP callback toolset — the heart of the Orchestrator↔Agent control plane (ADR-0002).
//
// An Agent emits domain outcomes by *calling tools*; the Orchestrator hosts a per-run MCP
// endpoint that turns those calls into events (and, for `request_approval`, holds the result
// until the Machine answers). This module is the single source of truth both sides consume:
// the Orchestrator builds an MCP server from it, and the Harness/Agent (and tests) know
// exactly which tools exist and what they accept/return. No server, no transport here — just
// the contract.
//
// Direction (ADR-0006): this fixed set is the *standard library* of control events. It will be
// generalized into `defineAgentEvent({ name, input, output?, semantics })` so workflow authors
// can declare custom events and bind them to Machine states — the agent drives the Machine
// through a surface the workflow defines. The binding (tool→event→transition) is built in the
// orchestrator slice; these tools are the first cut.

import { z } from "zod";

/**
 * How a tool call resolves:
 * - `ack`      fire-and-acknowledge; the Agent does not wait on a meaningful result.
 * - `deferred` the result is held open until the Machine answers (solicited down-channel).
 * - `poll`     the Agent calls it to pull any queued down-channel messages (cooperative steer).
 */
export type ToolSemantics = "ack" | "deferred" | "poll";

/** Shared acknowledgement payload for fire-and-ack tools. */
const ackOutput = z.object({ ok: z.literal(true) });

export const doneTool = {
  name: "done",
  semantics: "ack",
  description: "Signal the Agent has finished its turn of work.",
  input: z.object({ summary: z.string().optional() }),
  output: ackOutput,
} as const;

export const requestReviewTool = {
  name: "request_review",
  semantics: "ack",
  description: "Hand the current work off for review.",
  input: z.object({ summary: z.string() }),
  output: ackOutput,
} as const;

export const reportBlockedTool = {
  name: "report_blocked",
  semantics: "ack",
  description: "Report that the Agent cannot proceed and why.",
  input: z.object({ reason: z.string() }),
  output: ackOutput,
} as const;

export const requestApprovalTool = {
  name: "request_approval",
  semantics: "deferred",
  description: "Request approval for an action; the call blocks until the Machine answers.",
  input: z.object({ action: z.string(), reason: z.string().optional() }),
  output: z.object({ decision: z.string() }),
} as const;

export const checkInboxTool = {
  name: "check_inbox",
  semantics: "poll",
  description: "Pull any queued messages from the Machine (cooperative steer checkpoint).",
  input: z.object({}),
  output: z.object({ messages: z.array(z.string()) }),
} as const;

/** The full callback toolset, keyed by tool name. */
export const CALLBACK_TOOLS = {
  done: doneTool,
  request_review: requestReviewTool,
  report_blocked: reportBlockedTool,
  request_approval: requestApprovalTool,
  check_inbox: checkInboxTool,
} as const;

export type CallbackToolName = keyof typeof CALLBACK_TOOLS;

/** The validated input type for a given tool. */
export type ToolInput<N extends CallbackToolName> = z.infer<(typeof CALLBACK_TOOLS)[N]["input"]>;

/** The result type for a given tool. */
export type ToolOutput<N extends CallbackToolName> = z.infer<(typeof CALLBACK_TOOLS)[N]["output"]>;
