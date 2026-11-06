// The standing Pool (ADR-0017): jr2 keeps one live run of each standing Workflow, through a real
// RunHost and an in-memory store. It starts the run at boot and at publish, keeps a restored one,
// hands it over at a publish, at its bound and after `error` (with back-off), pauses it at a cancel
// and after 3 hand-overs from runs (`error` or the bound) in which no item that the run took itself
// started a run, and resumes it with its held items. A read skips an item with no id.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import type {} from "../src/hook-kinds/gitlab.ts";
import { dispatch } from "../src/dispatch-effect.ts";
import { carry, pool, source, standingPoolOf, type PoolNextInput } from "../src/pool.ts";
import {
  RunHost,
  StandingRefused,
  type RunFeedEvent,
  type StandingOptions,
  type WorkflowDef,
} from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { standingPoolLines } from "../src/assembly-checks.ts";
import { mkStore } from "./_fixtures.ts";
import { createHash } from "node:crypto";
import { gitlab } from "../src/hook-kinds/gitlab.ts";
import { hookDoor } from "../src/hooks.ts";
import { secret } from "../src/http-effect.ts";

const finish = defineEvent({ name: "finish", input: z.object({}) });
const triageDoor = z.object({ sha: z.string() });
const triage = jr2Setup({ types: {} as { context: { body: unknown } }, events: [finish] }).createMachine({
  id: "triage",
  input: triageDoor,
  context: ({ input }) => ({ body: input }),
  initial: "waiting",
  states: {
    waiting: { invoke: { src: "gate", id: "ctl" }, on: { finish: "done" } },
    done: { type: "final" },
  },
});

/** A push Source that carries a failed pipeline. `item` is the schema of the held items. */
function alertsPool(item: z.ZodType<{ sha: string }> = z.object({ sha: z.string() }), cap = 1) {
  return pool(dispatch("triage", { input: triageDoor, wait: true }), {
    id: "alerts",
    standing: true,
    source: source({
      item,
      hooks: {
        gitlab: {
          "pipeline.failed": ({ payload }) => carry({ sha: payload.object_attributes.sha }),
        },
      },
    }),
    itemId: (a: { sha: string }) => `alert-${a.sha}`,
    cap,
    itemInput: (a: { sha: string }) => ({ sha: a.sha }),
  });
}

/** A pull Source that gives each of `api.items` first, then throws while `api.fail` is above 0:
 * the Pool's run ends `error`. With `api.waitMs`, it waits that long before it throws, so an item
 * that it gave can start its run first. With `refuse`, the callee's door refuses each item. */
function failingPool(api: { fail: number; calls: number; items?: string[]; waitMs?: number }, cap = 1, refuse = false) {
  return pool(dispatch("triage", { wait: true }), {
    id: "flaky",
    standing: true,
    source: source<{ sha: string }>({
      next: fromPromise(async () => {
        api.calls++;
        const sha = api.items?.shift();
        if (sha !== undefined) return { sha };
        if (api.fail > 0) {
          api.fail--;
          if (api.waitMs) await new Promise((r) => setTimeout(r, api.waitMs));
          throw new Error("the tracker is down");
        }
        return null;
      }),
    }),
    itemId: (a: { sha: string }) => `alert-${a.sha}`,
    cap,
    itemInput: (a: { sha: string }) => (refuse ? { sha: 1 } : { sha: a.sha }),
  });
}

const def = (name: string, machine: unknown, assembly = "a"): WorkflowDef => ({
  name,
  machine: machine as never,
  provide: () => ({}),
  assembly,
});

const hosts: RunHost[] = [];
after(async () => {
  for (const host of hosts) {
    await host.close();
    for (const s of host.list()) await host.stop(s.runId);
  }
});

function hostWith(store: SnapshotStore, defs: WorkflowDef[], standing?: StandingOptions): RunHost {
  const host = new RunHost({ store, ...(standing ? { standing } : {}) });
  hosts.push(host);
  for (const d of defs) host.register(d);
  return host;
}

async function until(pred: () => boolean | Promise<boolean>, what: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
}

const pipeline = (delivery: string, sha: string) => ({
  hook: "gl",
  kind: "gitlab",
  key: "pipeline.failed",
  delivery,
  payload: { object_attributes: { sha, status: "failed" } },
  caller: { via: "hook" as const, name: "gl" },
  may: () => true,
});

type Ctx = { held: Array<{ key: string }>; active: string[] };
const liveOf = (host: RunHost, workflow: string) => host.list().filter((s) => s.workflow === workflow);
const theRun = (host: RunHost, workflow: string) => {
  const live = liveOf(host, workflow);
  assert.equal(live.length, 1, `one live run of ${workflow}: ${live.map((s) => s.runId).join(", ")}`);
  return live[0]!;
};
const heldOf = (host: RunHost, workflow: string) => (theRun(host, workflow).context as Ctx).held.map((h) => h.key);
const triageIds = (host: RunHost) =>
  liveOf(host, "triage")
    .map((s) => s.runId)
    .sort();

/** Fill the alerts Pool: one triage run (cap 1) and `held` more items held. */
async function fill(host: RunHost, held: string[]): Promise<void> {
  for (const sha of ["s0", ...held]) await host.deliverHook(pipeline(`d-${sha}`, sha));
  await until(() => liveOf(host, "triage").length === 1, "one triage run");
  assert.deepEqual(
    heldOf(host, "alerts"),
    held.map((s) => `alert-${s}`),
  );
}

test("boot starts one run of each standing Workflow, as jr2, and a second keep starts nothing", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("boot");
  const run = theRun(host, "alerts");
  assert.deepEqual(run.startedBy, { kind: "jr2", why: "boot" });
  await host.keepStanding("publish");
  assert.equal(theRun(host, "alerts").runId, run.runId, "the live run is kept");
  // jr2 never starts the callee: a standing Workflow is the one that stands.
  assert.equal(liveOf(host, "triage").length, 0);
  assert.deepEqual(
    store.standingHeads().map((h) => [h.workflow, h.run, h.streak, h.paused]),
    [["alerts", run.runId, 0, undefined]],
  );
});

test("a restore keeps the standing run, its held items and its runs, and the boot starts no second one", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("publish");
  await fill(host, ["s1", "s2"]);
  const pool = theRun(host, "alerts").runId;
  const runs = triageIds(host);
  for (const s of host.list()) await host.stop(s.runId);

  const second = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await second.restore();
  await second.keepStanding("boot");
  assert.equal(theRun(second, "alerts").runId, pool);
  assert.deepEqual(heldOf(second, "alerts"), ["alert-s1", "alert-s2"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(triageIds(second), runs, "the same runs: none started again");
});

test("a publish hands the run over: the old one ends done with handedOverTo, the new one takes the held items and re-attaches each active key", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("publish");
  await fill(host, ["s1", "s2"]);
  const old = theRun(host, "alerts").runId;
  const runs = triageIds(host);

  // The next Assembly's `item` schema refuses one held item: it is dropped with a mark.
  const strict = z.object({ sha: z.string().regex(/^s1$/) });
  host.register(def("alerts", alertsPool(strict), "b"));
  await host.keepStanding("publish");
  const next = theRun(host, "alerts");
  assert.notEqual(next.runId, old);
  assert.deepEqual(next.startedBy, { kind: "jr2", why: "hand-over" });
  assert.equal(next.assembly, "b");
  assert.deepEqual(heldOf(host, "alerts"), ["alert-s1"]);
  assert.deepEqual((next.context as Ctx).active, ["alert-s0"], "the active key is counted");

  const ended = await host.read(old);
  assert.equal(ended?.status, "done");
  assert.equal(ended?.handedOverTo, next.runId);
  assert.equal((await store.load(old))?.status, "done");

  // The active key is sent again: the door finds the run, and the wait follows it.
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(triageIds(host), runs, "no second run of the active key");
  host.sendToGate(runs[0]!, "ctl", { type: "finish" });
  await until(() => heldOf(host, "alerts").length === 0, "the held item starts in the freed slot");
  assert.equal(liveOf(host, "triage").length, 1);
  // The refused item's mark was on the new run's feed from its start.
  const feed = (host as unknown as { runs: Map<string, { feedSoFar: RunFeedEvent[] }> }).runs.get(
    next.runId,
  )!.feedSoFar;
  const refused = feed.filter((e) => e.kind === "pool" && e.mark === "carry-refused");
  assert.deepEqual(
    refused.map((e) => (e as { key: string }).key),
    ["alert-s2"],
  );
  const blob = (await store.load(next.runId))?.snapshot as { snapshot: { context: { refused: unknown[] } } };
  assert.deepEqual(blob.snapshot.context.refused, [], "each refusal was marked, then cleared");
});

test("a delivery whose key lookup is in flight across a publish's hand-over goes on to the new run's Source", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("publish");
  const old = theRun(host, "alerts").runId;
  // Hold the Source's first key lookup open until the hand-over is done.
  const orig = host.dispatched.bind(host);
  let release: (() => void) | undefined;
  host.dispatched = (workflow, key) => {
    if (key !== "alert-h1" || release) return orig(workflow, key);
    return new Promise((r) => {
      release = () => r(orig(workflow, key));
    });
  };
  const fan = host.deliverHook(pipeline("d-h1", "h1"));
  await until(() => release !== undefined, "the lookup is in flight");
  host.register(def("alerts", alertsPool(), "b"));
  await host.keepStanding("publish");
  const next = theRun(host, "alerts").runId;
  assert.notEqual(next, old);
  assert.equal((await host.read(old))?.handedOverTo, next);
  release!();
  const out = await fan;
  assert.deepEqual(
    out.sources.map((l) => [l.verdict, l.pool, l.key]),
    [["held", next, "alert-h1"]],
    "the new run holds it: not a skip that the door would claim",
  );
  assert.equal(out.waiting, undefined);
  const ctx = theRun(host, "alerts").context as Ctx;
  assert.ok([...ctx.held.map((h) => h.key), ...ctx.active].includes("alert-h1"));
  await until(() => liveOf(host, "triage").length === 1, "the item starts its run");
});

test("the bound hands the run over after its dispatches, and the age bound after its time", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool(undefined, 5)), def("triage", triage)], {
    dispatches: 2,
  });
  await host.keepStanding("publish");
  const first = theRun(host, "alerts").runId;
  await host.deliverHook(pipeline("d1", "b1"));
  await host.deliverHook(pipeline("d2", "b2"));
  await until(async () => (await host.read(first))?.status === "done", "the bound hands over");
  const next = theRun(host, "alerts");
  assert.equal((await host.read(first))?.handedOverTo, next.runId);
  assert.deepEqual((next.context as Ctx).active.sort(), ["alert-b1", "alert-b2"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(liveOf(host, "triage").length, 2, "the two runs, not four");

  const aged = hostWith(await mkStore(), [def("alerts", alertsPool()), def("triage", triage)], { ageMs: 40 });
  await aged.keepStanding("boot");
  const young = theRun(aged, "alerts").runId;
  await until(() => theRun(aged, "alerts").runId !== young, "the age bound hands over");
  assert.equal((await aged.read(young))?.handedOverTo, theRun(aged, "alerts").runId);
});

test("a cancel pauses the Workflow: no run at boot or publish, a delivery gets `paused`, and a resume takes the held items", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("publish");
  await fill(host, ["s1", "s2"]);
  const old = theRun(host, "alerts").runId;
  const runs = triageIds(host);
  await host.cancel(old, { by: { via: "token", name: "ops" } });
  assert.equal(liveOf(host, "alerts").length, 0);
  assert.equal(store.standingHeads()[0]?.paused, "cancel");

  await host.keepStanding("publish");
  await host.keepStanding("boot");
  assert.equal(liveOf(host, "alerts").length, 0, "a paused Workflow gets no run");
  const view = await host.standingView();
  assert.deepEqual(view, [
    { workflow: "alerts", pool: "alerts", callee: "triage", state: "paused", run: old, held: 2, why: "cancel" },
  ]);
  const fan = await host.deliverHook(pipeline("d-x", "x1"));
  assert.deepEqual(
    fan.sources.map((l) => [l.verdict, l.workflow, l.pool]),
    [["paused", "alerts", old]],
  );
  assert.equal(fan.waiting, undefined);

  // The resume is a hand-over from the cancelled run, and records its Caller.
  const resumed = await host.resumeStanding("alerts", { via: "token", name: "ann" });
  const next = theRun(host, "alerts");
  assert.equal(next.runId, resumed.runId);
  assert.deepEqual(next.startedBy, { kind: "jr2", why: "resume" });
  assert.deepEqual(next.resumedBy, { via: "token", name: "ann" });
  assert.deepEqual(heldOf(host, "alerts"), ["alert-s1", "alert-s2"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(triageIds(host), runs, "the active key re-attached: the same run");
  await assert.rejects(host.resumeStanding("alerts", { via: "token", name: "ann" }), StandingRefused);
  assert.equal(store.standingHeads()[0]?.paused, undefined);

  // `--drop-held`: the next resume carries no held item.
  await host.cancel(next.runId);
  await host.resumeStanding("alerts", { via: "token", name: "ann" }, { dropHeld: true });
  assert.deepEqual(heldOf(host, "alerts"), []);
  assert.equal((theRun(host, "alerts").context as Ctx).active.length, 1, "the active key is still carried");
});

test("after `error` jr2 hands over after a back-off, and after 3 hand-overs from runs with no run started the next `error` pauses the Workflow", async () => {
  const store = await mkStore();
  const api = { fail: 1, calls: 0 };
  const waits: number[] = [];
  const host = hostWith(store, [def("flaky", failingPool(api)), def("triage", triage)], {
    backoffMs: (n) => {
      waits.push(n);
      return 20;
    },
  });
  await host.keepStanding("publish");
  const first = store.standingHeads()[0]!.run;
  await until(async () => (await host.read(first))?.status === "error", "the first run ends error");
  // In the back-off a delivery to it would be 503: it has no live run and is not paused.
  assert.deepEqual(
    (
      await host.deliverHook({
        ...pipeline("d1", "x"),
      })
    ).waiting,
    undefined,
    "a Source that does not hear the kind and key is not waited for",
  );
  assert.equal((await host.standingView())[0]?.state, "waiting");
  await until(() => liveOf(host, "flaky").length === 1, "the hand-over after the back-off");
  assert.deepEqual(theRun(host, "flaky").startedBy, { kind: "jr2", why: "hand-over" });
  assert.deepEqual(waits, [1]);

  // Three hand-overs from `error` with no run started, then the fourth `error` pauses it.
  const second = theRun(host, "flaky").runId;
  api.fail = 4;
  await host.cancel(second); // a cancel pauses: resume it so `next` runs again
  await host.resumeStanding("flaky", { via: "token", name: "ann" });
  await until(async () => store.standingHeads()[0]?.paused === "errors", "paused after 4 errors", 800);
  assert.equal(liveOf(host, "flaky").length, 0);
  assert.deepEqual(waits, [1, 1, 2, 3], "3 hand-overs, each after its back-off");
  assert.equal(store.standingHeads()[0]?.streak, 4);
});

test("a run in which an item that it took started a run, and that ended `error`, is not counted: 3 more hand-overs come before the pause", async () => {
  const store = await mkStore();
  // The first run takes t1, whose run starts; then its `next` throws: it ends `error`.
  const api = { fail: 5, calls: 0, items: ["t1"], waitMs: 30 };
  const waits: number[] = [];
  const host = hostWith(store, [def("flaky", failingPool(api, 2)), def("triage", triage)], {
    backoffMs: (n) => {
      waits.push(n);
      return 20;
    },
  });
  await host.keepStanding("publish");
  const first = store.standingHeads()[0]!.run;
  await until(async () => (await host.read(first))?.status === "error", "the first run ends error");
  assert.equal(liveOf(host, "triage").length, 1, "t1 started its run");
  assert.equal(store.standingHeads()[0]?.streak, 0, "the count starts again");
  await until(async () => store.standingHeads()[0]?.paused === "errors", "paused after 4 more errors", 800);
  assert.deepEqual(waits, [1, 1, 2, 3], "a hand-over from the run that took t1, then 3 with nothing taken");
  assert.equal(store.standingHeads()[0]?.streak, 4);
  assert.equal(api.fail, 0, "each failure was one run");
});

test("a run that took only refused items and ended `error` counts in the streak", async () => {
  const store = await mkStore();
  // More failures than runs: a settle of r1 can call `next` again inside the first run.
  const api = { fail: 10, calls: 0, items: ["r1"], waitMs: 30 };
  const waits: number[] = [];
  const host = hostWith(store, [def("flaky", failingPool(api, 2, true)), def("triage", triage)], {
    backoffMs: (n) => {
      waits.push(n);
      return 20;
    },
  });
  await host.keepStanding("publish");
  const first = store.standingHeads()[0]!.run;
  await until(async () => (await host.read(first))?.status === "error", "the first run ends error");
  assert.equal(store.standingHeads()[0]?.streak, 1, "it took r1, and r1 started no run");
  await until(async () => store.standingHeads()[0]?.paused === "errors", "paused after 4 errors", 800);
  assert.deepEqual(waits, [1, 2, 3]);
  assert.equal(liveOf(host, "triage").length, 0);
});

test("carried keys whose runs live do not reset the streak: a refused backlog at the bound still pauses", async () => {
  const store = await mkStore();
  // g1 starts a run that lives; r0..r4 the callee's door refuses.
  type It = { sha: string; ok: boolean };
  const all: It[] = [{ sha: "g1", ok: true }, ...Array.from({ length: 5 }, (_, i) => ({ sha: `r${i}`, ok: false }))];
  const mixed = pool(dispatch("triage", { wait: true }), {
    id: "mixed",
    standing: true,
    source: source<It>({ read: fromPromise(async () => all) }),
    itemId: (a: It) => `m-${a.sha}`,
    cap: 4,
    itemInput: (a: It) => ({ sha: a.ok ? a.sha : 1 }),
  });
  const waits: number[] = [];
  const host = hostWith(store, [def("mixed", mixed), def("triage", triage)], {
    dispatches: 3,
    backoffMs: (n) => {
      waits.push(n);
      return 20;
    },
  });
  await host.keepStanding("publish");
  await until(() => store.standingHeads()[0]?.paused === "bound", "paused at the bound", 800);
  // The first run took g1, which started its run: it handed over at once. Each later run carried
  // m-g1, whose run lives, and took only refused items.
  assert.deepEqual(waits, [1, 2, 3]);
  assert.equal(store.standingHeads()[0]?.streak, 4);
  assert.equal(liveOf(host, "triage").length, 1, "g1's one run, found again under its key");
});

/** A Pool whose every item the callee's door refuses: each one ends `start-refused`, with no run.
 * A read Source reads all of them each time; a pull Source gives each one that is not active or
 * settled. */
function refusedPool(form: "read" | "pull", n = 5) {
  const all = Array.from({ length: n }, (_, i) => ({ sha: `r${i}` }));
  const keyOf = (a: { sha: string }) => `refused-${a.sha}`;
  return pool(dispatch("triage", { wait: true }), {
    id: "refused",
    standing: true,
    source:
      form === "read"
        ? source<{ sha: string }>({ read: fromPromise(async () => all) })
        : source<{ sha: string }>({
            next: fromPromise(
              async ({ input }: { input: PoolNextInput }) =>
                all.find((a) => !input.active.includes(keyOf(a)) && !input.settled.includes(keyOf(a))) ?? null,
            ),
          }),
    itemId: keyOf,
    cap: 1,
    // The triage door wants `sha` as a string: it refuses each start.
    itemInput: () => ({ sha: 1 }),
  });
}

for (const form of ["read", "pull"] as const) {
  test(`a ${form} Source whose items each start no run fills its bound in each run: jr2 backs off, and after 3 hand-overs it pauses`, async () => {
    const store = await mkStore();
    const waits: number[] = [];
    const host = hostWith(store, [def("refused", refusedPool(form)), def("triage", triage)], {
      dispatches: 3,
      backoffMs: (n) => {
        waits.push(n);
        return 20;
      },
    });
    // The event loop stays free: a timer fires while the loop runs.
    let ticks = 0;
    const tick = setInterval(() => ticks++, 5);
    try {
      await host.keepStanding("publish");
      await until(() => store.standingHeads()[0]?.paused === "bound", "paused at the bound", 800);
    } finally {
      clearInterval(tick);
    }
    assert.ok(ticks > 0, "a timer fired");
    assert.deepEqual(waits, [1, 2, 3], "3 hand-overs, each after its back-off");
    assert.equal(store.standingHeads()[0]?.streak, 4);
    assert.equal(liveOf(host, "refused").length, 0);
    assert.equal(liveOf(host, "triage").length, 0, "no item started a run");
    const view = await host.standingView();
    assert.equal(view[0]?.state, "paused");
    assert.equal(view[0]?.why, "bound");
    // The run that the pause ended is `done`, with no run to take over: the resume starts one.
    const last = store.standingHeads()[0]!.run;
    const ended = await host.read(last);
    assert.equal(ended?.status, "done");
    assert.equal(ended?.handedOverTo, undefined);
  });
}

test("at the bound, a run in which an item started a run hands over at once and starts the count again", async () => {
  const store = await mkStore();
  const waits: number[] = [];
  const host = hostWith(store, [def("alerts", alertsPool(undefined, 5)), def("triage", triage)], {
    dispatches: 2,
    backoffMs: (n) => {
      waits.push(n);
      return 20;
    },
  });
  await host.keepStanding("publish");
  const first = theRun(host, "alerts").runId;
  await host.deliverHook(pipeline("d1", "b1"));
  await host.deliverHook(pipeline("d2", "b2"));
  await until(async () => (await host.read(first))?.handedOverTo !== undefined, "the bound hands over");
  assert.deepEqual(waits, [], "no back-off");
  assert.equal(store.standingHeads()[0]?.streak, 0);
});

test("a read Source skips an item whose itemId throws, with one mark in the run's life, and starts the rest", async () => {
  const store = await mkStore();
  type Issue = { number: number | null };
  const issues = pool(dispatch("triage", { input: triageDoor, wait: true }), {
    id: "issues",
    standing: true,
    source: source<Issue>({
      read: fromPromise(async () => [{ number: null }, { number: 2 }] as Issue[]),
      pollEvery: 10,
    }),
    itemId: (i: Issue) => {
      if (i.number === null) throw new Error("the issue has no number");
      return `issue-${i.number}`;
    },
    cap: 1,
    itemInput: (i: Issue) => ({ sha: String(i.number) }),
  });
  const host = hostWith(store, [def("issues", issues), def("triage", triage)]);
  await host.keepStanding("publish");
  await until(() => liveOf(host, "triage").length === 1, "issue-2 starts");
  const run = theRun(host, "issues");
  assert.deepEqual((run.context as Ctx).active, ["issue-2"]);
  // Several polls read the bad item again: the feed has one mark for it.
  await new Promise((r) => setTimeout(r, 60));
  const feed = (host as unknown as { runs: Map<string, { feedSoFar: RunFeedEvent[] }> }).runs.get(run.runId)!.feedSoFar;
  const skipped = feed.filter((e) => e.kind === "pool" && e.mark === "skipped");
  assert.equal(skipped.length, 1);
  assert.match(
    (skipped[0] as { reason: string }).reason,
    /item 0 of the read: its itemId threw: the issue has no number/,
  );
});

test("a delivery to a standing Pool in its back-off is `waiting`, so the door answers 503", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)], { backoffMs: () => 60_000 });
  await host.keepStanding("publish");
  const run = theRun(host, "alerts");
  // End it `error` from outside the Machine, as a defect would.
  (host as unknown as { faultUnrouted: (id: string, b: unknown, f: string) => void }).faultUnrouted(
    run.runId,
    (host as unknown as { runs: Map<string, { binding: unknown }> }).runs.get(run.runId)!.binding,
    "a defect",
  );
  assert.equal((await host.read(run.runId))?.status, "error");
  const fan = await host.deliverHook(pipeline("d1", "w1"));
  assert.deepEqual(fan.waiting, ["alerts"]);
  assert.deepEqual(fan.sources, []);
  // Through the door: 503, and the delivery does not claim its id, so a send again is heard.
  const token = "glpat-hook";
  const door = hookDoor({
    host,
    store,
    hooks: () => ({ gl: gitlab({ secret: secret("GL") }) }),
    digests: () => ({ GL: createHash("sha256").update(token).digest("hex") }),
  });
  const send = () =>
    door.deliver(
      "gl",
      new Headers({ "x-gitlab-token": token, "idempotency-key": "g1", "content-type": "application/json" }),
      new TextEncoder().encode(
        JSON.stringify({ object_kind: "pipeline", object_attributes: { sha: "w2", status: "failed" }, user: {} }),
      ),
    );
  assert.equal((await send()).status, 503);
  const again = await send();
  assert.equal(again.status, 503, "not `seen`: the first 503 claimed nothing");
  assert.deepEqual(
    door.log("gl", 5).lines.map((l) => [l.kind, l.status]),
    [
      ["no-live-run", 503],
      ["no-live-run", 503],
    ],
  );
  await assert.rejects(host.resumeStanding("alerts", { via: "token", name: "ann" }), /not paused/);
});

test("the store's sweep keeps the run that a paused head names", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool()), def("triage", triage)]);
  await host.keepStanding("publish");
  const run = theRun(host, "alerts").runId;
  await host.cancel(run);
  await store.sweep(new Date(Date.now() + 60_000));
  assert.ok(await store.load(run), "the paused run's blob is kept");
});

test("jr2 up prints each standing Pool's chain and warns when two dispatch to one Workflow", async () => {
  const workflows = [
    { name: "alerts", machine: alertsPool() },
    { name: "pipelines", machine: alertsPool() },
    { name: "triage", machine: triage },
  ] as never;
  const lines = standingPoolLines(workflows, {
    gl: gitlab({ secret: secret("GL") }),
    other: gitlab({ secret: secret("GL2"), may: { answer: ["pipelines"] } }),
  });
  assert.deepEqual(lines.chains, ["gl → alerts → triage", "gl → pipelines → triage", "other → pipelines → triage"]);
  assert.equal(lines.warnings.length, 1);
  assert.match(lines.warnings[0]!, /"alerts" and "pipelines" each dispatch to "triage"/);
  assert.deepEqual(standingPoolOf(alertsPool())?.kinds, ["gitlab"]);
});
