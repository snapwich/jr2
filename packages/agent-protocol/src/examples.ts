// An EXAMPLE event set — not the protocol (ADR-0011). j2 ships the mechanism (`defineEvent`)
// and zero events; these defs exist for tests, fixtures, and as a starting point to copy into
// a workflow's own `events` manifest. ADR-0006's "standard library" framing is retired: nothing
// in j2 consumes these by name.
//
// All `ack` — outcomes an Agent reports and moves on from. The other two semantics (`deferred`,
// `poll`) are reserved and NOT implemented (ADR-0013), so `eventMap` refuses to register one; an
// example that could not be put in a manifest would be a trap, not a starting point.

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

/** The example set, manifest-shaped (drop into `export const events = [...exampleEvents]`). */
export const exampleEvents = [doneEvent, requestReviewEvent, reportBlockedEvent] as const;
