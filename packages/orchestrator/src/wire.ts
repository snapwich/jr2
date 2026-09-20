// The Harness wire as the CLIENT reads it (ADR-0027): the shapes `harness-client.ts` parses off
// the durable stream, and the run-narrative echo body `run-host.ts` pushes (ADR-0023).
//
// `@jr2/harness` SERVES the wire and owns the serving constants; this module is the Orchestrator's
// own view of it, and it lives here for one reason: `@jr2/orchestrator` is published to npm and
// `@jr2/harness` is not (ADR-0009/0043 — the Harness reaches users as a Kit image). The instance's
// program includes this package's `.ts` sources (zero-build), so an import of `@jr2/harness/wire`
// from here is a `Cannot find module` in every INSTALLED instance — and since ADR-0050 that is a
// `jr2 up` refusal, not a warning. The literals below are restated for the same reason a type
// cannot be: nothing published may reach into a package that was never published.
//
// The two views are held in agreement by the compiler, not by care: `test/wire-types.test.ts`
// asserts each shape here is mutually assignable with `@jr2/harness/wire`'s, and `@jr2/harness`
// stays a devDependency so that file — and only that file — can see the server's copy.

/** How a Submission ends (ADR-0024/0027): `completed` (the prompt resolved), `failed` (the turn
 * threw — provider failure after retries, or the Menu connect/list failed), `aborted` (swept). */
export type SettlementOutcome = "completed" | "failed" | "aborted";

/** The error payload a non-`completed` Settlement carries. */
export type SettlementError = { type: string; message?: string };

/** `SettlementError.type` for a swept Submission (ADR-0024/0025). */
export const SUBMISSION_ABORTED = "submission_aborted";

/** `SettlementError.type` for a Turn the Harness ended as a Runaway (ADR-0035) — no fourth
 * `SettlementOutcome`; the typed error on a `failed` settlement is what lets the Agent actor switch
 * on the class (one fresh-conversation reroll) without parsing prose. */
export const SUBMISSION_RUNAWAY = "runaway";

/** One settled Submission, in the shape `?view=history`'s `settlements` reports. */
export type Settlement = {
  submissionId: string;
  outcome: SettlementOutcome;
  error?: SettlementError;
};

/** Where a chunk sits on the durable stream. Ordering only (`batch`, then `index`); the Harness
 * appends each chunk as its own batch of one. */
export type StreamPosition = { batch: number; index: number };

/** The envelope every stream chunk carries. */
type StreamChunk<T extends string> = { type: T; conversationId: string; position: StreamPosition };

/** A completed conversation message landing on the stream. */
export type MessageAppendedEvent = StreamChunk<"message-appended"> & {
  message: { id: string; role: "user" | "assistant"; parts: { type: "text"; text: string; state: "done" }[] };
};

/** A Settlement landing on the stream, flat — what `wait` matches by submissionId, and what wakes
 * a parked long-poll. */
export type SubmissionSettledEvent = StreamChunk<"submission-settled"> & Settlement;

/** One event on the durable stream (`GET ?offset=…&view=updates` → 200 JSON array). */
export type StreamEvent = MessageAppendedEvent | SubmissionSettledEvent;

/** Response header: the offset to resume the stream from (every stream read carries it). */
export const STREAM_NEXT_OFFSET_HEADER = "stream-next-offset";

/** `?view=` value the client reads. A read with neither view is `updates`. */
export const VIEW_UPDATES = "updates";

/** `?live=` value: park until a new event or timeout (204 + the same headers). Long-poll is the
 * ONLY wait transport (ADR-0027) — no SSE, no `?wait=result`. */
export const LIVE_LONG_POLL = "long-poll";

// ---- The run-narrative echo (`POST /echo` — ADR-0023) ------------------------------------------
// "Print these events": the Orchestrator — the observation feed's one subscriber (ADR-0022) — tees
// the owning run's feed to the enclosing Workspace's Harness, which renders it into its own pod log.
// The wire payload is the STRUCTURED event, never a preformatted string: the Harness renders, and
// printing stays ADR-0023's craft.

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
