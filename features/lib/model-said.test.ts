// The @model drivers' readings (ADR-0066), pinned without a cluster or a model: the printed
// conversation a claim reads (ADR-0023), a followed log that outlives its pod's reap, and the mode a
// model was asked again in, read from the claim workflow itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMachine } from "xstate";
import {
  askAfter,
  follow,
  isNudge,
  isRestatement,
  menuCalls,
  modeAtAsk,
  modesOf,
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

/** The mode-stop shape: `ask_review` enters a mode with nothing to pick that a timer leaves. */
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
