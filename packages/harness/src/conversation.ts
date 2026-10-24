// The Conversation (ADR-0027): one `(Agent name, Instance ID)` exchange. Owns the re-owned
// semantics the ADR states — accept-and-queue (a Submission runs when it is the first unsettled
// Submission of its conversation, admission order), the abort sweep, the append-only stream log
// with jr2-minted opaque offsets, the settlements the history view asserts, and the long-poll
// parking that settlement events wake. Turn execution is injected (`runSubmission`), so this
// module owns ordering and observation and never touches pi or HTTP. Its record is written through
// an injected recorder as it goes, and a boot rebuilds it from that record (ADR-0031, `record.ts`).

import type { ConversationRecorder, RecordedConversation } from "./record.ts";
import {
  SUBMISSION_ABORTED,
  SUBMISSION_HARNESS_RESTARTED,
  SUBMISSION_RESTARTED_MESSAGE,
  SUBMISSION_RUNAWAY,
  type AbortCause,
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

/** Run one Submission (the turn, `turn.ts`). Resolution settles `completed` — unless it resolves
 * `TURN_OVER`: a pick found the Turn over and the run ended at the step boundary, so the Submission
 * waits for the Orchestrator's sweep, which says how the Turn ended (ADR-0024). A rejection settles
 * `failed` — unless the signal fired, which settles `aborted`. The signal is how an abort reaches
 * the active pi run. Takes the whole admitted request, not just its prompt: this Submission's
 * definition and dials frame the turn exactly as the prompt does (ADR-0018/0049). */
export type RunSubmission = (
  submission: AdmissionRequest,
  signal: AbortSignal,
  seat?: SubmissionSeat,
) => Promise<void | typeof TURN_OVER>;

/** What a run resolves when a pick found its Turn over (ADR-0024): the Harness does not settle it,
 * the Orchestrator's sweep does. */
export const TURN_OVER = "turn-over";

/**
 * How long a Submission whose run ended because its Turn is over waits for the Orchestrator's sweep
 * before it settles `aborted` itself (ADR-0024). The Orchestrator sends the sweep in the macrostep
 * that ends the Turn, before the pick's own receipt answers, so it lands within a round trip:
 * milliseconds. 10 s is far above that, and above a slow hop or a pause of the Orchestrator's
 * process; it is below every drain window (ADR-0031), so a stopping Harness still settles it.
 * Nothing waits on the Submission meanwhile: its run has ended, its actor has stopped, and the next
 * Turn on the conversation is admitted only after the sweep (the ordered abort).
 */
export const SWEEP_WAIT_MS = 10_000;

/** The message of a Submission whose Turn was over and no sweep came within `SWEEP_WAIT_MS`. */
export const NO_SWEEP_MESSAGE =
  "a pick found the Turn over, and no sweep came from the Orchestrator to say how it ended, so it settles aborted (ADR-0024)";

/**
 * What a running Submission tells its Conversation, and what a stopping Harness asks of it
 * (ADR-0031). A Turn whose only pending work is an outstanding pick's poll says so (`waiting`): a
 * drain cuts it at once rather than waiting on an answer that can take a human's time. `cut` fires
 * then: the Turn stops where it is — the poll is dropped unanswered, so the Orchestrator still holds
 * the answer for the re-admission, and nothing more reaches the model or the conversation.
 */
export type SubmissionSeat = {
  waiting: (onPickOnly: boolean) => void;
  cut: AbortSignal;
};

/** What a cut Submission's settlement says (ADR-0031): typed as a restart, which is what it is to
 * the Orchestrator — the Turn was cut while the workflow ran its pick. */
export const SUBMISSION_CUT_MESSAGE =
  "the Harness stopped while this Turn waited only on its pick's answer; the workflow runs on (ADR-0031)";

/** A Turn the Harness itself ended because it would not conclude (ADR-0035) — a runaway trigger
 * tripped in the turn loop. `turn.ts` throws it; the pump maps it to a `failed` settlement typed
 * `"runaway"`, carrying the legible reason as the message. Distinct from the sweep by
 * construction: the pump's signal never fired. A Runaway is a failure, so it is never `aborted` or
 * `ended`, which are the ends of a Turn (ADR-0024). */
export class RunawayError extends Error {}

/** A Turn that was over before it started (ADR-0026), so its Submission settles `aborted` at once,
 * the sweep's word: nothing is wrong, and a `failed` here would cry wolf. Its surface read answered
 * 404, so the state that asked for it has exited and the abort is on its way; `turn.ts` throws it
 * before the model is asked and before anything is written to the conversation. It never ran, so
 * there is nothing for the sweep to judge. */
export class TurnOverError extends Error {}

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
  private active:
    | {
        record: SubmissionRecord;
        controller: AbortController;
        /** The run says its only pending work is an outstanding pick's poll (`SubmissionSeat`). */
        onPickOnly: boolean;
        /** Fired when a stopping Harness cuts it (`drain`). */
        cut: AbortController;
        /** The run ended because its Turn is over, and the Submission waits for the sweep, at most
         * `SWEEP_WAIT_MS` (ADR-0024). */
        waiting?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** Set by `drain`: a Turn that waits only on its pick's answer is cut, now or when it comes to. */
  private stopping = false;
  /** The append-only stream. An offset is the log index as an opaque string. */
  private readonly log: StreamEvent[] = [];
  /** The history view's best-effort `messages`, kept beside the log (the log carries the wire's
   * chunk shapes, not history entries). */
  private readonly messages: HistoryMessage[] = [];
  private readonly settlements: Settlement[] = [];
  /** Parked long-polls; every append wakes all of them. */
  private readonly waiters = new Set<() => void>();
  /** Drains waiting for this conversation to hold no Submission (`idle`). */
  private readonly idleWaiters = new Set<() => void>();
  /** Where each record line goes as it is appended — memory alone when omitted (ADR-0031). */
  private readonly recorder: ConversationRecorder | undefined;
  private admitted = 0;
  private mintedMessages = 0;
  /** How long a Submission whose Turn is over waits for the sweep (`SWEEP_WAIT_MS`). */
  private readonly sweepWaitMs: number;

  constructor(
    agentName: string,
    instanceId: string,
    runSubmission: RunSubmission,
    recorder?: ConversationRecorder,
    options: { sweepWaitMs?: number } = {},
  ) {
    this.agentName = agentName;
    this.instanceId = instanceId;
    this.runSubmission = runSubmission;
    this.recorder = recorder;
    this.sweepWaitMs = options.sweepWaitMs ?? SWEEP_WAIT_MS;
  }

  /**
   * A conversation as its record left it (ADR-0031): the stream, the messages and the settlements
   * as written, so every offset the Orchestrator holds reads the same events. A Submission admitted
   * but not settled was lost with the process that ran it: it settles `failed` here, on the rebuilt
   * stream, so a re-attached `wait` reads a Settlement instead of parking or reading a 404. Nothing
   * is re-run — a Turn is continued by the conversation's NEXT Submission, never silently.
   */
  static rebuilt(
    recorded: RecordedConversation,
    runSubmission: RunSubmission,
    recorder?: ConversationRecorder,
    options: { sweepWaitMs?: number } = {},
  ): Conversation {
    const conversation = new Conversation(recorded.agentName, recorded.instanceId, runSubmission, recorder, options);
    conversation.log.push(...recorded.log);
    conversation.messages.push(...recorded.messages);
    conversation.settlements.push(...recorded.settlements);
    conversation.admitted = recorded.admitted.length;
    conversation.mintedMessages = recorded.log.filter((event) => event.type === "message-appended").length;
    const settled = new Set(recorded.settlements.map((s) => s.submissionId));
    const over = new Set(recorded.over ?? []);
    for (const submissionId of recorded.admitted) {
      if (settled.has(submissionId)) continue;
      // A run that ended because its Turn was over, and waited for the sweep when the process
      // stopped: no sweep came to it, so it settles as the wait's end settles it (ADR-0024).
      if (over.has(submissionId)) {
        conversation.settle({ submissionId, settled: false }, "aborted", {
          type: SUBMISSION_ABORTED,
          message: NO_SWEEP_MESSAGE,
        });
        continue;
      }
      conversation.settle({ submissionId, settled: false }, "failed", {
        type: SUBMISSION_HARNESS_RESTARTED,
        message: SUBMISSION_RESTARTED_MESSAGE,
      });
    }
    return conversation;
  }

  /** Whether a Submission is running or queued. A busy conversation is never freed (ADR-0031). */
  get busy(): boolean {
    return this.active !== undefined || this.queue.length > 0;
  }

  /** Resolves once the conversation holds no Submission — every admitted one settled and its run
   * wound down. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  /**
   * What a stopping Harness waits on (ADR-0031): every admitted Submission's Turn, the queued ones
   * too — except a Turn whose only pending work is an outstanding pick's poll. That one is cut at
   * once, or as soon as it comes to that: its answer can wait on a human (a Gate), often the one
   * who is stopping the Harness, so no grace period would help. The cut settles it `failed`,
   * `harness_restarted`, as a restart would, with everything queued behind it: the pick stays in the
   * Orchestrator, which re-admits the Agent on this conversation with the answer once the workflow
   * is back at Rest. A Turn still generating or running a tool keeps the graceful wait.
   */
  drain(): Promise<void> {
    this.stopping = true;
    this.cutIfOnPick();
    return this.idle();
  }

  /** Cut the running Turn if a drain is on and its only pending work is its pick's poll. */
  private cutIfOnPick(): void {
    const active = this.active;
    if (!this.stopping || !active?.onPickOnly || active.cut.signal.aborted) return;
    active.cut.abort();
    const error = { type: SUBMISSION_HARNESS_RESTARTED, message: SUBMISSION_CUT_MESSAGE };
    for (const record of [active.record, ...this.queue]) this.settle(record, "failed", error);
    // The run is left where it stopped — parked on a poll that will never answer — and the process
    // exits: nothing it did after this could reach the model or the record.
    this.active = undefined;
    this.pump();
  }

  /** Accept and queue (ADR-0027): mint the Admission and answer immediately — running comes
   * later, when the Submission is first unsettled. `streamUrl` is the conversation's wire path,
   * relative; the HTTP layer absolutizes it if it wants to. */
  admit(submission: AdmissionRequest): AdmissionResponse {
    const submissionId = `s-${++this.admitted}-${Math.random().toString(36).slice(2, 8)}`;
    this.recorder?.admitted(submissionId);
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
   * Submission and the queue behind it — settles in admission order, and the active run's signal
   * fires. The Orchestrator judges how the Turn ended: with the cause `pick` (the Turn's own pick
   * ended it) and the active Submission's id, the active Submission settles `ended`; with no cause,
   * or a cause about another Submission (or none named), `aborted` — a cause is never read about a
   * Submission it does not name. A queued Submission never ran, so it settles `aborted` for every
   * cause. The active Submission may be running still, or its run may have ended because a pick
   * found the Turn over: either way the sweep settles it. Answers `{ aborted: false }` when there is
   * nothing to end.
   */
  abort(cause?: AbortCause, submissionId?: string): { aborted: boolean } {
    const swept = this.queue.splice(0);
    if (swept.length === 0) return { aborted: false };
    const active = this.active;
    active?.controller.abort();
    for (const record of swept) {
      const ended = cause === "pick" && record === active?.record && record.submissionId === submissionId;
      if (ended) this.settle(record, "ended");
      else this.settle(record, "aborted", { type: SUBMISSION_ABORTED });
    }
    // A run that already ended waited only for this: the seat is free.
    if (active?.waiting !== undefined) this.release(active);
    return { aborted: true };
  }

  /** Append a conversation message to the stream and the history view (the turn's seam —
   * `turn.ts` reports what the model said; the Conversation never interprets it). Wakes parked
   * long-polls. */
  appendMessage(message: HistoryMessage): void {
    this.messages.push(message);
    this.recorder?.said(message);
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

  /**
   * The Harness's guard killed the Agent's processes at the memory limit (ADR-0061, layer 4). Put
   * on the stream only while a Submission runs and is not yet settled: the Orchestrator reads a
   * stream from an Admission's offset while it waits on that Submission, so that wait is the one
   * reader that can see it, and the notice it keeps names THIS conversation's Agent as the one whose
   * Turn it was (ADR-0062). The wait can stop before the Settlement — when the Agent's state exits,
   * before its abort lands — so the stream is not the kill's only path: the pod keeps every kill
   * (`pod-kills.ts`), under the same `id`. Not history: the history view is what was said. Returns
   * whether it was put on the stream. A Submission whose run ended and waits for its sweep runs
   * nothing, so a kill then is not its Turn's.
   */
  reportMemoryLimit(kill: { id: string; peak: string; limit: string }): boolean {
    if (!this.active || this.active.record.settled || this.active.waiting !== undefined) return false;
    this.append({
      type: "memory-limit",
      conversationId: this.instanceId,
      position: this.nextPosition(),
      id: kill.id,
      peak: kill.peak,
      limit: kill.limit,
    });
    return true;
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
    if (!record) {
      const idle = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of idle) resolve();
      return;
    }
    const controller = new AbortController();
    const active: NonNullable<Conversation["active"]> = {
      record,
      controller,
      onPickOnly: false,
      cut: new AbortController(),
    };
    this.active = active;
    const seat: SubmissionSeat = {
      waiting: (onPickOnly) => {
        active.onPickOnly = onPickOnly;
        if (this.active === active) this.cutIfOnPick();
      },
      cut: active.cut.signal,
    };
    void (async () => {
      let over = false;
      try {
        const end = await this.runSubmission(record.submission, controller.signal, seat);
        // The Turn is over (ADR-0024): the Orchestrator's sweep says how it ended. It may have
        // landed already; else the Submission waits for it, at most `sweepWaitMs`.
        over = end === TURN_OVER && !record.settled;
        if (end !== TURN_OVER) this.settle(record, "completed");
      } catch (err) {
        // A rejection caused by the signal is the swept turn winding down, not a failure. The
        // sweep normally settled it already; this arm only matters if the run rejected first.
        if (controller.signal.aborted) {
          this.settle(record, "aborted", { type: SUBMISSION_ABORTED });
        } else if (err instanceof TurnOverError) {
          this.settle(record, "aborted", { type: SUBMISSION_ABORTED, message: err.message });
        } else if (err instanceof RunawayError) {
          this.settle(record, "failed", { type: SUBMISSION_RUNAWAY, message: err.message });
        } else {
          this.settle(record, "failed", {
            type: "submission_failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        // A cut run already left the seat (`cutIfOnPick`), and another may hold it now.
        if (this.active === active) {
          if (over) {
            this.recorder?.over?.(record.submissionId);
            active.waiting = setTimeout(() => {
              this.settle(record, "aborted", { type: SUBMISSION_ABORTED, message: NO_SWEEP_MESSAGE });
              this.release(active);
            }, this.sweepWaitMs);
          } else {
            this.active = undefined;
            this.pump();
          }
        }
      }
    })();
  }

  /** Free the seat of a Submission that waited for its sweep, and promote the next. */
  private release(active: NonNullable<Conversation["active"]>): void {
    clearTimeout(active.waiting);
    active.waiting = undefined;
    if (this.active !== active) return;
    this.active = undefined;
    this.pump();
  }

  private settle(
    record: Pick<SubmissionRecord, "submissionId" | "settled">,
    outcome: SettlementOutcome,
    error?: SettlementError,
  ): void {
    if (record.settled) return;
    record.settled = true;
    const index = this.queue.findIndex((queued) => queued === record);
    if (index !== -1) this.queue.splice(index, 1);
    const settlement: Settlement = { submissionId: record.submissionId, outcome, ...(error ? { error } : {}) };
    // Recorded as its stream line alone (`append`): the rebuild reads settlements off the stream.
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
    this.recorder?.appended(event);
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
