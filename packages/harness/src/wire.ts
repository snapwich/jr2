// The Harness wire (ADR-0027): the five-endpoint protocol as shared shapes. The stub Harness
// (`packages/orchestrator/src/stub-harness.ts`) is normative for the endpoints, headers, and
// status codes; this module is those shapes as types, exported as `@j2/harness/wire` so wire
// consumers (the Orchestrator client, tests) depend on shapes, never on the server. The one
// documented divergence from the stub: a GET (either view) on an unknown conversation is 404 —
// POST creates, abort answers `{ aborted: false }` (ADR-0027).

import type { TurnDials } from "./spec.ts";

/** What `POST /agents/:name/:id` accepts. `message` is the prompt; the dials are this Submission's
 * override layer over the Agent's definition (ADR-0018 as amended) — omitted, the Harness runs the
 * definition's own values, so a dial-less admission is byte-identical to the original contract. An
 * unresolvable `model` is rejected at admission (400), not settled `failed` mid-run. */
export type AdmissionRequest = { message: string } & TurnDials;

/** The Admission: what `POST /agents/:name/:id` answers with (200, immediately — accept
 * and queue). The serializable three-string handle the host ledger persists (ADR-0016) and a
 * restarted Orchestrator re-attaches by. `offset` is a j2-minted opaque string. */
export type AdmissionResponse = {
  streamUrl: string;
  offset: string;
  submissionId: string;
};

/** How a Submission ends (ADR-0024/0027): `completed` (the prompt resolved), `failed` (the turn
 * threw — provider failure after retries, or the Menu connect/list failed), `aborted` (swept). */
export type SettlementOutcome = "completed" | "failed" | "aborted";

/** The error payload a non-`completed` Settlement carries. */
export type SettlementError = { type: string; message?: string };

/** `SettlementError.type` for a swept Submission — continuity with what ADR-0024/0025 recorded. */
export const SUBMISSION_ABORTED = "submission_aborted";

/** One settled Submission, in the shape `?view=history`'s `settlements` reports — the asserted
 * contract (the mechanics/@kind tiers assert exact counts and outcomes). */
export type Settlement = {
  submissionId: string;
  outcome: SettlementOutcome;
  error?: SettlementError;
};

/** A completed conversation message, as `?view=history`'s best-effort `messages` reports it. */
export type HistoryMessage = { role: "user" | "assistant"; text: string };

/** Where a chunk sits on the durable stream. Ordering only (`batch`, then `index`); the Harness
 * appends each chunk as its own batch of one. */
export type StreamPosition = { batch: number; index: number };

/** The envelope every stream chunk carries. The vocabulary is flue-lineage ON PURPOSE: the phased
 * migration (ADR-0027 — image swap and client swap are independent commits, so an old Orchestrator
 * drives the new image) has the retiring `@flue/sdk` `wait()` reading this view, and its chunk
 * validator rejects any element without a known flat `type` (`submission-settled`, not a nested
 * settlement), a `conversationId`, and a numeric `position` — so these shapes must stay chunks it
 * accepts until the last flue client leaves the repo. */
type StreamChunk<T extends string> = { type: T; conversationId: string; position: StreamPosition };

/** A completed conversation message landing on the stream. `message` is the retiring SDK's
 * UI-message shape; the one part j2 ever emits is settled text. */
export type MessageAppendedEvent = StreamChunk<"message-appended"> & {
  message: { id: string; role: "user" | "assistant"; parts: { type: "text"; text: string; state: "done" }[] };
};

/** A Settlement landing on the stream, flat — what `wait` matches by submissionId, and what wakes
 * a parked long-poll. */
export type SubmissionSettledEvent = StreamChunk<"submission-settled"> & Settlement;

/** One event on the durable stream (`GET ?offset=…&view=updates` → 200 JSON array). */
export type StreamEvent = MessageAppendedEvent | SubmissionSettledEvent;

/** The conversation snapshot (`GET ?view=history` → 200). `settlements` is the contract;
 * `messages` is observability. */
export type HistoryView = {
  v: 1;
  conversationId: string;
  offset: string;
  messages: HistoryMessage[];
  settlements: Settlement[];
};

/** Response header: the offset to resume the stream from (every stream read carries it). */
export const STREAM_NEXT_OFFSET_HEADER = "stream-next-offset";
/** Response header: whether the read reached the end of the stream. */
export const STREAM_UP_TO_DATE_HEADER = "stream-up-to-date";

/** `?view=` values. A read with neither view is `updates`. */
export const VIEW_UPDATES = "updates";
export const VIEW_HISTORY = "history";
/** `?live=` value: park until a new event or timeout (204 + the same headers). Long-poll is the
 * ONLY wait transport (ADR-0027) — no SSE, no `?wait=result`. */
export const LIVE_LONG_POLL = "long-poll";
