// The sender (ADR-0015, ADR-0011, ADR-0013): every event a party delivers carries
// `sender: { party, id }`, written by the Orchestrator as plain data on the event — an Agent by
// its slot, a Gate by its invoke id. The Machine's own events carry none. No caller can send it,
// and it survives the persisted state and a restore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { assign, raise } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import { jr2Setup } from "../src/setup.ts";
import { partyHost, post, type Ran, type Slots } from "./_party.ts";

const note = defineEvent({ name: "note", description: "Leave a note.", input: z.object({ text: z.string() }) });
const echo = defineEvent({ name: "echo", description: "Raise a note of your own.", input: z.object({}) });
const answer = defineEvent({ name: "answer", audience: "external", input: z.object({ text: z.string() }) });
const park = defineEvent({ name: "park", audience: "external", input: z.object({}) });
const later = defineEvent({ name: "later", audience: "external", input: z.object({}) });

/** Each writing records the event its action read. `work` invokes the Agent; `review`, a Gate,
 * is entered by the Agent's `note`. `park` re-raises the reviewer's own `later` after 300 ms —
 * a delayed event the run host persists beside the snapshot. */
const build = (x: Slots) =>
  jr2Setup({
    types: {} as { context: Ran & { seen: unknown[] } },
    events: [note, echo, answer, park, later],
    actors: { coder: x.coder! },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "snd",
    context: { ran: [], seen: [] },
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid" } },
        on: {
          note: { target: "review", actions: assign({ seen: ({ context, event }) => [...context.seen, event] }) },
          echo: { actions: raise({ type: "note", text: "own" }) },
        },
      },
      review: {
        invoke: { src: "gate", id: "reviewer", input: { gate: "board" } },
        on: {
          answer: { target: "done", actions: assign({ seen: ({ context, event }) => [...context.seen, event] }) },
          park: { actions: raise(({ event }) => ({ ...event, type: "later" }) as never, { delay: 300 }) },
          later: { target: "done", actions: assign({ seen: ({ context, event }) => [...context.seen, event] }) },
        },
      },
      done: { type: "final" },
    },
  });

const seen = async (h: Awaited<ReturnType<typeof partyHost>>, runId: string): Promise<unknown[]> =>
  ((await h.host.read(runId))!.context as { seen: unknown[] }).seen;

test("an Agent's pick and a Gate's answer each land with their sender; the Machine's own event carries none", async () => {
  const h = await partyHost(build);
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "note", text: "ready" });
  await r.until("review");
  h.host.sendToGate(r.runId, "board", { type: "answer", text: "lgtm" });
  assert.deepEqual(await seen(h, r.runId), [
    { type: "note", text: "ready", sender: { party: "agent", id: "coder" } },
    { type: "answer", text: "lgtm", sender: { party: "gate", id: "reviewer" } },
  ]);

  const own = await h.start();
  h.host.sendToAgent(own.iids.coder!, { type: "echo" });
  await own.until("review");
  assert.deepEqual(
    await seen(h, own.runId),
    [{ type: "note", text: "own" }],
    "a raise is the Machine's own: no sender",
  );
});

test("a Gate's sender id is its invoke id, not the caller-facing gate id", async () => {
  // `review`'s invoke is named `reviewer`; its caller-facing id is `board`.
  const h = await partyHost(build);
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "note", text: "x" });
  await r.until("review");
  assert.deepEqual(
    h.host.gates(r.runId).map((g) => g.gate),
    ["board"],
  );
  h.host.sendToGate(r.runId, "board", { type: "answer", text: "y" });
  assert.deepEqual((await seen(h, r.runId))[1], {
    type: "answer",
    text: "y",
    sender: { party: "gate", id: "reviewer" },
  });
});

test("a caller that posts `sender` is refused 400 on both wires, and nothing moves (ADR-0013)", async () => {
  const h = await partyHost(build);
  const r = await h.start();
  const agent = await post(h.app, `/agents/${encodeURIComponent(r.iids.coder!)}/events`, {
    type: "note",
    text: "x",
    sender: { party: "gate", id: "reviewer" },
  });
  assert.equal(agent.status, 400);
  assert.match(
    ((await agent.json()) as { error: string }).error,
    /`sender` is written by the Orchestrator on every delivered event; a caller cannot send it/,
  );
  assert.equal(await r.value(), JSON.stringify("work"));

  h.host.sendToAgent(r.iids.coder!, { type: "note", text: "x" });
  await r.until("review");
  const gate = await post(h.app, `/runs/${r.runId}/gates/board/events`, {
    type: "answer",
    text: "y",
    sender: { party: "agent", id: "coder" },
  });
  assert.equal(gate.status, 400);
  assert.match(((await gate.json()) as { error: string }).error, /a caller cannot send it/);
  assert.equal(await r.value(), JSON.stringify("review"));
});

test("the pick marker on the run feed carries the payload, never the sender (ADR-0023)", async () => {
  const h = await partyHost(build);
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "note", text: "done" });
  await r.until("review");
  const picks = h.feed.filter((e) => e.kind === "pick");
  assert.equal(picks.length, 1);
  assert.deepEqual((picks[0] as { payload?: unknown }).payload, { text: "done" });
  assert.ok(!JSON.stringify(picks).includes("sender"));
});

test("the sender is in the persisted state and survives a restore: a re-armed timer delivers it", async () => {
  const h = await partyHost(build);
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "note", text: "x" });
  await r.until("review");
  // The reviewer's `park` holds a copy of its own event, sender and all, as a 300 ms timer.
  h.host.sendToGate(r.runId, "board", { type: "park" });
  let stored = "";
  for (let i = 0; i < 100 && !stored.includes('"timers":[{'); i++) {
    stored = JSON.stringify(await h.store.load(r.runId));
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.match(stored, /"event":\{"type":"later","sender":\{"party":"gate","id":"reviewer"\}\}/);
  await h.host.stop(r.runId);

  const second = await partyHost(build, ["coder"], h.store);
  assert.deepEqual((await second.host.restore()).reattached, [r.runId]);
  const rr = second.handle(r.runId);
  await rr.until("done");
  assert.deepEqual((await seen(second, r.runId)).at(-1), {
    type: "later",
    sender: { party: "gate", id: "reviewer" },
  });
});

test("after a restore the registrations deliver with their sender again: it is recomputed, never stored", async () => {
  const h = await partyHost(build);
  const r = await h.start();
  await h.host.stop(r.runId);
  const second = await partyHost(build, ["coder"], h.store);
  await second.host.restore();
  second.host.sendToAgent(r.iids.coder!, { type: "note", text: "after" });
  await second.handle(r.runId).until("review");
  assert.deepEqual((await seen(second, r.runId))[0], {
    type: "note",
    text: "after",
    sender: { party: "agent", id: "coder" },
  });
});
