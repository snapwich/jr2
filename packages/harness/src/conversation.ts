// The Conversation (ADR-0027): one `(Agent name, Instance ID)` exchange. Owns the re-owned
// semantics the ADR states — accept-and-queue (a Submission runs when it is the first unsettled
// Submission of its conversation, admission order), the abort sweep, the append-only stream log
// with j2-minted opaque offsets, the settlements the history view asserts, and the long-poll
// parking that settlement events wake. Turn execution is injected (`runSubmission`), so this
// module owns ordering and observation and never touches pi or HTTP.

import {
  SUBMISSION_ABORTED,
  SUBMISSION_RUNAWAY,
  type AdmissionRequest,
  type AdmissionResponse,
  type HistoryMessage,
  type HistoryView,
  type Settlement,
  type SettlementError,
  type SettlementOutcome,
  type StreamEvent,
  type StreamPosition,
} from "./wire.ts";

/** Run one Submission (the turn, `turn.ts`). Resolution settles `completed`; a rejection settles
 * `failed` — unless the signal fired, which settles `aborted`. The signal is how an abort reaches
 * the active pi run. Takes the whole admitted request, not just its prompt: this Submission's
 * dials frame the turn exactly as the prompt does (ADR-0018). */
export type RunSubmission = (submission: AdmissionRequest, signal: AbortSignal) => Promise<void>;

/** A Turn the Harness itself ended because it would not conclude (ADR-0035) — a runaway trigger
 * tripped in the turn loop. `turn.ts` throws it; the pump maps it to a `failed` settlement typed
 * `"runaway"`, carrying the legible reason as the message. Distinct from the sweep by
 * construction: the pump's signal never fired, so `aborted` stays ADR-0024's word. */
export class RunawayError extends Error {}

/** One stream read, resolved to the end of the log. The HTTP layer carries `nextOffset` and
 * `upToDate` as the stream headers and `events` as the body. */
export type UpdatesView = {
  events: StreamEvent[];
  nextOffset: string;
  upToDate: boolean;
};

/** One admitted Submission, as the queue holds it. `settled` is the guard that lets the abort
 * sweep and the pump race safely: whichever settles first wins, the other is a no-op. */
type SubmissionRecord = {
  submissionId: string;
  submission: AdmissionRequest;
  settled: boolean;
};

export class Conversation {
  readonly agentName: string;
  readonly instanceId: string;
  private readonly runSubmission: RunSubmission;
  /** Admitted, unsettled Submissions in admission order; `queue[0]` is the one that may run. */
  private readonly queue: SubmissionRecord[] = [];
  /** The running Submission. Stays set until its `runSubmission` promise settles — even after an
   * abort sweep settled the record — so two turns never overlap (pi is one-prompt-at-a-time). */
  private active: { record: SubmissionRecord; controller: AbortController } | undefined;
  /** The append-only stream. An offset is the log index as an opaque string. */
  private readonly log: StreamEvent[] = [];
  /** The history view's best-effort `messages`, kept beside the log (the log carries the wire's
   * chunk shapes, not history entries). */
  private readonly messages: HistoryMessage[] = [];
  private readonly settlements: Settlement[] = [];
  /** Parked long-polls; every append wakes all of them. */
  private readonly waiters = new Set<() => void>();
  private admitted = 0;
  private mintedMessages = 0;

  constructor(agentName: string, instanceId: string, runSubmission: RunSubmission) {
    this.agentName = agentName;
    this.instanceId = instanceId;
    this.runSubmission = runSubmission;
  }

  /** Accept and queue (ADR-0027): mint the Admission and answer immediately — running comes
   * later, when the Submission is first unsettled. `streamUrl` is the conversation's wire path,
   * relative; the HTTP layer absolutizes it if it wants to. */
  admit(submission: AdmissionRequest): AdmissionResponse {
    const submissionId = `s-${++this.admitted}-${Math.random().toString(36).slice(2, 8)}`;
    this.queue.push({ submissionId, submission, settled: false });
    const admission: AdmissionResponse = {
      streamUrl: `/agents/${encodeURIComponent(this.agentName)}/${encodeURIComponent(this.instanceId)}`,
      offset: String(this.log.length),
      submissionId,
    };
    this.pump();
    return admission;
  }

  /**
   * The abort sweep (ADR-0024/0027): everything unsettled at processing time — the active
   * Submission and the queue behind it — settles `aborted` in admission order, and the active
   * run's signal fires. Answers `{ aborted: false }` when there is nothing to end.
   */
  abort(): { aborted: boolean } {
    const swept = this.queue.splice(0);
    if (swept.length === 0) return { aborted: false };
    this.active?.controller.abort();
    for (const record of swept) this.settle(record, "aborted", { type: SUBMISSION_ABORTED });
    return { aborted: true };
  }

  /** Append a conversation message to the stream and the history view (the turn's seam —
   * `turn.ts` reports what the model said; the Conversation never interprets it). Wakes parked
   * long-polls. */
  appendMessage(message: HistoryMessage): void {
    this.messages.push(message);
    this.append({
      type: "message-appended",
      conversationId: this.instanceId,
      position: this.nextPosition(),
      message: {
        id: `m-${++this.mintedMessages}`,
        role: message.role,
        parts: [{ type: "text", text: message.text, state: "done" }],
      },
    });
  }

  /** `GET ?view=updates`: every event from `offset` to the end of the log. */
  updatesView(offset: string): UpdatesView {
    const from = this.parseOffset(offset);
    return { events: this.log.slice(from), nextOffset: String(this.log.length), upToDate: true };
  }

  /** `GET ?live=long-poll`: the updates view, parked until an event lands past `offset` or the
   * timeout passes — the empty-`events` resolution is the 204. Settlements append, so they wake. */
  waitForEvent(offset: string, timeoutMs: number): Promise<UpdatesView> {
    const now = this.updatesView(offset);
    if (now.events.length > 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(this.updatesView(offset));
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(this.updatesView(offset));
      };
      this.waiters.add(wake);
    });
  }

  /** `GET ?view=history`: `settlements` is the asserted contract; `messages` is best-effort. */
  historyView(): HistoryView {
    return {
      v: 1,
      conversationId: this.instanceId,
      offset: String(this.log.length),
      messages: [...this.messages],
      settlements: [...this.settlements],
    };
  }

  /** Promote `queue[0]` when nothing is running. Every settlement path funnels back here. */
  private pump(): void {
    if (this.active) return;
    const record = this.queue[0];
    if (!record) return;
    const controller = new AbortController();
    this.active = { record, controller };
    void (async () => {
      try {
        await this.runSubmission(record.submission, controller.signal);
        this.settle(record, "completed");
      } catch (err) {
        // A rejection caused by the signal is the swept turn winding down, not a failure. The
        // sweep normally settled it already; this arm only matters if the run rejected first.
        if (controller.signal.aborted) {
          this.settle(record, "aborted", { type: SUBMISSION_ABORTED });
        } else if (err instanceof RunawayError) {
          this.settle(record, "failed", { type: SUBMISSION_RUNAWAY, message: err.message });
        } else {
          this.settle(record, "failed", {
            type: "submission_failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        this.active = undefined;
        this.pump();
      }
    })();
  }

  private settle(record: SubmissionRecord, outcome: SettlementOutcome, error?: SettlementError): void {
    if (record.settled) return;
    record.settled = true;
    const index = this.queue.indexOf(record);
    if (index !== -1) this.queue.splice(index, 1);
    const settlement: Settlement = { submissionId: record.submissionId, outcome, ...(error ? { error } : {}) };
    this.settlements.push(settlement);
    this.append({
      type: "submission-settled",
      conversationId: this.instanceId,
      position: this.nextPosition(),
      ...settlement,
    });
  }

  /** Each append is its own batch of one — monotone under the wire's (batch, index) order. */
  private nextPosition(): StreamPosition {
    return { batch: this.log.length, index: 0 };
  }

  private append(event: StreamEvent): void {
    this.log.push(event);
    const woken = [...this.waiters];
    this.waiters.clear();
    for (const wake of woken) wake();
  }

  /** Offsets are opaque to clients; here they are the log index. Anything unparsable reads from
   * the start — a stream re-read is always safe, a parked-forever poll is not. */
  private parseOffset(offset: string): number {
    const n = Number.parseInt(offset, 10);
    if (!Number.isInteger(n) || n < 0) return 0;
    return Math.min(n, this.log.length);
  }
}
