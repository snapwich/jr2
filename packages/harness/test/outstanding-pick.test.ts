// The outstanding pick, Harness side (ADR-0024, ADR-0013): an outstanding pick's answer is long-polled
// inside the one tool call; the Orchestrator's refusal while one is out names it; the answer reads
// as prose; a cut call's history result is jr2's text.

import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EffectStateShape } from "@jr2/orchestrator/internal";
import { noticeText } from "../src/briefing.ts";
import type { EngineMessage } from "../src/engine.ts";
import {
  answerText,
  noNewCommitText,
  rewrittenPushText,
  cutPickResult,
  outstandingRefusal,
  readMenu,
  receiptProse,
  type DeliveryReceipt,
  type Surface,
  unknownPickResult,
  unreadAnswerResult,
  unrunResult,
  unsentPickResult,
} from "../src/menu.ts";
import { menuToolName } from "../src/menu-tools.ts";
import { cutPickAnswers, settleCutPicks } from "../src/turn.ts";

const SURFACE: Surface = {
  instanceId: "run-1/coder",
  runId: "run-1",
  allowed: ["run_tests", "finish"],
  menu: ["run_tests", "finish"].map((name) => ({ name, input: { type: "object", properties: {} }, semantics: "ack" })),
};

type Call = { url: string; method: string };

function fakeFetch(answer: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET" };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const opts = (fetch: typeof globalThis.fetch, extra: object = {}) => ({
  url: "http://127.0.0.1:8081",
  token: "jr2-held-JR2_SANDBOX_TOKEN",
  fetch,
  log: () => {},
  retryInitialMs: 1,
  retryMaxMs: 2,
  toolName: menuToolName,
  ...extra,
});

const outstanding = {
  delivered: true,
  event: "run_tests",
  moved: true,
  turnComplete: false,
  allowed: [],
  deliveryId: "d-1",
  outstanding: true,
};

test("an outstanding pick: the POST answers at once, and the one tool call polls until the answer — through a 503 and a dropped socket", async () => {
  let polls = 0;
  const heard: string[][] = [];
  let answered = 0;
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    if (call.method === "POST") return Response.json(outstanding);
    polls += 1;
    if (polls === 1) return Response.json(outstanding); // the long poll ran out: ask again
    if (polls === 2) return Response.json({ error: "stopping" }, { status: 503 });
    if (polls === 3) throw new TypeError("fetch failed");
    return Response.json({
      ...outstanding,
      outstanding: undefined,
      answered: true,
      allowed: ["run_tests", "finish"],
      answer: { kind: "output", actor: "tests", output: { passed: 3 } },
    });
  });
  const read = await readMenu(
    opts(fetch, { onAllowed: (a: string[]) => heard.push(a), onAnswered: () => answered++ }),
    "run-1/coder",
  );
  const text = await read!.menu[0]!.pick({});
  assert.equal(calls.filter((c) => c.url.endsWith("/deliveries/d-1")).length, 4, "polled until answered");
  assert.equal(
    text,
    'Delivered "run_tests" to the workflow (delivery d-1). The workflow took it and is back in the state that asked ' +
      'for this turn. Its answer: the output of `tests`: {"passed":3}. Your turn is not over. Allowed now: ' +
      "`mcp__jr2__run_tests`, `mcp__jr2__finish`.",
  );
  assert.deepEqual(heard.at(-1), ["run_tests", "finish"], "the Allowed picks after the route are heard");
  assert.equal(answered, 1, "the Runaway guard hears the answer");
});

test("a pick answered on its own POST (the child settled inside the send): no poll, the answer reads as prose, and the Runaway guard hears it", async () => {
  let answered = 0;
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    return Response.json({
      ...outstanding,
      outstanding: undefined,
      answered: true,
      allowed: ["run_tests", "finish"],
      answer: { kind: "output", actor: "decider", output: { verdict: "sync" } },
    });
  });
  const read = await readMenu(opts(fetch, { onAnswered: () => answered++ }), "run-1/coder");
  const text = await read!.menu[0]!.pick({});
  assert.equal(calls.filter((c) => c.url.includes("/deliveries/")).length, 0, "nothing to poll");
  assert.match(text, /Its answer: the output of `decider`: \{"verdict":"sync"\}\. Your turn is not over\./);
  assert.equal(answered, 1, "the identical-call streak starts again");
});

test("a guard straight back is answered, but the Runaway guard does not hear it: nothing ran (ADR-0035)", async () => {
  let answered = 0;
  const { fetch } = fakeFetch((call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    return Response.json({
      ...outstanding,
      outstanding: undefined,
      answered: true,
      straightBack: true,
      allowed: ["run_tests"],
    });
  });
  const read = await readMenu(opts(fetch, { onAnswered: () => answered++ }), "run-1/coder");
  for (let n = 0; n < 4; n++) assert.match(await read!.menu[0]!.pick({}), /It moved the workflow, and nothing ran:/);
  assert.equal(answered, 0, "the identical-call streak runs on");
});

test("the Orchestrator's refusal while a pick is out names that pick; busy with no pick of ours says rest", async () => {
  const refuse = (body: object) =>
    fakeFetch((call) =>
      call.url.endsWith("/surface") ? Response.json(SURFACE) : Response.json(body, { status: 409 }),
    );
  const held = refuse({ error: "x", refused: "outstanding", outstanding: "run_tests", allowed: [] });
  const read = await readMenu(opts(held.fetch), "run-1/coder");
  await assert.rejects(read!.menu[1]!.pick({}), { message: outstandingRefusal("finish", "run_tests", menuToolName) });

  const busy = refuse({ error: "x", refused: "outstanding", allowed: [] });
  const busyRead = await readMenu(opts(busy.fetch), "run-1/coder");
  await assert.rejects(busyRead!.menu[1]!.pick({}), {
    message:
      "`mcp__jr2__finish` was NOT delivered: the workflow is still running work in the state that asked for this " +
      "turn, and takes no pick until it is back at rest. Allowed now: none — the workflow's current state accepts " +
      "no pick yet, so any pick is refused or does nothing.",
  });
});

test("a poll answered 404 is a Turn that is over", async () => {
  let over = false;
  const { fetch } = fakeFetch((call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    if (call.method === "POST") return Response.json(outstanding);
    return Response.json({ error: "no delivery" }, { status: 404 });
  });
  const read = await readMenu(opts(fetch, { onTurnOver: () => (over = true) }), "run-1/coder");
  await assert.rejects(read!.menu[0]!.pick({}), /this turn is over/);
  assert.equal(over, true);
});

test("an answer that left the Agent's state ends the Turn; the answer's words name who replied", () => {
  const receipt: DeliveryReceipt = {
    delivered: true,
    event: "ship",
    moved: true,
    turnComplete: true,
    allowed: [],
    deliveryId: "d",
    answered: true,
  };
  assert.equal(
    receiptProse(receipt, menuToolName),
    'Delivered "ship" to the workflow (delivery d). The workflow took it and moved on: your turn is over.',
  );
  assert.equal(
    answerText({ kind: "event", event: "approve", sender: { party: "gate", id: "review" }, payload: { note: "ok" } }),
    'Its answer: `approve` from Gate `review`, with {"note":"ok"}.',
  );
  assert.equal(
    answerText({ kind: "event", event: "advice", sender: { party: "agent", id: "reviewer" }, payload: {} }),
    "Its answer: `advice` from Agent `reviewer`.",
  );
  assert.equal(answerText(undefined), "No reply came back for it.");
  // The Machine's `answer` (ADR-0067): a string is its own words; anything else is its JSON.
  assert.equal(
    answerText({ kind: "answer", value: "Preview at https://p.example/1." }),
    "Its answer: Preview at https://p.example/1.",
  );
  assert.equal(
    answerText({ kind: "answer", value: { url: "https://p.example/1" } }),
    'Its answer: {"url":"https://p.example/1"}',
  );
});

test("an Effector's outcome reads as its output, decoded off the wire as the Orchestrator decodes it (ADR-0068, ADR-0067)", () => {
  // The golden fixtures (effector/testdata/wire/) are what the Effector answers; the default answer
  // renders the output whole, so these are the texts the model reads for each outcome. A push's
  // bundle is the sync's, and the Orchestrator delivers its output without it.
  const fixtures = fileURLToPath(new URL("../../../effector/testdata/wire/", import.meta.url));
  const read = (name: string) => {
    const wire = EffectStateShape.parse(JSON.parse(readFileSync(join(fixtures, name), "utf8"))).output;
    const { bundle: _bundle, ...output } = (wire ?? {}) as Record<string, unknown>;
    return answerText({ kind: "output", actor: "comment", output });
  };
  const want: Record<string, string> = {
    "response.settled-response-text.json":
      'Its answer: the output of `comment`: {"outcome":"response","status":201,"headers":{"content-type":' +
      '"application/json; charset=utf-8","x-echo-auth":"[secret:jira]"},"contentType":"application/json; ' +
      'charset=utf-8","size":57,"body":"{\\"id\\":\\"10042\\",\\"self\\":\\"https://jira.example.com/comment/10042\\"}"}.',
    "response.settled-response-binary.json":
      'Its answer: the output of `comment`: {"outcome":"response","status":200,"headers":{"content-type":' +
      '"application/pdf"},"contentType":"application/pdf","size":1048576}.',
    "response.settled-response-truncated.json":
      'Its answer: the output of `comment`: {"outcome":"response","status":500,"headers":{},"contentType":"",' +
      '"size":200000,"body":"<html>érror","truncated":true}.',
    "response.settled-refused.json":
      'Its answer: the output of `comment`: {"outcome":"refused","reason":"path segment 1 is \\"..\\", which a ' +
      'path may not hold; nothing was sent"}.',
    "response.settled-unreachable.json":
      'Its answer: the output of `comment`: {"outcome":"unreachable","reason":"dial tcp 10.0.0.9:443: connect: ' +
      'connection refused; nothing was sent"}.',
    "response.settled-unknown.json":
      'Its answer: the output of `comment`: {"outcome":"unknown","reason":"the timeout passed; the request may ' +
      'have reached the host, and no answer came"}.',
    "response.settled-pushed.json":
      'Its answer: the output of `comment`: {"outcome":"pushed","published":"2222222222222222222222222222222222222222",' +
      '"source":"1111111111111111111111111111111111111111","via":"ancestry","newCommits":1}.',
    "response.settled-pushed-squashed.json":
      'Its answer: the output of `comment`: {"outcome":"pushed","published":"3333333333333333333333333333333333333333",' +
      '"source":"1111111111111111111111111111111111111111","previous":"2222222222222222222222222222222222222222",' +
      '"via":"ancestry","newCommits":1,"squashed":"unsigned"}.',
    // A push that sent no new commit says so in words (ADR-0067): `pushed` alone does not.
    "response.settled-pushed-no-new-commit.json":
      'Its answer: the output of `comment`: {"outcome":"pushed","published":"1111111111111111111111111111111111111111",' +
      '"source":"1111111111111111111111111111111111111111","newCommits":0}. jr2 counted no new commit in this ' +
      "push: it found commit `1111111111111111111111111111111111111111` already on the remote or in jr2's copy of the remote. A " +
      "change that you did not commit before the push is not in this push.",
    "response.settled-rejected.json":
      'Its answer: the output of `comment`: {"outcome":"rejected","stage":"push","reason":"non-fast-forward: the ' +
      'remote\'s branch moved","detail":"! [rejected] (fetch first)"}.',
    "response.settled-diverged.json":
      'Its answer: the output of `comment`: {"outcome":"diverged","reason":"the published commit 222222222222 is ' +
      "not in the history of the Agent's 111111111111, and no fallback pairs it; nothing was pushed\"," +
      '"published":"2222222222222222222222222222222222222222","source":"1111111111111111111111111111111111111111"}.',
    "response.settled-exited-dirty.json":
      'Its answer: the output of `comment`: {"outcome":"exited","code":0,"tail":"Apply complete! [secret:aws]\\n",' +
      '"dirty":true}.',
    // A dispatch's outcomes (ADR-0071): the run it started, the run's end, the door's refusal, and
    // no reach — each the Effect's output, so each is what an Agent's pick is answered with.
    "response.settled-dispatch-started.json":
      'Its answer: the output of `comment`: {"outcome":"started","run":"5c4b3a29-1807-4f6e-9d5c-4b3a2918f7e6"}.',
    "response.settled-dispatch-settled.json":
      'Its answer: the output of `comment`: {"outcome":"settled","run":"5c4b3a29-1807-4f6e-9d5c-4b3a2918f7e6",' +
      '"status":"done","output":{"verdict":"approve","notes":["[secret:ops-instance]"],"score":0.9,"extra":null}}.',
    "response.settled-dispatch-refused.json":
      'Its answer: the output of `comment`: {"outcome":"refused","status":400,"report":["invalid input for ' +
      'workflow \\"review\\": ticket: Invalid input: expected string, received undefined"]}.',
    "response.settled-dispatch-unreachable.json":
      'Its answer: the output of `comment`: {"outcome":"unreachable","reason":"dial tcp 10.0.0.9:443: connect: ' +
      'connection refused; nothing was started"}.',
  };
  // A stopped command's outcome (`exited` with the signal) answers the Orchestrator's stop, after the
  // state that asked has exited: no Machine takes it, so no Agent reads it (ADR-0067).
  const settled = readdirSync(fixtures).filter(
    (f) => f.startsWith("response.settled-") && !f.startsWith("response.settled-exited-stopped"),
  );
  assert.deepEqual(settled.sort(), Object.keys(want).sort(), "every settled fixture has its text here");
  for (const [name, text] of Object.entries(want)) assert.equal(read(name), text, name);
});

test("after a push whose published commit is not the Agent's own, the Agent reads what moved, by the sync's answer; never a rebase to do (ADR-0067)", () => {
  const pushed = { outcome: "pushed", published: "2".repeat(40), source: "1".repeat(40), via: "ancestry" };
  const synced = answerText({ kind: "output", actor: "publish", output: { ...pushed, sync: "synced" } });
  assert.equal(
    synced,
    `Its answer: the output of \`publish\`: ${JSON.stringify({ ...pushed, sync: "synced" })}. jr2 signed your ` +
      "commits and pushed the signed copies. The signed commits have new commit ids, and jr2 moved your branch to " +
      "them. Your files, your index and your stash did not change. The old commit ids are in the reflog. Continue " +
      "your work on your branch. Do not merge or rebase branches that you made before this push. Do not change the " +
      'pushed commits: if you amend, rebase or reset them, the next push stops with "diverged".',
  );
  const busy = rewrittenPushText({ ...pushed, sync: "busy", syncReason: "a rebase of your branch is in progress" });
  assert.equal(
    busy,
    "jr2 signed your commits and pushed the signed copies. jr2 did not move your branch to them (a rebase of your " +
      "branch is in progress). Continue your work on your branch: the next push finds the published commits. Do not " +
      "merge or rebase branches that you made before this push. Do not change the pushed commits: if you amend, " +
      'rebase or reset them, the next push stops with "diverged".',
  );
  assert.equal(rewrittenPushText({ ...pushed, source: pushed.published, sync: "skipped" }), undefined, "its own");
  assert.equal(rewrittenPushText({ outcome: "diverged", reason: "x" }), undefined);

  // A signed push that sent no new commit (a restore, a pair that mapped the published tip): the fact
  // that it sent nothing first, and the paragraph names the earlier push that signed, so the two agree.
  const restored = answerText({
    kind: "output",
    actor: "publish",
    output: { ...pushed, newCommits: 0, unchanged: true, sync: "synced" },
  });
  assert.match(
    restored,
    /\}\. jr2 counted no new commit in this push: it found commit `2{40}` already on the remote or in jr2's copy of the remote\. .* An earlier push signed your commits and pushed the signed copies\. The signed commits have new commit ids/,
  );
  assert.doesNotMatch(restored, /jr2 signed your commits/);
  assert.match(
    rewrittenPushText({ ...pushed, squashed: "signed", newCommits: 0, sync: "synced" }) ?? "",
    /^An earlier push squashed your commits into one signed commit and pushed it\./,
  );
  assert.equal(noNewCommitText({ ...pushed, newCommits: 1 }), undefined, "a new commit went out");
  assert.equal(noNewCommitText({ ...pushed }), undefined, "no count, no claim");
  assert.equal(noNewCommitText({ outcome: "diverged", published: "2".repeat(40), newCommits: 0 }), undefined);

  // One squashed commit: the paragraph names it, and says "signed" only of a signed one.
  const keep =
    "Do not merge or rebase branches that you made before this push. Do not change the pushed commits: if you " +
    'amend, rebase or reset them, the next push stops with "diverged".';
  const squashedSynced = (squashed: string) => rewrittenPushText({ ...pushed, squashed, sync: "synced" });
  assert.equal(
    squashedSynced("unsigned"),
    "jr2 squashed your commits into one commit and pushed it. That commit has a new commit id, and jr2 moved your " +
      "branch to it. Your files, your index and your stash did not change. The old commit ids are in the reflog. " +
      `Continue your work on your branch. ${keep}`,
  );
  assert.equal(
    squashedSynced("signed"),
    "jr2 squashed your commits into one signed commit and pushed it. That commit has a new commit id, and jr2 moved " +
      "your branch to it. Your files, your index and your stash did not change. The old commit ids are in the " +
      `reflog. Continue your work on your branch. ${keep}`,
  );
  const squashedBusy = rewrittenPushText({
    ...pushed,
    squashed: "unsigned",
    sync: "not-synced",
    syncReason: "your repository has no branch jr2/run-1",
  });
  assert.equal(
    squashedBusy,
    "jr2 squashed your commits into one commit and pushed it. jr2 did not move your branch to it (your repository " +
      "has no branch jr2/run-1). Continue your work on your branch: the next push finds the published commit. " +
      keep,
  );
  for (const text of [squashedSynced("unsigned")!, squashedBusy!]) assert.doesNotMatch(text, /\bsigned\b/);
  for (const text of [synced, busy!, squashedSynced("signed")!, squashedBusy!]) {
    assert.doesNotMatch(text, /\b(please )?rebase (your|onto)/i);
  }
});

test("a sync's reasons name the published commits, never a signature: an unsigned squash is synced too (ADR-0067)", () => {
  const src = readFileSync(new URL("../src/sync.ts", import.meta.url), "utf8");
  const reasons = [...src.matchAll(/reason: "([^"]*)"/g)].map((m) => m[1]!);
  assert.ok(reasons.length >= 4, `the sync's reasons: ${reasons.join(" | ")}`);
  for (const reason of reasons) assert.doesNotMatch(reason, /\bsigned\b|not signed/, reason);
});

test('a guard straight back alone reads "moved; nothing ran"; a move to a mode reads as the plain receipt', () => {
  const base = { delivered: true as const, event: "bounce", moved: true, turnComplete: false, deliveryId: "d" };
  assert.equal(
    receiptProse({ ...base, allowed: ["run_tests"], answered: true, straightBack: true }, menuToolName),
    'Delivered "bounce" to the workflow (delivery d). It moved the workflow, and nothing ran: the workflow is back ' +
      "in the state that asked for this turn. Your turn is not over. Allowed now: `mcp__jr2__run_tests`.",
  );
  assert.equal(
    receiptProse({ ...base, event: "draft", allowed: ["finish"] }, menuToolName),
    'Delivered "draft" to the workflow (delivery d). The workflow is still in the state that asked for this turn. ' +
      "Your turn is not over. Allowed now: `mcp__jr2__finish`.",
  );
});

test("a pick's answer that never reached its call is a notice: cut by a restart, or after the Turn was over", () => {
  const answer = { kind: "output" as const, actor: "tests", output: "pass" };
  assert.equal(
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "run_tests", cut: true, answer }, menuToolName),
    "Notice: The pick `mcp__jr2__run_tests` that was cut from your last turn is no longer outstanding: the " +
      'workflow took it once. Its answer: the output of `tests`: "pass".',
  );
  assert.equal(
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "ship", cut: false }, menuToolName),
    "Notice: The workflow left the state of your last turn while your pick `mcp__jr2__ship` was outstanding. " +
      "No reply came back for it.",
  );
});

test("a pick whose work an exit stopped: the poll and the next Turn's notice say so, and keep an earlier link's reply (ADR-0024)", () => {
  const base = {
    delivered: true as const,
    event: "go",
    moved: true,
    turnComplete: true,
    deliveryId: "d",
    allowed: [],
    answered: true,
    stopped: true,
  };
  const left =
    'Delivered "go" to the workflow (delivery d). The workflow left the state that asked for this turn while it ' +
    "ran your pick, and that stopped the pick's work before it finished: your turn is over.";
  assert.equal(receiptProse(base, menuToolName), left);
  const built = { kind: "output" as const, actor: "build", output: { ok: true } };
  assert.equal(
    receiptProse({ ...base, answer: built }, menuToolName),
    `${left} Its answer: the output of \`build\`: {"ok":true}.`,
  );
  const notice = {
    kind: "pick-answer" as const,
    scope: "conversation" as const,
    pick: "go",
    cut: false,
    stopped: true as const,
  };
  const didNot =
    "Notice: Your pick `mcp__jr2__go` did not finish: the workflow left the state that asked for your last turn " +
    "while it ran, and that stopped it.";
  assert.equal(noticeText(notice, menuToolName), didNot);
  assert.equal(
    noticeText({ ...notice, answer: built }, menuToolName),
    `${didNot} Its answer: the output of \`build\`: {"ok":true}.`,
  );
});

test("work that something stopped before it replied is never told it did not run, nor that it ran to its end (ADR-0024)", () => {
  // An outstanding pick whose work a per-step `after`, a Turn timeout or an outside event stopped:
  // answered with no reply and no `straightBack`. Its words state what is known, no more.
  const stopped: DeliveryReceipt = {
    delivered: true,
    event: "run_tests",
    moved: true,
    turnComplete: false,
    allowed: ["run_tests"],
    deliveryId: "d",
    answered: true,
  };
  const texts = [
    receiptProse(stopped, menuToolName),
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "run_tests", cut: false }, menuToolName),
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "run_tests", cut: true }, menuToolName),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /nothing ran|ran to its end|finished|ran it|ran once/, text);
    assert.match(text, /No reply came back for it\./, text);
  }
});

test("a Menu call a restart cut gets jr2's result in the history; a Working-tool call is left to pi; every call after the cut one never started (ADR-0027)", () => {
  const finished = (...calls: Array<[string, string]>) =>
    [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
        stopReason: "toolUse",
        timestamp: 2,
      },
    ] as unknown as EngineMessage[];
  const answers = (messages: EngineMessage[]) =>
    (settleCutPicks(messages) as Array<{ role: string; toolCallId?: string; content?: Array<{ text: string }> }>)
      .filter((m) => m.role === "toolResult")
      .map((m) => [m.toolCallId, m.content![0]!.text]);
  // The engine runs the calls in order: the first with no result is the one a restart cut while it
  // was out, and the ones after it never started.
  const pickFirst = finished(["m1", "mcp__jr2__run_tests"], ["b1", "bash"], ["m2", "mcp__jr2__finish"]);
  assert.deepEqual(answers(pickFirst), [
    ["m1", cutPickResult("mcp__jr2__run_tests")],
    ["b1", unrunResult()],
    ["m2", unrunResult()],
  ]);
  // A Working-tool call cut while it was out is pi-ai's to answer; the pick after it never started.
  assert.deepEqual(answers(finished(["b1", "bash"], ["m1", "mcp__jr2__run_tests"])), [["m1", unrunResult()]]);
  // A call that did not run is an error, as a blocked call is; the cut pick's answer is not.
  const flags = (settleCutPicks(pickFirst) as Array<{ role: string; isError?: boolean }>)
    .filter((m) => m.role === "toolResult")
    .map((m) => m.isError);
  assert.deepEqual(flags, [false, true, true]);
  const settled = settleCutPicks(pickFirst);
  assert.deepEqual(settleCutPicks(settled), settled, "an answered call is left alone");
});

test("a Menu call in a message an abort cut while the model wrote it gets the text that it never reached the workflow; a finished message's call keeps the restart's (ADR-0031)", () => {
  const cut = (stopReason: string) =>
    [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running it." },
          { type: "toolCall", id: "m1", name: "mcp__jr2__run_tests", arguments: {} },
        ],
        stopReason,
        timestamp: 2,
      },
    ] as unknown as EngineMessage[];
  const textOf = (messages: EngineMessage[]) =>
    (settleCutPicks(messages) as Array<{ role: string; toolCallId?: string; content?: Array<{ text: string }> }>)
      .filter((m) => m.role === "toolResult")
      .map((m) => [m.toolCallId, m.content![0]!.text]);
  assert.deepEqual(textOf(cut("aborted")), [["m1", unsentPickResult("mcp__jr2__run_tests")]]);
  assert.deepEqual(textOf(cut("toolUse")), [["m1", cutPickResult("mcp__jr2__run_tests")]]);
  const settled = settleCutPicks(cut("aborted")) as Array<{ role: string; stopReason?: string }>;
  assert.equal(settled[1]!.stopReason, "toolUse", "the aborted message is re-tagged, so pi replays it");
  assert.deepEqual(
    cutPickAnswers(cut("aborted")).map((m) => (m.content[0] as { text: string }).text),
    [unsentPickResult("mcp__jr2__run_tests")],
    "it prints once, before the next prompt, like the restart's",
  );
  const text = unsentPickResult("mcp__jr2__run_tests");
  assert.match(text, /did not reach the workflow/);
  assert.match(text, /cut while you were still writing your call to `mcp__jr2__run_tests`/);
  assert.match(text, /Nothing ran\./);
  assert.match(text, /You may call `mcp__jr2__run_tests` again if the newest "Allowed now" still lists it\./);
});

test("a Menu call in a message a provider error ended gets no answer and is not re-tagged: pi drops the message, so an answer would be a result with no call (ADR-0031)", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Running it." },
        { type: "toolCall", id: "m1", name: "mcp__jr2__run_tests", arguments: {} },
      ],
      stopReason: "error",
      errorMessage: "Stream ended without finish_reason",
      timestamp: 2,
    },
  ] as unknown as EngineMessage[];
  assert.deepEqual(settleCutPicks(messages), messages, "nothing is added and nothing is re-tagged");
  assert.deepEqual(cutPickAnswers(messages), [], "nothing prints");
  // The same message followed by the next prompt: still no answer.
  const later = [...messages, { role: "user", content: "Try again.", timestamp: 3 }] as EngineMessage[];
  assert.deepEqual(settleCutPicks(later), later);
});

test("the cut answers a rebuilt engine part prints are those of the Menu calls it ends in; a cut call further back printed already (ADR-0023)", () => {
  const cutTurn = [
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "m1", name: "mcp__jr2__run_tests", arguments: {} },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [], isError: false, timestamp: 3 },
  ] as unknown as EngineMessage[];
  assert.deepEqual(
    cutPickAnswers(cutTurn).map((m) => [m.toolCallId, (m.content[0] as { text: string }).text]),
    [["m1", cutPickResult("mcp__jr2__run_tests")]],
  );
  // The same call once the next process prompted after it: the history still answers it, and it
  // printed in that process, so nothing prints now.
  const later = [...cutTurn, { role: "user", content: "Your previous turn was cut", timestamp: 4 }] as EngineMessage[];
  assert.equal(
    settleCutPicks(later).filter((m) => (m as { role: string }).role === "toolResult").length,
    2,
    "the history answers it",
  );
  assert.deepEqual(cutPickAnswers(later), []);
  assert.deepEqual(cutPickAnswers(settleCutPicks(cutTurn)), [], "an answered call prints nothing");
});

test('a pick\'s POST failure reads "never reached" only when no byte of it left; any other failure, an abort included, answers that the Harness does not know (ADR-0002)', async () => {
  const failing = (cause: unknown) =>
    fakeFetch((call) => {
      if (call.url.endsWith("/surface")) return Response.json(SURFACE);
      throw new TypeError("fetch failed", { cause });
    });
  const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
  const pickWith = async (cause: unknown, signal?: AbortSignal) =>
    (await readMenu(opts(failing(cause).fetch), "run-1/coder"))!.menu[0]!.pick({}, signal);

  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
    await assert.rejects(pickWith(coded(code, `connect ${code}`)), {
      message: `the pick never reached the Orchestrator (connect ${code}) — try it again`,
    });
  }
  // An unreachable network or host proves it only when the `connect` call failed.
  for (const code of ["EHOSTUNREACH", "ENETUNREACH"]) {
    await assert.rejects(pickWith(Object.assign(coded(code, `connect ${code}`), { syscall: "connect" })), {
      message: `the pick never reached the Orchestrator (connect ${code}) — try it again`,
    });
    assert.equal(
      await pickWith(Object.assign(coded(code, `write ${code}`), { syscall: "write" })),
      unknownPickResult("mcp__jr2__run_tests", `write ${code}`, false),
    );
  }
  // The text is the call's answer, not an error: an error reads as a failed pick.
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"]) {
    assert.equal(
      await pickWith(coded(code, `failed ${code}`)),
      unknownPickResult("mcp__jr2__run_tests", `failed ${code}`, false),
    );
  }
  const ended = new AbortController();
  ended.abort();
  // An abort reads "not known" even with a code that would prove the request never left: the call
  // was the Turn's, and the Turn is over.
  assert.equal(
    await pickWith(coded("ECONNREFUSED", "This operation was aborted"), ended.signal),
    unknownPickResult("mcp__jr2__run_tests", "This operation was aborted", true),
  );
});

test("the Custodian's 502: a request it never forwarded never reached the Orchestrator; any other flag answers that the Harness does not know (ADR-0002, ADR-0059)", async () => {
  const custodian = (flags: string) =>
    fakeFetch((call) => {
      if (call.url.endsWith("/surface")) return Response.json(SURFACE);
      return Response.json(
        { detail: "upstream connect error", flags },
        { status: 502, headers: { "x-jr2-custodian": "unreachable" } },
      );
    });
  const pickWith = async (flags: string) =>
    (await readMenu(opts(custodian(flags).fetch), "run-1/coder"))!.menu[0]!.pick({});
  for (const flags of ["UF", "UH", "DF", "URX", "UF,URX"]) {
    await assert.rejects(pickWith(flags), {
      message:
        "the pick never reached the Orchestrator (the Custodian could not reach it (upstream connect error)) — try it again",
    });
  }
  for (const flags of ["UC", "UMSDR", "DPE", "UPE", "UR", "LR", "UF,UC", ""]) {
    assert.equal(
      await pickWith(flags),
      unknownPickResult("mcp__jr2__run_tests", "the Custodian could not reach it (upstream connect error)", false),
    );
  }
});

test("an outstanding pick whose poll the Turn's abort cuts reads that it reached the workflow (ADR-0002)", async () => {
  const ending = new AbortController();
  const held = fakeFetch((call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    if (call.method === "POST") return Response.json(outstanding);
    ending.abort();
    throw new DOMException("This operation was aborted", "AbortError");
  });
  const heldRead = await readMenu(opts(held.fetch), "run-1/coder");
  assert.equal(await heldRead!.menu[0]!.pick({}, ending.signal), unreadAnswerResult("mcp__jr2__run_tests"));
});

test("over a real socket: a refused connection never reached the Orchestrator; a socket closed after the request is not known; a 200 whose body the abort cuts reached the workflow (ADR-0002)", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  let handle: (req: IncomingMessage, res: ServerResponse) => void = () => {};
  const server = createServer((req, res) => handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  // The surface is read in process; the pick's POST goes over a real socket to `target`.
  const pickTo = async (target: string, signal?: AbortSignal) => {
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/surface")
        ? Promise.resolve(Response.json(SURFACE))
        : globalThis.fetch(`${target}${new URL(String(input)).pathname}`, init)) as typeof globalThis.fetch;
    return (await readMenu(opts(fetch), "run-1/coder"))!.menu[0]!.pick({}, signal);
  };
  const live = `http://127.0.0.1:${port}`;
  try {
    // The request left and was read; the socket closed with no answer.
    handle = (req) => {
      req.resume();
      req.on("end", () => req.socket.destroy());
    };
    assert.match(
      await pickTo(live),
      /^It is not known whether this pick reached the workflow: the call to `mcp__jr2__run_tests` failed before the workflow answered \(/,
    );

    // A 200 whose body the Turn's abort cuts: the Orchestrator took the pick.
    const ended = new AbortController();
    handle = (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"delivered":');
      setTimeout(() => ended.abort(), 20);
    };
    assert.equal(await pickTo(live, ended.signal), unreadAnswerResult("mcp__jr2__run_tests"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // Nothing listens on the port now: the connection is refused, so no byte of the request left.
  await assert.rejects(pickTo(live), /^Error: the pick never reached the Orchestrator \(connect ECONNREFUSED /);
});
