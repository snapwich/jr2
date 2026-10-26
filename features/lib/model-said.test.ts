// The @model drivers' readings (ADR-0066), pinned without a cluster or a model: the printed
// conversation a claim reads (ADR-0023), a followed log that outlives its pod's reap, and the mode a
// model was asked again in, read from the claim workflow itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assign, createMachine } from "xstate";
import {
  answersIn,
  askAfter,
  calledIn,
  follow,
  harnessRestarts,
  isNudge,
  isRestatement,
  menuCalls,
  modeAtAsk,
  modesOf,
  ofRun,
  printedLine,
  restartedHarnessRunning,
  saidAfterPrompt,
  saidIn,
  told,
  withoutIid,
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
 * a timer with a target would hold Rest (ADR-0024), and the model would never stop. A reviewer below
 * the mode answers the pick while the picks are still closed; the states that its hold adds below
 * the mode (`reading`, `answered`) are no mode. */
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
          initial: "reading",
          states: { reading: { invoke: { src: "reviewer", onDone: "answered" } }, answered: {} },
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

// What a trial note says the model called (ADR-0066), read off the conversation the tier kept: the
// followed log is timestamped, and it spans every container the trial's follow attached to.
test("the calls of a kept conversation: timestamped lines, read after the trial's prompt, across a restart", () => {
  const kept = [
    "2026-10-13T10:00:00.000000001Z [coder] [prompt] [t0-aaaaaa] Fix the failing test.",
    "2026-10-13T10:00:01.000000001Z [coder] [bash] node --test",
    "2026-10-13T10:00:02.000000001Z [coder] multi-line body, not a call",
    "2026-10-13T10:00:03.000000001Z [coder] [prompt] <jr2-turn>",
    '2026-10-13T10:00:04.000000001Z [coder] [ask_approval] {"why":"x"}',
    "--- followed again: the container restarted ---",
    "2026-10-13T10:01:00.000000001Z [coder] [prompt] Your previous turn was cut",
    "2026-10-13T10:01:01.000000001Z [coder] [submit] {}",
  ].join("\n");
  assert.deepEqual(calledIn(kept, "t0-aaaaaa"), [
    { call: "bash" },
    { prompt: "<jr2-turn>" },
    { call: "ask_approval" },
    { prompt: "Your previous turn was cut" },
    { call: "submit" },
  ]);
  assert.equal(told(calledIn(kept, "t0-aaaaaa")!), "bash (restated) ask_approval (prompt) submit");
});

test("a kept conversation is read from the trial's own prompt when it carries the marker, else from its first", () => {
  const kept = ["[advisor] [hold] {}", "[advisor] [prompt] [t1-bbbbbb] The next trial.", "[advisor] [release] {}"].join(
    "\n",
  );
  assert.deepEqual(calledIn(kept, "t1-bbbbbb"), [{ call: "release" }]);
  assert.deepEqual(calledIn("[coder] [prompt] go\n[coder] [bash] ls", "t9-none"), [{ call: "bash" }]);
  assert.equal(calledIn("no conversation printed", "t9-none"), undefined);
});

test("a kept conversation that opens with an earlier trial's late lines is read from this trial's own prompt", () => {
  // The Instance Harness's kept log starts at the trial's start, so it can open with the end of the
  // trial before: its Frame, and a call made after it.
  const kept = [
    "[advisor] [prompt] [t0-aaaaaa] The earlier trial.",
    "[advisor] [hold] {}",
    "[advisor] [prompt] [t1-bbbbbb] This trial.",
    "[advisor] [release] {}",
  ].join("\n");
  assert.deepEqual(calledIn(kept, "t1-bbbbbb"), [{ call: "release" }]);
  assert.deepEqual(calledIn(kept, "t9-none"), [{ call: "hold" }], "no own prompt: read from the first");
});

test("a kept conversation's calls are its Agents' own: the run narrative echo and another Harness's markers are not calls", () => {
  // A Workspace Harness's log: the conversation, and the echo the Orchestrator pushes beside it — a
  // status at every transition, an Emit, and an Agent's admission and pick on another Harness — in
  // the shapes the Harness's printer writes them (packages/harness/test/echo.test.ts pins them).
  const kept = [
    "2026-10-13T10:00:00Z [coder] [prompt] [t0-abcdef] Fix the failing test.",
    "2026-10-13T10:00:01Z [coder] [bash] node --test",
    "2026-10-13T10:00:02Z [run] [status] running · body: working.publishing",
    "2026-10-13T10:00:03Z [coder] [publish] {}",
    '2026-10-13T10:00:04Z [run] [emit] published {"sha":"abc"}',
    "2026-10-13T10:00:05Z [reviewer] [admitted] Review it.",
    "2026-10-13T10:00:06Z [reviewer] [pick] approve",
    "2026-10-13T10:00:07Z [run] [status] running · body: finishing",
    "2026-10-13T10:00:08Z [coder] [finish] {}",
    "2026-10-13T10:00:09Z [run] [status] done",
  ].join("\n");
  assert.equal(told(calledIn(kept, "t0-abcdef")!), "bash publish finish");
});

// Each pick's answer in a kept conversation (ADR-0023, ADR-0066): the Harness prints a Menu call's
// result after its call, as the model read it, in the shapes its printer writes
// (packages/harness/test/printer.test.ts pins them).
test("a kept conversation pairs each pick with the answer the model read, and a Working tool's call has none", () => {
  const kept = [
    "2026-10-13T10:00:00Z [coder] [prompt] [t0-abcdef] Commit, then publish.",
    "2026-10-13T10:00:01Z [coder] [bash] git commit -am one",
    '2026-10-13T10:00:02Z [coder] [publish] {"summary":"x"}',
    '2026-10-13T10:00:02Z [coder] [publish error] Validation failed for tool "mcp__jr2__publish":',
    "2026-10-13T10:00:02Z [coder]   - root: must NOT have additional properties",
    "2026-10-13T10:00:03Z [coder] [publish] {}",
    "2026-10-13T10:00:04Z [run] [status] running · body: working.publishing",
    '2026-10-13T10:00:09Z [coder] [publish answer] Delivered "publish" to the workflow (delivery d-1). jr2 signed your commits and pushed the signed copies. Continue your work on your branch.',
    "2026-10-13T10:00:10Z [coder] [text] I continue.",
    "2026-10-13T10:00:10Z [coder] a second line of text, not an answer's",
    "2026-10-13T10:00:11Z [coder] [finish] {}",
    '2026-10-13T10:00:12Z [coder] [finish answer] Delivered "finish" to the workflow (delivery d-2).',
    "2026-10-13T10:00:12Z [coder] The workflow consumed it and moved on: your turn is over.",
  ].join("\n");
  assert.deepEqual(answersIn(kept, "t0-abcdef"), [
    { call: "bash", input: "git commit -am one" },
    {
      call: "publish",
      input: '{"summary":"x"}',
      answer: 'Validation failed for tool "mcp__jr2__publish":\n  - root: must NOT have additional properties',
      error: true,
    },
    {
      call: "publish",
      input: "{}",
      answer:
        'Delivered "publish" to the workflow (delivery d-1). jr2 signed your commits and pushed the signed copies. Continue your work on your branch.',
    },
    {
      call: "finish",
      input: "{}",
      answer:
        'Delivered "finish" to the workflow (delivery d-2).\nThe workflow consumed it and moved on: your turn is over.',
    },
  ]);
  // The answer lines are not calls: the note's reading is what it was.
  assert.equal(told(calledIn(kept, "t0-abcdef")!), "bash publish publish finish");
});

test("an answer pairs with the oldest unanswered call of its pick; a call still out has none; the next trial's are not read", () => {
  const kept = [
    "[coder] [prompt] [t1-bbbbbb] Go.",
    "[coder] [run_tests] {}",
    "[coder] [finish] {}",
    "[coder] [run_tests answer] Delivered. Its answer: the output of `tests`.",
    "[coder] [finish error] `mcp__jr2__finish` was NOT delivered: your pick `mcp__jr2__run_tests` is still running.",
    "[coder] [run_tests] {}",
    "[coder] [prompt] [t2-cccccc] The next trial.",
    "[coder] [finish answer] Not this trial's.",
  ].join("\n");
  assert.deepEqual(answersIn(kept, "t1-bbbbbb"), [
    { call: "run_tests", input: "{}", answer: "Delivered. Its answer: the output of `tests`." },
    {
      call: "finish",
      input: "{}",
      answer: "`mcp__jr2__finish` was NOT delivered: your pick `mcp__jr2__run_tests` is still running.",
      error: true,
    },
    { call: "run_tests", input: "{}" },
  ]);
  assert.equal(answersIn("no conversation printed", "t9-none"), undefined);
});

test("a call a Harness restart cut gets jr2's text, printed by the next container before its prompt", () => {
  // ADR-0023: the rebuilt history answers a cut Menu call with jr2's text, and the Harness prints
  // it once, before the re-admission's prompt — the next container's first lines in the kept log.
  // The model calling the same pick again after that prompt is the cut-pick claim's miss, and the
  // answer after it is the second call's alone.
  const cutText = "This pick reached the workflow, but its answer did not reach you. Do not call it again.";
  const kept = [
    "2026-10-13T10:00:00.000000001Z [decisioner] [prompt] [t0-cutcut] Audit the expenses.",
    "2026-10-13T10:00:01.000000001Z [decisioner] [run_audit] {}",
    `2026-10-13T10:01:00.000000001Z [decisioner] [run_audit answer] ${cutText}`,
    "2026-10-13T10:01:00.000000002Z [decisioner] [prompt] Your previous turn was cut: the workflow ran `run_audit`.",
    '2026-10-13T10:01:01.000000001Z [decisioner] [run_audit] {"again":true}',
    '2026-10-13T10:01:01.000000002Z [decisioner] [run_audit answer] Delivered "run_audit" to the workflow (delivery d-2).',
  ].join("\n");
  assert.deepEqual(answersIn(kept, "t0-cutcut"), [
    { call: "run_audit", input: "{}", answer: cutText },
    { call: "run_audit", input: '{"again":true}', answer: 'Delivered "run_audit" to the workflow (delivery d-2).' },
  ]);
});

test("a call whose answer never printed keeps none: a prompt line closes every call before it", () => {
  // Every prompt prints after the answers of the calls before it (ADR-0023, pinned by the Harness's
  // conformance test), so a call still open at a prompt lost its answer from the log (a container
  // the follow never read) or never had one (a message a provider error ended), and the answer
  // after the prompt is a later call's.
  const kept = [
    "[decisioner] [prompt] [t0-cutcut] Audit the expenses.",
    "[decisioner] [run_audit] {}",
    "[decisioner] [prompt] Your previous turn was cut: the workflow ran `run_audit`.",
    '[decisioner] [run_audit] {"again":true}',
    '[decisioner] [run_audit answer] Delivered "run_audit" to the workflow (delivery d-2).',
  ].join("\n");
  assert.deepEqual(answersIn(kept, "t0-cutcut"), [
    { call: "run_audit", input: "{}" },
    { call: "run_audit", input: '{"again":true}', answer: 'Delivered "run_audit" to the workflow (delivery d-2).' },
  ]);
});

test("two calls of one pick in one message: the first call gets the first answer, the second the refusal", () => {
  // A message's answers print in the order of its calls, parallel or sequential (ADR-0023; the
  // Harness's conformance suite pins it).
  const kept = [
    "[coder] [prompt] [t3-dddddd] Ship it.",
    '[coder] [ship] {"n":1}',
    '[coder] [ship] {"n":2}',
    '[coder] [ship answer] Delivered "ship" to the workflow (delivery d-1).',
    "[coder] [ship error] `mcp__jr2__ship` was NOT delivered: your pick `mcp__jr2__ship` is still running.",
  ].join("\n");
  assert.deepEqual(answersIn(kept, "t3-dddddd"), [
    { call: "ship", input: '{"n":1}', answer: 'Delivered "ship" to the workflow (delivery d-1).' },
    {
      call: "ship",
      input: '{"n":2}',
      answer: "`mcp__jr2__ship` was NOT delivered: your pick `mcp__jr2__ship` is still running.",
      error: true,
    },
  ]);
});

test("a followed process keeps what it printed to stderr apart: the reason a log could not be read", async () => {
  const f = follow(process.execPath, ["-e", "console.error('container \"harness\" is waiting to start')"]);
  await f.closed;
  assert.equal(f.text, "");
  assert.match(f.err, /waiting to start/);
});

test("a printed line carries its Agent and its Instance ID; a line of the run narrative echo carries none (ADR-0023)", () => {
  assert.deepEqual(printedLine("[advisor] [r1/root/advisor] [prompt] [t0-a] Go."), {
    agent: "advisor",
    iid: "r1/root/advisor",
    rest: "[prompt] [t0-a] Go.",
  });
  // A body's later line: no label after the Instance ID.
  assert.deepEqual(printedLine("[advisor] [r1/root/advisor] - Faster cold start."), {
    agent: "advisor",
    iid: "r1/root/advisor",
    rest: "- Faster cold start.",
  });
  // A label never holds a `/`, so the echo, and a line in the shape before the Instance ID, have none.
  for (const echo of ["[run] [status] running · body: working", "[decisioner] [admitted] go", "[advisor] [prompt] Go."])
    assert.equal(printedLine(echo), undefined, echo);
  assert.equal(withoutIid("[advisor] [r1/root/advisor] [submit] {}"), "[advisor] [submit] {}");
  assert.equal(withoutIid("[run] [status] done"), "[run] [status] done");
});

test("the readings take the printed shape with the Instance ID, beside the echo lines that carry none", () => {
  const log = [
    "[run] [status] running · body: working",
    "[coder] [r1/body/coder] [prompt] [t0-a] Go.",
    "[coder] [r1/body/coder] [bash] ls",
    "[reviewer] [admitted] review it",
    "[coder] [r1/body/coder] [submit] {}",
    "[coder] [r1/body/coder] [submit answer] Delivered.",
    "[coder] [r1/body/coder] Allowed now: none.",
    "[run] [status] done",
  ].join("\n");
  assert.deepEqual(saidIn(log, "coder", "t0-a"), [{ call: "bash" }, { call: "submit" }]);
  assert.deepEqual(calledIn(log, "t0-a"), [{ call: "bash" }, { call: "submit" }]);
  assert.deepEqual(answersIn(log, "t0-a"), [
    { call: "bash", input: "ls" },
    { call: "submit", input: "{}", answer: "Delivered.\nAllowed now: none." },
  ]);
});

/** Two Menu-only trials in flight on the Instance Harness: their lines interleave in one log. */
const SHARED = [
  "2026-10-25T10:00:00Z [advisor] [r1/root/advisor] [prompt] [t0-aaaaaa] Draft the notes.",
  "2026-10-25T10:00:00.5Z [advisor] [r2/root/advisor] [prompt] [t1-bbbbbb] Draft the notes.",
  "2026-10-25T10:00:01Z [advisor] [r2/root/advisor] [hold] {}",
  "2026-10-25T10:00:01Z [advisor] [r1/root/advisor] [submit] {}",
  "2026-10-25T10:00:02Z [advisor] [r1/root/advisor] [submit answer] Delivered.",
  "2026-10-25T10:00:02Z [advisor] [r2/root/advisor] [hold answer] Delivered.",
  "2026-10-25T10:00:02Z [advisor] [r1/root/advisor] Allowed now: none.",
  "--- followed again: the container restarted ---",
  "2026-10-25T10:00:03Z [advisor] [r1/root/advisor/1] [prompt] Your previous turn was cut.",
  "2026-10-25T10:00:03Z [advisor] [r2/root/advisor] [prompt] Your previous turn was cut.",
  "2026-10-25T10:00:04Z [advisor] [r1/root/advisor/1] [file_report] {}",
  "2026-10-25T10:00:04Z [advisor] [r2/root/advisor] [run_audit] {}",
  "2026-10-25T10:00:05Z [summarizer] [r1/root/open/summarizer/0a1b2c3d] [prompt] Sum it up.",
  "2026-10-25T10:00:05Z [advisor] [r10/root/advisor] [prompt] [t2-cccccc] Another run.",
  "2026-10-25T10:00:06Z [run] [status] done",
].join("\n");

test("one run's lines of a shared log: by the Instance ID's prefix, untimed, in the shape the readings take", () => {
  assert.equal(
    ofRun(SHARED, "r1"),
    [
      "[advisor] [prompt] [t0-aaaaaa] Draft the notes.",
      "[advisor] [submit] {}",
      "[advisor] [submit answer] Delivered.",
      "[advisor] Allowed now: none.",
      // The conversation after one jr2 faulted (`<iid>/<epoch>`) is still the run's.
      "[advisor] [prompt] Your previous turn was cut.",
      "[advisor] [file_report] {}",
      // So is an Agent at another Machine path.
      "[summarizer] [prompt] Sum it up.",
    ].join("\n"),
  );
  // `r10` is not `r1`: the prefix ends at the `/`.
  assert.equal(ofRun(SHARED, "r10"), "[advisor] [prompt] [t2-cccccc] Another run.");
  assert.equal(ofRun(SHARED, "r3"), "");
});

test("each trial of a shared log reads only its own run: the first call, and the first after a re-admission", () => {
  assert.deepEqual(saidIn(ofRun(SHARED, "r1"), "advisor", "t0-aaaaaa")?.[0], { call: "submit" });
  assert.deepEqual(saidIn(ofRun(SHARED, "r2"), "advisor", "t1-bbbbbb")?.[0], { call: "hold" });
  // Read off the whole log, the other run's interleaved prompt would end the trial at once.
  assert.deepEqual(saidAfterPrompt(ofRun(SHARED, "r1"), "advisor", "Your previous turn was cut"), [
    { call: "file_report" },
  ]);
  assert.deepEqual(saidAfterPrompt(ofRun(SHARED, "r2"), "advisor", "Your previous turn was cut"), [
    { call: "run_audit" },
  ]);
  assert.deepEqual(answersIn(ofRun(SHARED, "r2"), "t1-bbbbbb"), [
    { call: "hold", input: "{}", answer: "Delivered." },
    { call: "run_audit", input: "{}" },
  ]);
});
