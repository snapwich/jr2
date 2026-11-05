// The three Source forms and the Pool of runs (ADR-0017), through a real RunHost and an in-memory
// store: a push Source and its held items, `hold` and the 429, the key check before the hold, a
// read Source's merged read, its latch and the store's key check, a restore with live runs and held
// items, the key of each run and the load refusals.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { gitlab } from "@jr2/hooks/gitlab";
import type {} from "@jr2/hooks/gitlab";
import { dispatch } from "../src/dispatch-effect.ts";
import { hookDoor } from "../src/hooks.ts";
import { secret } from "../src/http-effect.ts";
import { carry, isStandingPool, pool, reread, skip, source, type PoolNextInput } from "../src/pool.ts";
import { observe, RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import type { SourceVerdictLine } from "../src/registration.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

// --- The callees: a door, a Gate that ends the run, an output -----------------------------------------

const finish = defineEvent({ name: "finish", input: z.object({}) });

function callee(id: string, door: z.ZodObject) {
  return jr2Setup({ types: {} as { context: { body: unknown } }, events: [finish] }).createMachine({
    id,
    input: door,
    context: ({ input }) => ({ body: input }),
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "ctl" }, on: { finish: "done" } },
      done: { type: "final" },
    },
    output: ({ context }) => context.body,
  });
}
const triageDoor = z.object({ sha: z.string() });
const triage = callee("triage", triageDoor);
const ticket = callee("ticket", z.object({ number: z.number() }));

// --- The Pools -----------------------------------------------------------------------------------------

const alert = z.object({ sha: z.string(), status: z.string() });

/** A push Source: GitLab's failed pipeline carries an alert. */
function alertsPool(cap = 2, hold?: number) {
  return pool(dispatch("triage", { input: triageDoor, wait: true }), {
    id: "alerts",
    standing: true,
    source: source({
      item: alert,
      ...(hold !== undefined ? { hold } : {}),
      hooks: {
        gitlab: {
          "pipeline.failed": ({ payload }) =>
            payload.object_attributes.sha.startsWith("skip")
              ? skip(`sha ${payload.object_attributes.sha} is not for this Pool`)
              : carry({ sha: payload.object_attributes.sha, status: payload.object_attributes.status }),
        },
      },
    }),
    itemId: (a) => `alert-${a.sha}`,
    cap,
    itemInput: (a) => ({ sha: a.sha }),
  });
}

/** A read Source over a list that the test holds. `gate` holds each read until the test lets it go. */
function issuesPool(api: { issues: number[]; reads: number; gate?: Promise<void> }, cap = 2) {
  return pool(dispatch("ticket", { input: z.object({ number: z.number() }), wait: true }), {
    id: "issues",
    standing: true,
    source: source<{ number: number }>({
      read: fromPromise(async () => {
        api.reads++;
        await api.gate;
        return api.issues.map((n) => ({ number: n }));
      }),
      hooks: { gitlab: { "note.MergeRequest": () => reread() } },
    }),
    itemId: (i: { number: number }) => `issue-${i.number}`,
    cap,
  });
}

const def = (name: string, machine: unknown): WorkflowDef => ({ name, machine: machine as never, provide: () => ({}) });

const hosts: RunHost[] = [];
after(async () => {
  for (const host of hosts) for (const s of host.list()) await host.stop(s.runId);
});

function hostWith(store: SnapshotStore, defs: WorkflowDef[]): RunHost {
  const host = new RunHost({ store });
  hosts.push(host);
  for (const d of defs) host.register(d);
  return host;
}

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
}

type Ctx = { held: Array<{ key: string }>; active: string[]; items: Record<string, { status: string }> };
const liveOf = (host: RunHost, workflow: string) => host.list().filter((s) => s.workflow === workflow);
const ctxOf = (host: RunHost, runId: string) => host.status(runId)!.context as Ctx;
const keyOf = (host: RunHost, runId: string) => host.status(runId)?.dispatchedBy?.key;
const keys = (host: RunHost, workflow: string) =>
  liveOf(host, workflow)
    .map((s) => keyOf(host, s.runId))
    .sort();

const pipeline = (delivery: string, sha: string) => ({
  hook: "gl",
  kind: "gitlab",
  key: "pipeline.failed",
  delivery,
  payload: { object_attributes: { sha, status: "failed" } },
  caller: { via: "hook" as const, name: "gl", onBehalfOf: "ann" },
  may: () => true,
});
const verdicts = (lines: SourceVerdictLine[]) => lines.map((l) => [l.verdict, l.key]);

/** Every run of `workflow` the store holds, in any status, with its key. */
function allRuns(store: SnapshotStore, workflow: string): Array<{ runId: string; key: string }> {
  const db = (store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): unknown[] } } }).db;
  return db
    .prepare(`SELECT run_id, dispatch_effect FROM machine_snapshots WHERE dispatch_workflow = ?`)
    .all(workflow)
    .map((r) => ({ runId: (r as { run_id: string }).run_id, key: (r as { dispatch_effect: string }).dispatch_effect }));
}

// --- 1. The push Source ---------------------------------------------------------------------------------

test("push: a carried item is held and claimed under cap, one run per key, and a held key, a live key and a skip start nothing", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool(2)), def("triage", triage)]);
  const { runId: pool } = await host.start("alerts");

  const first = await host.deliverHook(pipeline("d1", "a1"));
  assert.deepEqual(verdicts(first.sources), [["held", "alert-a1"]]);
  assert.equal(first.sources[0]!.pool, pool);
  assert.equal(first.sources[0]!.workflow, "alerts");
  assert.equal(first.sources[0]!.source, "source");
  await host.deliverHook(pipeline("d2", "a2"));
  await host.deliverHook(pipeline("d3", "a3"));
  await until(() => liveOf(host, "triage").length === 2, "two triage runs (cap 2)");
  assert.deepEqual(keys(host, "triage"), ["alert-a1", "alert-a2"]);
  assert.deepEqual(
    ctxOf(host, pool).held.map((h) => h.key),
    ["alert-a3"],
    "the third is held",
  );

  // The key check before the hold: a held key, then a key whose run is live.
  assert.deepEqual(verdicts((await host.deliverHook(pipeline("d4", "a3"))).sources), [["existing", "alert-a3"]]);
  const live = (await host.deliverHook(pipeline("d5", "a1"))).sources[0]!;
  assert.equal(live.verdict, "existing");
  assert.equal(live.run, liveOf(host, "triage").find((s) => keyOf(host, s.runId) === "alert-a1")!.runId);
  const skipped = (await host.deliverHook(pipeline("d6", "skip-1"))).sources[0]!;
  assert.deepEqual([skipped.verdict, skipped.reason], ["skipped", "sha skip-1 is not for this Pool"]);

  // A run that ends frees its slot: the held item starts, and the Pool records the run's status.
  const a1 = liveOf(host, "triage").find((s) => keyOf(host, s.runId) === "alert-a1")!.runId;
  host.sendToGate(a1, "ctl", { type: "finish" });
  await until(() => keys(host, "triage").join() === "alert-a2,alert-a3", "a3 starts in a1's slot");
  assert.deepEqual(ctxOf(host, pool).held, []);
  assert.equal(ctxOf(host, pool).items["alert-a1"]!.status, "done");
  // The run's record names the key and the delivery; the open band names neither.
  const a3 = liveOf(host, "triage").find((s) => keyOf(host, s.runId) === "alert-a3")!;
  assert.deepEqual(host.status(a3.runId)!.dispatchedBy!.hook, { name: "gl", delivery: "d3", onBehalfOf: "ann" });
  const seen = observe(host.status(a3.runId)!).dispatchedBy as Record<string, unknown>;
  assert.equal(seen.key, undefined);
  assert.equal(seen.hook, undefined);
  assert.deepEqual(
    allRuns(store, "triage")
      .map((r) => r.key)
      .sort(),
    ["alert-a1", "alert-a2", "alert-a3"],
    "one run per key",
  );
  // A Pool of runs stands: it is still live, with nothing to do.
  assert.equal(host.status(pool)?.status, "active");
});

test("push: a held item is in the saved blob before the verdict is answered", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool(1)), def("triage", triage)]);
  const { runId: pool } = await host.start("alerts");
  await host.deliverHook(pipeline("d1", "b1"));
  const fan = await host.deliverHook(pipeline("d2", "b2"));
  assert.equal(fan.sources[0]!.verdict, "held");
  // No tick between the answer and the read: the save happened before the answer.
  const blob = (await store.load(pool))!.snapshot as { snapshot: { context: Ctx } };
  assert.deepEqual(
    blob.snapshot.context.held.map((h) => h.key),
    ["alert-b2"],
  );
});

test("push: above `hold` the verdict is hold-full and the door answers 429 without claiming the delivery's id", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool(1, 1)), def("triage", triage)]);
  const { runId: pool } = await host.start("alerts");
  const token = "glpat-hook";
  const door = hookDoor({
    host,
    store,
    hooks: () => ({ gl: gitlab({ secret: secret("GL") }) }),
    digests: () => ({ GL: createHash("sha256").update(token).digest("hex") }),
  });
  const send = (id: string, sha: string) =>
    door.deliver(
      "gl",
      new Headers({ "x-gitlab-token": token, "idempotency-key": id, "content-type": "application/json" }),
      new TextEncoder().encode(
        JSON.stringify({
          object_kind: "pipeline",
          object_attributes: { sha, status: "failed" },
          user: { username: "u" },
        }),
      ),
    );
  assert.equal((await send("g1", "c1")).status, 200); // runs
  assert.equal((await send("g2", "c2")).status, 200); // held
  const full = await send("g3", "c3");
  assert.equal(full.status, 429);
  assert.deepEqual(verdicts((full.body as { sources: SourceVerdictLine[] }).sources), [["hold-full", "alert-c3"]]);
  assert.deepEqual(
    ctxOf(host, pool).held.map((h) => h.key),
    ["alert-c2"],
  );
  // The service sends it again once a slot is free: it is heard, not `seen`.
  const c1 = liveOf(host, "triage")[0]!.runId;
  host.sendToGate(c1, "ctl", { type: "finish" });
  await until(() => ctxOf(host, pool).held.length === 0, "c2 leaves the held items");
  const again = await send("g3", "c3");
  assert.equal(again.status, 200);
  assert.equal((again.body as { seen: boolean }).seen, false);
  assert.deepEqual(verdicts((again.body as { sources: SourceVerdictLine[] }).sources), [["held", "alert-c3"]]);
  assert.deepEqual(
    door.log("gl", 10).lines.map((l) => [l.kind, l.status]),
    [
      ["delivered", 200],
      ["hold-full", 429],
      ["delivered", 200],
      ["delivered", 200],
    ],
  );
});

test("push: a restore keeps the held items and the live runs, and starts nothing twice", async () => {
  const store = await mkStore();
  const host = hostWith(store, [def("alerts", alertsPool(2)), def("triage", triage)]);
  const { runId: pool } = await host.start("alerts");
  for (const sha of ["r1", "r2", "r3", "r4"]) await host.deliverHook(pipeline(`d-${sha}`, sha));
  await until(() => liveOf(host, "triage").length === 2, "two runs");
  const before = liveOf(host, "triage")
    .map((s) => s.runId)
    .sort();
  for (const s of host.list()) await host.stop(s.runId);

  const second = hostWith(store, [def("alerts", alertsPool(2)), def("triage", triage)]);
  const restored = await second.restore();
  assert.equal(restored.reattached.length, 3);
  assert.deepEqual(
    ctxOf(second, pool).held.map((h) => h.key),
    ["alert-r3", "alert-r4"],
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    liveOf(second, "triage")
      .map((s) => s.runId)
      .sort(),
    before,
    "the same runs",
  );
  // The waits follow their runs after the restore: an end frees a slot, and a held item starts.
  second.sendToGate(before[0]!, "ctl", { type: "finish" });
  await until(() => ctxOf(second, pool).held.length === 1, "r3 starts");
  assert.equal(allRuns(store, "triage").length, 3);
});

// --- 2. The read Source ---------------------------------------------------------------------------------

test("read: one read claims every free slot, a reread during a read reads once more, and the store's key check keeps an ended item from a second run", async () => {
  const store = await mkStore();
  let release!: () => void;
  const api = { issues: [] as number[], reads: 0, gate: undefined as Promise<void> | undefined };
  const host = hostWith(store, [def("issues", issuesPool(api, 2)), def("ticket", ticket)]);
  const { runId: pool } = await host.start("issues");
  await until(() => api.reads === 1 && host.status(pool)?.value === "parked", "the first read, empty");

  // Hold the next read open, ask for two rereads during it: one more read follows, not two.
  api.gate = new Promise<void>((r) => (release = r));
  api.issues.push(11, 12, 13);
  const note = { ...pipeline("n1", "x"), key: "note.MergeRequest", payload: {} };
  assert.deepEqual(verdicts((await host.deliverHook(note)).sources), [["reread", undefined]]);
  await until(() => api.reads === 2, "the second read starts");
  await host.deliverHook({ ...note, delivery: "n2" });
  await host.deliverHook({ ...note, delivery: "n3" });
  api.gate = undefined;
  release();
  await until(() => api.reads === 3 && host.status(pool)?.value === "parked", "one read after the latch");
  assert.deepEqual(keys(host, "ticket"), ["issue-11", "issue-12"], "the read claims both free slots");

  // 11 ends; the read after the settle finds 11 still listed, and the store says it ran.
  const r11 = liveOf(host, "ticket").find((s) => keyOf(host, s.runId) === "issue-11")!.runId;
  host.sendToGate(r11, "ctl", { type: "finish" });
  await until(() => keys(host, "ticket").join() === "issue-12,issue-13", "13 takes 11's slot");
  await host.deliverHook({ ...note, delivery: "n4" });
  await until(() => host.status(pool)?.value === "parked", "parked again");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    allRuns(store, "ticket")
      .map((r) => r.key)
      .sort(),
    ["issue-11", "issue-12", "issue-13"],
  );
});

test("read: an item whose start the callee's door refuses settles once and is not claimed again by the read its settle starts", async () => {
  const store = await mkStore();
  const api = { reads: 0 };
  const refusing = pool(dispatch("ticket", { wait: true }), {
    id: "issues",
    standing: true,
    source: source<{ number: number | null }>({
      read: fromPromise(async () => {
        api.reads++;
        return [{ number: null }, { number: 2 }];
      }),
    }),
    itemId: (i: { number: number | null }) => `issue-${i.number ?? "none"}`,
    cap: 2,
    itemInput: (i: { number: number | null }) => ({ number: i.number }) as never,
  });
  const host = hostWith(store, [def("issues", refusing), def("ticket", ticket)]);
  const { runId: issues } = await host.start("issues");
  await until(
    () => ctxOf(host, issues).items["issue-none"] !== undefined && host.status(issues)?.value === "parked",
    "the refused item settles and the Pool parks",
  );
  // A timer in the same process fires: the loop does not hold the event loop.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctxOf(host, issues).items["issue-none"]!.status, "start-refused");
  assert.ok(api.reads <= 2, `one read, and one after the refused item's settle: ${api.reads}`);
  assert.equal(host.status(issues)?.value, "parked");
  assert.deepEqual(keys(host, "ticket"), ["issue-2"], "the valid item runs");
  assert.deepEqual(
    allRuns(store, "ticket").map((r) => r.key),
    ["issue-2"],
  );
});

test("a Pool of child Machines reads too: a read Source drains, and a Hook's reread() reaches a pull Source", async () => {
  const done = defineEvent({ name: "done", input: z.object({}) });
  const worker = jr2Setup({ types: {} as { input: { n: number } } }).createMachine({
    id: "w",
    initial: "go",
    states: { go: { after: { 1: "end" } }, end: { type: "final" } },
    output: ({ self }) => ({ id: self.id }),
  });
  const list = [1, 2, 3];
  const read = pool(worker, {
    id: "reader",
    source: source<{ n: number }>({ read: fromPromise(async () => list.map((n) => ({ n }))) }),
    itemId: (i: { n: number }) => `n-${i.n}`,
    cap: 2,
    failures: "report",
  });
  const store = await mkStore();
  const host = hostWith(store, [def("reader", read)]);
  const { runId } = await host.start("reader");
  await until(() => host.status(runId) === undefined, "the read Pool drains");
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done");
  assert.deepEqual(Object.keys((final.context as { items: object }).items).sort(), ["n-1", "n-2", "n-3"]);

  // A pull Source hears a Hook: reread() asks `next` again while workers run.
  const asks: number[] = [];
  let ready: Array<{ n: number }> = [];
  const gated = jr2Setup({ types: {} as { input: { n: number } }, events: [done] }).createMachine({
    id: "g",
    initial: "wait",
    states: { wait: { invoke: { src: "gate", id: "hold" }, on: { done: "end" } }, end: { type: "final" } },
  });
  const pull = pool(gated, {
    id: "puller",
    source: source<{ n: number }>({
      next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
        asks.push(input.active.length);
        return ready.shift() ?? null;
      }),
      hooks: { gitlab: { "note.MergeRequest": () => reread() } },
    }),
    itemId: (i: { n: number }) => `p-${i.n}`,
    cap: 3,
  });
  host.register(def("puller", pull));
  ready = [{ n: 1 }];
  const { runId: p } = await host.start("puller");
  await until(() => host.status(p)?.value === "parked", "one worker, parked");
  ready = [{ n: 2 }];
  const fan = await host.deliverHook({ ...pipeline("p1", "x"), key: "note.MergeRequest", payload: {} });
  assert.deepEqual(verdicts(fan.sources), [["reread", undefined]]);
  await until(() => (host.status(p)?.context as Ctx).active.length === 2, "the reread claims p-2");
});

// --- 3. The feed and the refusals -----------------------------------------------------------------------

test("a Pool of runs marks each start and each end on its feed, and a refused start is one item's end", async () => {
  const store = await mkStore();
  const strict = pool(dispatch("triage", { wait: true }), {
    id: "alerts",
    standing: true,
    source: source({
      item: alert,
      hooks: {
        gitlab: { "pipeline.failed": ({ payload }) => carry({ sha: payload.object_attributes.sha, status: "x" }) },
      },
    }),
    itemId: (a) => `alert-${a.sha}`,
    cap: 1,
    // The callee's door wants a sha; this body has none, so the door refuses each start.
    itemInput: () => ({ nope: true }),
  });
  const host = hostWith(store, [def("alerts", strict), def("triage", triage)]);
  const { runId } = await host.start("alerts");
  const marks: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => {
    if (e.kind === "pool") marks.push(e);
  });
  await host.deliverHook(pipeline("d1", "z1"));
  await until(() => marks.length === 2, "started and settled");
  assert.deepEqual(
    marks.map((m) => [(m as { mark: string }).mark, (m as { key: string }).key, (m as { status?: string }).status]),
    [
      ["started", "alert-z1", undefined],
      ["settled", "alert-z1", "start-refused"],
    ],
  );
  assert.equal(host.status(runId)?.status, "active", "the Pool goes on");
});

test("pool() refuses what a Pool cannot run, naming the fix", () => {
  const triageSlot = dispatch("triage", { wait: true });
  const push = source({ item: alert, hooks: { gitlab: { "pipeline.failed": () => skip("no") } } });
  const pull = source<{ id: string }>({ next: fromPromise(async () => null) });
  const child = callee("c", z.object({}));
  const base = { itemId: (a: { sha: string }) => a.sha, cap: 1 };
  const refuses = (fn: () => unknown, text: RegExp) => assert.throws(fn, text);
  // A bare Workflow name.
  refuses(() => pool("triage" as never, { ...base, source: pull } as never), /never|dispatch\("triage"/);
  // A Pool of runs that does not stand.
  refuses(() => pool(triageSlot, { ...base, source: push } as never), /standing: true/);
  // No `wait: true`, a `target`, no `cap`.
  refuses(() => pool(dispatch("triage"), { ...base, standing: true, source: push } as never), /wait: true/);
  refuses(
    () =>
      pool(dispatch("triage", { wait: true, target: { url: "https://ops.example.com", token: secret("OPS") } }), {
        ...base,
        standing: true,
        source: push,
      } as never),
    /target/,
  );
  refuses(() => pool(triageSlot, { itemId: base.itemId, standing: true, source: push } as never), /cap/);
  // `standing: true` on a Pool of children; a push Source on a Pool that drains.
  refuses(() => pool(child, { ...base, standing: true, source: pull } as never), /child Machine cannot be handed over/);
  refuses(() => pool(child, { ...base, source: push } as never), /push Source needs a standing Pool/);
  // A Source with two forms.
  refuses(() => pool(child, { ...base, source: { next: pull.next, read: pull.next } } as never), /exactly one of/);
  // A read that is not idempotent, or not a read at all.
  refuses(() => pool(child, { ...base, source: { read: dispatch("triage") } } as never), /read/);
  // A handler keyed with `*`: the door matches an event key exactly (ADR-0011).
  refuses(
    () =>
      pool(triageSlot, {
        ...base,
        standing: true,
        source: { item: alert, hooks: { slack: { "block_actions.*": () => skip("no") } } },
      } as never),
    /its source: hooks\.slack\["block_actions\.\*"\] holds "\*".*name the full key/,
  );
  // What passes is marked standing, for the load walk.
  assert.equal(isStandingPool(alertsPool()), true);
  assert.equal(isStandingPool(pool(child, { ...base, source: pull })), false);
});

test("the load walk refuses a standing Pool that is not the top Machine of its Workflow", async () => {
  const { standingPoolRefusals } = await import("../src/assembly-checks.ts");
  const standing = alertsPool();
  const outer = jr2Setup({ actors: { alerts: standing } }).createMachine({
    id: "outer",
    initial: "on",
    states: { on: { invoke: { src: "alerts", input: {} } } },
  });
  assert.deepEqual(standingPoolRefusals([{ name: "alerts", machine: standing }]), []);
  const lines = standingPoolRefusals([{ name: "outer", machine: outer }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /workflow "outer": machine "outer" composes the standing Pool "alerts"/);
  assert.match(lines[0]!, /a file of its own in workflows\//);
});
