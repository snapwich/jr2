// The outstanding pick, Harness side (ADR-0024, ADR-0013): an outstanding pick's answer is long-polled
// inside the one tool call; the Harness claims one pick at a time in message order; a refusal while
// one is out names it; the answer reads as prose; a cut call's history result is jr2's text.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { noticeText } from "../src/briefing.ts";
import {
  answerText,
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
    'Delivered "run_tests" to the workflow (delivery d-1). The workflow ran it and is back in the state that asked ' +
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
  assert.match(await first, /It moved, and nothing ran\./);
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
    'Delivered "ship" to the workflow (delivery d). The workflow ran it and moved on: your turn is over. Stop here — ' +
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
  assert.equal(answerText({ kind: "error", actor: "tests", error: "boom" }), "Its answer: `tests` failed: boom.");
  assert.equal(answerText(undefined), "It moved, and nothing ran.");
});

test("a pick's answer that never reached its call is a notice: cut by a restart, or after the Turn was over", () => {
  const answer = { kind: "output" as const, actor: "tests", output: "pass" };
  assert.equal(
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "run_tests", cut: true, answer }, menuToolName),
    "Notice: The workflow finished `mcp__jr2__run_tests`, the pick that was cut from your last turn. It ran once. " +
      'Its answer: the output of `tests`: "pass".',
  );
  assert.equal(
    noticeText({ kind: "pick-answer", scope: "conversation", pick: "ship", cut: false }, menuToolName),
    "Notice: Your pick `mcp__jr2__ship` ran to its end after your last turn was over. It moved, and nothing ran.",
  );
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
