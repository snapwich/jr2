// The @model drivers' readings (ADR-0066), pinned without a cluster or a model: the printed
// conversation a claim reads (ADR-0023), a followed log that outlives its pod's reap, and the mode a
// model was asked again in, read from the claim workflow itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMachine } from "xstate";
import {
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

/** The mode-stop shape: a mode with nothing to pick that a timer leaves, and two modes with picks. */
const notes = createMachine({
  id: "w",
  initial: "notes",
  states: {
    notes: {
      initial: "waiting",
      states: {
        waiting: { after: { 30_000: "reviewing" } },
        reviewing: { on: { revise: "drafting", submit: "#w.submitted" } },
        drafting: { on: { ask_review: "reviewing" } },
      },
    },
    submitted: { type: "final" },
  },
}).root.states.notes as unknown as StateNodeLike;

test("the modes are read from the built Machine: each pick's target, and each timer's (efb2d7e)", () => {
  assert.deepEqual(modesOf(notes), {
    waiting: { picks: {}, after: ["reviewing"] },
    reviewing: { picks: { revise: "drafting", submit: "w.submitted" }, after: [] },
    drafting: { picks: { ask_review: "reviewing" }, after: [] },
  });
});

test("the mode at the ask: allowed picks move it, refused picks do not, and a woken model is asked once a pick opens", () => {
  const modes = modesOf(notes);
  // Nothing allowed while waiting: a refused `submit` moves nothing; the wake follows the timer.
  assert.equal(modeAtAsk(modes, "waiting", [{ call: "submit" }]), "reviewing");
  // A nudge after picks: `revise` took the model to drafting, where it stopped with a pick left.
  assert.equal(modeAtAsk(modes, "reviewing", [{ call: "revise" }]), "drafting");
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "ask_review" }, { call: "revise" }]), "drafting");
  assert.equal(modeAtAsk(modes, "drafting", [{ call: "revise" }]), "drafting", "not allowed in drafting");
});
