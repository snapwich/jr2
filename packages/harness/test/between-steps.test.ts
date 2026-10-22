// The step-boundary check (`between-steps.ts`, ADR-0029), socket-free: what the model last
// READ against the surface NOW — set-compared, said once, silent on every failure — and the hook
// that lets every receipt and refusal count as read. No pi here: conformance drives the real loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { between, ToldPicks } from "../src/between-steps.ts";
import { restatedTurnPart } from "../src/briefing.ts";
import { readAllowed, readMenu, type MenuOptions, type Surface } from "../src/menu.ts";

const surface = (allowed: string[] | undefined, menu = ["abandon", "ask_review", "revise", "submit"]): Surface => ({
  instanceId: "run-1/coder",
  runId: "run-1",
  menu: menu.map((name) => ({ name, input: { type: "object", properties: {} }, semantics: "ack" as const })),
  ...(allowed ? { allowed } : {}),
});

function opts(answer: (url: string, init?: RequestInit) => Response | Promise<Response>, extra?: Partial<MenuOptions>) {
  const urls: string[] = [];
  const options: MenuOptions = {
    url: "http://custodian.invalid",
    token: "stand-in",
    toolName: (name) => `mcp__jr2__${name}`,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return answer(String(input), init);
    }) as typeof fetch,
    ...extra,
  };
  return { options, urls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("ToldPicks: a set, not a sentence — order and repeats are no change; nothing differs before anything is heard", () => {
  const told = new ToldPicks();
  assert.equal(told.differs(["a"]), false, "a Turn always hears its Turn part first");
  told.heard(["submit", "abandon"]);
  assert.equal(told.differs(["abandon", "submit"]), false);
  assert.equal(told.differs(["abandon", "submit", "submit"]), false);
  assert.equal(told.differs(["abandon"]), true);
  assert.equal(told.differs([]), true, "empty is a list too");
});

test("between: says the new list once, then records it as read", async () => {
  let allowed = ["abandon", "ask_review"];
  const { options, urls } = opts(() => json(200, surface(allowed)));
  const told = new ToldPicks();
  told.heard(["ask_review", "abandon"]);
  assert.equal(await between(options, "run-1/coder", told), undefined, "same set: nothing");
  allowed = ["abandon", "revise", "submit"];
  assert.equal(
    await between(options, "run-1/coder", told),
    "<jr2-turn>\nThe workflow's state changed since you last read the Allowed picks. " +
      "Allowed now: `mcp__jr2__abandon`, `mcp__jr2__revise`, `mcp__jr2__submit`.\n</jr2-turn>",
  );
  assert.equal(await between(options, "run-1/coder", told), undefined, "already said");
  assert.deepEqual(urls, Array(3).fill("http://custodian.invalid/agents/run-1%2Fcoder/surface"));
});

test("between, the ask-again rule: a model that STOPPED is not restated an empty list; a model answer that ran tools is", async () => {
  let allowed: string[] = [];
  const { options } = opts(() => json(200, surface(allowed)));
  const told = new ToldPicks();
  told.heard(["abandon", "ask_review"]);
  assert.equal(await between(options, "i", told, undefined, { stopped: true }), undefined, "stopped + empty: nothing");
  assert.equal(told.differs([]), true, "not heard: the next read with picks says it");
  allowed = ["revise"];
  assert.match((await between(options, "i", told, undefined, { stopped: true })) ?? "", /mcp__jr2__revise/);
  allowed = [];
  assert.match(
    (await between(options, "i", told, undefined, { stopped: false })) ?? "",
    /Allowed now: none/,
    "a model answer that ran tools goes on anyway: the empty list is said",
  );
});

test("between: every failure is silence — 404 (Turn over), 503, the Custodian's unreachable, a transport throw, a timeout", async () => {
  const told = new ToldPicks();
  told.heard(["x"]);
  const answers: Array<() => Response | Promise<Response>> = [
    () => json(404, { error: "no live agent surface" }),
    () => json(503, { error: "stopping" }),
    () => json(502, { detail: "refused" }, { "x-jr2-custodian": "unreachable" }),
    () => {
      throw new TypeError("fetch failed");
    },
  ];
  for (const answer of answers) {
    const { options } = opts(answer);
    assert.equal(await between(options, "i", told), undefined);
  }
  // A read that never answers is cut at its bound, never waited on.
  const { options } = opts(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      ),
  );
  const started = Date.now();
  assert.equal(await readAllowed(options, "i", undefined, 50), undefined);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(told.differs(["x"]), false, "and nothing was recorded as read");
});

test("readAllowed: an older Orchestrator's surface (no `allowed`) reads as the whole Menu — absent is not empty (ADR-0029)", async () => {
  const { options } = opts(() => json(200, surface(undefined, ["a", "b"])));
  assert.deepEqual(await readAllowed(options, "i"), ["a", "b"]);
});

test("onAllowed hears every receipt's and every refusal's Allowed picks — what the model reads with a pick's answer", async () => {
  const heard: string[][] = [];
  let reply: Response = json(200, surface(["ask_review"]));
  const { options } = opts(() => reply, { onAllowed: (allowed) => heard.push(allowed) });
  const read = await readMenu(options, "i");
  assert.deepEqual(heard, [], "the surface read is not a pick: the Turn part is recorded by turn.ts");
  const pick = read!.menu.find((item) => item.event === "ask_review")!;

  reply = json(200, {
    delivered: true,
    event: "ask_review",
    moved: true,
    turnComplete: false,
    allowed: ["revise", "submit"],
    deliveryId: "d-1",
  });
  await pick.pick({});
  reply = json(400, { error: 'the workflow\'s current state does not accept "x"', allowed: ["abandon"] });
  await assert.rejects(pick.pick({}), /Allowed now: `mcp__jr2__abandon`\./);
  reply = json(200, { delivered: true, event: "ask_review", turnComplete: false, deliveryId: "d-2" });
  await pick.pick({});
  assert.deepEqual(heard, [["revise", "submit"], ["abandon"]], "a receipt with no `allowed` (skew) says nothing");
});

test("onTurnOver hears a receipt that ended the Turn and a pick's 404 — never a receipt that left it open", async () => {
  let over = 0;
  let reply: Response = json(200, surface(["submit"]));
  const { options } = opts(() => reply, { onTurnOver: () => void over++ });
  const pick = (await readMenu(options, "i"))!.menu.find((item) => item.event === "submit")!;

  reply = json(200, {
    delivered: true,
    event: "submit",
    moved: true,
    turnComplete: false,
    allowed: [],
    deliveryId: "d",
  });
  await pick.pick({});
  assert.equal(over, 0, "an open Turn");
  reply = json(200, {
    delivered: true,
    event: "submit",
    moved: true,
    turnComplete: true,
    allowed: [],
    deliveryId: "d",
  });
  await pick.pick({});
  assert.equal(over, 1, "turnComplete");
  reply = json(404, { error: "no live registration" });
  await assert.rejects(pick.pick({}), /this turn is over/);
  assert.equal(over, 2, "no surface");
});

test("restatedTurnPart: an empty list reads as the receipt's 'none' — the same words the model already knows", () => {
  assert.match(restatedTurnPart([]), /Allowed now: none — the workflow's current state accepts no pick yet/);
});
