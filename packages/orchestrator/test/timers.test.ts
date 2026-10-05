// A run's pending timers survive an Orchestrator restart (ADR-0007, src/timers.ts).
//
// Two layers, side by side, so it is clear which one loses a timer and which one keeps it:
//   - RAW xstate: createActor → getPersistedSnapshot → JSON → createActor({ snapshot }). These
//     tests show that xstate 5 itself drops a pending timer on restore. They are the canary for an
//     xstate bump: when one of them fails, xstate changed the thing src/timers.ts reads, and the
//     fix must be read again (on xstate 6, deleted).
//   - The REAL run host: RunHost.start → persist to a sqlite store → stop() → a second RunHost on
//     the same store → restore(). `stop()` keeps the row `live`, as a crash does (ADR-0024).
//
// Each case waits DELAY, restarts about RESTART_AT in, and times the transition after restore:
// about DELAY - RESTART_AT → the remaining time was kept; about DELAY → the full delay started
// again; never → the timer was lost.
//
// The hosts read deadlines on `clock`, which never steps. A wall clock can step (a WSL2 host steps
// back about 3 s every 30 s), and a step between the save and the restore moves every deadline: the
// clamp then gives the full delay, which is ADR-0007's rule and not what these tests measure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assign,
  createActor,
  createMachine,
  fromCallback,
  fromPromise,
  raise,
  sendParent,
  sendTo,
  setup,
} from "xstate";
import { z } from "zod";
import { defineEvent, doneEvent, requestReviewEvent } from "@jr2/agent-protocol";
import { agentActorWith, type AgentTurnInput, type AgentTurnPlacement } from "../src/actor.ts";
import { agent } from "../src/harness-client.ts";
import { pool, source } from "../src/pool.ts";
import { jr2Setup } from "../src/setup.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { pendingTimers, startAndRearm, type PendingTimer } from "../src/timers.ts";
import { coderDefinition, mkStore, MockFlueClient } from "./_fixtures.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";

const DELAY = 400;
const RESTART_AT = 150;
const LIMIT = 1500;
/** The slack on a measured time: wide enough for a loaded test machine, narrow enough that "the
 * remaining time" (≈250) cannot be mistaken for "the full delay" (≈400) or "at once" (≈0). */
const SLACK = 80;

/** ms from now until `pred` holds, or "never" within `limit`. */
async function timeTo(pred: () => boolean, limit = LIMIT): Promise<number | "never"> {
  const t0 = performance.now();
  while (performance.now() - t0 < limit) {
    if (pred()) return Math.round(performance.now() - t0);
    await sleep(5);
  }
  return "never";
}

function assertAbout(t: number | "never", expected: number, label: string): void {
  assert.ok(typeof t === "number" && Math.abs(t - expected) <= SLACK, `${label}: ${t} ms, expected about ${expected}`);
}

const remaining = DELAY - RESTART_AT;

/** A wall clock for the hosts that does not step: see the header. */
const clock = () => performance.timeOrigin + performance.now();

// ---- Raw xstate: the canary -----------------------------------------------------------------

const waiting = createMachine({
  id: "m",
  initial: "waiting",
  states: { waiting: { after: { [DELAY]: "done" } }, done: {} },
});

test("raw xstate: a restore loses a pending `after` (the canary — this is why src/timers.ts exists)", async () => {
  const first = createActor(waiting).start();
  await sleep(RESTART_AT);
  const persisted = JSON.parse(JSON.stringify(first.getPersistedSnapshot()));
  const scheduled = Object.values(first.system.getSnapshot()._scheduledEvents);
  first.stop();

  // The persisted snapshot has no timer in it: the timer lives on the actor SYSTEM.
  assert.deepEqual(Object.keys(persisted).sort(), ["children", "context", "historyValue", "status", "value"]);
  assert.equal(scheduled.length, 1, "the system did hold the timer at persist time");

  const restored = createActor(waiting, { snapshot: persisted }).start();
  const t = await timeTo(() => restored.getSnapshot().value === "done");
  restored.stop();
  assert.equal(t, "never");
});

test("raw xstate: the system's `snapshot.scheduler` seam is not wired — passing it changes nothing", async () => {
  const first = createActor(waiting).start();
  await sleep(RESTART_AT);
  const scheduler = first.system.getSnapshot()._scheduledEvents;
  const persisted = { ...JSON.parse(JSON.stringify(first.getPersistedSnapshot())), scheduler };
  first.stop();

  // createSystem reads `options.snapshot.scheduler`, but the Actor constructor calls createSystem
  // with { clock, logger } only.
  const restored = createActor(waiting, { snapshot: persisted as never }).start();
  const t = await timeTo(() => restored.getSnapshot().value === "done");
  restored.stop();
  assert.equal(t, "never");
});

test("raw xstate + pendingTimers: a timer is recorded with its absolute deadline, JSON-safe", async () => {
  const now = 1_000_000;
  const actor = createActor(waiting).start();
  await sleep(20);
  const timers = pendingTimers(actor, now);
  actor.stop();
  assert.equal(timers.length, 1);
  const [t] = timers as [PendingTimer];
  assert.deepEqual(
    { source: t.source, target: t.target, id: t.id, event: t.event, delay: t.delay },
    {
      source: [],
      target: [],
      id: `xstate.after.${DELAY}.m.waiting`,
      event: { type: `xstate.after.${DELAY}.m.waiting` },
      delay: DELAY,
    },
  );
  // Read at `now`, 20 ms after xstate scheduled it: what remains, on the host's clock.
  assert.ok(t.deadline > now + DELAY - 20 - SLACK && t.deadline <= now + DELAY - 20, `deadline ${t.deadline}`);
  assert.deepEqual(JSON.parse(JSON.stringify(timers)), timers);
});

test("raw xstate + startAndRearm: a backwards wall clock cannot push a timer past its own delay", async () => {
  const first = createActor(waiting).start();
  const persisted = JSON.parse(JSON.stringify(first.getPersistedSnapshot()));
  first.stop();
  const restored = createActor(waiting, { snapshot: persisted });
  const now = 1_000_000;
  // A deadline an hour out: the clock that wrote it ran ahead of this one.
  startAndRearm(
    restored,
    [
      {
        source: [],
        target: [],
        id: `xstate.after.${DELAY}.m.waiting`,
        event: { type: `xstate.after.${DELAY}.m.waiting` },
        delay: DELAY,
        deadline: now + 3_600_000,
      },
    ],
    now,
  );
  const t = await timeTo(() => restored.getSnapshot().value === "done");
  restored.stop();
  assertAbout(t, DELAY, "clamped to the delay");
});

// ---- The run host, driven like a restart ----------------------------------------------------

/** Wait until the store holds this run as `live` with the snapshot `value` given. */
async function persistedAt(store: SnapshotStore, runId: string, value: unknown): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const row = await store.load(runId);
    const blob = row?.snapshot as { snapshot?: { value?: unknown } } | undefined;
    if (row?.status === "live" && JSON.stringify(blob?.snapshot?.value) === JSON.stringify(value)) return;
    await sleep(2);
  }
  throw new Error(`run ${runId} never persisted at ${JSON.stringify(value)}`);
}

/** Start `def`, let it persist at `value`, run `ms` more, and stop the host's actor. The row stays
 * `live`, as after a crash. */
async function runThenStop(def: WorkflowDef, value: unknown, ms: number) {
  const store = await mkStore();
  const a = new RunHost({ store, now: clock });
  a.register(def);
  const { runId } = await a.start(def.name);
  await persistedAt(store, runId, value);
  await sleep(ms);
  await a.stop(runId);
  return { store, runId };
}

async function restoreOn(store: SnapshotStore, def: WorkflowDef, runId: string): Promise<RunHost> {
  const host = new RunHost({ store, now: clock });
  host.register(def);
  assert.deepEqual((await host.restore()).reattached, [runId]);
  return host;
}

function workflow(name: string, machine: WorkflowDef["machine"]): WorkflowDef {
  return { name, machine, provide: () => ({}) };
}

type Count = { fired: number };
const firedOf = (host: RunHost, runId: string) => (host.status(runId)?.context as Count).fired;

/** `waiting` leaves for `done` after DELAY, counting each time it fires. */
const counting = workflow(
  "counting",
  setup({
    types: {} as { context: Count },
    actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
  }).createMachine({
    id: "m",
    context: { fired: 0 },
    initial: "waiting",
    states: { waiting: { after: { [DELAY]: { target: "done", actions: "count" } } }, done: {} },
  }),
);

test("run host, with the timers dropped from the blob: the restore loses the `after`", async () => {
  const { store, runId } = await runThenStop(counting, "waiting", RESTART_AT);
  const row = (await store.load(runId))!;
  const { timers, ...blob } = row.snapshot as { timers?: unknown[] };
  assert.equal(timers?.length, 1, "the host records the pending timer beside the snapshot");
  await store.save(runId, blob, "live"); // the blob of a host that does not record timers

  const b = await restoreOn(store, counting, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  await b.stop(runId);
  assert.equal(t, "never");
});

test("an `after` fires exactly once after a restore, after the REMAINING time", async () => {
  const { store, runId } = await runThenStop(counting, "waiting", RESTART_AT);
  const b = await restoreOn(store, counting, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "after restore");
  await sleep(DELAY * 2);
  assert.equal(firedOf(b, runId), 1, "once, not twice");
  await b.stop(runId);
  const blob = (await store.load(runId))!.snapshot as { timers?: unknown[] };
  assert.deepEqual(blob.timers, [], "a timer that fired is not saved again");
});

test("re-arming comes after start(): a self-re-entering timer fires once per period after a restore", async () => {
  // xstate's own `system.start()` schedules whatever is in the system's table. Re-armed BEFORE
  // `start()`, each timer is armed twice and fires twice at its deadline; this loop re-enters
  // itself, so it accepts the second copy too, and counts it.
  const def = workflow(
    "loop",
    setup({
      types: {} as { context: Count },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      initial: "waiting",
      states: {
        waiting: {
          initial: "tick",
          states: { tick: { after: { [DELAY]: { target: "tick", reenter: true, actions: "count" } } } },
        },
      },
    }),
  );
  const { store, runId } = await runThenStop(def, { waiting: "tick" }, RESTART_AT);
  const b = await restoreOn(store, def, runId);
  await sleep(remaining + DELAY / 2); // one deadline passed, the next half a period out
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("a deadline that passed while the Orchestrator was down fires promptly", async () => {
  const { store, runId } = await runThenStop(counting, "waiting", RESTART_AT);
  await sleep(DELAY); // down past the deadline
  const b = await restoreOn(store, counting, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assert.ok(typeof t === "number" && t < SLACK, `prompt: ${t}`);
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("a timer that a state exit cancelled before the restart does not fire after it", async () => {
  // `waiting` holds two timers; the short one leaves the state, which cancels the long one.
  const def = workflow(
    "cancel",
    createMachine({
      id: "m",
      initial: "waiting",
      states: {
        waiting: {
          initial: "inner",
          states: { inner: { after: { [DELAY]: "#m.late" } } },
          after: { 100: "left" },
        },
        left: {},
        late: {},
      },
    }),
  );
  const { store, runId } = await runThenStop(def, "left", 50);
  assert.deepEqual(((await store.load(runId))!.snapshot as { timers?: unknown[] }).timers, []);
  const b = await restoreOn(store, def, runId);
  await sleep(DELAY * 2);
  assert.equal(b.status(runId)?.value, "left", "the cancelled timer stayed cancelled");
  await b.stop(runId);
});

test("two restores in a row keep the one deadline", async () => {
  const { store, runId } = await runThenStop(counting, "waiting", RESTART_AT);
  const b = await restoreOn(store, counting, runId);
  await sleep(100);
  await b.stop(runId);
  const c = await restoreOn(store, counting, runId);
  const t = await timeTo(() => c.status(runId)?.value === "done");
  assertAbout(t, remaining - 100, "second restore");
  assert.equal(firedOf(c, runId), 1);
  await c.stop(runId);
});

test("the host writes and reads deadlines on its own clock (`now`), not on Date.now", async () => {
  // Both hosts run 10 s ahead of Date.now. A host that read either side on Date.now would see a
  // deadline 10 s off: the full delay (clamped), or at once.
  const ahead = () => clock() + 10_000;
  const store = await mkStore();
  const a = new RunHost({ store, now: ahead });
  a.register(counting);
  const { runId } = await a.start(counting.name);
  await persistedAt(store, runId, "waiting");
  const [saved] = ((await store.load(runId))!.snapshot as { timers: PendingTimer[] }).timers;
  assert.ok(Math.abs(saved!.deadline - (ahead() + DELAY)) < SLACK, "the deadline is a time on `now`");
  await sleep(RESTART_AT);
  await a.stop(runId);
  const b = new RunHost({ store, now: ahead });
  b.register(counting);
  await b.restore();
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "on the host's clock");
  await b.stop(runId);
});

test("a state exit after the restore cancels a re-armed timer", async () => {
  // Restart 150 ms in: `leave` is re-armed at 50 ms, the `after` at 250. `leave` exits `waiting`,
  // which must cancel the re-armed `after`; `other` enters `waiting` again 100 ms later, with a fresh
  // DELAY. A re-armed timer the exit missed would fire at 250 into the fresh `waiting`.
  const def = workflow(
    "exit-after",
    setup({
      types: {} as { context: Count; events: { type: "leave" } },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      entry: raise({ type: "leave" }, { delay: 200 }),
      initial: "waiting",
      states: {
        waiting: { after: { [DELAY]: { target: "done", actions: "count" } }, on: { leave: "other" } },
        other: { after: { 100: "waiting" } },
        done: {},
      },
    }),
  );
  const { store, runId } = await runThenStop(def, "waiting", RESTART_AT);
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, 200 - RESTART_AT + 100 + DELAY, "the fresh `after`, not the re-armed one");
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("a state exit during start() on restore cancels the saved timer", async () => {
  // `start()` drains the mailbox: the restored `cb` sends `leave` while it starts, before anything is
  // re-armed. That exit must still cancel the saved `after`: `other` enters `waiting` again 100 ms
  // later, with a fresh DELAY, and the saved row (250 ms left) must not fire into it.
  let sendOnStart = false;
  const machine = setup({
    types: {} as { context: Count; events: { type: "leave" } },
    actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
    actors: { cb: fromCallback(() => {}) },
  }).createMachine({
    id: "m",
    context: { fired: 0 },
    initial: "waiting",
    states: {
      waiting: {
        invoke: { src: "cb" },
        after: { [DELAY]: { target: "done", actions: "count" } },
        on: { leave: "other" },
      },
      other: { after: { 100: "waiting" } },
      done: {},
    },
  });
  const def: WorkflowDef = {
    name: "exit-during-start",
    machine,
    provide: () => ({
      actors: {
        cb: fromCallback(({ sendBack }) => {
          if (!sendOnStart) return;
          sendOnStart = false;
          sendBack({ type: "leave" });
        }),
      },
    }),
  };
  const { store, runId } = await runThenStop(def, "waiting", RESTART_AT);
  sendOnStart = true;
  const b = await restoreOn(store, def, runId);
  assert.equal(b.status(runId)?.value, "other", "the exit happened inside start()");
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, 100 + DELAY, "the fresh `after`, not the saved one");
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("timers that fell due while the Orchestrator was down fire in deadline order", async () => {
  // The outer `after` is scheduled first and falls due last. Uninterrupted, the inner one fires at
  // 100 and its exit cancels the outer: the run ends `inner`. Restored after both deadlines, it must
  // end the same way, not `timeout`.
  const def = workflow(
    "overdue-order",
    createMachine({
      id: "m",
      initial: "outer",
      states: {
        outer: {
          after: { 300: "timeout" },
          initial: "a",
          states: { a: { after: { 100: "#m.inner" } } },
        },
        inner: {},
        timeout: {},
      },
    }),
  );
  const { store, runId } = await runThenStop(def, { outer: "a" }, 50);
  const saved = ((await store.load(runId))!.snapshot as { timers: PendingTimer[] }).timers;
  assert.deepEqual(
    saved.map((t) => t.delay),
    [300, 100],
    "saved in the order xstate scheduled them",
  );
  await sleep(400); // down past both deadlines
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => typeof b.status(runId)?.value === "string");
  assert.ok(typeof t === "number" && t < SLACK, `prompt: ${t}`);
  assert.equal(b.status(runId)?.value, "inner");
  await b.stop(runId);
});

test("a named delay is re-armed with the remaining time", async () => {
  const def = workflow(
    "named",
    setup({
      types: {} as { context: Count },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
      delays: { patience: DELAY },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      initial: "waiting",
      states: { waiting: { after: { patience: { target: "done", actions: "count" } } }, done: {} },
    }),
  );
  const { store, runId } = await runThenStop(def, "waiting", RESTART_AT);
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "named delay");
  await sleep(DELAY);
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("a delayed `raise` is re-armed and fires once", async () => {
  // `done` takes `go` too, and counts it, so a second copy would show.
  const def = workflow(
    "raise",
    setup({
      types: {} as { context: Count; events: { type: "go" } },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      initial: "waiting",
      states: {
        waiting: { entry: raise({ type: "go" }, { delay: DELAY }), on: { go: { target: "done", actions: "count" } } },
        done: { on: { go: { actions: "count" } } },
      },
    }),
  );
  const { store, runId } = await runThenStop(def, "waiting", RESTART_AT);
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "delayed raise");
  await sleep(DELAY);
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

/** A child Machine that reports each `poke` up as `poked`. */
const poked = setup({}).createMachine({
  id: "kid",
  on: { poke: { actions: sendParent({ type: "poked" }) } },
});

test("a delayed `sendTo` a child Machine is re-armed and delivered once", async () => {
  const def = workflow(
    "send-to-child",
    setup({
      types: {} as { context: Count; events: { type: "poked" } },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
      actors: { kid: poked },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      initial: "running",
      states: {
        running: {
          invoke: { id: "kid", src: "kid" },
          initial: "waiting",
          states: {
            waiting: {
              entry: sendTo("kid", { type: "poke" }, { delay: DELAY }),
              on: { poked: { target: "done", actions: "count" } },
            },
            done: { on: { poked: { actions: "count" } } },
          },
        },
      },
    }),
  );
  const { store, runId } = await runThenStop(def, { running: "waiting" }, RESTART_AT);
  const timers = ((await store.load(runId))!.snapshot as { timers: PendingTimer[] }).timers;
  assert.deepEqual(
    timers.map((t) => [t.source, t.target]),
    [[[], ["kid"]]],
  );
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => JSON.stringify(b.status(runId)?.value) === JSON.stringify({ running: "done" }));
  assertAbout(t, remaining, "delayed sendTo a child");
  await sleep(DELAY);
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("a delayed `sendParent` from a child Machine is re-armed and delivered once", async () => {
  const kid = setup({}).createMachine({ id: "kid", entry: sendParent({ type: "poked" }, { delay: DELAY }) });
  const def = workflow(
    "send-parent",
    setup({
      types: {} as { context: Count; events: { type: "poked" } },
      actions: { count: assign({ fired: ({ context }) => context.fired + 1 }) },
      actors: { kid },
    }).createMachine({
      id: "m",
      context: { fired: 0 },
      initial: "running",
      states: {
        running: { invoke: { id: "kid", src: "kid" }, on: { poked: { target: "done", actions: "count" } } },
        done: { on: { poked: { actions: "count" } } },
      },
    }),
  );
  const { store, runId } = await runThenStop(def, "running", RESTART_AT);
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "delayed sendParent");
  await sleep(DELAY);
  assert.equal(firedOf(b, runId), 1);
  await b.stop(runId);
});

test("an `after` in a child Machine is re-armed with the remaining time", async () => {
  const kid = setup({}).createMachine({
    id: "kid",
    initial: "waiting",
    states: { waiting: { after: { [DELAY]: "over" } }, over: { type: "final" } },
  });
  const def = workflow(
    "child",
    setup({ actors: { kid } }).createMachine({
      id: "m",
      initial: "running",
      states: { running: { invoke: { id: "kid", src: "kid", onDone: "done" } }, done: {} },
    }),
  );
  const { store, runId } = await runThenStop(def, "running", RESTART_AT);
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => b.status(runId)?.value === "done");
  assertAbout(t, remaining, "child Machine");
  await b.stop(runId);
});

test("an `after` below a state that invokes an Agent is re-armed; the Turn is re-attached, not admitted again", async () => {
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [doneEvent, requestReviewEvent],
    actors: { coder: agent(coderDefinition) },
  }).createMachine({
    id: "m",
    context: {},
    initial: "active",
    states: {
      active: {
        invoke: {
          id: "coder",
          src: "coder",
          input: (): AgentTurnInput & AgentTurnPlacement => ({ endpoint: "http://harness.invalid", prompt: "do work" }),
        },
        on: { done: "#m.done" },
        initial: "running",
        states: { running: { after: { [DELAY]: "review" } }, review: {} },
      },
      done: { type: "final" },
    },
  });
  const clients: MockFlueClient[] = [];
  const def: WorkflowDef = {
    name: "agent",
    machine,
    provide: () => {
      const client = new MockFlueClient();
      clients.push(client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition) } };
    },
  };
  const store = await mkStore();
  const a = new RunHost({ store, now: clock });
  a.register(def);
  const { runId } = await a.start(def.name);
  // Persisted with the admission ledgered, so the restore re-attaches the Turn.
  for (let i = 0; i < 200; i++) {
    const blob = (await store.load(runId))?.snapshot as { agents?: object } | undefined;
    if (blob?.agents && Object.keys(blob.agents).length) break;
    await sleep(2);
  }
  await sleep(RESTART_AT);
  await a.stop(runId);

  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => JSON.stringify(b.status(runId)?.value) === JSON.stringify({ active: "review" }));
  assertAbout(t, remaining, "below an Agent's state");
  const second = clients.at(-1)!;
  assert.equal(second.admits.length, 0, "the Turn was re-attached, not admitted again");
  assert.equal(second.settled.length, 1);
  await b.stop(runId);
});

// ---- Pool's `pollEvery` with a parked worker ------------------------------------------------

type Item = { id: string };
const finish = defineEvent({ name: "finish", input: z.object({}) });
const parkedWorker = jr2Setup({
  types: {} as { context: { item: Item }; input: { item: Item } },
  events: [finish],
}).createMachine({
  id: "workerBody",
  context: ({ input }) => ({ item: input.item }),
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: ({ context }) => ({ gate: context.item.id }) }, on: { finish: "done" } },
    done: { type: "final" },
  },
});

function pollingPool(items: Item[], claims: string[][]) {
  return pool(parkedWorker, {
    id: "run",
    source: source<Item>({
      next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
        claims.push([...input.active]);
        const item = items.find((i) => !input.active.includes(i.id)) ?? null;
        if (item) items.splice(items.indexOf(item), 1);
        return { item, open: 0 };
      }),
      pollEvery: DELAY,
    }),
    itemId: (i) => i.id,
    cap: 4,
    itemInput: (i) => ({ item: i }),
  });
}

test("Pool's `pollEvery` keeps polling after a restore, after the remaining time", async () => {
  const items: Item[] = [{ id: "F-1" }];
  const claims: string[][] = [];
  const def = workflow("run", pollingPool(items, claims));
  const { store, runId } = await runThenStop(def, "parked", RESTART_AT);
  const before = claims.length;

  // The set changes while the Orchestrator is down; only the poll can see it.
  items.push({ id: "F-2" });
  const b = await restoreOn(store, def, runId);
  const t = await timeTo(() => claims.length > before);
  assertAbout(t, remaining, "Pool poll");
  // …and it claimed the new item, beside the parked worker F-1.
  await timeTo(() => (b.status(runId)?.context as { active: string[] }).active.length === 2);
  assert.deepEqual((b.status(runId)?.context as { active: string[] }).active, ["F-1", "F-2"]);
  // …and keeps polling: the next period is armed again.
  const after = claims.length;
  const next = await timeTo(() => claims.length > after);
  assertAbout(next, DELAY, "the next poll");
  await b.stop(runId);
});
