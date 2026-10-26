// The `dispatch` Effect (ADR-0071): a run starts a run. In-process, through the real `jr2Setup`
// walk and a real `RunHost` with two registered Workflows and NO Effector binding: the run host is
// reached through `RunBinding.dispatch`, the callee's row carries `dispatchedBy`, the caller's
// ledger row carries the run, `wait` settles with the callee's status and output, a door refusal is
// output, D1 stops the wait and never the run, and a restore resumes the wait or sends the start
// again under its key. Foreign, through `dispatchWith` over the fake Effector's signed transport:
// the start request is the golden fixture's, each wire outcome maps 1:1, and a dispatch is sent
// again wherever an http Effect would settle `unknown` — it is idempotent by construction.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import {
  dispatch,
  dispatchParts,
  dispatchWith,
  openDispatchParts,
  DISPATCHED_BY_HEADER,
  type DispatchDefinition,
} from "../src/dispatch-effect.ts";
import {
  dropSavedTails,
  inputKeysOf,
  isEffect,
  placementOf,
  type DispatchOutput,
  type EffectRow,
} from "../src/effect.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import { secret } from "../src/http-effect.ts";
import { open } from "../src/open.ts";
import { binderOf } from "../src/open-effect.ts";
import { observe, RunHost, type RunFeedEvent, type RunHostOptions, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { fail as failPart } from "../src/fail.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { agentActorWith } from "../src/actor.ts";
import { fromPick } from "../src/pick.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { chartedSrc, machineOf, reviewLoop } from "./_assembly.ts";

// --- The callee: a door `{ ticket }`, a gate that ends it, and an output ------------------------

const finish = defineEvent({ name: "finish", input: z.object({}) });
const fail = defineEvent({ name: "fail", input: z.object({}) });
const leave = defineEvent({ name: "leave", input: z.object({}) });
const giveUp = defineEvent({ name: "giveUp", input: z.object({}) });

const intakeDoor = z.object({ ticket: z.string() });

const intake = jr2Setup({
  types: {} as { context: { ticket: string }; input: { ticket: string } },
  events: [finish, fail, giveUp],
  actors: {
    boom: fromPromise(async () => {
      throw new Error("the intake broke");
    }),
    stop: failPart(),
  },
}).createMachine({
  id: "intake",
  input: intakeDoor,
  context: ({ input }) => ({ ticket: input.ticket }),
  initial: "waiting",
  states: {
    waiting: { invoke: { src: "gate", id: "ctl" }, on: { finish: "done", fail: "breaking", giveUp: "givingUp" } },
    breaking: { invoke: { src: "boom" } },
    givingUp: { invoke: { src: "stop", input: { reason: "no owner for the ticket", detail: { queue: "triage" } } } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ verdict: "triaged", ticket: context.ticket }),
});

// --- The caller: one dispatch slot, its output in context ---------------------------------------

type Ctx = { result?: DispatchOutput; fault?: string };

function callerOf(dispatcher: unknown, body: Record<string, unknown> = { ticket: "PROJ-7" }) {
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [leave],
    actors: { start: dispatcher as never },
  }).createMachine({
    id: "caller",
    context: {},
    initial: "calling",
    states: {
      calling: {
        invoke: [
          {
            src: "start",
            input: () => body as never,
            onDone: { target: "done", actions: assign({ result: ({ event }) => event.output as DispatchOutput }) },
            onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
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

const def = (name: string, machine: unknown): WorkflowDef => ({ name, machine: machine as never, provide: () => ({}) });

/** Every host a test made: parked at the end, so no wait or poll outlives the suite. */
const hosts: RunHost[] = [];
after(async () => {
  for (const host of hosts) for (const s of host.list()) await host.stop(s.runId);
});

type Rig = { host: RunHost; store: SnapshotStore; runId: string; feed: RunFeedEvent[] };

async function rig(
  dispatcher: unknown,
  opts: {
    body?: Record<string, unknown>;
    store?: SnapshotStore;
    host?: Partial<RunHostOptions>;
    extra?: WorkflowDef[];
  } = {},
): Promise<Rig> {
  const store = opts.store ?? (await mkStore());
  const host = new RunHost({ store, ...opts.host });
  hosts.push(host);
  host.register(def("caller", callerOf(dispatcher, opts.body)));
  host.register(def("intake", intake));
  for (const extra of opts.extra ?? []) host.register(extra);
  const { runId } = await host.start("caller");
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (ev) => feed.push(ev));
  return { host, store, runId, feed };
}

const ctx = (host: RunHost, runId: string): Ctx => (host.status(runId)?.context ?? {}) as Ctx;
const resultOf = (host: RunHost, runId: string): DispatchOutput | undefined => ctx(host, runId).result;

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> } | undefined)?.effects ?? {};

/** The caller's one dispatch row, and its id (the key). */
async function rowOf(store: SnapshotStore, runId: string): Promise<[string, EffectRow]> {
  const rows = Object.entries(await ledger(store, runId));
  assert.equal(rows.length, 1);
  return rows[0]!;
}

/** The run the caller's intent row names, once the start's answer wrote it. */
async function startedRun(store: SnapshotStore, runId: string): Promise<string> {
  let run: string | undefined;
  for (let i = 0; i < 200 && run === undefined; i++) {
    const rows = Object.values(await ledger(store, runId));
    const row = rows[0] as { state?: string; run?: string; output?: { run?: string } } | undefined;
    run = row?.run ?? row?.output?.run;
    if (run === undefined) await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(run, "the caller's ledger row names the run it started");
  return run;
}

const intakeRuns = (host: RunHost): string[] =>
  host
    .list()
    .filter((s) => s.workflow === "intake")
    .map((s) => s.runId);

const typed = <S extends z.ZodObject | undefined = undefined>(d: DispatchDefinition<S> = {}) => d;

// --- In-process ----------------------------------------------------------------------------------

test("in-process: the run is started through the run host, its row says who dispatched it, and the caller's row names it", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor }));
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const result = resultOf(r.host, r.runId)!;
  assert.equal(result.outcome, "started");
  const callee = (result as { run: string }).run;
  const [effect, row] = await rowOf(r.store, r.runId);
  assert.equal(row.state, "settled");
  assert.deepEqual((row as { output: unknown }).output, { outcome: "started", run: callee });
  const status = r.host.status(callee) ?? (await r.host.read(callee));
  assert.equal(status?.workflow, "intake");
  assert.deepEqual(status?.dispatchedBy, { run: r.runId, slot: "start", effect, depth: 1 });
  assert.equal((status?.context as { ticket: string }).ticket, "PROJ-7", "the invoke's input is the run's body");
  assert.equal(r.host.depthOf(callee), 1);
  assert.equal(r.host.depthOf(r.runId), 0);
  // The chain both ways (ADR-0071): the caller's status names the run its slot started, and the
  // open band carries the same routing without the row's time.
  const caller = r.host.status(r.runId)!;
  assert.deepEqual(
    caller.dispatched?.map(({ slot, run }) => ({ slot, run })),
    [{ slot: "start", run: callee }],
  );
  assert.deepEqual(observe(caller).dispatched, [{ slot: "start", run: callee }]);
  const stored = await r.host.read(r.runId);
  assert.deepEqual(stored?.dispatched, caller.dispatched);
});

test("in-process wait: the intent row names the run while it waits; the callee's end settles it with its status and output", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const callee = await startedRun(r.store, r.runId);
  const [, row] = await rowOf(r.store, r.runId);
  assert.deepEqual(
    { ...row, at: "t" },
    {
      state: "intent",
      kind: "dispatch",
      slot: "start",
      placement: "orchestrator",
      idempotent: true,
      wait: true,
      run: callee,
      at: "t",
    },
  );
  assert.equal(resultOf(r.host, r.runId), undefined, "still waiting");
  r.host.sendToGate(callee, "ctl", { type: "finish" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.deepEqual(resultOf(r.host, r.runId), {
    outcome: "settled",
    run: callee,
    status: "done",
    output: { verdict: "triaged", ticket: "PROJ-7" },
  });
  const settled = r.feed.find((e) => e.kind === "effect" && e.stage === "settled") as { output: unknown };
  assert.deepEqual(settled.output, resultOf(r.host, r.runId), "the feed says how it ended");
});

test("in-process wait: a callee that errors settles `error`; one cancelled settles `cancelled`", async () => {
  const errs = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const broken = await startedRun(errs.store, errs.runId);
  errs.host.sendToGate(broken, "ctl", { type: "fail" });
  await waitFor(() => resultOf(errs.host, errs.runId) !== undefined);
  const errored = resultOf(errs.host, errs.runId) as { outcome: string; status: string; run: string };
  assert.deepEqual([errored.outcome, errored.status, errored.run], ["settled", "error", broken]);

  const cancels = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const victim = await startedRun(cancels.store, cancels.runId);
  await cancels.host.cancel(victim);
  await waitFor(() => resultOf(cancels.host, cancels.runId) !== undefined);
  const cancelled = resultOf(cancels.host, cancels.runId) as { status: string };
  assert.equal(cancelled.status, "cancelled");
});

test("in-process wait: a callee that fails settles `failed`, its Failure as the output (ADR-0073)", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const callee = await startedRun(r.store, r.runId);
  r.host.sendToGate(callee, "ctl", { type: "giveUp" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.deepEqual(resultOf(r.host, r.runId), {
    outcome: "settled",
    run: callee,
    status: "failed",
    output: { reason: "no owner for the ticket", detail: { queue: "triage" } },
  });
});

test("in-process: a door refusal is output — 400 naming the door's shape, 404 for no such Workflow, 409 for an unrunnable named Chart", async () => {
  const bad = await rig(dispatch("intake"), { body: { title: "no ticket" } });
  await waitFor(() => resultOf(bad.host, bad.runId) !== undefined);
  const r400 = resultOf(bad.host, bad.runId) as { outcome: string; status: number; report: string[] };
  assert.equal(r400.outcome, "refused");
  assert.equal(r400.status, 400);
  assert.match(r400.report[1] ?? "", /the door of "intake" takes .*"ticket"/, "the report names what the door takes");
  assert.deepEqual(intakeRuns(bad.host), [], "nothing started");

  const none = await rig(dispatch("nowhere"));
  await waitFor(() => resultOf(none.host, none.runId) !== undefined);
  const r404 = resultOf(none.host, none.runId) as { status: number; report: string[] };
  assert.equal(r404.status, 404);
  assert.match(r404.report.join("\n"), /nowhere/);

  const unrunnable = await rig(dispatch("charted/loop"), {
    host: { unrunnableChart: (name) => (name === "charted/loop" ? "Chart refused: coder is not lent" : undefined) },
  });
  await waitFor(() => resultOf(unrunnable.host, unrunnable.runId) !== undefined);
  const r409 = resultOf(unrunnable.host, unrunnable.runId) as { status: number; report: string[] };
  assert.equal(r409.status, 409);
  assert.match(r409.report.join("\n"), /coder is not lent/);
});

test("in-process: a Chart the wrapper's door refuses is output `refused` 422, with the door's report", async () => {
  const charted = await machineOf(chartedSrc());
  const text = await reviewLoop();
  const r = await rig(dispatch("charted"), {
    body: {
      endpoint: "http://127.0.0.1:9",
      task: "t",
      chart: { ...text, states: { ...(text.states as object), draft: { invoke: { src: "linter" } } } },
    },
    extra: [def("charted", charted)],
  });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const refused = resultOf(r.host, r.runId) as { outcome: string; status: number; report: string[] };
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.status, 422);
  assert.match(refused.report.join("\n"), /linter/);
});

test("in-process: input that misses the slot's schema is the invoke's error, and nothing starts", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor }), { body: { ticket: 7 } });
  await waitFor(() => r.host.status(r.runId)?.value === "faulted");
  assert.match(ctx(r.host, r.runId).fault!, /does not match the slot's input schema/);
  assert.deepEqual(intakeRuns(r.host), []);
  assert.deepEqual(await ledger(r.store, r.runId), {}, "no intent row: nothing was started");
});

test("in-process D1: leaving the state stops the wait, records the abort, and the callee runs on to `done`", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const callee = await startedRun(r.store, r.runId);
  r.host.sendToGate(r.runId, "ctl", { type: "leave" });
  await waitFor(() => r.host.status(r.runId)?.value === "left");
  await new Promise((res) => setTimeout(res, 20));
  const [, row] = await rowOf(r.store, r.runId);
  assert.equal(row.state, "aborted");
  assert.equal((row as { run?: string }).run, callee, "the caller's row still names the run it started");
  const aborted = r.feed.find((e) => e.kind === "effect" && e.stage === "aborted") as { text: string };
  assert.match(aborted.text, new RegExp(`run ${callee} runs on; outcome unknown`));
  assert.equal(r.host.status(callee)?.status, "active", "the callee is not the caller's to end");
  r.host.sendToGate(callee, "ctl", { type: "finish" });
  await waitFor(() => r.host.status(callee) === undefined);
  assert.equal((await r.host.read(callee))?.status, "done");
});

test("in-process: cancelling the caller leaves the callee live", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const callee = await startedRun(r.store, r.runId);
  await r.host.cancel(r.runId);
  assert.equal(r.host.status(callee)?.status, "active");
});

/** Park every run of a host, as a shutdown does: each re-attaches on the next host's restore. */
async function parkAll(host: RunHost): Promise<void> {
  for (const s of host.list()) await host.stop(s.runId);
}

/** A store whose `live()` answers in reverse: the callee's row restores before its caller's. */
function reversed(store: SnapshotStore): SnapshotStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "live") return async () => (await target.live()).reverse();
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function restoredHost(store: SnapshotStore, dispatcher: unknown): Promise<RunHost> {
  const host = new RunHost({ store });
  hosts.push(host);
  host.register(def("caller", callerOf(dispatcher)));
  host.register(def("intake", intake));
  await host.restore();
  return host;
}

test("restore mid-wait: the caller resumes the wait on the run its row names, in either restore order", async () => {
  for (const order of ["caller first", "callee first"] as const) {
    const dispatcher = () => dispatch("intake", { input: intakeDoor, wait: true });
    const r = await rig(dispatcher());
    const callee = await startedRun(r.store, r.runId);
    await parkAll(r.host);
    const host = await restoredHost(order === "callee first" ? reversed(r.store) : r.store, dispatcher());
    await waitFor(() => host.status(callee) !== undefined && host.status(r.runId) !== undefined);
    assert.equal(resultOf(host, r.runId), undefined, `${order}: still waiting`);
    host.sendToGate(callee, "ctl", { type: "finish" });
    await waitFor(() => resultOf(host, r.runId) !== undefined);
    assert.deepEqual(
      resultOf(host, r.runId),
      { outcome: "settled", run: callee, status: "done", output: { verdict: "triaged", ticket: "PROJ-7" } },
      order,
    );
    assert.deepEqual(intakeRuns(host), [], `${order}: one callee, ended`);
  }
});

test("restore after the start returned but before the row named the run: the start is sent again, and the key finds the same run", async () => {
  for (const order of ["caller first", "callee first"] as const) {
    const dispatcher = () => dispatch("intake", { input: intakeDoor, wait: true });
    const r = await rig(dispatcher());
    const callee = await startedRun(r.store, r.runId);
    await parkAll(r.host);
    // The row as it was between the start's answer and the re-write that names the run.
    const stored = (await r.store.load(r.runId))!.snapshot as { effects: Record<string, EffectRow> };
    for (const row of Object.values(stored.effects)) delete (row as { run?: string }).run;
    await r.store.save(r.runId, stored);
    const host = await restoredHost(order === "callee first" ? reversed(r.store) : r.store, dispatcher());
    assert.equal(await startedRun(r.store, r.runId), callee, `${order}: the key found the run it started`);
    assert.deepEqual(intakeRuns(host), [callee], `${order}: no second run`);
    host.sendToGate(callee, "ctl", { type: "finish" });
    await waitFor(() => resultOf(host, r.runId) !== undefined);
    assert.equal((resultOf(host, r.runId) as { run: string }).run, callee);
  }
});

test("a restore whose row names the run, for a slot with no wait, settles `started` at once and starts nothing", async () => {
  // Parked with the run on its row, and restored under a definition with no wait: the row a
  // restart between the re-write and the settle leaves.
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true }));
  const callee = await startedRun(r.store, r.runId);
  await parkAll(r.host);
  const host = await restoredHost(r.store, dispatch("intake", { input: intakeDoor }));
  await waitFor(() => resultOf(host, r.runId) !== undefined);
  assert.deepEqual(resultOf(host, r.runId), { outcome: "started", run: callee });
  assert.deepEqual(intakeRuns(host), [callee], "no second run");
});

test('in-process wait: the slot\'s timeout ends the wait with `status: "live"`, never the run', async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true, timeout: "0.1s" }));
  const callee = await startedRun(r.store, r.runId);
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.deepEqual(resultOf(r.host, r.runId), { outcome: "settled", run: callee, status: "live" });
  assert.equal(r.host.status(callee)?.status, "active");
});

test("in-process wait: a bound over 24.8 days (one setTimeout's most) still holds the wait", async () => {
  const r = await rig(dispatch("intake", { input: intakeDoor, wait: true, timeout: "600h" }));
  const callee = await startedRun(r.store, r.runId);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(resultOf(r.host, r.runId), undefined, "still waiting: the bound has not passed");
  r.host.sendToGate(callee, "ctl", { type: "finish" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.equal((resultOf(r.host, r.runId) as { status: string }).status, "done");
});

test("in-process: the slot's bound holds the start — a run host that does not answer in it settles `unknown`", async () => {
  const store = await mkStore();
  // A key lookup that never answers: the start never comes back.
  const stuck = new Proxy(store, {
    get(target, prop) {
      if (prop === "findByDispatch") return () => new Promise(() => {});
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const r = await rig(dispatch("intake", { input: intakeDoor, timeout: "0.1s" }), { store: stuck });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const out = resultOf(r.host, r.runId) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /did not answer the start of intake within the slot's timeout/);
});

test("a chain of dispatches: a callee that dispatches is depth 1, and the run it starts depth 2", async () => {
  const relay = jr2Setup({
    types: {} as { context: Ctx },
    events: [],
    actors: { next: dispatch("intake", { input: intakeDoor }) },
  }).createMachine({
    id: "relay",
    context: {},
    initial: "go",
    states: {
      go: {
        invoke: {
          src: "next",
          input: () => ({ ticket: "PROJ-8" }),
          onDone: { target: "parked", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      parked: {},
    },
  });
  const r = await rig(dispatch("relay"), { extra: [def("relay", relay)] });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const relayRun = (resultOf(r.host, r.runId) as { run: string }).run;
  await waitFor(() => resultOf(r.host, relayRun) !== undefined);
  const last = (resultOf(r.host, relayRun) as { run: string }).run;
  assert.equal(r.host.status(relayRun)?.dispatchedBy?.depth, 1);
  assert.deepEqual(
    { ...r.host.status(last)?.dispatchedBy, effect: "k" },
    { run: relayRun, slot: "next", effect: "k", depth: 2 },
  );
});

test("a pick that runs a dispatch is held at Rest while it waits, and answered with its output", async () => {
  const review = defineEvent({ name: "request_review", input: z.object({ ticket: z.string() }) });
  const coder = new MockFlueClient();
  const dispatcher = dispatch("intake", { input: intakeDoor, wait: true });
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [review],
    actors: { coder: agentActorWith(() => coder, coderDefinition), start: dispatcher },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "wf",
    context: {},
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid", continue: true } },
        initial: "rest",
        states: {
          rest: {},
          request_review: {
            invoke: { src: "start", input: fromPick(review, () => ({})) as never },
          },
        },
        on: { request_review: ".request_review" },
      },
    },
  });
  const store = await mkStore();
  const host = new RunHost({ store });
  hosts.push(host);
  host.register(def("fx", machine));
  host.register(def("intake", intake));
  const { runId } = await host.start("fx");
  await waitFor(() => coder.admits.length === 1);
  const iid = coder.admits[0]!.instanceId;
  const pick = host.sendToAgent(iid, { type: "request_review", ticket: "PROJ-9" });
  assert.equal(pick.outstanding, true, "held while the dispatched run runs");
  const callee = await startedRun(store, runId);
  assert.equal((host.status(callee)?.context as { ticket: string }).ticket, "PROJ-9", "the pick's param is the body");
  host.sendToGate(callee, "ctl", { type: "finish" });
  const answered = await host.awaitDelivery(iid, pick.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "output",
    actor: "start",
    output: { outcome: "settled", run: callee, status: "done", output: { verdict: "triaged", ticket: "PROJ-9" } },
  });
});

// --- Foreign -------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL("../../../effector/testdata/wire/", import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as Record<string, unknown>;

const effector = {
  effector: () => ({ placement: "instance" as const, service: "svc:8082", key: EFFECTOR_KEY }),
  orchestratorName: "ops-caller",
};
const target = { url: "https://ops.example.com", token: secret("ops-instance") };
const fixtureBody = { ticket: "PROJ-7", note: null, labels: ["ci", 1, true] };

function foreign(fake: FakeEffector, extra: Partial<DispatchDefinition> = {}) {
  return dispatchWith((t) => createEffectorClient({ key: t.key, transport: fake.transport }), "review", {
    target,
    ...extra,
  });
}

async function foreignRig(fake: FakeEffector, extra: Partial<DispatchDefinition> = {}, store?: SnapshotStore) {
  return rig(foreign(fake, extra), { body: fixtureBody, host: effector, ...(store ? { store } : {}) });
}

async function foreignRestored(r: Rig, fake: FakeEffector, extra: Partial<DispatchDefinition> = {}): Promise<RunHost> {
  const host = new RunHost({ store: r.store, ...effector });
  hosts.push(host);
  host.register(def("caller", callerOf(foreign(fake, extra), fixtureBody)));
  host.register(def("intake", intake));
  await host.restore();
  return host;
}

test("foreign: the start request is the golden fixture's — the origin, the body whole, the token by name, the key", async () => {
  const fake = new FakeEffector();
  const r = await foreignRig(fake);
  await waitFor(() => fake.starts.length === 1);
  const { id, req } = fake.starts[0]!;
  const golden = fixture("request.dispatch-start.json");
  assert.deepEqual(req, {
    ...golden,
    dispatchedBy: {
      run: r.runId,
      slot: "start",
      effect: id,
      depth: 1,
      instance: "ops-caller",
    },
  });
  assert.notEqual(
    (req as { dispatchedBy: { instance: string } }).dispatchedBy.instance,
    r.host.status(r.runId)!.instanceId,
    "the caller is named by its Orchestrator, never by a run's Instance ID",
  );
  const [, row] = await rowOf(r.store, r.runId);
  assert.deepEqual(
    [row.state, (row as { placement: string }).placement, (row as { idempotent: boolean }).idempotent],
    ["intent", "instance", true],
  );
});

test("foreign: `started` and `settled` map 1:1, and the row names the run", async () => {
  const fake = new FakeEffector();
  const r = await foreignRig(fake);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "started", run: "remote-1" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.deepEqual(resultOf(r.host, r.runId), { outcome: "started", run: "remote-1" });
  const [, startedRow] = await rowOf(r.store, r.runId);
  assert.deepEqual((startedRow as { output: unknown }).output, { outcome: "started", run: "remote-1" });

  const waits = new FakeEffector();
  const w = await foreignRig(waits, { wait: true });
  await waitFor(() => waits.starts.length === 1);
  assert.equal((waits.starts[0]!.req as { wait: boolean; timeoutMs: number }).wait, true);
  assert.equal((waits.starts[0]!.req as { timeoutMs: number }).timeoutMs, 600_000, "the wait's default bound");
  // The door answered and the wait runs: the running state names the run, and the intent row with it.
  waits.name("remote-2");
  assert.equal(await startedRun(w.store, w.runId), "remote-2");
  const [, waiting] = await rowOf(w.store, w.runId);
  assert.equal(waiting.state, "intent", "the intent row names the callee during the wait");
  const settled = { outcome: "settled", run: "remote-2", status: "done", output: { verdict: "ok" } };
  waits.settle(settled);
  await waitFor(() => resultOf(w.host, w.runId) !== undefined);
  assert.deepEqual(resultOf(w.host, w.runId), settled);
  const [, settledRow] = await rowOf(w.store, w.runId);
  assert.equal((settledRow as { output: { run: string } }).output.run, "remote-2");
});

test("foreign: `refused` carries the door's status and report; `unreachable` is output, not an error", async () => {
  for (const output of [
    { outcome: "refused", status: 422, report: ['the Chart refers to "linter", which the wrapper does not lend'] },
    { outcome: "unreachable", reason: "dial tcp 10.0.0.9:443: connect: connection refused; nothing was started" },
  ]) {
    const fake = new FakeEffector();
    const r = await foreignRig(fake);
    await waitFor(() => fake.starts.length === 1);
    fake.settle(output);
    await waitFor(() => resultOf(r.host, r.runId) !== undefined);
    assert.deepEqual(resultOf(r.host, r.runId), output);
  }
});

test("foreign: a lost answer is found on the replica that took it — one start", async () => {
  const fake = new FakeEffector(["a", "b"]);
  fake.loseNextAnswer = true;
  const r = await foreignRig(fake);
  await waitFor(() => fake.calls.filter((c) => c.method === "GET").length >= 2);
  fake.settle({ outcome: "started", run: "remote-1" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.equal(fake.starts.length, 1);
});

test("foreign: a replica that forgot it is sent it again under the same id — idempotent by construction", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const r = await foreignRig(fake, { wait: true });
  await waitFor(() => fake.starts.length === 1);
  fake.restart(fake.starts[0]!.replica);
  await waitFor(() => fake.starts.length === 2);
  assert.equal(fake.starts[1]!.id, fake.starts[0]!.id, "the same id: the same key at the door");
  fake.settle({ outcome: "settled", run: "remote-1", status: "done" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  assert.equal((resultOf(r.host, r.runId) as { outcome: string }).outcome, "settled");
});

test("foreign restore: the replica that holds it is followed; when none does, it is sent again under its id", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const r = await foreignRig(fake, { wait: true });
  await waitFor(() => fake.starts.length === 1);
  await r.host.stop(r.runId);
  const host = await foreignRestored(r, fake, { wait: true });
  await waitFor(() => fake.calls.filter((c) => c.method === "GET").length >= 2);
  fake.settle({ outcome: "settled", run: "remote-1", status: "done" });
  await waitFor(() => resultOf(host, r.runId) !== undefined);
  assert.equal(fake.starts.length, 1, "found, followed: sent once");

  const forgot = new FakeEffector(["a", "b"]);
  const r2 = await foreignRig(forgot, { wait: true });
  await waitFor(() => forgot.starts.length === 1);
  await r2.host.stop(r2.runId);
  forgot.restart(forgot.starts[0]!.replica);
  await new Promise((res) => setTimeout(res, 20));
  const host2 = await foreignRestored(r2, forgot, { wait: true });
  await waitFor(() => forgot.starts.length === 2);
  assert.equal(forgot.starts[1]!.id, forgot.starts[0]!.id);
  const bound = (n: number) => (forgot.starts[n]!.req as { timeoutMs: number }).timeoutMs;
  assert.ok(bound(1) < bound(0), `the re-send carries what is left of the bound: ${bound(1)} < ${bound(0)}`);
  forgot.settle({ outcome: "settled", run: "remote-2", status: "error" });
  await waitFor(() => resultOf(host2, r2.runId) !== undefined);
  assert.equal((resultOf(host2, r2.runId) as { status: string }).status, "error");
});

test("foreign: a forged answer settles `unknown`, never sent again; a malformed one is the invoke's error", async () => {
  const forged = new FakeEffector(["a"], "a-key-the-orchestrator-does-not-derive");
  const r = await foreignRig(forged);
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const out = resultOf(r.host, r.runId) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /does not carry the Effector's signature/);
  assert.equal(forged.starts.length, 0);

  const malformed = new FakeEffector();
  malformed.malformed = true;
  const m = await foreignRig(malformed);
  await waitFor(() => m.host.status(m.runId)?.value === "faulted");
  assert.match(ctx(m.host, m.runId).fault!, /is not the wire's shape/);
  assert.equal(malformed.calls.length, 1);
});

test("foreign: an Effector output that is not a dispatch's is malformed — an error, never output", async () => {
  const fake = new FakeEffector();
  const r = await foreignRig(fake);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "refused", reason: "an http refusal has no report" });
  await waitFor(() => r.host.status(r.runId)?.value === "faulted");
  assert.match(ctx(r.host, r.runId).fault!, /not a dispatch's/);
});

test("foreign D1: leaving the state stops the polling and records the abort", async () => {
  const fake = new FakeEffector();
  const r = await foreignRig(fake, { wait: true });
  await waitFor(() => fake.starts.length === 1);
  r.host.sendToGate(r.runId, "ctl", { type: "leave" });
  await waitFor(() => r.host.status(r.runId)?.value === "left");
  await new Promise((res) => setTimeout(res, 20));
  const [, row] = await rowOf(r.store, r.runId);
  assert.equal(row.state, "aborted");
  // The Effector's own poll of the door is stopped too: one DELETE (ADR-0071).
  await waitFor(() => fake.stopped.length === 1);
  assert.deepEqual(fake.stopped, [fake.starts[0]!.id]);
  const calls = fake.calls.length;
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(fake.calls.length, calls, "nobody polls it any more");
});

test("foreign: the slot's bound holds when no Effector replica answers — `unreachable`, nothing started", async () => {
  const fake = new FakeEffector([]);
  const r = await foreignRig(fake, { timeout: "0.2s" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const out = resultOf(r.host, r.runId) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unreachable");
  assert.match(out.reason, /within the slot's timeout; nothing was started/);
  assert.equal(fake.starts.length, 0);
});

test("foreign: a start a replica took whose outcome never comes is `unknown` past the slot's bound", async () => {
  const fake = new FakeEffector();
  const r = await foreignRig(fake, { timeout: "0.2s" });
  await waitFor(() => resultOf(r.host, r.runId) !== undefined);
  const out = resultOf(r.host, r.runId) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /a run may have started/);
  assert.equal(fake.starts.length, 1);
});

test("foreign: an Orchestrator with no Effector is the invoke's error; nothing is sent", async () => {
  const fake = new FakeEffector();
  const r = await rig(foreign(fake), { body: fixtureBody });
  await waitFor(() => r.host.status(r.runId)?.value === "faulted");
  assert.match(ctx(r.host, r.runId).fault!, /knows none/);
  assert.equal(fake.calls.length, 0);
});

// --- The definition ------------------------------------------------------------------------------

test("the definition is plain data: the Workflow, the wait, the bound, the target, the placement, the keys", () => {
  const inProcess = dispatchParts("intake", typed({ input: intakeDoor, wait: true }));
  assert.deepEqual(inProcess, {
    kind: "dispatch",
    workflow: "intake",
    wait: true,
    timeoutMs: 600_000,
    inputKeys: ["ticket"],
    secrets: [],
    openSecret: false,
  });
  assert.equal(placementOf(inProcess), "orchestrator");
  assert.deepEqual(inputKeysOf(inProcess), ["ticket"]);
  const away = dispatchParts("task/review-loop", {
    target: { url: "http://jr2-orchestrator.ops.svc:4000/", token: secret("ops") },
  });
  assert.deepEqual(away.target, { url: "http://jr2-orchestrator.ops.svc:4000", token: "ops" });
  assert.deepEqual(away.secrets, ["ops"]);
  assert.equal(away.timeoutMs, 30_000, "without wait the bound is the start's");
  assert.equal(placementOf(away), "instance");
  assert.equal(inputKeysOf(away), undefined, "no schema: the door alone checks, so the walk reads everything");
  assert.ok(isEffect(dispatch("intake")));
  assert.equal(DISPATCHED_BY_HEADER, "jr2-dispatched-by");
});

test("the definition refuses a name `jr2 run` would not take, a url that is not an origin, and a token that is not a named secret", () => {
  for (const name of ["", "Review", "a/b/c", "-x", "a b"]) {
    assert.throws(() => dispatchParts(name), /named as `jr2 run` names it/, name);
  }
  for (const url of [
    "https://ops.example.com/workflows",
    "https://ops.example.com?x=1",
    "https://u:p@ops.example.com",
    "ftp://ops.example.com",
    "ops.example.com",
  ]) {
    assert.throws(() => dispatchParts("x", { target: { url, token: secret("t") } }), /is not an origin/, url);
  }
  assert.throws(
    () => dispatchParts("x", { target: { url: { text: [] } as never, token: secret("t") } }),
    /a string origin/,
  );
  assert.throws(() => dispatchParts("x", { target: { url: "https://a.example.com", token: "t" as never } }), /secret/);
  assert.throws(
    // The type refuses it too (customize-types.test.ts); the load holds it for a caller that casts.
    () => dispatchParts("x", { target: { url: "https://a.example.com", token: secret(open) as never } }),
    /the target is the Open part, not its secret/,
  );
  assert.throws(() => dispatchParts("x", { timeout: "soon" as never }), /positive duration/);
  assert.throws(() => dispatchParts("x", { input: z.string() as never }), /z\.object/);
});

test("an Open target: the slot is placed in the Instance Effector, runs nothing unbound, and binds url and token together", () => {
  const slot = dispatch("review", { target: open });
  assert.equal(slot.effect.kind, "dispatch");
  assert.equal(placementOf(slot.effect), "instance");
  assert.deepEqual(openDispatchParts("review").secrets, []);
  const bind = binderOf(slot)!;
  assert.ok(bind, "an Open slot carries its binder");
  const bound = bind({ target: { url: "https://ops.example.com", token: secret("ops") } } as never);
  assert.deepEqual((bound.effect as { target?: unknown }).target, { url: "https://ops.example.com", token: "ops" });
  assert.throws(() => bind({ url: "https://ops.example.com" } as never), /Open part is its target/);
});

test("a saved dispatch row drops the callee's output once its transition is saved, and keeps the run and status", () => {
  const effects: Record<string, EffectRow> = {
    done: {
      state: "settled",
      kind: "dispatch",
      slot: "start",
      output: { outcome: "settled", run: "r", status: "done", output: { big: "x".repeat(1000) } },
      at: "t",
    },
  };
  effects.refused = {
    state: "settled",
    kind: "dispatch",
    slot: "start",
    output: { outcome: "refused", status: 400, report: ["ticket: required", `the door of "intake" takes {...}`] },
    at: "t",
  };
  dropSavedTails(effects, {});
  assert.deepEqual((effects.done as { output: unknown }).output, { outcome: "settled", run: "r", status: "done" });
  assert.deepEqual(
    (effects.refused as { output: unknown }).output,
    { outcome: "refused", status: 400 },
    "a refusal's report, which can carry the door's whole schema, is a tail",
  );
});
