// The Conversation's re-owned semantics (ADR-0027): accept-and-queue in admission order, one
// running Submission per conversation, the abort sweep (admission order, `submission_aborted`),
// settlement outcomes, opaque monotone offsets, and long-poll parking that settlements wake.
// Turn execution is scripted — no pi, no HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/conversation.ts";
import type { TurnDials } from "../src/spec.ts";
import { SUBMISSION_ABORTED, type AdmissionRequest, type Settlement } from "../src/wire.ts";

type ScriptedRun = {
  message: string;
  /** The whole admitted request — the dials this Submission was framed with (ADR-0018)
   * reach the turn beside the prompt. */
  submission: AdmissionRequest;
  signal: AbortSignal;
  resolve: () => void;
  reject: (err: unknown) => void;
};

/** The definition every admission carries (ADR-0049) — irrelevant to ordering, which is what this
 * suite is about, so one constant serves them all. */
const CODER = { model: "faux/model", instructions: "code" };

/** A Conversation whose turns the test settles by hand. `admit` keeps the prompt-only shape most
 * of these tests care about; dials ride the optional second argument. */
function scripted() {
  const runs: ScriptedRun[] = [];
  const conversation = new Conversation("coder", "iid-1", (submission, signal) => {
    return new Promise<void>((resolve, reject) => {
      runs.push({ message: submission.message, submission, signal, resolve, reject });
    });
  });
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
