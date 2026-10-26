// The Conversation's re-owned semantics (ADR-0027): accept-and-queue in admission order, one
// running Submission per conversation, the abort sweep (admission order, `submission_aborted`),
// settlement outcomes, opaque monotone offsets, and long-poll parking that settlements wake.
// Turn execution is scripted — no pi, no HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation, NO_SWEEP_MESSAGE, TURN_OVER, TurnOverError } from "../src/conversation.ts";
import type { TurnDials } from "../src/spec.ts";
import { SUBMISSION_ABORTED, type AdmissionRequest, type Settlement, type StreamEvent } from "../src/wire.ts";

type ScriptedRun = {
  message: string;
  /** The whole admitted request — the dials this Submission was framed with (ADR-0018)
   * reach the turn beside the prompt. */
  submission: AdmissionRequest;
  signal: AbortSignal;
  resolve: (end?: typeof TURN_OVER) => void;
  reject: (err: unknown) => void;
};

/** The definition every admission carries (ADR-0049) — irrelevant to ordering, which is what this
 * suite is about, so one constant serves them all. */
const CODER = { model: "faux/model", instructions: "code" };

/** A Conversation whose turns the test settles by hand. `admit` keeps the prompt-only shape most
 * of these tests care about; dials ride the optional second argument. */
function scripted(sweepWaitMs?: number) {
  const runs: ScriptedRun[] = [];
  const conversation = new Conversation(
    "coder",
    "iid-1",
    (submission, signal) => {
      return new Promise<void | typeof TURN_OVER>((resolve, reject) => {
        runs.push({ message: submission.message, submission, signal, resolve, reject });
      });
    },
    undefined,
    sweepWaitMs === undefined ? {} : { sweepWaitMs },
  );
  const admit = (message: string, dials?: TurnDials) => conversation.admit({ message, definition: CODER, ...dials });
  return { conversation, runs, admit };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function settlementEvents(conversation: Conversation, offset: string): Settlement[] {
  return conversation
    .updatesView(offset)
    .events.flatMap((event) =>
      event.type === "submission-settled"
        ? [{ submissionId: event.submissionId, outcome: event.outcome, ...(event.error ? { error: event.error } : {}) }]
        : [],
    );
}

test("admit accepts and queues: answers synchronously, only the first Submission runs", () => {
  const { conversation, runs, admit } = scripted();
  const first = admit("one");
  const second = admit("two");
  assert.equal(first.streamUrl, "/agents/coder/iid-1");
  assert.notEqual(first.submissionId, second.submissionId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.message, "one");
});

test("promotion is admission order: each settlement promotes the next Submission", async () => {
  const { conversation, runs, admit } = scripted();
  const admissions = [admit("one"), admit("two"), admit("three")];
  for (let i = 0; i < 3; i++) {
    assert.equal(runs.length, i + 1);
    runs[i]!.resolve();
    await flush();
  }
  assert.deepEqual(
    conversation.historyView().settlements,
    admissions.map(({ submissionId }) => ({ submissionId, outcome: "completed" })),
  );
});

test("a rejected turn settles failed, carrying the error message", async () => {
  const { conversation, runs, admit } = scripted();
  const { submissionId } = admit("one");
  runs[0]!.reject(new Error("provider melted"));
  await flush();
  assert.deepEqual(conversation.historyView().settlements, [
    { submissionId, outcome: "failed", error: { type: "submission_failed", message: "provider melted" } },
  ]);
});

test("abort sweeps active + queued: aborted in admission order, signal fired, nothing promoted", async () => {
  const { conversation, runs, admit } = scripted();
  const admissions = [admit("one"), admit("two"), admit("three")];
  const { offset } = admissions[0]!;

  assert.deepEqual(conversation.abort(), { aborted: true });
  assert.equal(runs[0]!.signal.aborted, true);

  const expected = admissions.map(({ submissionId }) => ({
    submissionId,
    outcome: "aborted",
    error: { type: SUBMISSION_ABORTED },
  }));
  assert.deepEqual(conversation.historyView().settlements, expected);
  // The sweep is also on the stream, same order — what a re-attached wait matches by.
  assert.deepEqual(settlementEvents(conversation, offset), expected);

  await flush();
  assert.equal(runs.length, 1, "swept Submissions never run");
});

test("a run that ends because its Turn is over settles nothing: the sweep settles it — ended for `pick`, aborted for no cause — and only then does the next Submission run (ADR-0024)", async () => {
  for (const [cause, expected] of [
    ["pick", { outcome: "ended" }],
    [undefined, { outcome: "aborted", error: { type: SUBMISSION_ABORTED } }],
  ] as const) {
    const { conversation, runs, admit } = scripted();
    const { submissionId } = admit("one");
    runs[0]!.resolve(TURN_OVER);
    await flush();
    assert.deepEqual(conversation.historyView().settlements, [], "it waits for the sweep");
    admit("two");
    await flush();
    assert.equal(runs.length, 1, "the next Submission queues behind it");
    assert.deepEqual(conversation.abort(cause, cause && submissionId), { aborted: true });
    await flush();
    const [first, second] = conversation.historyView().settlements;
    assert.deepEqual(first, { submissionId, ...expected });
    assert.equal(second?.outcome, "aborted", "the queued one never ran: aborted for every cause");
  }
});

test("a sweep with the cause `pick` while the run still runs: ended, and the run's later end changes nothing (ADR-0024)", async () => {
  const { conversation, runs, admit } = scripted();
  const { submissionId } = admit("one");
  assert.deepEqual(conversation.abort("pick", submissionId), { aborted: true });
  runs[0]!.resolve(TURN_OVER);
  await flush();
  assert.deepEqual(conversation.historyView().settlements, [{ submissionId, outcome: "ended" }]);
  admit("again");
  await flush();
  assert.equal(runs.length, 2, "the seat is free");
});

test("no sweep within the wait: the Submission settles aborted, and says that no sweep came (ADR-0024)", async () => {
  const { conversation, runs, admit } = scripted(20);
  const { submissionId } = admit("one");
  runs[0]!.resolve(TURN_OVER);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(conversation.historyView().settlements, [
    { submissionId, outcome: "aborted", error: { type: SUBMISSION_ABORTED, message: NO_SWEEP_MESSAGE } },
  ]);
  assert.deepEqual(conversation.abort("pick", submissionId), { aborted: false }, "a late sweep finds nothing to end");
});

test("a cause `pick` that names another Submission, or none, is not about the running one: aborted (ADR-0024)", async () => {
  for (const named of ["s-elsewhere", undefined]) {
    const { conversation, runs, admit } = scripted();
    const { submissionId } = admit("one");
    runs[0]!.resolve(TURN_OVER);
    await flush();
    assert.deepEqual(conversation.abort("pick", named), { aborted: true });
    assert.deepEqual(conversation.historyView().settlements, [
      { submissionId, outcome: "aborted", error: { type: SUBMISSION_ABORTED } },
    ]);
  }
});

test("a memory kill while the Submission waits for its sweep is not put on the stream: its run has ended (ADR-0062)", async () => {
  const { conversation, runs, admit } = scripted();
  const { submissionId } = admit("one");
  runs[0]!.resolve(TURN_OVER);
  await flush();
  assert.equal(conversation.reportMemoryLimit({ id: "k-1", peak: "1.9Gi", limit: "2Gi" }), false);
  conversation.abort("pick", submissionId);
});

test("a restart while the Submission waits for its sweep: the rebuild settles it aborted, as the end of the wait does (ADR-0024, ADR-0031)", async () => {
  const lines = { admitted: [] as string[], over: [] as string[], log: [] as StreamEvent[] };
  const recorder = {
    admitted: (id: string) => void lines.admitted.push(id),
    appended: (event: StreamEvent) => void lines.log.push(event),
    said: () => {},
    over: (id: string) => void lines.over.push(id),
  };
  const runs: ScriptedRun[] = [];
  const conversation = new Conversation(
    "coder",
    "iid-1",
    (submission, signal) =>
      new Promise<void | typeof TURN_OVER>((resolve, reject) =>
        runs.push({ message: submission.message, submission, signal, resolve, reject }),
      ),
    recorder,
    { sweepWaitMs: 60_000 },
  );
  const over = conversation.admit({ message: "one", definition: CODER });
  runs[0]!.resolve(TURN_OVER);
  await flush();
  const cut = conversation.admit({ message: "two", definition: CODER });
  // The process stops here: no sweep, no end of the wait.
  const rebuilt = Conversation.rebuilt(
    {
      agentName: "coder",
      instanceId: "iid-1",
      admitted: lines.admitted,
      over: lines.over,
      log: lines.log,
      messages: [],
      settlements: [],
    },
    async () => {},
  );
  assert.deepEqual(
    rebuilt
      .historyView()
      .settlements.map((s) => ({ submissionId: s.submissionId, outcome: s.outcome, type: s.error?.type })),
    [
      { submissionId: over.submissionId, outcome: "aborted", type: SUBMISSION_ABORTED },
      { submissionId: cut.submissionId, outcome: "failed", type: "harness_restarted" },
    ],
  );
  assert.equal(rebuilt.historyView().settlements[0]!.error?.message, NO_SWEEP_MESSAGE);
  conversation.abort();
});

test("abort on an idle conversation answers { aborted: false }", async () => {
  const { conversation, runs, admit } = scripted();
  assert.deepEqual(conversation.abort(), { aborted: false });
  admit("one");
  runs[0]!.resolve();
  await flush();
  assert.deepEqual(conversation.abort(), { aborted: false }, "everything settled is idle again");
});

test("a signal-caused rejection settles aborted exactly once, never failed", async () => {
  let calls = 0;
  const conversation = new Conversation("coder", "iid-1", (_submission, signal) => {
    calls++;
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("run torn down")));
    });
  });
  const { submissionId } = conversation.admit({ message: "one", definition: CODER });
  conversation.abort();
  await flush();
  assert.deepEqual(conversation.historyView().settlements, [
    { submissionId, outcome: "aborted", error: { type: SUBMISSION_ABORTED } },
  ]);
  // The swept turn wound down, so a post-abort admission is first unsettled and runs.
  conversation.admit({ message: "again", definition: CODER });
  await flush();
  assert.equal(calls, 2);
});

test("offsets are monotone: each nextOffset reads exactly what landed after it", async () => {
  const { conversation, runs, admit } = scripted();
  const { offset } = admit("one");

  conversation.appendMessage({ role: "user", text: "one" });
  conversation.appendMessage({ role: "assistant", text: "hi" });
  const view = conversation.updatesView(offset);
  assert.equal(view.events.length, 2);
  assert.equal(view.upToDate, true);
  assert.equal(conversation.updatesView(view.nextOffset).events.length, 0);

  runs[0]!.resolve();
  await flush();
  const tail = conversation.updatesView(view.nextOffset);
  assert.equal(tail.events.length, 1, "only the settlement landed after nextOffset");
  assert.equal(tail.events[0]!.type, "submission-settled");
  assert.notEqual(tail.nextOffset, view.nextOffset);
});

test("a parked long-poll wakes on settlement", async () => {
  const { conversation, runs, admit } = scripted();
  const { offset } = admit("one");
  const parked = conversation.waitForEvent(offset, 60_000);
  runs[0]!.resolve();
  const view = await parked;
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0]!.type, "submission-settled");
});

test("a long-poll with events already past the offset answers immediately", async () => {
  const { conversation } = scripted();
  conversation.appendMessage({ role: "assistant", text: "already here" });
  const view = await conversation.waitForEvent("0", 60_000);
  assert.equal(view.events.length, 1);
});

test("a long-poll that times out answers empty with the same offset — the 204", async () => {
  const { conversation } = scripted();
  const view = await conversation.waitForEvent("0", 20);
  assert.deepEqual(view, { events: [], nextOffset: "0", upToDate: true });
});

test("historyView carries the wire shape: settlements are the contract, messages best-effort", async () => {
  const { conversation, runs, admit } = scripted();
  const { submissionId } = admit("one");
  conversation.appendMessage({ role: "user", text: "one" });
  conversation.appendMessage({ role: "assistant", text: "done" });
  runs[0]!.resolve();
  await flush();
  assert.deepEqual(conversation.historyView(), {
    v: 1,
    conversationId: "iid-1",
    offset: "3",
    messages: [
      { role: "user", text: "one" },
      { role: "assistant", text: "done" },
    ],
    settlements: [{ submissionId, outcome: "completed" }],
  });
});

test("stream chunks carry the flue-lineage envelope the retiring SDK validates (ADR-0027 migration)", async () => {
  // The phased migration's safety property — an old Orchestrator drives the new image — holds
  // only while every updates-view element passes `@flue/sdk`'s chunk validator: a known flat
  // `type`, a `conversationId`, and a numeric `position` on every chunk.
  const { conversation, runs, admit } = scripted();
  const { offset, submissionId } = admit("one");
  conversation.appendMessage({ role: "assistant", text: "hi" });
  runs[0]!.resolve();
  await flush();
  const events = conversation.updatesView(offset).events;
  assert.deepEqual(events, [
    {
      type: "message-appended",
      conversationId: "iid-1",
      position: { batch: 0, index: 0 },
      message: { id: "m-1", role: "assistant", parts: [{ type: "text", text: "hi", state: "done" }] },
    },
    {
      type: "submission-settled",
      conversationId: "iid-1",
      position: { batch: 1, index: 0 },
      submissionId,
      outcome: "completed",
    },
  ]);
});

test("a Turn that was over before it started settles aborted, never failed (ADR-0026)", async () => {
  const { conversation, runs, admit } = scripted();
  const { offset, submissionId } = admit("one");
  runs[0]!.reject(new TurnOverError("no live surface"));
  await flush();
  assert.deepEqual(settlementEvents(conversation, offset), [
    { submissionId, outcome: "aborted", error: { type: SUBMISSION_ABORTED, message: "no live surface" } },
  ]);
});

test("a guard kill lands on the stream of a conversation whose Submission is running, and no other (ADR-0062)", async () => {
  const { conversation, runs, admit } = scripted();
  const kill = { id: "k-1", peak: "1.9Gi", limit: "2Gi" };
  // Idle: no Submission was running, and no wait could read it — nothing is appended.
  assert.equal(conversation.reportMemoryLimit(kill), false);
  assert.deepEqual(conversation.updatesView("0").events, []);
  const { offset } = admit("one");
  assert.equal(conversation.reportMemoryLimit(kill), true);
  assert.deepEqual(conversation.updatesView(offset).events, [
    {
      type: "memory-limit",
      conversationId: "iid-1",
      position: { batch: 0, index: 0 },
      id: "k-1",
      peak: "1.9Gi",
      limit: "2Gi",
    },
  ]);
  runs[0]!.resolve();
  await flush();
  // …and it is not in the history view: that view is what was SAID, and the settlement.
  assert.deepEqual(conversation.historyView().messages, []);
});

test("a guard kill after the sweep settled the running Submission is not on its stream: no wait reads past a Settlement (ADR-0062)", async () => {
  const { conversation, admit } = scripted();
  const { offset } = admit("one");
  conversation.abort();
  // The run still winds down — `active` stays set until it returns — but its Settlement is on the
  // stream, and the wait that followed it has stopped reading.
  assert.equal(conversation.reportMemoryLimit({ id: "k-1", peak: "1.9Gi", limit: "2Gi" }), false);
  assert.deepEqual(
    conversation.updatesView(offset).events.map((event) => event.type),
    ["submission-settled"],
  );
});

test("a settlement carries the sum of what its run reported spent; one whose model never answered carries none (ADR-0027)", async () => {
  const answers = [
    { input: 40, output: 20, cacheRead: 60, cacheWrite: 0, cost: 0.0015 },
    { input: 50, output: 30, cacheRead: 90, cacheWrite: 10, cost: 0.0025 },
  ];
  const conversation = new Conversation("coder", "iid-1", async (submission, _signal, seat) => {
    if (submission.message === "spend") for (const usage of answers) seat?.spent(usage);
  });
  const spent = conversation.admit({ message: "spend", definition: CODER });
  const quiet = conversation.admit({ message: "quiet", definition: CODER });
  await conversation.idle();
  const [first, second] = conversation.historyView().settlements;
  assert.equal(first!.submissionId, spent.submissionId);
  assert.deepEqual(first!.usage, { input: 90, output: 50, cacheRead: 150, cacheWrite: 10, cost: 0.004 });
  assert.equal(second!.submissionId, quiet.submissionId);
  assert.equal(second!.usage, undefined, "no model answer, no usage");
  const streamed = conversation.updatesView("0").events.find((e) => e.type === "submission-settled");
  assert.deepEqual(streamed?.type === "submission-settled" ? streamed.usage : undefined, first!.usage);
});
