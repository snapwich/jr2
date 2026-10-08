// The @model drivers' readings (ADR-0066), pinned without a cluster or a model: the printed
// conversation a claim reads (ADR-0023), a followed log that outlives its pod's reap, and the mode a
// model was asked again in, read from the claim workflow itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assign, createMachine } from "xstate";
import {
  askAfter,
  follow,
  harnessRestarts,
  isNudge,
  isRestatement,
  menuCalls,
  modeAtAsk,
  modesOf,
  restartedHarnessRunning,
  saidAfterPrompt,
  saidIn,
  told,
  type StateNodeLike,
} from "./model-said.ts";

const LOG = [
  "[advisor] [prompt] [t0-aaaaaa] The release notes for v2.3 are drafted:",
  "[advisor] - Faster cold start.",
  '[advisor] [submit] {"notes":"x"}',
  "[advisor] [text] I will wait.",
  "[advisor] [thinking] [Output Generation] not a call",
  "[advisor] [prompt] Your previous turn ended, and the workflow is still waiting for your pick.",
  "[advisor] <jr2-turn>",
  "[advisor] Allowed now: `mcp__jr2__revise`, `mcp__jr2__submit`.",
  "[advisor] </jr2-turn>",
  "[advisor] [prompt] <jr2-turn>",
  '[advisor] [revise] {"why":"y"}',
  "[other] [submit] {}",
  "[advisor] [prompt] [t1-bbbbbb] The next trial.",
  "[advisor] [submit] {}",
].join("\n");

test("the printed conversation of one trial: its calls and prompts, through its nudges, up to the next trial's Frame", () => {
  const said = saidIn(LOG, "advisor", "t0-aaaaaa");
  assert.deepEqual(said, [
    { call: "submit" },
    { prompt: "Your previous turn ended, and the workflow is still waiting for your pick." },
    { prompt: "<jr2-turn>" },
    { call: "revise" },
  ]);
  assert.equal(told(said!), "submit (nudge) (restated) revise");
  assert.ok(isNudge(said![1]!));
  assert.ok(isRestatement(said![2]!));
  assert.deepEqual(menuCalls(said!, new Set(["revise", "submit"]), 1), [{ at: 3, call: "revise" }]);
});

test("a trial whose prompt has not printed reads as undefined", () => {
  assert.equal(saidIn(LOG, "advisor", "t9-zzzzzz"), undefined);
  assert.deepEqual(saidIn(LOG, "advisor", "t1-bbbbbb"), [{ call: "submit" }]);
});

test("a followed process keeps all it printed after it ends — a reaped pod's log is still read (8190a2b)", async () => {
  const f = follow(process.execPath, [
    "-e",
    "console.log('[coder] [prompt] [m] go'); console.log('[coder] [bash] sleep 20')",
  ]);
  await f.closed;
  assert.deepEqual(saidIn(f.text, "coder", "m"), [{ call: "bash" }]);
});

/** A timer that moves the mode: `ask_review` enters a mode with nothing to pick that a timer leaves. */
const notes = createMachine({
  id: "w",
  initial: "notes",
  states: {
    notes: {
      initial: "drafting",
      states: {
        drafting: { on: { ask_review: "waiting" } },
        waiting: { after: { 30_000: "reviewing" } },
        reviewing: { on: { revise: "drafting", submit: "#w.submitted" } },
      },
    },
    submitted: { type: "final" },
  },
}).root.states.notes as unknown as StateNodeLike;

test("the modes are read from the built Machine: each pick's target, and each timer's (efb2d7e)", () => {
  assert.deepEqual(modesOf(notes), {
    drafting: { picks: { ask_review: "waiting" }, after: [] },
    waiting: { picks: {}, after: ["reviewing"] },
    reviewing: { picks: { revise: "drafting", submit: "w.submitted" }, after: [] },
  });
});

test("the mode at the ask: allowed picks move it, refused picks do not, and a woken model is asked once a pick opens", () => {
  const modes = modesOf(notes);
  // `ask_review`, then nothing allowed: a refused `submit` moves nothing; the wake follows the timer.
  const menu = new Set(["ask_review", "revise", "submit"]);
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }, { call: "submit" }], menu), "reviewing");
  // A nudge after picks: `revise` took the model to drafting, where it stopped with a pick left.
  assert.equal(modeAtAsk(modes, "reviewing", [{ call: "revise" }], menu), "drafting");
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "revise" }], menu), "drafting", "not allowed in drafting");
  // A call that is not on the Menu (a Working tool) moves nothing.
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "bash" }, { call: "ask_review" }], menu), "reviewing");
});

test("the mode at the ask takes the timer where the Turn part was restated, not only at the ask", () => {
  const modes = modesOf(notes);
  const menu = new Set(["ask_review", "revise", "submit"]);
  const restated = { prompt: "<jr2-turn>" };
  // The timer fired while the model worked: the restatement told it `revise` and `submit` are
  // allowed, `revise` took it back to drafting, and it stopped there with a pick left — the nudge
  // asks it in drafting. Replayed without the timer, `revise` would be refused in `waiting` and the
  // ask would be read as the wake's, in reviewing.
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }, restated, { call: "revise" }], menu), "drafting");
  // After the restatement, `submit` is a pick of reviewing: it leaves the Agent's state.
  assert.equal(
    modeAtAsk(modes, "drafting", [{ call: "ask_review" }, restated, { call: "submit" }], menu),
    "w.submitted",
  );
  // A restatement in a mode with no timer moves nothing.
  assert.equal(modeAtAsk(modes, "drafting", [restated, { call: "ask_review" }], menu), "reviewing");
});

/** The mode-stop shape: `ask_review` enters a mode whose guarded picks a timer with no target opens —
 * a timer with a target would hold Rest (ADR-0024), and the model would never stop. */
const guarded = createMachine({
  id: "g",
  context: { read: false },
  initial: "notes",
  states: {
    notes: {
      initial: "drafting",
      states: {
        drafting: { on: { ask_review: "reviewing" } },
        reviewing: {
          entry: assign({ read: false }),
          after: { 30_000: { actions: assign({ read: true }) } },
          on: {
            revise: { guard: ({ context }) => context.read, target: "drafting" },
            submit: { guard: ({ context }) => context.read, target: "#g.submitted" },
          },
        },
      },
    },
    submitted: { type: "final" },
  },
}).root.states.notes as unknown as StateNodeLike;

test("a mode with a timer that has no target opens its picks: closed from each entry until the timer fires", () => {
  const modes = modesOf(guarded);
  assert.deepEqual(modes, {
    drafting: { picks: { ask_review: "reviewing" }, after: [] },
    reviewing: { picks: { revise: "drafting", submit: "g.submitted" }, after: [], opens: true },
  });
  const menu = new Set(["ask_review", "revise", "submit"]);
  const restated = { prompt: "<jr2-turn>" };
  // `ask_review`, nothing allowed, the model stopped: the wake asks once the picks open, in reviewing.
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }], menu), "reviewing");
  // A pick made while the picks are closed is refused and moves nothing.
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }, { call: "revise" }], menu), "reviewing");
  // The timer fired while the model worked: the restatement opened the picks, `revise` took it to
  // drafting, where it stopped with a pick left — the nudge asks it there.
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }, restated, { call: "revise" }], menu), "drafting");
  // A second entry closes the picks again until the timer fires again.
  assert.equal(
    modeAtAsk(
      modes,
      "drafting",
      [{ call: "ask_review" }, restated, { call: "revise" }, { call: "ask_review" }, { call: "submit" }],
      menu,
    ),
    "reviewing",
  );
});

test("mode-stop measures the first ask AFTER the model's `ask_review`; a trial with none is void", () => {
  const nudge = { prompt: "Your previous turn ended, and the workflow is still waiting for your pick." };
  const restated = { prompt: "<jr2-turn>" };
  assert.equal(askAfter([{ call: "ask_review" }, nudge, { call: "submit" }], "ask_review"), 1);
  assert.equal(askAfter([{ call: "ask_review" }, restated, { call: "submit" }, nudge], "ask_review"), 3);
  // Stopped in drafting before asking for the review, nudged, then asked: not measured.
  assert.equal(askAfter([nudge, { call: "ask_review" }], "ask_review"), -1, "an ask before the call is not measured");
  assert.equal(askAfter([{ call: "ask_review" }, restated, { call: "submit" }], "ask_review"), -1, "never asked");
  assert.equal(askAfter([nudge, { call: "revise" }], "ask_review"), -1, "never called");
});

test("after a Harness restart: what the model said after the re-admission prompt, which carries no marker (ADR-0031)", () => {
  const log = [
    "[advisor] [prompt] Your previous turn was cut: the process that ran you restarted while the workflow was busy.",
    "[advisor] <jr2-turn>",
    "[advisor] Notice: The pick `mcp__jr2__run_audit` that was cut from your last turn is no longer outstanding: the workflow took it once.",
    "[advisor] </jr2-turn>",
    '[advisor] [file_report] {"summary":"s"}',
    "[advisor] [prompt] [t1-bbbbbb] The next trial.",
    "[advisor] [run_audit] {}",
  ].join("\n");
  assert.deepEqual(saidAfterPrompt(log, "advisor", "Your previous turn was cut"), [{ call: "file_report" }]);
  assert.equal(saidAfterPrompt("[advisor] [prompt] [t0-a] x", "advisor", "Your previous turn was cut"), undefined);
});

// A Sandbox's Harness container restarted in place keeps its pod, and the reap when the run settles
// takes the pod and every log it held: the restarted container's log is followed while it lives.
const sandboxPod = (restartCount: number, state: Record<string, unknown>) => ({
  status: {
    containerStatuses: [
      { name: "repo-sync", restartCount: 9, state: { running: {} } },
      { name: "harness", restartCount, state },
    ],
  },
});

test("harnessRestarts reads the Harness container's restart count, and nothing without that container", () => {
  assert.equal(harnessRestarts(sandboxPod(2, { running: {} })), 2);
  assert.equal(harnessRestarts({ status: { containerStatuses: [{ name: "repo-sync", restartCount: 1 }] } }), undefined);
  assert.equal(harnessRestarts({}), undefined);
});

test("restartedHarnessRunning holds once the Harness container restarted past `before` and runs again", () => {
  assert.equal(restartedHarnessRunning(sandboxPod(0, { running: {} }), 0), false, "not restarted yet");
  assert.equal(
    restartedHarnessRunning(sandboxPod(1, { waiting: { reason: "CrashLoopBackOff" } }), 0),
    false,
    "restarted, not running",
  );
  assert.equal(restartedHarnessRunning(sandboxPod(1, { running: {} }), 0), true);
  assert.equal(restartedHarnessRunning(sandboxPod(3, { running: {} }), 2), true);
  assert.equal(restartedHarnessRunning({}, 0), false, "no Harness container");
});
