// An EXAMPLE event set — not the protocol (ADR-0011). j2 ships the mechanism (`defineEvent`)
// and zero events; these defs exist for tests, fixtures, and as a starting point to copy into
// a workflow's own `events` manifest. ADR-0006's "standard library" framing is retired: nothing
// in j2 consumes these by name.
//
// One of each semantics, for reference:
//   - `ack` outcomes an agent reports and moves on from,
//   - `deferred` a request whose tool result is held open until the Machine answers,
//   - `poll` a checkpoint that drains queued down-channel messages (cooperative steer).

import { z } from "zod";
import { defineEvent } from "./define-event.ts";

export const doneEvent = defineEvent({
  name: "done",
  description: "Signal the Agent has finished its turn of work.",
  input: z.object({ summary: z.string().optional() }),
});

export const requestReviewEvent = defineEvent({
  name: "request_review",
  description: "Hand the current work off for review.",
  input: z.object({ summary: z.string() }),
});

export const reportBlockedEvent = defineEvent({
  name: "report_blocked",
  description: "Report that the Agent cannot proceed and why.",
  input: z.object({ reason: z.string() }),
});

export const requestApprovalEvent = defineEvent({
  name: "request_approval",
  semantics: "deferred",
  description: "Request approval for an action; the call blocks until the Machine answers.",
  input: z.object({ action: z.string(), reason: z.string().optional() }),
  output: z.object({ decision: z.string() }),
});

export const checkInboxEvent = defineEvent({
  name: "check_inbox",
  semantics: "poll",
  description: "Pull any queued messages from the Machine (cooperative steer checkpoint).",
  input: z.object({}),
  output: z.object({ messages: z.array(z.string()) }),
});

/** The example set, manifest-shaped (drop into `export const events = [...exampleEvents]`). */
export const exampleEvents = [
  doneEvent,
  requestReviewEvent,
  reportBlockedEvent,
  requestApprovalEvent,
  checkInboxEvent,
] as const;
