// The `command` Effect (ADR-0067), through the real `jr2Setup` walk and the real `RunHost`: an actor
// slot whose output the Machine routes on, an intent row on disk before the call, D1 on state exit,
// and a restore that re-attaches by id or settles `unknown` — never a second run. A fake Harness
// exec is settled by hand; one test runs real processes through the Harness's own `Execs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { Execs } from "@jr2/harness/exec";
import { arg, commandWith, type CommandOutput, type EffectRow, type ExecPortFactory } from "../src/effect.ts";
import { RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { execsPort, fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({ filter: z.string() }) });
const leave = defineEvent({ name: "leave", input: z.object({}) });

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
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => valueOf(rig) === "done");
  const rows = Object.values(await ledger(store, rig.runId));
  assert.deepEqual(
    rows.map((r) => r.state),
    ["settled"],
  );
});

test("D1: its state exits while it runs — the exec is killed, the ledger and the feed say `outcome unknown`, the Machine hears nothing", async () => {
  const fake = new FakeHarnessExec();
  const rig = await started(fake.factory);
  await waitFor(() => fake.starts.length === 1);
  rig.host.sendToGate(rig.runId, "ctl", { type: "leave" });
  await waitFor(() => fake.kills.length === 1);
  assert.equal(fake.kills[0], fake.starts[0]!.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(valueOf(rig), "left");
  assert.equal(contextOf(rig).result, undefined, "the Machine never got the abort");
  const rows = Object.values(await ledger(rig.store, rig.runId));
  assert.deepEqual(
    rows.map((r) => r.state),
    ["aborted"],
  );
  const aborted = rig.feed.find((e) => e.kind === "effect" && e.phase === "aborted");
  assert.match((aborted as { text: string }).text, /outcome unknown/);
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
  const bare = jr2Setup({ types: {} as { context: Ctx }, events: [go], actors: { tests } }).createMachine({
    id: "bare",
    context: {},
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate", id: "start" }, on: { go: "running" } },
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
  host.sendToGate(runId, "start", { type: "go", filter: "x" });
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
