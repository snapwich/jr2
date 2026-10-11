// The outstanding pick, Harness side (ADR-0024, ADR-0013): an outstanding pick's answer is long-polled
// inside the one tool call; the Harness claims one pick at a time in message order; a refusal while
// one is out names it; the answer reads as prose; a cut call's history result is jr2's text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { EffectStateShape } from "@jr2/orchestrator";
import { noticeText } from "../src/briefing.ts";
import {
  answerText,
  signedPushText,
  cutPickResult,
  outstandingRefusal,
  readMenu,
  receiptProse,
  type DeliveryReceipt,
  type Surface,
} from "../src/menu.ts";
import { menuToolName } from "../src/menu-tools.ts";
import { settleCutPicks } from "../src/turn.ts";

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

test("the Harness claims one pick at a time, in message order: the second call of a message is refused before it leaves — `finish` included", async () => {
  let release: (() => void) | undefined;
  const { fetch, calls } = fakeFetch(async (call) => {
    if (call.url.endsWith("/surface")) return Response.json(SURFACE);
    if (call.method === "POST") return Response.json(outstanding);
    await new Promise<void>((resolve) => (release = resolve));
    return Response.json({ ...outstanding, outstanding: undefined, answered: true, allowed: ["finish"] });
  });
  const read = await readMenu(opts(fetch), "run-1/coder");
  const [runTests, finish] = read!.menu;
  const first = runTests!.pick({});
  const second = finish!.pick({});
  await assert.rejects(second, (err: Error) => {
    assert.equal(
      err.message,
      "`mcp__jr2__finish` was NOT delivered: your pick `mcp__jr2__run_tests` is still running in the workflow, and " +
        "no other pick is taken until it answers. Wait for its answer, then pick again.",
    );
    return true;
  });
  await new Promise((r) => setTimeout(r, 5));
  release?.();
  assert.match(await first, /No reply came back for it\./);
  assert.deepEqual(
    calls.filter((c) => c.method === "POST").map((c) => c.url),
    ["http://127.0.0.1:8081/agents/run-1%2Fcoder/events"],
    "only the first pick reached the Orchestrator",
  );
  // Answered: the claim is free again, and the next pick leaves.
  const third = finish!.pick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  release?.();
  await third;
});

test("the Orchestrator's refusal while a pick is out reads the same as the Harness's own; busy with no pick of ours says rest", async () => {
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
    'Delivered "ship" to the workflow (delivery d). The workflow took it and moved on: your turn is over. Stop here — ' +
      "do not call this or any other tool again.",
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
      '"source":"1111111111111111111111111111111111111111","via":"ancestry"}.',
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
  };
  const settled = readdirSync(fixtures).filter((f) => f.startsWith("response.settled-"));
  assert.deepEqual(settled.sort(), Object.keys(want).sort(), "every settled fixture has its text here");
  for (const [name, text] of Object.entries(want)) assert.equal(read(name), text, name);
});

test("after a signed push the Agent reads what moved, by the sync's answer; never a rebase to do (ADR-0067)", () => {
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
  const busy = signedPushText({ ...pushed, sync: "busy", syncReason: "a rebase of your branch is in progress" });
  assert.equal(
    busy,
    "jr2 signed your commits and pushed the signed copies. jr2 did not move your branch to them (a rebase of your " +
      "branch is in progress). Continue your work on your branch: the next push finds the published commits. Do not " +
      "merge or rebase branches that you made before this push. Do not change the pushed commits: if you amend, " +
      'rebase or reset them, the next push stops with "diverged".',
  );
  assert.equal(signedPushText({ ...pushed, source: pushed.published, sync: "skipped" }), undefined, "unsigned");
  // An unsigned squash (B15) publishes a new commit and is not synced (design 6: the sync follows a signed push), so
  // it reads no signed-push paragraph: "jr2 signed your commits" would be false there.
  assert.equal(signedPushText({ ...pushed, sync: "skipped" }), undefined, "unsigned squash");
  assert.equal(signedPushText({ outcome: "diverged", reason: "x" }), undefined);
  for (const text of [synced, busy!]) assert.doesNotMatch(text, /\b(please )?rebase (your|onto)/i);
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
    'Delivered "draft" to the workflow (delivery d). The workflow is still in the state that asked for this turn, ' +
      "so it is not over yet. Allowed now: `mcp__jr2__finish`.",
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
  const stop = "Stop here — do not call this or any other tool again.";
  const left =
    'Delivered "go" to the workflow (delivery d). The workflow left the state that asked for this turn while it ' +
    "ran your pick, and that stopped the pick's work before it finished: your turn is over.";
  assert.equal(receiptProse(base, menuToolName), `${left} ${stop}`);
  const built = { kind: "output" as const, actor: "build", output: { ok: true } };
  assert.equal(
    receiptProse({ ...base, answer: built }, menuToolName),
    `${left} Its answer: the output of \`build\`: {"ok":true}. ${stop}`,
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

test("a Menu call a restart cut gets jr2's result in the history; a Working-tool call is left to pi", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "m1", name: "mcp__jr2__run_tests", arguments: {} },
        { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
  ] as unknown as AgentMessage[];
  const settled = settleCutPicks(messages) as Array<{ role: string; toolCallId?: string; content?: unknown }>;
  const results = settled.filter((m) => m.role === "toolResult");
  assert.deepEqual(
    results.map((m) => m.toolCallId),
    ["m1"],
  );
  assert.deepEqual((results[0]!.content as Array<{ text: string }>)[0]!.text, cutPickResult("mcp__jr2__run_tests"));
  assert.deepEqual(settleCutPicks(settled as unknown as AgentMessage[]), settled, "an answered call is left alone");
});
