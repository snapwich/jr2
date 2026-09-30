// The feeds' fan-out (ADR-0022, "a frame is rendered once, and a slow reader is closed, not
// queued"), driven through the real HTTP app over a real RunHost. Two claims: every subscriber of a
// feed is written the SAME wire string, rendered once per event however many are attached; and a
// subscriber that leaves the bound's worth of writes unread across a ping interval is closed while
// the others read on — judged on lag, never on burst size. The feeds are level-triggered, so the
// closed reader loses no state: it reconnects to the whole current truth.

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

/** One transition that emits `BURST` Emits — far more than the backlog bound, all in one tick —
 * then parks. */
const BURST = 200;
function burstDef(): WorkflowDef {
  const machine = setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "burst"; n: number };
    },
  }).createMachine({
    id: "burst",
    context: {},
    initial: "waiting",
    states: {
      waiting: {
        after: {
          5: {
            target: "parked",
            actions: Array.from({ length: BURST }, (_, n) => emit({ type: "burst" as const, n })),
          },
        },
      },
      parked: {},
    },
  });
  return { name: "burst", machine, provide: () => ({}) };
}

/** Short enough that a stalled reader is judged within a test; long next to a reader that keeps up. */
const PING = { pingMs: 20 };

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
  const app = createApp(host, undefined, PING);

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

for (const [band, route] of [
  ["the Instance's run feed", (runId: string) => `/runs/${runId}/events`],
  ["the open band's run feed", (runId: string) => `/workflows/ticker/runs/${runId}/events`],
] as const) {
  test(`${band} closes a stalled reader the same way`, { timeout: 10_000 }, async () => {
    const host = new RunHost({ store: await mkStore() });
    host.register(tickerDef());
    const app = createApp(host, undefined, PING);
    const { runId } = await host.start("ticker");

    const stalled = await app.request(route(runId));
    const reading = await app.request(route(runId));
    const live = await read(reading, (b) => b.includes(`"value":"parked"`));
    assert.ok(!live.ended);

    const late = await read(stalled);
    assert.ok(late.ended, "closed, though the run has not settled");
    assert.ok(!late.buf.includes(`"value":"parked"`));
    assert.ok(host.status(runId), "the run is untouched");
  });
}

test(
  "one transition's burst reaches every reader that keeps up whole, on every feed",
  { timeout: 10_000 },
  async () => {
    const host = new RunHost({ store: await mkStore() });
    host.register(burstDef());
    const app = createApp(host, undefined, PING);

    const page = await app.request("/workflows/burst/events");
    const { runId } = await host.start("burst");
    const runFeeds = [`/runs/${runId}/events`, `/workflows/burst/runs/${runId}/events`];
    const feeds = [page, ...(await Promise.all(runFeeds.map((route) => app.request(route))))];

    // A burst is not lag: every write is pending in the same tick, and a reader that keeps up
    // drains it before any ping judges it.
    for (const res of feeds) {
      const { buf, ended } = await read(res, (b) => b.includes(`"value":"parked"`));
      assert.ok(!ended, "still attached after the burst");
      assert.equal(buf.match(/event: emit\n/g)?.length, BURST, "and missed nothing");
    }
  },
);

test("a reader stalled on a quiet feed is closed by its own pings", { timeout: 10_000 }, async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(burstDef());
  const app = createApp(host, undefined, { pingMs: 2 });
  const { runId } = await host.start("burst");
  while (host.status(runId)?.value !== "parked") await new Promise((r) => setTimeout(r, 5));

  // Parked: nothing moves, so nothing but pings is written — and unread, they pass the bound.
  const stalled = await app.request("/workflows/burst/events");
  assert.equal(host.observerCount("burst"), 1);
  const deadline = Date.now() + 5_000;
  while (host.observerCount("burst") > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(host.observerCount("burst"), 0, "the stalled page's observer is gone");
  assert.ok((await read(stalled)).ended);
  assert.equal(host.status(runId)?.value, "parked", "the run is untouched");
});
