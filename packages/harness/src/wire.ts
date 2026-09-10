// The Harness wire (ADR-0027): the five-endpoint protocol as shared shapes, plus ADR-0023's echo
// endpoint. The stub Harness (`packages/orchestrator/src/stub-harness.ts`) is normative for the
// five conversation endpoints, headers, and status codes; this module is those shapes as types,
// exported as `@j2/harness/wire` so wire consumers (the Orchestrator client, tests) depend on
// shapes, never on the server. The one documented divergence from the stub: a GET (either view)
// on an unknown conversation is 404 — POST creates, abort answers `{ aborted: false }`
// (ADR-0027). The echo endpoint (`POST /echo` — the run-narrative shapes at the bottom of this
// file) is the real Harness's alone: the stub hosts turns for tests, and nothing ever narrates
// to it.

import type { TurnDials } from "./spec.ts";

/** What `POST /agents/:name/:id` accepts. `message` is the prompt; the dials are this Submission's
 * override layer over the Agent's definition (ADR-0018) — omitted, the Harness runs the
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

/** `SettlementError.type` for a Turn the Harness ended as a Runaway (ADR-0035) — no fourth
 * `SettlementOutcome`; the typed error on a `failed` settlement is what lets the Agent actor switch on
 * the class (one fresh-conversation reroll) without parsing prose. */
export const SUBMISSION_RUNAWAY = "runaway";

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

// ---- The run-narrative echo (`POST /echo` — ADR-0023) ------------------------------------------
// "Print these events": the Orchestrator — the observation feed's one subscriber (ADR-0022) —
// tees the owning run's feed to the enclosing Workspace's Harness, which renders it into its own
// pod log beside the conversations it hosts. The wire payload is the STRUCTURED event, never a
// preformatted string — the Harness renders, and printing stays ADR-0023's craft (printer.ts).
// Instance-token-gated (200 `{ printed }`; 401 on a bad bearer; 403 when the Harness has no gate
// configured), and FIRE-AND-FORGET on the pushing side: the feed remains the record, the log is
// a courtesy view, and a failed echo never fails a turn, a state, or a run.

/** One live child MACHINE's place, nested — state keys and spawn ids only, by construction. A
 * root's value alone says almost nothing about where a run is (the work happens in children:
 * a `workspace()` body is one), so the narrative carries the tree. */
export type EchoStatusChild = { id: string; value: unknown; children?: EchoStatusChild[] };

/** The run moved: one status delta, projected to what the narrative needs — the Machine's state
 * value (root + child machines) and the run-lifecycle status. Deliberately not the full run
 * status: context is the workflow's working data, and the log narrates, it does not mirror
 * state. */
export type EchoStatusEvent = { kind: "status"; status: string; value: unknown; children?: EchoStatusChild[] };

/** An author Emit (the sole author API for the narrative — no `log()` primitive exists or will).
 * The PAYLOAD rides here: this endpoint is instance-token-gated wire, so the ADR-0014 open band
 * — which carries Emit types alone — is not widened by it. */
export type EchoEmitEvent = { kind: "emit"; event: { type: string } & Record<string, unknown> };

/** MARKER, not mirror (ADR-0023): a Turn hosted on another Harness (a Menu-only Agent on the
 * Instance Harness — ADR-0031) was admitted — the Agent and its framing. Its transcript prints
 * exactly once, where the Turn ran; the enclosing Workspace's log gets this line and the pick. */
export type EchoAdmissionEvent = { kind: "admission"; agent: string; prompt: string };

/** The second marker: the remotely-hosted Turn's settlement pick — the Menu event (and payload)
 * the Agent ended its turn with. */
export type EchoPickEvent = { kind: "pick"; agent: string; event: string; payload?: Record<string, unknown> };

/** One structured run-narrative event, as the echo body carries it. */
export type EchoEvent = EchoStatusEvent | EchoEmitEvent | EchoAdmissionEvent | EchoPickEvent;

/** What `POST /echo` accepts: feed events in feed order. The answer is `{ printed }` — how many
 * lines landed on stdout (an unrenderable event prints nothing; it never errors the batch). */
export type EchoRequest = { events: EchoEvent[] };
