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

/** `SettlementError.type` for a Submission the Harness admitted but had not settled when it
 * restarted (ADR-0031): the rebuilt stream settles it `failed`, so a re-attached `wait` reads a
 * Settlement, not a 404. The Agent actor switches on this type, never on the message's prose. */
export const SUBMISSION_HARNESS_RESTARTED = "harness_restarted";

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

/**
 * The Harness's memory guard killed the Agent's processes (ADR-0061, layer 4), on the stream of the
 * conversation whose Turn was running. The Agent heard it in its `bash` answer; this is how the
 * Orchestrator hears it, so the next Turn in the Workspace is told (ADR-0062). `peak` and `limit`
 * are the guard's own spellings — carried to the notice as they are, never parsed.
 */
export type MemoryLimitEvent = StreamChunk<"memory-limit"> & { peak: string; limit: string };

/** One event on the durable stream (`GET ?offset=…&view=updates` → 200 JSON array). */
export type StreamEvent = MessageAppendedEvent | SubmissionSettledEvent | MemoryLimitEvent;

// ---- Notices (ADR-0062) ------------------------------------------------------------------------
// What happened that the next Turn cannot find out for itself, as DATA: the Orchestrator keeps
// them and attaches the pending ones in scope to an admission (`AdmissionRequest.notices`); the
// Harness writes every word of the Briefing's Turn part from them.

/** The Sandbox's processes were killed at its memory limit during `agent`'s Turn — by the
 * Harness's guard (`peak` known) or by the kernel (`peak` unknown). Workspace scope: the next Turn
 * of any Agent in that Workspace. */
export type MemoryLimitNotice = {
  kind: "memory-limit";
  scope: "workspace";
  agent: string;
  peak?: string;
  limit: string;
};

/** This conversation is new; earlier context is gone. Conversation scope: that Agent's next
 * continued Turn. `reason` says why — the fault that burned the last one, or that the Harness no
 * longer holds it. */
export type ConversationNewNotice = { kind: "conversation-new"; scope: "conversation"; reason: string };

/**
 * What an outstanding pick's answer is (ADR-0024): the LAST reply from below the Agent's state since
 * the pick — a party's event (a Gate's answer, a nested Agent's pick) with its payload, or a child's
 * output (a child Machine, an Effect stand-in) — named by who sent it. A child's error is no reply (a
 * defect, ADR-0024). Absent where nothing replied: the answer carries no reply, and says nothing of
 * whether work ran. Plain data; the Harness writes the words. `answer`: the value the Machine's
 * `answer` action set (ADR-0067), which replaces the default.
 */
export type PickAnswer =
  | { kind: "event"; event: string; sender?: { party: "agent" | "gate"; id: string }; payload: Record<string, unknown> }
  | { kind: "output"; actor: string; output: unknown }
  | { kind: "answer"; value: unknown };

/**
 * A pick's answer that did not reach the pick's call (ADR-0024): `cut` — the Harness restarted while
 * the workflow ran it, and jr2 re-admits the Agent on the same conversation with this notice; or the
 * route left the Agent's state, and the next Turn of the conversation the picking Turn continued
 * hears it. Conversation scope.
 */
export type PickAnswerNotice = {
  kind: "pick-answer";
  scope: "conversation";
  pick: string;
  cut: boolean;
  /** The last reply since the pick — with `stopped`, an earlier link's, kept. */
  answer?: PickAnswer;
  /** Something other than the pick's route left the Agent's state while the pick's work ran, and
   * that exit stopped the work before it finished (ADR-0024). */
  stopped?: true;
};

export type Notice = MemoryLimitNotice | ConversationNewNotice | PickAnswerNotice;

/** Response header: the offset to resume the stream from (every stream read carries it). */
export const STREAM_NEXT_OFFSET_HEADER = "stream-next-offset";

/** `?view=` values the client reads. A read with neither view is `updates`; `history` is the
 * conversation snapshot, read only to learn whether the Harness still holds it (ADR-0062). */
export const VIEW_UPDATES = "updates";
export const VIEW_HISTORY = "history";

/** `?live=` value: park until a new event or timeout (204 + the same headers). Long-poll is the
 * ONLY wait transport (ADR-0027) — no SSE, no `?wait=result`. */
export const LIVE_LONG_POLL = "long-poll";

// ---- The live set (`PUT /agents` — ADR-0031) ----------------------------------------------------
// The Orchestrator states which conversations its live runs hold on the Instance Harness, and the
// Harness frees every other one that is not busy. The whole set every time (level-triggered), so a
// missed statement costs nothing.

/** One conversation a live run holds: the `:name` and `:id` of its `/agents/:name/:id` route. */
export type LiveConversation = { agent: string; instanceId: string };

/** What `PUT /agents` accepts: every conversation the Orchestrator's live runs hold. */
export type LiveSetRequest = { live: LiveConversation[] };

/** What `PUT /agents` answers (200): how many conversations this statement freed. */
export type LiveSetResponse = { freed: number };

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

// --- the attach (ADR-0063) ----------------------------------------------------------------------
// The Workspace's Repos into `/work`, run by the Harness on `POST /attach` — the Orchestrator's
// call where it once ran a script over `kubectl exec`. Same bearer as every Harness route
// (ADR-0058); idempotent on the Harness's side.

/** One Repo Slot to attach. The Orchestrator resolves the Repo's `identity` and cache `key`
 * (repo-identity.ts) — the Harness never re-derives them, so the cache it clones from and the node
 * cache the operator mounted agree by construction (ADR-0051). `url` is the Binding's own spelling,
 * the push url (ADR-0005); `ref` is the base the branch starts from, omitted for the Repo's default
 * branch. */
export type AttachSlot = { slot: string; url: string; identity: string; key: string; ref?: string };

/** What `POST /attach` accepts: the slots in declaration order, the Workspace's branch, and — for a
 * reviewer's seat — the sha the detached review worktree is forced to (ADR-0028). */
export type AttachRequest = { slots: AttachSlot[]; branch: string; reviewSha?: string };

/** What `POST /attach` answers (200): the branch worktree per slot, and the review worktree per
 * slot when the request named a `reviewSha`. Freshness is the operator's verdict on the Sandbox,
 * which the Orchestrator reads itself — never the Harness's to report. */
export type AttachResponse = { repos: Record<string, string>; review?: Record<string, string> };

/** What a failed attach answers: 400 for a body that is not an `AttachRequest`, 500 when a step
 * failed — `slot` names the Repo Slot, and `error` carries the step and git's own stderr. */
export type AttachError = { error: string; slot?: string };

// --- the exec (a `command` Effect, ADR-0067) ----------------------------------------------------
// A `command` Effect runs in the Harness container of its Workspace's Sandbox, named by its
// Effect's id: one id runs once, whoever asks again. Same bearer as every Harness route (ADR-0058).

/** What `POST /exec/:id` accepts: argv (never shell text), an absolute `cwd` or none, the timeout,
 * and how many characters of the stream's end the output keeps. */
export type ExecRequest = { argv: string[]; cwd?: string; timeoutMs: number; tail: number };

/** How an exec ended. Every one is output; none is a fault. */
export type ExecOutcome =
  | { outcome: "exited"; code: number; tail: string }
  | { outcome: "timeout"; tail: string }
  | { outcome: "killed"; signal: string; tail: string };

/** What `GET /exec/:id` answers: the stream from `offset` to `next`, and the output once settled. A
 * read with no `offset` starts at the end. */
export type ExecRead = {
  state: "running" | "settled";
  stream: string;
  next: number;
  dropped?: number;
  output?: ExecOutcome;
};
