// A push's pair and its sync across pushes (ADR-0067): the pair is the ledger's last push
// of the SAME Workspace and Repo Slot, a sync that did not finish runs again before the next push
// of that slot — from the bundle its row keeps until a sync finishes — and a signed push that
// published nothing new still syncs. D1 for the Sandbox kinds. In-process, socket-free (ADR-0010).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { dropSavedTails, pushPairsOf, type EffectLogic, type EffectRow } from "../src/effect.ts";
import { createEffectorClient, type PushStartRequest } from "../src/effector-wire.ts";
import { RunHost, type RunFeedEvent } from "../src/run-host.ts";
import { lastPushOf, pushWith } from "../src/sandbox-effect.ts";
import type { SyncPortFactory } from "../src/sync-client.ts";
import type { SyncAnswer, SyncRequest } from "../src/wire.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { fakeWorkspace, handles } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({}) });
const next = defineEvent({ name: "next", input: z.object({}) });
const leave = defineEvent({ name: "leave", input: z.object({}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffect = EffectLogic<any, unknown>;
type Ctx = Record<string, unknown>;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const target = { effector: () => ({ placement: "sandbox" as const, service: "ws-1:8082", key: EFFECTOR_KEY }) };
const port = (fake: FakeEffector) => () => createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });

/** The Workspace's Harness sync, in-process: each call, and the answers in turn. */
class FakeSync {
  readonly calls: SyncRequest[] = [];
  answers: SyncAnswer[] = [];
  factory: SyncPortFactory = () => ({
    sync: async (req) => {
      this.calls.push(req);
      return this.answers.shift() ?? { sync: "already" };
    },
  });
}

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};

/**
 * A Machine that runs the slots named in `order`, one state each, with a Gate between them, so the
 * save that carries each push's transition is on disk before the next push starts.
 */
function pushes(repos: Record<string, string>, effects: Record<string, AnyEffect>, order: string[]): AnyStateMachine {
  const states: Record<string, unknown> = {
    waiting: { invoke: { src: "gate", id: "start" }, on: { go: "s0" } },
    done: {},
  };
  order.forEach((slot, i) => {
    states[`s${i}`] = {
      invoke: { src: slot, onDone: { target: `g${i}`, actions: assign({ [`out${i}`]: ({ event }) => event.output }) } },
    };
    states[`g${i}`] = {
      invoke: { src: "gate", id: `g${i}` },
      on: { next: i + 1 < order.length ? `s${i + 1}` : "done" },
    };
  });
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [go, next],
    actors: {
      ws: fakeWorkspace({
        ...handles(repos),
        bindings: Object.fromEntries(Object.keys(repos).map((r) => [r, `https://github.com/ourorg/${r}.git`])),
      }),
      ...effects,
    },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "waiting",
    states,
  } as never) as unknown as AnyStateMachine;
}

async function run(machine: AnyStateMachine) {
  const store = await mkStore();
  const host = new RunHost({ store, ...target });
  host.register({ name: "fx", machine, provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  return { host, store, runId };
}

/** Wait for an async condition (a ledger read), polling. */
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("the condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ctxOf = (host: RunHost, runId: string) => host.status(runId)?.context as Ctx;

test("two Repo Slots: each push's pair and its sync re-run are its own slot's, never the other slot's", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const repos = { app: "/work/app/jr2-run-1", lib: "/work/lib/jr2-run-1" };
  const app = pushWith(port(fake), { sign: true, slot: "app" }, syncs.factory) as AnyEffect;
  const lib = pushWith(port(fake), { sign: true, slot: "lib" }, syncs.factory) as AnyEffect;
  const rig = await run(pushes(repos, { app, lib }, ["app", "lib", "app"]));

  // app's push; its sync answers busy.
  await waitFor(() => fake.starts.length === 1);
  syncs.answers.push({ sync: "busy", reason: "a rebase of your branch is in progress" });
  fake.settle({ outcome: "pushed", published: B, source: A, via: "ancestry", bundle: "QVBQ" });
  await waitFor(() => ctxOf(rig.host, rig.runId)?.out0 !== undefined);
  rig.host.sendToGate(rig.runId, "g0", { type: "next" });

  // lib's push: no pair of app's push, and app's unfinished sync is not run in lib's Worktree.
  await waitFor(() => fake.starts.length === 2);
  const second = fake.starts[1]!.req as PushStartRequest;
  assert.equal(second.push.url, "https://github.com/ourorg/lib.git");
  assert.equal(second.push.pairs, undefined, "lib's push names no pair of app's push");
  assert.deepEqual(
    syncs.calls.map((c) => c.worktree),
    ["/work/app/jr2-run-1"],
    "nothing ran in lib's Worktree before lib's push",
  );
  fake.settle({ outcome: "pushed", published: C, source: C });
  await waitFor(() => ctxOf(rig.host, rig.runId)?.out1 !== undefined);
  rig.host.sendToGate(rig.runId, "g1", { type: "next" });

  // app's next push: app's pair, and app's sync run again in app's Worktree, with its bundle.
  await waitFor(() => fake.starts.length === 3);
  const third = fake.starts[2]!.req as PushStartRequest;
  assert.deepEqual(third.push.pairs, [{ published: B, source: A }], "app's pairs alone, never lib's");
  assert.equal(syncs.calls.length, 2);
  assert.deepEqual(syncs.calls[1], {
    worktree: "/work/app/jr2-run-1",
    branch: "jr2/run-1",
    published: B,
    source: A,
    bundle: "QVBQ",
  });
  const rows = Object.values(await ledger(rig.store, rig.runId)).filter((r) => r.state === "settled");
  assert.deepEqual(rows.map((r) => (r as { repo?: string }).repo).sort(), ["app", "lib"]);
  // The third push is still followed: stop the run, so nothing polls once the test is done.
  await rig.host.stop(rig.runId);
});

test("a sync that never unbundled runs again before the next push with the bundle: the row keeps it past the save until a sync finishes", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const push = pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect;
  const rig = await run(pushes({ app: "/work/app/jr2-run-1" }, { push }, ["push", "push"]));
  await waitFor(() => fake.starts.length === 1);
  syncs.answers.push({ sync: "not-synced", reason: "the Harness could not be reached: ECONNREFUSED" });
  fake.settle({ outcome: "pushed", published: B, source: A, via: "ancestry", bundle: "QlVORExF" });
  await waitFor(() => ctxOf(rig.host, rig.runId)?.out0 !== undefined);
  // The save that carries the push's transition is on disk; the row still holds the bundle.
  await until(async () => {
    const row = Object.values(await ledger(rig.store, rig.runId)).find((r) => r.state === "settled");
    return (row as { output?: { sync?: string } } | undefined)?.output?.sync === "not-synced";
  });
  const saved = Object.values(await ledger(rig.store, rig.runId)).find((r) => r.state === "settled") as {
    output: Record<string, unknown>;
  };
  assert.equal(saved.output.bundle, "QlVORExF", "an unfinished sync's bundle is not a tail");
  rig.host.sendToGate(rig.runId, "g0", { type: "next" });
  await waitFor(() => fake.starts.length === 2);
  assert.equal(syncs.calls.length, 2);
  assert.equal(syncs.calls[1]!.bundle, "QlVORExF", "the re-run carries the bundle");
  fake.settle({ outcome: "pushed", published: C, source: C });
  await waitFor(() => ctxOf(rig.host, rig.runId)?.out1 !== undefined);
  rig.host.sendToGate(rig.runId, "g1", { type: "next" });
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  // The re-run answered `already`: the next save drops the bundle.
  await until(async () =>
    Object.values(await ledger(rig.store, rig.runId)).every(
      (r) => r.state !== "settled" || !("bundle" in (r.output as object)),
    ),
  );
});

test("the tail rule for a push: the bundle stays while the sync is busy or not-synced, and goes once a sync finished; the pair and its `squashed` stay whole", () => {
  // Each row is the newest push of its own Repo Slot.
  const row = (sync: string): EffectRow => ({
    state: "settled",
    kind: "push",
    slot: "publish",
    sandbox: "ws-1",
    repo: `app-${sync}`,
    output: {
      outcome: "pushed",
      published: B,
      source: A,
      squashed: "signed",
      bundle: "QlVORExF",
      detail: "git said",
      sync,
    },
    at: "t",
  });
  const effects: Record<string, EffectRow> = {
    busy: row("busy"),
    not: row("not-synced"),
    synced: row("synced"),
    already: row("already"),
  };
  dropSavedTails(effects, {});
  const out = (id: string) => (effects[id] as { output: Record<string, unknown> }).output;
  assert.equal(out("busy").bundle, "QlVORExF");
  assert.equal(out("not").bundle, "QlVORExF");
  assert.equal("bundle" in out("synced"), false);
  assert.equal("bundle" in out("already"), false);
  for (const id of Object.keys(effects)) {
    assert.equal("detail" in out(id), false, "git's words are a tail");
    assert.equal(out(id).published, B, "the pair stays whole");
    assert.equal(out(id).source, A, "the pair stays whole");
    assert.equal(out(id).squashed, "signed", "the pair stays whole");
    assert.equal(out(id).sync !== undefined, true, "the sync's answer stays");
  }
  // Every later push of the Repo Slot sends the saved row as one of its pairs.
  assert.deepEqual(pushPairsOf(effects, "ws-1", "app-synced"), [{ published: B, source: A, squashed: "signed" }]);
});

test("only the newest push of a Repo Slot keeps its bundle: three pushes whose syncs never finish leave one bundle in the saved ledger", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const push = pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect;
  const rig = await run(pushes({ app: "/work/app/jr2-run-1" }, { push }, ["push", "push", "push"]));
  const tips = [B, C, "d".repeat(40)];
  for (let i = 0; i < 3; i++) {
    await waitFor(() => fake.starts.length === i + 1);
    // This push's own sync, and (from the second on) the re-run before it, never finish.
    syncs.answers = [
      { sync: "not-synced", reason: "the Harness could not be reached: ECONNREFUSED" },
      { sync: "not-synced", reason: "the Harness could not be reached: ECONNREFUSED" },
    ];
    fake.settle({ outcome: "pushed", published: tips[i]!, source: A, via: "ancestry", bundle: `QlVORExF${i}` });
    await waitFor(() => ctxOf(rig.host, rig.runId)?.[`out${i}`] !== undefined);
    rig.host.sendToGate(rig.runId, `g${i}`, { type: "next" });
  }
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  // The saves after the run's last transition are on disk: one bundle, the newest push's.
  let bundles: unknown[] = [];
  await until(async () => {
    const rows = Object.values(await ledger(rig.store, rig.runId));
    bundles = rows
      .map((r) => (r.state === "settled" ? (r.output as { bundle?: unknown }).bundle : undefined))
      .filter((b) => b !== undefined);
    return rows.filter((r) => r.state === "settled").length === 3 && bundles.length === 1;
  });
  assert.deepEqual(bundles, ["QlVORExF2"], "the newest push's bundle, and no older one");
});

test("the tail rule: a push row's bundle goes once a newer push of its Repo Slot published, kept for another slot", () => {
  const row = (repo: string, at: string, bundle: string): EffectRow => ({
    state: "settled",
    kind: "push",
    slot: "publish",
    sandbox: "ws-1",
    repo,
    output: { outcome: "pushed", published: B, source: A, bundle, sync: "not-synced" },
    at,
  });
  const effects: Record<string, EffectRow> = {
    old: row("app", "2026-10-10T00:00:01Z", "b1"),
    mid: row("app", "2026-10-10T00:00:02Z", "b2"),
    // A newer push that did not publish is not the pair: the one before it stays the newest.
    rejected: {
      ...row("app", "2026-10-10T00:00:03Z", "x"),
      output: { outcome: "rejected", reason: "no" },
    } as EffectRow,
    lib: row("lib", "2026-10-10T00:00:00Z", "b3"),
  };
  dropSavedTails(effects, {});
  const bundle = (id: string) => (effects[id] as { output: Record<string, unknown> }).output.bundle;
  assert.equal(bundle("old"), undefined);
  assert.equal(bundle("mid"), "b2");
  assert.equal(bundle("lib"), "b3");
});

test("a signed push that published nothing new (the pair mapped the published tip) still syncs, and is never `skipped`", async () => {
  for (const bundle of ["QlVORExF", undefined]) {
    const fake = new FakeEffector(["sandbox"]);
    const syncs = new FakeSync();
    syncs.answers.push({ sync: "synced", from: A, to: B, replayed: 0, tries: 1 });
    const push = pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect;
    const rig = await run(pushes({ app: "/work/app/jr2-run-1" }, { push }, ["push"]));
    await waitFor(() => fake.starts.length === 1);
    fake.settle({
      outcome: "pushed",
      published: B,
      source: A,
      previous: B,
      via: "pair",
      unchanged: true,
      ...(bundle ? { bundle } : {}),
    });
    await waitFor(() => ctxOf(rig.host, rig.runId)?.out0 !== undefined);
    const out = ctxOf(rig.host, rig.runId).out0 as Record<string, unknown>;
    assert.equal(out.sync, "synced", `bundle ${bundle}`);
    assert.equal(syncs.calls.length, 1);
    assert.equal(syncs.calls[0]!.bundle, bundle);
    await rig.host.stop(rig.runId);
  }
});

test("the pair is the last push of the same Workspace AND Repo Slot that published", () => {
  const row = (sandbox: string, repo: string, at: string, output: Record<string, unknown>): EffectRow => ({
    state: "settled",
    kind: "push",
    slot: "publish",
    sandbox,
    repo,
    output,
    at,
  });
  const ok = (p: string) => ({ outcome: "pushed", published: p.repeat(40), source: "0".repeat(40) });
  const rows: Record<string, EffectRow> = {
    a: row("ws-1", "app", "2026-01-01T00:00:01Z", ok("1")),
    b: row("ws-1", "lib", "2026-01-01T00:00:02Z", ok("2")),
    c: row("ws-2", "app", "2026-01-01T00:00:03Z", ok("3")),
  };
  assert.equal(lastPushOf(rows, "ws-1", "app", "self")?.output.published, "1".repeat(40));
  assert.equal(lastPushOf(rows, "ws-1", "lib", "self")?.output.published, "2".repeat(40));
  assert.equal(lastPushOf(rows, "ws-2", "lib", "self"), undefined);
});

test("only `pushed` rows give pairs, oldest first: a diverged row's published commit is the remote's, never a copy of its source", () => {
  const row = (at: string, output: Record<string, unknown>, sandbox = "ws-1"): EffectRow => ({
    state: "settled",
    kind: "push",
    slot: "publish",
    sandbox,
    repo: "app",
    output,
    at,
  });
  const sha = (c: string) => c.repeat(40);
  const rows: Record<string, EffectRow> = {
    // Written out of order: the pairs are sorted by `at`, not by the ledger's keys.
    late: row("2026-01-01T00:00:05Z", { outcome: "pushed", published: sha("5"), source: sha("e"), squashed: "signed" }),
    early: row("2026-01-01T00:00:01Z", { outcome: "pushed", published: sha("1"), source: sha("a") }),
    diverged: row("2026-01-01T00:00:02Z", {
      outcome: "diverged",
      reason: "the published commit is not in the history of the Agent's tip",
      published: sha("2"),
      source: sha("b"),
    }),
    rejected: row("2026-01-01T00:00:03Z", {
      outcome: "rejected",
      reason: "non-fast-forward",
      published: sha("3"),
      source: sha("c"),
    }),
    unknown: row("2026-01-01T00:00:04Z", { outcome: "unknown", published: sha("4"), source: sha("d") }),
    other: row("2026-01-01T00:00:06Z", { outcome: "pushed", published: sha("6"), source: sha("f") }, "ws-2"),
    self: row("2026-01-01T00:00:07Z", { outcome: "pushed", published: sha("7"), source: sha("7") }),
  };
  assert.deepEqual(pushPairsOf(rows, "ws-1", "app", "self"), [
    { published: sha("1"), source: sha("a") },
    { published: sha("5"), source: sha("e"), squashed: "signed" },
  ]);
});

test("D1 for the Sandbox kinds: its state exits while it runs — polling stops, the ledger and the feed say `outcome unknown`", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const push = pushWith(port(fake), { sign: true }, new FakeSync().factory) as AnyEffect;
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [go, leave],
    actors: {
      ws: fakeWorkspace({ ...handles({ app: "/work/app/jr2-run-1" }), bindings: { app: "https://x.example/app.git" } }),
      push,
    },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "start" }, on: { go: "pushing" } },
      pushing: {
        invoke: [
          { src: "push", onDone: "done" },
          { src: "gate", id: "ctl" },
        ],
        on: { leave: "left" },
      },
      done: {},
      left: {},
    },
  });
  const rig = await run(machine as unknown as AnyStateMachine);
  const feed: RunFeedEvent[] = [];
  rig.host.subscribe(rig.runId, (ev) => feed.push(ev));
  await waitFor(() => fake.starts.length === 1);
  await until(async () => Object.values(await ledger(rig.store, rig.runId)).some((r) => "pinned" in r));
  rig.host.sendToGate(rig.runId, "ctl", { type: "leave" });
  await waitFor(() => rig.host.status(rig.runId)?.value === "left");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    Object.values(await ledger(rig.store, rig.runId)).map((r) => r.state),
    ["aborted"],
    "the abort is saved with the transition that exited the state",
  );
  const aborted = feed.find((e) => e.kind === "effect" && e.stage === "aborted") as { text: string } | undefined;
  assert.match(aborted?.text ?? "", /the Sandbox Effector may still run it; outcome unknown/);
  const calls = fake.calls.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fake.calls.length, calls, "nobody polls it any more");
  await rig.host.stop(rig.runId);
});
