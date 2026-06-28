// PoC #8 — the headline deliverable: the coding Machine driven END TO END on
// mocks, with NO infrastructure (no Kubernetes, no flue, no Postgres). Every
// acceptance criterion from the handoff is asserted here against the in-memory
// Work Source + scripted Agents, all wired through the SAME `assembleCodingMachine`
// the real run uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, type Actor } from "xstate";

import { assembleCodingMachine, type TopMachine } from "../src/coding/index.ts";
import { CODER_MENU, REVIEWER_MENU, assertInMenu } from "../src/coding/control-surface.ts";
import { InMemoryWorkSource } from "../src/coding/testing/mock-work-source.ts";
import { makeWorkSourceProviders } from "../src/coding/work-source.ts";
import {
  mockCodingProviders,
  workSourceActions,
  makeMockCreateSandbox,
  makeMockCleanupSandbox,
  mockWorktree,
  makeMockReviewer,
  makeBarrierCoder,
  pushReadiness,
  Barrier,
  newTracker,
  type CoderScript,
  type ReviewerScript,
} from "../src/coding/testing/mock-providers.ts";

// --- helpers ----------------------------------------------------------------

async function until(pred: () => boolean, msg = "condition", timeout = 3000, every = 4): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timeout waiting for: ${msg}`);
}

function run(
  machine: TopMachine,
  input: { maxConcurrent: number; reviewRoundsMax?: number; holder?: string },
): Actor<TopMachine> {
  const actor = createActor(machine, { input });
  actor.start();
  return actor;
}

// Common scripts.
const coderRequestsReview: CoderScript = () => [{ emit: "request_review" }];
const coderDone: CoderScript = () => [{ emit: "done" }];
const reviewerApproves: ReviewerScript = () => ({ emit: "approve" });
const reviewerRequestsChanges: ReviewerScript = () => ({ emit: "request_changes", notes: "fix it" });

// --- 1. claims in dependency (ready) order ---------------------------------

test("claims in ready-order: a dependent feature waits for its dependency", async () => {
  // B depends on A; A and C are independent. maxConcurrent=2 → A and C claim
  // first; B must NOT be claimed until A is done.
  const source = new InMemoryWorkSource([{ id: "A" }, { id: "C" }, { id: "B", dependsOn: ["A"] }]);
  const tracker = newTracker();
  const actor = run(
    assembleCodingMachine(mockCodingProviders({ source, tracker, coder: coderDone, reviewer: reviewerApproves })),
    {
      maxConcurrent: 2,
    },
  );

  await until(() => source.allFeaturesDone(), "all features done");
  actor.stop();

  // The first two Sandboxes are the independent features — never the blocked B.
  assert.deepEqual(new Set(tracker.sandboxCreated.slice(0, 2)), new Set(["A", "C"]));
  assert.ok(tracker.sandboxCreated.includes("B"), "B eventually ran");
  assert.ok(tracker.sandboxCreated.indexOf("B") > tracker.sandboxCreated.indexOf("A"), "B claimed only after A");
});

// --- 2. bounded pool: parallelism capped, tasks sequential within a feature -

test("runs features up to maxConcurrent in parallel, never more", async () => {
  const source = new InMemoryWorkSource([{ id: "F1" }, { id: "F2" }, { id: "F3" }]);
  const tracker = newTracker();
  const barrier = new Barrier();

  const ws = makeWorkSourceProviders(source);
  const providers = {
    readiness: pushReadiness(source),
    claimNextFeature: ws.claimNextFeature,
    claimNextTask: ws.claimNextTask,
    createSandbox: makeMockCreateSandbox(tracker),
    setupWorktree: mockWorktree,
    cleanupSandbox: makeMockCleanupSandbox(tracker),
    coder: makeBarrierCoder(barrier, tracker), // hold every coder busy
    reviewer: makeMockReviewer(reviewerApproves),
    ...workSourceActions(source),
  };
  const actor = run(assembleCodingMachine(providers), { maxConcurrent: 2 });

  // With all coders blocked, exactly 2 Sandboxes go live and the pool saturates.
  await until(() => actor.getSnapshot().value === "saturated", "pool saturates at 2");
  assert.equal(actor.getSnapshot().context.activeCount, 2);
  assert.equal(tracker.sandboxCreated.length, 2, "3rd feature not claimed while saturated");

  barrier.release(); // let them finish; the 3rd starts as workers free up
  await until(() => source.allFeaturesDone(), "all 3 features done");
  actor.stop();

  assert.equal(tracker.peakConcurrent, 2, "never exceeded maxConcurrent");
  assert.deepEqual(new Set(tracker.sandboxCreated), new Set(["F1", "F2", "F3"]));
});

test("runs tasks sequentially within a feature (one Agent at a time)", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0", "t1", "t2"] }]);
  const tracker = newTracker();
  const actor = run(
    assembleCodingMachine(
      mockCodingProviders({ source, tracker, coder: coderRequestsReview, reviewer: reviewerApproves }),
    ),
    { maxConcurrent: 1 },
  );

  await until(() => source.allFeaturesDone(), "feature done");
  actor.stop();

  // Tasks were coded strictly in order, never interleaved (one Sandbox).
  assert.deepEqual(
    tracker.coderTurns.map((t) => t.taskId),
    ["t0", "t1", "t2"],
  );
  assert.equal(tracker.sandboxCreated.length, 1, "one Sandbox for the feature");
  assert.equal(tracker.sandboxCleaned.length, 1, "Sandbox torn down once");
});

// --- 3. code → review → approve closes the task and loops -------------------

test("approve closes the task and the loop advances", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0", "t1"] }]);
  const tracker = newTracker();
  const actor = run(
    assembleCodingMachine(
      mockCodingProviders({ source, tracker, coder: coderRequestsReview, reviewer: reviewerApproves }),
    ),
    { maxConcurrent: 1 },
  );

  await until(() => source.allFeaturesDone(), "feature done");
  actor.stop();

  assert.equal(source.statusOf("t0"), "done");
  assert.equal(source.statusOf("t1"), "done");
  assert.equal(tracker.reviewerTurns.length, 2, "each task reviewed once");
});

// --- 4. review-round cap is honored (no infinite loop) ---------------------

test("honors the review-round cap, then escalates", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0"] }]);
  const tracker = newTracker();
  const actor = run(
    assembleCodingMachine(
      mockCodingProviders({ source, tracker, coder: coderRequestsReview, reviewer: reviewerRequestsChanges }),
    ),
    { maxConcurrent: 1, reviewRoundsMax: 2 },
  );

  await until(() => source.allFeaturesDone(), "feature completes despite cap");
  actor.stop();

  // rounds 0,1,2 coded+reviewed, then escalate (guard reviewRound<2 fails at 2).
  assert.deepEqual(
    tracker.coderTurns.map((t) => t.round),
    [0, 1, 2],
  );
  assert.deepEqual(
    tracker.reviewerTurns.map((t) => t.round),
    [0, 1, 2],
  );
  assert.equal(source.statusOf("t0"), "blocked", "task escalated to blocked");
  assert.ok(
    source.comments.some((c) => c.body.includes("cap exceeded")),
    "escalation commented",
  );
  // Fresh reviewer context: a distinct Instance ID per round (never the coder's).
  assert.equal(new Set(tracker.reviewerTurns.map((t) => t.instanceId)).size, 3);
});

// --- 5. solicited approval gate round-trips --------------------------------

test("a coder request_approval is answered and the run proceeds", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0"] }]);
  const tracker = newTracker();
  // The coder blocks on approval before finishing; if it were never answered the
  // task would never complete and this test would time out.
  const coder: CoderScript = () => [{ emit: "request_approval", action: "git push" }, { emit: "done" }];
  const actor = run(
    assembleCodingMachine(mockCodingProviders({ source, tracker, coder, reviewer: reviewerApproves })),
    {
      maxConcurrent: 1,
    },
  );

  await until(() => source.allFeaturesDone(), "approval answered, task done");
  actor.stop();
  assert.equal(source.statusOf("t0"), "done");
});

// --- 6. idles (daemon) when empty, wakes on WORK_READY ---------------------

test("idles when the ready-set empties, then wakes when work arrives", async () => {
  const source = new InMemoryWorkSource([]); // empty backlog
  const tracker = newTracker();
  const actor = run(
    assembleCodingMachine(mockCodingProviders({ source, tracker, coder: coderDone, reviewer: reviewerApproves })),
    {
      maxConcurrent: 1,
    },
  );

  await until(() => actor.getSnapshot().value === "idle", "machine idles on empty backlog");
  assert.equal(actor.getSnapshot().status, "active", "daemon — not terminated");
  assert.equal(tracker.sandboxCreated.length, 0);

  // Inject work — the push readiness actor fires WORK_READY and the pool wakes.
  source.addFeature({ id: "late" });
  await until(() => source.allFeaturesDone(), "late feature processed after wake");
  actor.stop();
  assert.deepEqual(tracker.sandboxCreated, ["late"]);
});

// --- 7. a reopened/added item mid-run needs no special Machine state --------

test("an item added mid-run is picked up on the next claim (no special state)", async () => {
  const source = new InMemoryWorkSource([{ id: "F1" }]);
  const tracker = newTracker();
  const barrier = new Barrier();

  const ws = makeWorkSourceProviders(source);
  const providers = {
    readiness: pushReadiness(source),
    claimNextFeature: ws.claimNextFeature,
    claimNextTask: ws.claimNextTask,
    createSandbox: makeMockCreateSandbox(tracker),
    setupWorktree: mockWorktree,
    cleanupSandbox: makeMockCleanupSandbox(tracker),
    coder: makeBarrierCoder(barrier, tracker),
    reviewer: makeMockReviewer(reviewerApproves),
    ...workSourceActions(source),
  };
  const actor = run(assembleCodingMachine(providers), { maxConcurrent: 1 });

  // F1 is in-flight (coder blocked). Inject F2 while the Machine is busy.
  await until(() => tracker.sandboxCreated.includes("F1"), "F1 in-flight");
  source.addFeature({ id: "F2" });

  barrier.release();
  await until(() => source.allFeaturesDone(), "both processed");
  actor.stop();

  assert.deepEqual(new Set(tracker.sandboxCreated), new Set(["F1", "F2"]));
  // The ready-set mutated; the Machine just re-queried claimNext — no F2-specific state.
});

// --- 8. the memory slot: unfilled = noop in place; filled = active in place -

test("memory slot is an observable noop when unfilled", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0", "t1"] }]);
  const tracker = newTracker();
  // memory omitted → the template's passthrough noop sits in position.
  const actor = run(
    assembleCodingMachine(
      mockCodingProviders({ source, tracker, coder: coderRequestsReview, reviewer: reviewerApproves }),
    ),
    { maxConcurrent: 1 },
  );
  await until(() => source.allFeaturesDone(), "feature done with noop memory");
  actor.stop();
  assert.equal(tracker.memoryInjected.length, 0, "noop did nothing, in place");
});

test("filling the memory slot activates it in place — same template, no edit", async () => {
  const source = new InMemoryWorkSource([{ id: "F1", tasks: ["t0", "t1"] }]);
  const tracker = newTracker();
  // memory:true → inject a real memory provider into the SAME template.
  const actor = run(
    assembleCodingMachine(
      mockCodingProviders({ source, tracker, coder: coderRequestsReview, reviewer: reviewerApproves, memory: true }),
    ),
    { maxConcurrent: 1 },
  );
  await until(() => source.allFeaturesDone(), "feature done with active memory");
  actor.stop();
  // Activated once per task, in the pre-coding position — no template change.
  assert.deepEqual(
    tracker.memoryInjected.map((m) => m.taskId),
    ["t0", "t1"],
  );
});

// --- 9. control surface: agents only pick from the state's flat menu --------

test("control surface: every advertised pick is in the state's flat menu", () => {
  // Positive — the picks the mocks emit are all menu-legal.
  for (const pick of ["request_review", "done", "report_blocked", "request_approval"]) {
    assert.doesNotThrow(() => assertInMenu(CODER_MENU, pick));
  }
  for (const pick of ["approve", "request_changes"]) {
    assert.doesNotThrow(() => assertInMenu(REVIEWER_MENU, pick));
  }
  // Negative — an off-menu pick is rejected (the Agent cannot steer the workflow).
  assert.throws(() => assertInMenu(CODER_MENU, "approve"), /not in the advertised menu/);
  assert.throws(() => assertInMenu(REVIEWER_MENU, "done"), /not in the advertised menu/);
});
