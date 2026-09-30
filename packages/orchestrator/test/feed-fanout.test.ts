// The feeds' fan-out (ADR-0022, "a frame is rendered once, and a slow reader is closed, not
// queued"), driven through the real HTTP app over a real RunHost. Two claims: every subscriber of a
// feed is written the SAME wire string, rendered once per event however many are attached; and a
// subscriber whose backlog of pending writes passes the bound is closed while the others read on.
// The feeds are level-triggered, so the closed reader loses nothing: it reconnects to the whole
// current truth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, emit, setup } from "xstate";
import { RunHost, type RunFeedEvent, type WorkflowDef, type WorkflowFeedEvent } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { mkStore } from "./_fixtures.ts";

/** working ──after 10ms──▶ (emit "note") done. One emit and a handful of statuses, then it settles. */
function quickDef(): WorkflowDef {
  const machine = setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "note"; message: string };
    },
  }).createMachine({
    id: "quick",
    context: {},
    initial: "working",
    states: {
      working: { after: { 10: { target: "done", actions: emit({ type: "note", message: "hi" }) } } },
      done: { type: "final" },
    },
  });
  return { name: "quick", machine, provide: () => ({}) };
}

/** Ticks `TICKS` times a millisecond apart — a status and an Emit per tick, far more frames than the
 * backlog bound — then parks, so a feed stays open after the burst. */
const TICKS = 120;
function tickerDef(): WorkflowDef {
  const machine = setup({
    types: {} as {
      context: { n: number };
      input: { instanceId: string };
      emitted: { type: "tick"; n: number };
    },
  }).createMachine({
    id: "ticker",
    context: { n: 0 },
    initial: "ticking",
    states: {
      ticking: {
        after: {
          1: [
            {
              guard: ({ context }) => context.n < TICKS,
              target: "ticking",
              reenter: true,
              actions: [
                assign({ n: ({ context }) => context.n + 1 }),
                emit(({ context }) => ({ type: "tick" as const, n: context.n })),
              ],
            },
            { target: "parked" },
          ],
        },
      },
      parked: {},
    },
  });
  return { name: "ticker", machine, provide: () => ({}) };
}

/** Read an SSE body until `until` holds or the stream ends; `ended` says which. */
async function read(res: Response, until: (buf: string) => boolean = () => false) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ended = false;
  try {
    while (!until(buf)) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return { buf, ended };
}

/** The JSON.stringify calls whose output starts with `prefix` — one per rendered frame of a kind. */
function rendersStartingWith(calls: ReadonlyArray<{ result?: unknown }>, prefix: string): number {
  return calls.filter((c) => typeof c.result === "string" && c.result.startsWith(prefix)).length;
}

test("the workflow feed renders each event once, however many pages are attached", async (t) => {
  const host = new RunHost({ store: await mkStore() });
  host.register(quickDef());
  const app = createApp(host);

  // Attach first: each opening `runs` frame is that subscriber's own, so it is outside the count.
  const pages = await Promise.all([1, 2, 3].map(() => app.request("/workflows/quick/events")));
  const fed: WorkflowFeedEvent[] = [];
  host.observeWorkflow("quick", (e) => fed.push(e));
  const stringify = t.mock.method(JSON, "stringify");

  const { runId } = await host.start("quick");
  const bodies = await Promise.all(pages.map((res) => read(res, (b) => b.includes("event: gone"))));

  const statuses = fed.filter((e) => e.kind === "status").length;
  assert.ok(statuses > 1);
  for (const { buf } of bodies) {
    assert.equal(buf.match(/event: status\n/g)?.length, statuses, "every page saw every status");
  }
  const calls = stringify.mock.calls;
  // `observe()` + JSON once per status event — not once per page.
  assert.equal(rendersStartingWith(calls, `{"runId":"${runId}","workflow":"quick","status":`), statuses);
  assert.equal(rendersStartingWith(calls, `{"runId":"${runId}","type":"note"}`), 1);
  assert.equal(rendersStartingWith(calls, `{"runId":"${runId}"}`), 1, "gone, once");
});

test("a run's feed renders each event once, in both bands", async (t) => {
  const host = new RunHost({ store: await mkStore() });
  host.register(quickDef());
  const app = createApp(host);
  const { runId } = await host.start("quick");

  const instance = await Promise.all([1, 2, 3].map(() => app.request(`/runs/${runId}/events`)));
  const open = await Promise.all([1, 2, 3].map(() => app.request(`/workflows/quick/runs/${runId}/events`)));
  const fed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => fed.push(e));
  const replayed = fed.length; // the test's own attach replay, which no page shares
  const stringify = t.mock.method(JSON, "stringify");

  // Each feed ends on its own at the terminal status.
  const bodies = await Promise.all([...instance, ...open].map((res) => read(res)));
  for (const { ended } of bodies) assert.ok(ended);

  const statuses = fed.slice(replayed).filter((e) => e.kind === "status").length;
  assert.ok(statuses > 0);
  const calls = stringify.mock.calls;
  // The Instance band carries the whole status; the open band its `observe()` projection.
  assert.equal(rendersStartingWith(calls, `{"runId":"${runId}","workflow":"quick","instanceId":`), statuses);
  assert.equal(rendersStartingWith(calls, `{"runId":"${runId}","workflow":"quick","status":`), statuses);
  assert.equal(rendersStartingWith(calls, `{"type":"note","message":"hi"}`), 1, "the Instance band's emit");
  assert.equal(rendersStartingWith(calls, `{"type":"note"}`), 1, "the open band's emit");
});

test("a page that stops reading is closed past its backlog; the others read on", { timeout: 10_000 }, async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(tickerDef());
  const app = createApp(host);

  const stalled = await app.request("/workflows/ticker/events"); // never read while the run ticks
  const reading = await app.request("/workflows/ticker/events");
  assert.equal(host.observerCount("ticker"), 2);
  await host.start("ticker");

  const live = await read(reading, (b) => b.includes(`"value":"parked"`));
  assert.ok(!live.ended, "the reader that kept up is still attached");
  assert.equal(live.buf.match(/event: emit\n/g)?.length, TICKS, "and missed nothing");

  // The stalled page was aborted, not drained: its body ends short of the burst, and its observer
  // is gone — while the run it watched is still running.
  const late = await read(stalled);
  assert.ok(late.ended);
  assert.ok(!late.buf.includes(`"value":"parked"`));
  assert.ok((late.buf.match(/event: emit\n/g)?.length ?? 0) < TICKS);
  assert.equal(host.observerCount("ticker"), 0);
  assert.equal(host.list().length, 1);
});

test("the Instance's run feed closes a stalled reader the same way", { timeout: 10_000 }, async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(tickerDef());
  const app = createApp(host);
  const { runId } = await host.start("ticker");

  const stalled = await app.request(`/runs/${runId}/events`);
  const reading = await app.request(`/runs/${runId}/events`);
  const live = await read(reading, (b) => b.includes(`"value":"parked"`));
  assert.ok(!live.ended);

  const late = await read(stalled);
  assert.ok(late.ended, "closed, though the run has not settled");
  assert.ok(!late.buf.includes(`"value":"parked"`));
  assert.ok(host.status(runId), "the run is untouched");
});
