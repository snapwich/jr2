// The Harness wire (ADR-0027): the five-endpoint protocol as shared shapes, plus ADR-0023's echo
// endpoint. The stub Harness (`packages/orchestrator/src/stub-harness.ts`) is normative for the
// five conversation endpoints, headers, and status codes; this module is those shapes as types,
// exported as `@jr2/harness/wire` so wire consumers (the Orchestrator client, tests) depend on
// shapes, never on the server. Two documented divergences from the stub. First, a GET (either
// view) on an unknown conversation is 404 — POST creates, abort answers `{ aborted: false }`
// (ADR-0027). Second, a POST with `kept: true` on an unknown conversation is 404 and creates
// nothing (ADR-0062); the stub keeps every conversation (its history view answers each one), so
// it admits it. The echo endpoint (`POST /echo` — the run-narrative shapes at the bottom of this
// file) is the real Harness's alone: the stub hosts turns for tests, and nothing ever narrates
// to it. So is the live set (`PUT /agents`, ADR-0031) and the drain's 503 on admission: the stub
// keeps nothing to free and never shuts down under a Turn.

import type { AgentDefinition, TurnDials, TurnFrame } from "./spec.ts";

/** What `POST /agents/:name/:id` accepts — one Turn, in the three pieces ADR-0057 names it by.
 * The FRAME is `message` (the prompt) and `cwd` (where the Working tools are rooted): flat
 * siblings on the body, because where a Turn works is the same kind of fact as what it is about,
 * and flattening keeps ADR-0027's wire as it was. The DEFINITION is the Agent the Machine's slot
 * carries (ADR-0049) — it rides every admission, because the Harness holds no roster and the
 * `:name` in the route is a SLOT KEY, unique only within its Machine. The DIALS are this
 * Submission's override layer over that definition (ADR-0018) — omitted, the Harness runs the
 * definition's own values. A definition that cannot run (missing fields, an unresolvable `model`)
 * or a Frame that cannot frame (a `cwd` that is not a path) is rejected at admission (400, naming
 * the slot), not settled `failed` mid-run. */
export type AdmissionRequest = { definition: AgentDefinition } & TurnFrame & TurnDials & TurnNotices;

/** The body of `POST /agents/:name/:id` as the wire carries it: the Submission, and the flag that
 * only the route reads (`TurnKept`). The engine gets the `AdmissionRequest` alone. */
export type AdmissionBody = AdmissionRequest & TurnKept;

/** What the Orchestrator keeps for the next Turn in a scope (ADR-0062), typed — the Harness writes
 * every word of the Briefing, so the wire carries facts, never text. Delivered once: the admission
 * that carries a notice is the one that clears it. */
export type TurnNotices = { notices?: Notice[] };

/** The Orchestrator admits onto a conversation that it was told this Harness keeps (ADR-0062): the
 * re-admission after a restart cut the Turn, and a continued Turn. Its "kept" can be a guess: the
 * question times out while a Harness in CrashLoopBackOff does not answer, and then the answer is
 * "kept". So with `kept: true` a Harness that keeps no such conversation refuses with 404 and seats
 * none. A new conversation must be told that it is new and be given its task again, and only the
 * Orchestrator can do that. Absent, POST seats a new conversation for an unknown Instance ID. */
export type TurnKept = { kept?: boolean };

/** What a Harness answers (404) to an admission with `kept: true` when it keeps no such
 * conversation (ADR-0062). `kept: false` is the marker: the Orchestrator takes a 404 as "not kept"
 * only when it carries it, so a 404 from anything else (a proxy, a route that moved) is a failed
 * admission, as before. */
export type NotKeptResponse = { error: string; kept: false };

/** The Sandbox's processes were killed at its memory limit (ADR-0061) during `agent`'s Turn —
 * stated to the next Turn of ANY Agent in that Workspace. `agent` is absent for every kill read from
 * the pod's list (`GET /memory-kills`): the list cannot say whose Turn a kill ended. `peak` is known
 * when the Harness's guard fired, not when the kernel did. Sizes are written the way a Size is (`2Gi`,
 * `1.9Gi`). */
export type MemoryLimitNotice = {
  kind: "memory-limit";
  scope: "workspace";
  agent?: string;
  peak?: string;
  /** Absent with `peak` when the sizes read were not sizes: the notice says no sizes. */
  limit?: string;
};

/** This conversation is new and earlier context is gone — stated to that Agent's next Turn. */
export type ConversationNewNotice = { kind: "conversation-new"; scope: "conversation"; reason: string };

/** What a pick's answer carries (ADR-0024): by default the last reply from below the Agent's state
 * since the pick — a party's event with its payload, or a child's output; or the value the
 * Machine's `answer` action set (ADR-0067). Absent: no reply came, which says nothing of whether
 * work ran. */
export type PickAnswer =
  | { kind: "event"; event: string; sender?: { party: "agent" | "gate"; id: string }; payload: Record<string, unknown> }
  | { kind: "output"; actor: string; output: unknown }
  | { kind: "answer"; value: unknown };

/** A pick's answer that never reached its call — `cut`: this Harness restarted while the workflow
 * ran it, and the re-admission carries it; else the route left the Agent's state, and the next
 * continued Turn hears it (ADR-0024, ADR-0031). */
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

/** The Admission: what `POST /agents/:name/:id` answers with (200, immediately — accept
 * and queue). The serializable three-string handle the host ledger persists (ADR-0016) and a
 * restarted Orchestrator re-attaches by. `offset` is a jr2-minted opaque string. */
export type AdmissionResponse = {
  streamUrl: string;
  offset: string;
  submissionId: string;
};

/** How a Submission ends (ADR-0024/0027): `completed` (the prompt resolved), `failed` (the turn
 * threw — provider failure after retries, or the Menu connect/list failed), `aborted` (swept, or
 * over before it started — ADR-0026). */
export type SettlementOutcome = "completed" | "failed" | "aborted";

/** The error payload a non-`completed` Settlement carries. */
export type SettlementError = { type: string; message?: string };

/** `SettlementError.type` for a swept Submission — continuity with what ADR-0024/0025 recorded. */
export const SUBMISSION_ABORTED = "submission_aborted";

/** `SettlementError.type` for a Turn the Harness ended as a Runaway (ADR-0035) — no fourth
 * `SettlementOutcome`; the typed error on a `failed` settlement is what lets the Agent actor switch on
 * the class (one fresh-conversation reroll) without parsing prose. */
export const SUBMISSION_RUNAWAY = "runaway";

/** `SettlementError.type` for a Submission the Harness admitted but had not settled when it
 * restarted (ADR-0031): the rebuilt conversation settles it `failed` on its stream, so a re-attached
 * `wait` reads a Settlement, not a 404, and the conversation's next Turn continues it. The message
 * is `SUBMISSION_RESTARTED_MESSAGE`. */
export const SUBMISSION_HARNESS_RESTARTED = "harness_restarted";
export const SUBMISSION_RESTARTED_MESSAGE = "Harness restarted before this Submission settled (ADR-0031)";

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
 * UI-message shape; the one part jr2 ever emits is settled text. */
export type MessageAppendedEvent = StreamChunk<"message-appended"> & {
  message: { id: string; role: "user" | "assistant"; parts: { type: "text"; text: string; state: "done" }[] };
};

/** A Settlement landing on the stream, flat — what `wait` matches by submissionId, and what wakes
 * a parked long-poll. */
export type SubmissionSettledEvent = StreamChunk<"submission-settled"> & Settlement;

/** The Harness's guard killed the Agent's processes at the memory limit (ADR-0061, layer 4) while
 * this conversation's Submission ran. The Orchestrator reads it off the stream it already waits on
 * and keeps a workspace notice (ADR-0062) — the pod did not restart, so nothing else would tell it.
 * `id` is the kill's, the same on every stream that carries it and in `GET /memory-kills`, so one
 * kill is one notice whichever reader sees it first. Sizes as `formatBytes` writes them (`1.9Gi`). */
export type MemoryLimitEvent = StreamChunk<"memory-limit"> & { id: string; peak: string; limit: string };

/** One event on the durable stream (`GET ?offset=…&view=updates` → 200 JSON array). */
export type StreamEvent = MessageAppendedEvent | SubmissionSettledEvent | MemoryLimitEvent;

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

// ---- The live set (`PUT /agents` — ADR-0031) ----------------------------------------------------
// The Orchestrator states which conversations its live runs hold — from the admission ledgers in
// memory, never from the store — after every restore and every 5 minutes (the Lease's cadence).
// LEVEL-triggered: each statement is the whole set, so a missed one costs nothing and the next
// frees what it would have. The Harness frees the memory and the directory of every conversation
// not named, except one whose Submission is still running: that one is kept until it settles and
// goes on the next statement. No idle TTL — a run parked on a Gate for a day keeps its
// conversation, because the live set is the only thing that can say it is gone. Idempotent; gated
// on the same bearer as every route (ADR-0058). Only the Instance Harness is told: a Sandbox's
// Harness is freed whole by its Workspace's teardown.

/** One conversation a live run holds: the `:name` and `:id` of its `/agents/:name/:id` route. */
export type LiveConversation = { agent: string; instanceId: string };

/** What `PUT /agents` accepts: every conversation the Orchestrator's live runs hold. */
export type LiveSetRequest = { live: LiveConversation[] };

/** What `PUT /agents` answers (200): how many conversations this statement freed. */
export type LiveSetResponse = { freed: number };

// ---- The pod's guard kills (`GET /memory-kills` — ADR-0061, ADR-0062) -------------------------
// Every guard kill, kept pod-scoped. A stream is read only while the Orchestrator waits on a
// Submission, and that wait stops when the Agent's state exits — so a kill while no Submission
// runs, or after the wait stopped, has no reader there. The Orchestrator reads this list before it
// admits a Turn into the Workspace. A read changes nothing: the Orchestrator keeps each `id` it has
// raised, so a second read raises nothing new.

/** One guard kill. `id` is unique for the pod's life and is the stream events' `id`; `at` is when
 * the guard fired; `told` are the conversations with a `bash` call running then, whose answer told
 * the Agent of the kill — none when no call ran. Sizes as `formatBytes` writes them (`1.9Gi`). */
export type PodMemoryKill = {
  id: string;
  at: string;
  /** Absent, with `limit`, when the pod could not keep the sizes as sizes. */
  peak?: string;
  limit?: string;
  told: LiveConversation[];
};

/** What `GET /memory-kills` answers (200): the newest kills, oldest first. */
export type MemoryKillsResponse = { kills: PodMemoryKill[] };

// The bounds of the list, the same on the two sides of the wire (ADR-0062). The Agent's uid can
// write the file the list is read from, so the Harness keeps no kill, and no `told` entry, that the
// Orchestrator drops. With these bounds the largest answer is 149,259 bytes, under the
// Orchestrator's read of 256 KiB: 16 kills of 208 bytes and 32 `told` entries of 284 bytes each.

/** How many kills the pod keeps. A guard kill is rare; a burst of them is one piece of news. */
export const KEPT_KILLS = 16;
/** The most conversations one kill's `told` holds: far more Agents than a Workspace runs. */
export const MAX_TOLD = 32;
/** The longest `id` and `at` of a kill. A minted id and an ISO time are less than half of it. */
export const MAX_KILL_STAMP = 64;
/** The longest `agent` and `instanceId` of a `told` entry. */
export const MAX_KILL_NAME = 128;
/** The most of `GET /memory-kills` the Orchestrator reads, in bytes. */
export const MAX_KILLS_BODY = 256 * 1024;

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

// ---- The attach (`POST /attach` — ADR-0063) ----------------------------------------------------
// The post-Ready attach (ADR-0004, ADR-0051), run by the Harness in its own container instead of
// by the Orchestrator over `kubectl exec`: no stream per Workspace crosses the API server, and a
// pod already running can receive its Repos and branch late. Gated on the same bearer as every
// route (ADR-0058). Idempotent: a second attach with the same body finds every checkout and
// worktree present and answers the same paths.

/** One Repo Slot to attach. The Orchestrator resolves the Repo's `identity` and cache `key`
 * (repo-identity.ts) — the Harness never re-derives them, so the cache path this side clones from
 * and the node cache the operator mounted agree by construction (ADR-0051). `url` is the Binding's
 * own spelling, the push url (ADR-0005); `ref` is the base the branch starts from, omitted for the
 * Repo's default branch. */
export type AttachSlot = { slot: string; url: string; identity: string; key: string; ref?: string };

/** What `POST /attach` accepts: the slots in declaration order, the Workspace's branch, and — for a
 * reviewer's seat — the sha the detached review worktree is forced to (ADR-0028). */
export type AttachRequest = { slots: AttachSlot[]; branch: string; reviewSha?: string };

/** What `POST /attach` answers (200): the branch worktree per slot, and the review worktree per
 * slot when the request named a `reviewSha`. Freshness (`stale`) is not here: it is the operator's
 * verdict on the Sandbox, which the Orchestrator reads itself. */
export type AttachResponse = { repos: Record<string, string>; review?: Record<string, string> };

/** What a failed attach answers: 400 for a body that is not an `AttachRequest`, 500 when a step
 * failed — `slot` names the Repo Slot, and `error` carries the step and git's own stderr. */
export type AttachError = { error: string; slot?: string };

// --- the sync (ADR-0067) ------------------------------------------------------------------------
// After a push whose published commit is not the Agent's own — signed copies of its commits, or
// one squashed commit, signed or not — the sync moves the Agent's branch to it, here, in the
// Harness container, with one `update-ref` (files, index, HEAD and stash do not change). The
// bundle of the published commits travels through the Orchestrator. Same bearer as every Harness route (ADR-0058).

/** What `POST /sync` accepts: the branch Worktree (absolute, under `/work`), the branch, the pair
 * the push published (`published`, the published tip; `source`, the Agent's commit it re-creates) and,
 * when the push just ran, the bundle of the published commits (base64). With no bundle the published
 * commits must already be in the Agent's store (a sync run again). */
export type SyncRequest = { worktree: string; branch: string; published: string; source: string; bundle?: string };

/** What the sync answers — a report, which the next push never trusts. `synced`: the branch moved
 * (`replayed` commits the Agent made after the push were copied onto the published tip). `already`:
 * the branch holds the published tip. `skipped`: the push published the Agent's own commit. `busy`: a rebase, merge,
 * cherry-pick or revert of the branch is in progress; nothing changed. `not-synced`: the branch
 * did not move (`reason` says why). */
export type SyncAnswer =
  | { sync: "synced"; from: string; to: string; replayed: number; tries: number }
  | { sync: "already" }
  | { sync: "skipped" | "busy" | "not-synced"; reason: string };

// --- the exec (a `command` Effect, ADR-0067) ----------------------------------------------------
// A Machine's `command` Effect runs here, in the Harness container of its Workspace's Sandbox: a
// child of the Harness process, so the Agent's user and the same Stand-ins, never through a shell.
// The Orchestrator names each exec by its Effect's id, so one id runs once whoever asks again.
// Same bearer as every Harness route (ADR-0058).

/** What `POST /exec/:id` accepts. `argv` is never shell text: each entry is one argument. `cwd` is
 * absolute, or absent for the Harness's own (`/work`). `tail`: how many characters of the end of
 * the stream the output keeps. */
export type ExecRequest = { argv: string[]; cwd?: string; timeoutMs: number; tail: number };

/** How an exec ended: it exited (a command not found is exit 127), its timeout killed its process
 * group, or a signal ended it. Every one is output; none is a fault. */
export type ExecOutcome =
  | { outcome: "exited"; code: number; tail: string }
  | { outcome: "timeout"; tail: string }
  | { outcome: "killed"; signal: string; tail: string };

/** What `GET /exec/:id` answers: the stream from `offset` (stdout and stderr, in arrival order) up
 * to `next`, and the output once settled. `dropped`: characters before `offset` the Harness no
 * longer keeps. A read with no `offset` starts at the end — a re-attach reads what comes next. */
export type ExecRead = {
  state: "running" | "settled";
  stream: string;
  next: number;
  dropped?: number;
  output?: ExecOutcome;
};
