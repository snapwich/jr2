// The `command` Effect (ADR-0067), through the real `jr2Setup` walk and the real `RunHost`: an actor
// slot whose output the Machine routes on, an intent row on disk before the call, D1 on state exit,
// and a restore that re-attaches by id or settles `unknown` — never a second run. A fake Harness
// exec is settled by hand; one test runs real processes through the Harness's own `Execs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { Execs } from "@jr2/harness/exec";
import {
  arg,
  commandWith,
  ExecNotSent,
  type CommandOutput,
  type EffectLogic,
  type EffectRow,
  type ExecPortFactory,
} from "../src/effect.ts";
import { RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { execsPort, fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({ filter: z.string() }) });
const leave = defineEvent({ name: "leave", input: z.object({}) });
const begin = defineEvent({ name: "begin", input: z.object({}) });

type Ctx = { filter?: string; result?: CommandOutput; fault?: string };

function machineWith(factory: ExecPortFactory, repos?: Record<string, string>, slot?: string) {
  const tests = commandWith(factory, ["pnpm", "test", "--filter", arg("filter")], {
    timeout: "90s",
    tail: 100,
    ...(slot ? { slot } : {}),
  });
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [go, leave],
    actors: { ws: fakeWorkspace(handles(repos)), tests },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: {
        invoke: { src: "gate", id: "start" },
        on: { go: { target: "running", actions: assign({ filter: ({ event }) => event.filter }) } },
      },
      running: {
        invoke: [
          {
            src: "tests",
            input: ({ context }) => ({ filter: context.filter! }),
            onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
            onError: {
              target: "faulted",
              actions: assign({ fault: ({ event }) => (event.error as Error).message }),
            },
          },
          { src: "gate", id: "ctl" },
        ],
        on: { leave: "left" },
      },
      done: {},
      left: {},
      faulted: {},
    },
  });
}

const defOf = (factory: ExecPortFactory, repos?: Record<string, string>, slot?: string): WorkflowDef => ({
  name: "fx",
  machine: machineWith(factory, repos, slot),
  provide: () => ({}),
});

type Rig = { host: RunHost; store: SnapshotStore; runId: string; feed: RunFeedEvent[] };

async function started(
  factory: ExecPortFactory,
  store?: SnapshotStore,
  repos?: Record<string, string>,
  slot?: string,
): Promise<Rig> {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s });
  host.register(defOf(factory, repos, slot));
  const { runId } = await host.start("fx");
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (ev) => feed.push(ev));
  host.sendToGate(runId, "start", { type: "go", filter: "unit; rm -rf /" });
  return { host, store: s, runId, feed };
}

/** Every ledger the store was asked to save, in order: what reached the disk, row by row. */
function savedLedgers(store: SnapshotStore): Array<Record<string, EffectRow>> {
  const saved: Array<Record<string, EffectRow>> = [];
  const save = store.save.bind(store);
  store.save = (runId, blob, status) => {
    saved.push(structuredClone((blob as { effects?: Record<string, EffectRow> }).effects ?? {}));
    return save(runId, blob, status);
  };
  return saved;
}

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};
const valueOf = (rig: Rig) => rig.host.status(rig.runId)?.value;
const contextOf = (rig: Rig) => rig.host.status(rig.runId)?.context as Ctx;

test("a command runs in its Workspace's Harness: argv filled by name, one argument each, in the one Repo Slot's Worktree", async () => {
  const fake = new FakeHarnessExec();
  const rig = await started(fake.factory);
  await waitFor(() => fake.starts.length === 1);
  const [exec] = fake.starts;
  assert.deepEqual(exec!.req, {
    argv: ["pnpm", "test", "--filter", "unit; rm -rf /"],
    cwd: "/work/app/run-1",
    timeoutMs: 90_000,
    tail: 100,
  });
  assert.equal(exec!.endpoint, "http://harness.invalid", "the Workspace's Harness");
  fake.write("ok 1\n");
  fake.settle({ outcome: "exited", code: 1, tail: "ok 1\nnot ok 2\n" });
  await waitFor(() => valueOf(rig) === "done");
  assert.deepEqual(contextOf(rig).result, { outcome: "exited", code: 1, tail: "ok 1\nnot ok 2\n" });
  // The feed carries the start, the stream, and the output.
  const lines = rig.feed.filter((e) => e.kind === "effect").map((e) => (e as { phase: string }).phase);
  assert.deepEqual(lines, ["started", "output", "settled"]);
});

test("write-ahead: the intent row is on disk, with the snapshot that holds the Effect, before the call leaves", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const seen: Array<{ row?: EffectRow; child: boolean }> = [];
  // What the store holds at the moment the call leaves: read synchronously inside `start`.
  const watching: ExecPortFactory = (endpoint, bearer) => {
    const port = fake.port(endpoint, bearer);
    return {
      ...port,
      start: async (id, req, signal) => {
        const [row] = await store.live();
        const blob = row!.snapshot as { effects?: Record<string, EffectRow>; snapshot: unknown };
        seen.push({ row: blob.effects?.[id], child: JSON.stringify(blob.snapshot).includes(id) });
        return port.start(id, req, signal);
      },
    };
  };
  const rig = await started(watching, store);
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0]!.row?.state, "intent");
  assert.ok(seen[0]!.child, "the same persist holds the Effect child and its id");
  const saved = savedLedgers(store);
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => valueOf(rig) === "done");
  assert.ok(
    saved.some((rows) => Object.values(rows).some((r) => r.state === "settled")),
    "the settled row reached the disk",
  );
  // The settled row rides the persist that carries its transition, and stays: the record of what ran.
  const blob = (await store.load(rig.runId))!.snapshot as { snapshot: { value?: unknown } };
  assert.equal(blob.snapshot.value, "done", "this persist carries the transition");
  const rows = Object.values(await ledger(store, rig.runId));
  assert.deepEqual(
    rows.map((r) => [r.state, r.slot, (r as { output?: unknown }).output]),
    [["settled", "tests", { outcome: "exited", code: 0, tail: "" }]],
    "and it holds the settled row",
  );
});

test("D1: its state exits while it runs — the exec is killed, the ledger and the feed say `outcome unknown`, the Machine hears nothing", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const saved = savedLedgers(store);
  const rig = await started(fake.factory, store);
  await waitFor(() => fake.starts.length === 1);
  rig.host.sendToGate(rig.runId, "ctl", { type: "leave" });
  await waitFor(() => fake.kills.length === 1);
  assert.equal(fake.kills[0], fake.starts[0]!.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(valueOf(rig), "left");
  assert.equal(contextOf(rig).result, undefined, "the Machine never got the abort");
  assert.deepEqual(
    saved.flatMap((rows) => Object.values(rows).map((r) => r.state)).filter((s, i, all) => s !== all[i - 1]),
    ["intent", "aborted"],
    "the abort reached the ledger on disk",
  );
  assert.deepEqual(
    Object.values(await ledger(store, rig.runId)).map((r) => r.state),
    ["aborted"],
    "and it stays there: the record that it was cut",
  );
  const aborted = rig.feed.find((e) => e.kind === "effect" && e.phase === "aborted");
  assert.match((aborted as { text: string }).text, /outcome unknown/);
});

test("D1: a cancel mid-command kills the exec, and the aborted row reaches the disk before the run is untracked", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const rig = await started(fake.factory, store);
  await waitFor(() => fake.starts.length === 1);
  await rig.host.cancel(rig.runId);
  await waitFor(() => fake.kills.length === 1);
  assert.equal(fake.kills[0], fake.starts[0]!.id);
  const stored = await store.load(rig.runId);
  assert.equal(stored?.status, "cancelled");
  assert.deepEqual(
    Object.values(await ledger(store, rig.runId)).map((r) => r.state),
    ["aborted"],
    "the cancel's final save carries the abort",
  );
});

test("park is not an exit: the exec runs on, and the restored run re-attaches by id — one run", async () => {
  const fake = new FakeHarnessExec();
  const rig = await started(fake.factory);
  await waitFor(() => fake.starts.length === 1);
  fake.write("half\n");
  await rig.host.stop(rig.runId);
  assert.deepEqual(fake.kills, [], "a park kills nothing");

  const host = new RunHost({ store: rig.store });
  host.register(defOf(fake.factory));
  const { reattached } = await host.restore();
  assert.deepEqual(reattached, [rig.runId]);
  await waitFor(() => fake.reads.filter((r) => r.offset === undefined).length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "half\nall\n" });
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(fake.starts.length, 1, "started once, across the restart");
  assert.deepEqual((host.status(rig.runId)?.context as Ctx).result, {
    outcome: "exited",
    code: 0,
    tail: "half\nall\n",
  });
});

test("restore after the Harness lost it: output `unknown`, routed by the Machine — never run again", async () => {
  const fake = new FakeHarnessExec();
  const rig = await started(fake.factory);
  await waitFor(() => fake.starts.length === 1);
  await rig.host.stop(rig.runId);
  fake.forgetAll();

  const host = new RunHost({ store: rig.store });
  host.register(defOf(fake.factory));
  await host.restore();
  await waitFor(() => host.status(rig.runId)?.value === "done");
  const result = (host.status(rig.runId)?.context as Ctx).result;
  assert.equal(result?.outcome, "unknown");
  assert.match((result as { reason: string }).reason, /not run again/);
  assert.equal(fake.starts.length, 1);
});

test("restore of a settled row whose transition was not saved: the output is delivered, nothing is called", async () => {
  const fake = new FakeHarnessExec();
  const rig = await started(fake.factory);
  await waitFor(() => fake.starts.length === 1);
  await rig.host.stop(rig.runId);
  // The settled row reached the disk; the transition it drives did not.
  const stored = (await rig.store.load(rig.runId))!.snapshot as { effects: Record<string, EffectRow> };
  const [id] = Object.keys(stored.effects);
  stored.effects[id!] = {
    ...stored.effects[id!]!,
    state: "settled",
    output: { outcome: "exited", code: 0, tail: "" },
  } as EffectRow;
  await rig.store.save(rig.runId, stored);

  const host = new RunHost({ store: rig.store });
  host.register(defOf(fake.factory));
  await host.restore();
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.reads.filter((r) => r.offset === undefined).length, 0, "not even a read");
});

test("refused outside a Workspace, and under several Repo Slots with none named: an error, never output", async () => {
  const fake = new FakeHarnessExec();
  const tests = commandWith(fake.factory, ["true"]);
  const bare = jr2Setup({ types: {} as { context: Ctx }, events: [begin], actors: { tests } }).createMachine({
    id: "bare",
    context: {},
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { begin: "running" } },
      running: {
        invoke: {
          src: "tests",
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      faulted: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "bare", machine: bare, provide: () => ({}) });
  const { runId } = await host.start("bare");
  host.sendToGate(runId, "start", { type: "begin" });
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match((host.status(runId)?.context as Ctx).fault!, /not inside a workspace\(\)/);

  const two = await started(fake.factory, undefined, { app: "/work/app/b", docs: "/work/docs/b" });
  await waitFor(() => valueOf(two) === "faulted");
  assert.match(contextOf(two).fault!, /more than one Repo Slot \(app, docs\)/);
  assert.equal(fake.starts.length, 0);

  const named = await started(fake.factory, undefined, { app: "/work/app/b", docs: "/work/docs/b" }, "docs");
  await waitFor(() => fake.starts.length === 1);
  assert.equal(fake.starts[0]!.req.cwd, "/work/docs/b");
  void named;
});

test("real processes through the Harness's own exec: a metacharacter stays inside its one argument", async () => {
  const execs = new Execs();
  const echo = commandWith(execsPort(execs), [
    process.execPath,
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    arg("filter"),
  ]);
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [go],
    actors: { ws: fakeWorkspace(handles({})), echo },
  }).createMachine({
    id: "real",
    context: {},
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: {
        invoke: { src: "gate", id: "start" },
        on: { go: { target: "running", actions: assign({ filter: ({ event }) => event.filter }) } },
      },
      running: {
        invoke: {
          src: "echo",
          input: ({ context }) => ({ filter: context.filter! }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "real", machine, provide: () => ({}) });
  const { runId } = await host.start("real");
  host.sendToGate(runId, "start", { type: "go", filter: "a; echo pwned $(id) | cat" });
  await waitFor(() => host.status(runId)?.value === "done");
  const result = (host.status(runId)?.context as Ctx).result!;
  assert.equal(result.outcome, "exited");
  assert.deepEqual(JSON.parse((result as { tail: string }).tail), ["a; echo pwned $(id) | cat"]);
});

test("the ledger keeps every row, and drops each output tail once its transition is saved: a loop does not grow the blob by its tails", async () => {
  // Each pass settles at once, with a large tail, then re-enters the state that runs it.
  const tail = "x".repeat(50_000);
  const instant: ExecPortFactory = () => ({
    start: async () => {},
    read: async () => ({
      state: "settled",
      stream: tail,
      next: tail.length,
      output: { outcome: "exited", code: 0, tail },
    }),
    kill: async () => {},
    forget: async () => {},
  });
  const loop = commandWith(instant, ["make"]);
  const machine = jr2Setup({
    types: {} as { context: { n: number } },
    events: [begin],
    actors: { ws: fakeWorkspace(handles()), loop },
  }).createMachine({
    id: "loop",
    context: { n: 0 },
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { begin: "running" } },
      running: {
        invoke: {
          src: "loop",
          onDone: [
            { guard: ({ context }) => context.n >= 4, target: "done" },
            { target: "running", reenter: true, actions: assign({ n: ({ context }) => context.n + 1 }) },
          ],
        },
      },
      done: {},
    },
  });
  const store = await mkStore();
  const saved = savedLedgers(store);
  const host = new RunHost({ store });
  host.register({ name: "loop", machine, provide: () => ({}) });
  const { runId } = await host.start("loop");
  host.sendToGate(runId, "start", { type: "begin" });
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal((host.status(runId)?.context as { n: number }).n, 4, "five passes");
  const rows = Object.values(await ledger(store, runId));
  assert.equal(rows.length, 5, "one row per pass, each by its own id");
  // Each finished row keeps its id, kind and outcome; the tail is on the feed. The last pass's row
  // still has its tail on disk: the save that carries its transition is the run's last.
  assert.deepEqual(
    rows.slice(0, 4).map((r) => [r.state, r.kind, r.slot, (r as { output?: unknown }).output]),
    Array.from({ length: 4 }, () => ["settled", "command", "loop", { outcome: "exited", code: 0 }]),
  );
  // No save carries more than one tail: the tail of the pass that settles, never the passes before.
  const tails = saved.map((rows) => Object.values(rows).filter((r) => JSON.stringify(r).includes(tail)).length);
  assert.ok(Math.max(...tails) === 1, JSON.stringify(tails));
});

test("D1 holds a fast exit through the real exec: a kill that overtakes its start keeps it from running", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-fx-"));
  const marker = join(dir, "ran");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let kills = 0;
  // The start is on the wire, held; the state exits and the kill reaches the Harness first.
  const racing: ExecPortFactory = (endpoint, bearer) => {
    const port = execsPort(execs)(endpoint, bearer);
    return {
      ...port,
      start: async (id, req, signal) => {
        await held;
        return port.start(id, req, signal);
      },
      kill: async (id) => {
        kills++;
        return port.kill(id);
      },
    };
  };
  const writes = commandWith(racing, [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
  ]);
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [begin, leave],
    actors: { ws: fakeWorkspace(handles({})), writes },
  }).createMachine({
    id: "fast",
    context: {},
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { begin: "running" } },
      running: {
        invoke: [
          { src: "writes", onDone: "done" },
          { src: "gate", id: "ctl" },
        ],
        on: { leave: "left" },
      },
      done: {},
      left: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "fast", machine, provide: () => ({}) });
  const { runId } = await host.start("fast");
  host.sendToGate(runId, "start", { type: "begin" });
  await waitFor(() => host.status(runId)?.value === "running");
  host.sendToGate(runId, "ctl", { type: "leave" });
  await waitFor(() => kills === 1);
  release();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(host.status(runId)?.value, "left");
  assert.equal(existsSync(marker), false, "the late start ran nothing");
});

test("D1: a kill lost to a transport fault is sent again until the Harness keeps it", async () => {
  const fake = new FakeHarnessExec();
  let attempts = 0;
  const flaky: ExecPortFactory = (endpoint, bearer) => {
    const port = fake.port(endpoint, bearer);
    return {
      ...port,
      kill: async (id) => {
        attempts++;
        if (attempts < 3) throw new Error("harness exec POST /exec/x/kill failed: ECONNRESET");
        return port.kill(id);
      },
    };
  };
  const rig = await started(flaky);
  await waitFor(() => fake.starts.length === 1);
  rig.host.sendToGate(rig.runId, "ctl", { type: "leave" });
  for (let i = 0; i < 40 && fake.kills.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(attempts, 3, "sent again after each fault");
  assert.deepEqual(fake.kills, [fake.starts[0]!.id], "and kept once");
  assert.equal(valueOf(rig), "left");
});

test("an Effect with no onDone settles in place: xstate keeps the done child, and the ledger keeps its settled row", async () => {
  const fake = new FakeHarnessExec();
  const lint = commandWith(fake.factory, ["pnpm", "lint"]);
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [begin, leave],
    actors: { ws: fakeWorkspace(handles()), lint },
  }).createMachine({
    id: "inplace",
    context: {},
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { begin: "linting" } },
      linting: {
        invoke: [
          { src: "lint", id: "lint" },
          { src: "gate", id: "ctl" },
        ],
        on: { leave: "left" },
      },
      left: {},
    },
  });
  const store = await mkStore();
  const saved = savedLedgers(store);
  const host = new RunHost({ store });
  host.register({ name: "inplace", machine, provide: () => ({}) });
  const { runId } = await host.start("inplace");
  host.sendToGate(runId, "start", { type: "begin" });
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => saved.some((rows) => Object.values(rows).some((r) => r.state === "settled")));
  await new Promise((r) => setTimeout(r, 20));
  const blob = (await store.load(runId))!.snapshot as { snapshot: unknown };
  assert.match(JSON.stringify(blob.snapshot), /"status":"done"/, "the settled child is still in the snapshot");
  assert.equal(host.status(runId)?.value, "linting", "settled in place: no route");
  assert.deepEqual(
    Object.values(await ledger(store, runId)).map((r) => r.state),
    ["settled"],
    "and its settled row is on the disk",
  );
});

/** A one-state Machine that runs `logic` once `begin` arrives and keeps its output. */
function onceMachine(id: string, logic: EffectLogic<void, CommandOutput>) {
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [begin],
    actors: { ws: fakeWorkspace(handles({})), logic },
  }).createMachine({
    id,
    context: {},
    invoke: { src: "ws" },
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { begin: "running" } },
      running: {
        invoke: { src: "logic", onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) } },
      },
      done: {},
    },
  });
}

async function runOnce(id: string, logic: EffectLogic<void, CommandOutput>): Promise<CommandOutput> {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: id, machine: onceMachine(id, logic), provide: () => ({}) });
  const { runId } = await host.start(id);
  host.sendToGate(runId, "start", { type: "begin" });
  await waitFor(() => host.status(runId)?.value === "done");
  return (host.status(runId)?.context as Ctx).result!;
}

/** argv that appends one "x" to `file` each time it runs. */
const appendsTo = (file: string) => [
  process.execPath,
  "-e",
  `require("node:fs").appendFileSync(${JSON.stringify(file)}, "x")`,
];

test("no second fire: a start that reached a Harness which then restarted is never sent again — `unknown`, one run", async () => {
  const marks = join(mkdtempSync(join(tmpdir(), "jr2-fx-")), "marks");
  let execs = new Execs();
  let starts = 0;
  // The first start runs the command, then the Harness restarts before it answers.
  const restarting: ExecPortFactory = (endpoint, bearer) => {
    const live = () => execsPort(execs)(endpoint, bearer);
    return {
      start: async (id, req, signal) => {
        starts++;
        await live().start(id, req, signal);
        await waitFor(() => existsSync(marks));
        execs = new Execs();
        throw new Error("harness exec POST /exec/x failed: ECONNRESET");
      },
      read: (id, offset, signal) => live().read(id, offset, signal),
      kill: (id) => live().kill(id),
      forget: (id) => live().forget(id),
    };
  };
  const result = await runOnce("restarting", commandWith(restarting, appendsTo(marks)));
  assert.equal(result.outcome, "unknown");
  assert.match((result as { reason: string }).reason, /may have reached the Harness.*not run again/);
  assert.equal(starts, 1, "the start was not sent again");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(readFileSync(marks, "utf8"), "x", "the command ran once");
});

test("a start whose answer was lost while its Harness lives on: it is read by id and followed — one run, its real output", async () => {
  const marks = join(mkdtempSync(join(tmpdir(), "jr2-fx-")), "marks");
  const execs = new Execs();
  let starts = 0;
  const lossy: ExecPortFactory = (endpoint, bearer) => {
    const port = execsPort(execs)(endpoint, bearer);
    return {
      ...port,
      start: async (id, req, signal) => {
        starts++;
        await port.start(id, req, signal);
        throw new Error("harness exec POST /exec/x failed: ECONNRESET");
      },
    };
  };
  const result = await runOnce("lossy", commandWith(lossy, appendsTo(marks)));
  assert.deepEqual(result, { outcome: "exited", code: 0, tail: "" });
  assert.equal(starts, 1);
  assert.equal(readFileSync(marks, "utf8"), "x");
});

test("a start that never left (the connection was refused) is sent again until it lands — one run", async () => {
  const marks = join(mkdtempSync(join(tmpdir(), "jr2-fx-")), "marks");
  const execs = new Execs();
  let starts = 0;
  const refusing: ExecPortFactory = (endpoint, bearer) => {
    const port = execsPort(execs)(endpoint, bearer);
    return {
      ...port,
      start: async (id, req, signal) => {
        starts++;
        if (starts === 1) throw new ExecNotSent("connect ECONNREFUSED");
        return port.start(id, req, signal);
      },
    };
  };
  const result = await runOnce("refusing", commandWith(refusing, appendsTo(marks)));
  assert.deepEqual(result, { outcome: "exited", code: 0, tail: "" });
  assert.equal(starts, 2, "sent again after the refused connection");
  assert.equal(readFileSync(marks, "utf8"), "x");
});
