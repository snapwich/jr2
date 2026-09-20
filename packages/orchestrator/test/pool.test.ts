// pool(worker, spec) — ADR-0017. Driven through a REAL RunHost so spawn-under-cap, completion
// collection, the wake gate, the poll timer, and the three-valued terminal triage (drained /
// deadlocked / waiting) are exercised the way a run experiences them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { pool, source } from "../src/pool.ts";
import { jr2Setup } from "../src/setup.ts";
import { vocabularyOf } from "../src/vocabulary.ts";
import { RunHost } from "../src/run-host.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

type Item = { id: string; label: string };

const finish = defineEvent({ name: "finish", input: z.object({}) });
const workReady = defineEvent({ name: "work_ready", audience: "external", input: z.object({}) });

/** A worker that parks on a per-item gate until an external `finish` settles it. */
const gatedWorker = jr2Setup({
  types: {} as {
    context: { item: Item };
    input: { item: Item };
    output: { label: string };
  },
  events: [finish],
}).createMachine({
  id: "workerBody",
  context: ({ input }) => ({ item: input.item }),
  initial: "working",
  states: {
    working: {
      invoke: { src: "gate", input: ({ context }) => ({ gate: context.item.id }) },
      on: { finish: "done" },
    },
    done: { type: "final" },
  },
  output: ({ context }) => ({ label: context.item.label }),
});

/** An in-memory ready-set: hand out `ready` items not already active; report `open` stragglers. */
function memorySource(items: Item[], opts: { open?: () => number } = {}) {
  const claims: string[][] = [];
  const src = source<Item>({
    next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
      claims.push([...input.active]);
      const item = items.find((i) => !input.active.includes(i.id)) ?? null;
      if (item) items.splice(items.indexOf(item), 1);
      const open = opts.open?.() ?? 0;
      return { item, open };
    }),
    wake: workReady,
    pollEvery: 5,
  });
  return { src, claims };
}

async function mkPool(items: Item[], opts: { cap?: number; open?: () => number } = {}) {
  const { src, claims } = memorySource(items, opts);
  const machine = pool(gatedWorker, {
    id: "run",
    source: src,
    itemId: (i) => i.id,
    cap: opts.cap ?? 2,
    itemInput: (i) => ({ item: i }),
    onDrained: "final",
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "run", machine, provide: () => ({}) });
  const { runId } = await host.start("run");
  return { host, runId, claims };
}

test("spawns one worker per item under the cap; completions free slots; drained is final", async () => {
  const { host, runId } = await mkPool([
    { id: "F-1", label: "one" },
    { id: "F-2", label: "two" },
    { id: "F-3", label: "three" },
  ]);

  // Cap 2: F-1 and F-2 spawned (each parked on its own gate), F-3 waits for a slot.
  await waitFor(() => host.gates(runId).filter((g) => g.gate.startsWith("F-")).length === 2);
  assert.deepEqual(
    host
      .gates(runId)
      .map((g) => g.gate)
      .filter((g) => g.startsWith("F-"))
      .sort(),
    ["F-1", "F-2"],
  );
  assert.equal(JSON.stringify(host.status(runId)?.value), '"saturated"');

  // Settle F-1 → its slot frees → F-3 claims it.
  host.sendToGate(runId, "F-1", { type: "finish" });
  await waitFor(() => host.gates(runId).some((g) => g.gate === "F-3"));

  // Settle the rest → the source drains → the run reaches final with collected outputs.
  host.sendToGate(runId, "F-2", { type: "finish" });
  host.sendToGate(runId, "F-3", { type: "finish" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const output = (final?.context as { status?: string; items?: Record<string, { label: string }> }) ?? {};
  // Root output reads outcome-from-context; the persisted terminal context carries both.
  assert.equal(output.status, "drained");
  assert.deepEqual(output.items, { "F-1": { label: "one" }, "F-2": { label: "two" }, "F-3": { label: "three" } });
});

test("waiting: nothing ready + workers parked keeps the run open; wake re-queries early", async () => {
  const items = [{ id: "F-1", label: "one" }];
  const { host, runId, claims } = await mkPool(items, { cap: 2 });

  await waitFor(() => host.gates(runId).some((g) => g.gate === "F-1"));
  // One worker parked, source empty → the pool parks (healthy waiting, jr exit 3): run stays open.
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === '"parked"');
  assert.ok(host.status(runId), "waiting is an OPEN run, not a terminal state");

  // The wake gate is a standing surface; pushing work_ready re-queries immediately.
  const before = claims.length;
  items.push({ id: "F-2", label: "two" });
  host.sendToGate(runId, "source", { type: "work_ready" });
  await waitFor(() => host.gates(runId).some((g) => g.gate === "F-2"));
  assert.ok(claims.length > before, "wake caused a re-query");

  host.sendToGate(runId, "F-1", { type: "finish" });
  host.sendToGate(runId, "F-2", { type: "finish" });
  await waitFor(() => host.status(runId) === undefined);
});

test("deadlocked: idle with open-but-never-ready items is final and DISTINCT from drained", async () => {
  const { host, runId } = await mkPool([], { open: () => 3 });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.equal((final?.context as { status?: string }).status, "deadlocked");
});

test("the poll timer re-queries a mutating set with no push at all", async () => {
  // One worker parks (so the pool WAITS instead of draining), then a new item appears with no
  // wake pushed — only the pollEvery cadence can find it.
  const items = [{ id: "F-1", label: "one" }];
  const { host, runId } = await mkPool(items, { cap: 2 });
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === '"parked"');

  items.push({ id: "F-2", label: "two" });
  await waitFor(() => host.gates(runId).some((g) => g.gate === "F-2"));

  host.sendToGate(runId, "F-1", { type: "finish" });
  host.sendToGate(runId, "F-2", { type: "finish" });
  await waitFor(() => host.status(runId) === undefined);
});

test("the pool machine's vocabulary is its OWN wake def; the worker keeps its own (ADR-0049)", async () => {
  const { src } = memorySource([]);
  const machine = pool(gatedWorker, { source: src, itemId: (i) => i.id });
  assert.deepEqual([...vocabularyOf(machine)!.keys()], ["work_ready"]);
  // The worker's `finish` never migrates up: the worker's gate resolves against the worker.
  assert.deepEqual([...vocabularyOf(gatedWorker)!.keys()], ["finish"]);
});

test("a wake def sharing a worker event's NAME is no collision — the scopes are separate", async () => {
  // Same name, different payload, one run: legal since the sets never merge (ADR-0011/0049).
  const clash = defineEvent({ name: "finish", audience: "external", input: z.object({ why: z.string() }) });
  const src = source<Item>({ next: fromPromise<Item | null, { active: string[] }>(async () => null), wake: clash });
  const machine = pool(gatedWorker, { source: src, itemId: (i) => i.id });
  assert.equal(vocabularyOf(machine)!.get("finish"), clash);
  assert.notEqual(vocabularyOf(gatedWorker)!.get("finish"), clash);
});

test("a plain-setup worker with no vocabulary still pools (wake def only)", () => {
  const bare = setup({}).createMachine({ id: "w", initial: "done", states: { done: { type: "final" } } });
  const { src } = memorySource([]);
  const machine = pool(bare, { source: src, itemId: (i) => i.id });
  assert.deepEqual([...vocabularyOf(machine)!.keys()], ["work_ready"]);
});
