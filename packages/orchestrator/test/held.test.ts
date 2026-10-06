// The held answer (ADR-0024, ADR-0013): a pick that moves the workflow to work inside the Agent's
// state is OUTSTANDING until the workflow is back at Rest there. Its POST answers at once with a
// delivery id; the answer — the last reply since the pick, and the Allowed picks read after the
// route — is read at `awaitDelivery` (what `GET /agents/:iid/deliveries/:id` serves). No Effects
// exist yet: the child states are a plain `fromPromise`, a Gate, another Agent, a child Machine and
// a timer. Socket-free, through the real `jr2Setup` walk and the real `RunHost`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { OutstandingError } from "../src/registration.ts";
import { SUBMISSION_HARNESS_RESTARTED } from "../src/wire.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import type { HarnessRestarts, SandboxPort } from "../src/workspace.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const ev = (name: string, input: z.ZodObject = z.object({})) => defineEvent({ name, input });
const run_tests = ev("run_tests");
const ask = ev("ask");
const approve = ev("approve", z.object({ note: z.string().optional() }));
const consult = ev("consult");
const advice = ev("advice", z.object({ text: z.string() }));
const delegate = ev("delegate");
const wait = ev("wait");
const chain = ev("chain");
const ship = ev("ship");
const finish = ev("finish");

/** A command stand-in the test settles by hand: each run waits on the next `settle`. */
function controllable() {
  const settles: Array<(out: unknown) => void> = [];
  const logic = fromPromise<unknown>(() => new Promise((resolve) => settles.push(resolve)));
  return { logic, runs: () => settles.length, settle: (out: unknown) => settles.at(-1)?.(out) };
}

const reviewerDefinition = { ...coderDefinition, name: "reviewer" } as typeof coderDefinition;
const child = createMachine({
  initial: "w",
  states: { w: { after: { 10: "f" } }, f: { type: "final" } },
  output: () => ({ verdict: "fine" }),
});

function heldMachine(
  coder: ReturnType<typeof agentActorWith>,
  reviewer: ReturnType<typeof agentActorWith>,
  tests: ReturnType<typeof controllable>["logic"],
) {
  const endpoint = "http://harness.invalid";
  return jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [run_tests, ask, approve, consult, advice, delegate, wait, chain, ship, finish],
    actors: { coder, reviewer, tests, child },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint, sandbox: "ws-1", continue: true } },
        on: { finish: "#wf.done", "agent.fault": "#wf.faulted" },
        initial: "rest",
        states: {
          rest: {
            on: {
              run_tests: "testing",
              ask: "asking",
              consult: "consulting",
              delegate: "delegating",
              wait: "waiting",
              chain: "first",
              ship: "shipping",
            },
          },
          testing: { invoke: { src: "tests", onDone: "rest" } },
          asking: { invoke: { src: "gate", id: "review", input: {} }, on: { approve: "rest" } },
          consulting: {
            invoke: { src: "reviewer", input: { prompt: "Advise.", endpoint } },
            on: { advice: "rest" },
          },
          delegating: { invoke: { src: "child", onDone: "rest" } },
          waiting: { after: { 20: "rest" } },
          first: { invoke: { src: "tests", onDone: "second" } },
          second: { invoke: { src: "gate", id: "second", input: {} }, on: { approve: "rest" } },
          shipping: { invoke: { src: "tests", onDone: "#wf.next" } },
        },
      },
      next: {
        invoke: { src: "coder", input: { prompt: "Carry on.", endpoint, continue: true } },
        on: { finish: "#wf.done" },
      },
      done: { type: "final" },
      faulted: { type: "final" },
    },
  });
}

type Rig = {
  host: RunHost;
  store: SnapshotStore;
  runId: string;
  iid: string;
  coder: MockFlueClient;
  reviewer: MockFlueClient;
  tests: ReturnType<typeof controllable>;
};

function heldDef(
  rig: { coders: MockFlueClient[]; reviewers: MockFlueClient[] },
  tests: ReturnType<typeof controllable>,
): WorkflowDef {
  return {
    name: "held",
    machine: heldMachine(
      agentActorWith(() => new MockFlueClient(), coderDefinition),
      agentActorWith(() => new MockFlueClient(), reviewerDefinition),
      tests.logic,
    ),
    provide: () => {
      const coder = new MockFlueClient();
      const reviewer = new MockFlueClient();
      rig.coders.push(coder);
      rig.reviewers.push(reviewer);
      return {
        actors: {
          coder: agentActorWith(() => coder, coderDefinition),
          reviewer: agentActorWith(() => reviewer, reviewerDefinition),
          tests: tests.logic,
        },
      };
    },
  };
}

async function started(store?: SnapshotStore, sandbox?: SandboxPort): Promise<Rig> {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s, ...(sandbox ? { sandbox } : {}) });
  const clients = { coders: [] as MockFlueClient[], reviewers: [] as MockFlueClient[] };
  const tests = controllable();
  host.register(heldDef(clients, tests));
  const { runId } = await host.start("held");
  const coder = clients.coders[0]!;
  await waitFor(() => coder.admits.length > 0);
  return { host, store: s, runId, iid: coder.admits[0]!.instanceId, coder, reviewer: clients.reviewers[0]!, tests };
}

const value = (rig: Rig) => JSON.stringify(rig.host.status(rig.runId)?.value);

test("a Gate below the Agent's state: outstanding until its answer routes; the answer is the Gate's event and payload", async () => {
  const rig = await started();
  const receipt = rig.host.sendToAgent(rig.iid, { type: "ask" });
  assert.equal(receipt.outstanding, true);
  assert.deepEqual(receipt.allowed, []);
  assert.ok(receipt.since, "since when the pick is held");
  assert.deepEqual(rig.host.status(rig.runId)?.held, [{ agent: "coder", pick: "ask", since: receipt.since }]);

  // A poll that times out answers `outstanding`, and the Harness asks again.
  const early = await rig.host.awaitDelivery(rig.iid, receipt.deliveryId, 10);
  assert.equal(early?.outstanding, true);

  const polled = rig.host.awaitDelivery(rig.iid, receipt.deliveryId);
  rig.host.sendToGate(rig.runId, "review", { type: "approve", note: "ship it" });
  const answer = await polled;
  assert.deepEqual(answer?.answer, {
    kind: "event",
    event: "approve",
    sender: { party: "gate", id: "review" },
    payload: { note: "ship it" },
  });
  assert.equal(answer?.turnComplete, false);
  assert.ok(answer?.allowed.includes("run_tests"), "the Allowed picks after the route: back in `rest`");
  assert.deepEqual(rig.host.status(rig.runId)?.held, [], "answered: nothing is held");
  // The answer is read again on a repeated poll — a lost answer is asked for again.
  assert.deepEqual((await rig.host.awaitDelivery(rig.iid, receipt.deliveryId, 10))?.answer, answer?.answer);
});

test("while a pick is outstanding every other pick is refused — `finish` included — and the work runs on", async () => {
  const rig = await started();
  const receipt = rig.host.sendToAgent(rig.iid, { type: "run_tests" });
  assert.equal(receipt.outstanding, true);
  for (const pick of ["finish", "run_tests", "ask"]) {
    assert.throws(
      () => rig.host.sendToAgent(rig.iid, { type: pick }),
      (err: Error) =>
        err instanceof OutstandingError &&
        err.outstanding === "run_tests" &&
        /"run_tests" is still running/.test(err.message),
    );
  }
  assert.equal(value(rig), JSON.stringify({ work: "testing" }), "xstate never saw `finish`: the work was not stopped");
  assert.equal(rig.tests.runs(), 1, "and never fired twice");
  assert.deepEqual(rig.host.agentSurface(rig.iid)?.allowed, [], "the Allowed picks are empty");

  const polled = rig.host.awaitDelivery(rig.iid, receipt.deliveryId);
  rig.tests.settle({ passed: 3 });
  const answer = await polled;
  assert.deepEqual(answer?.answer, { kind: "output", actor: "tests", output: { passed: 3 } });
  // Answered: `finish` is taken now.
  assert.equal(rig.host.sendToAgent(rig.iid, { type: "finish" }).turnComplete, true);
});

test("another Agent below: its pick is the answer; a child Machine: its output is", async () => {
  const rig = await started();
  const consulting = rig.host.sendToAgent(rig.iid, { type: "consult" });
  await waitFor(() => rig.reviewer.admits.length === 1);
  const reviewerIid = rig.reviewer.admits[0]!.instanceId;
  const advised = rig.host.awaitDelivery(rig.iid, consulting.deliveryId);
  rig.host.sendToAgent(reviewerIid, { type: "advice", text: "split the function" });
  assert.deepEqual((await advised)?.answer, {
    kind: "event",
    event: "advice",
    sender: { party: "agent", id: "reviewer" },
    payload: { text: "split the function" },
  });

  const delegating = rig.host.sendToAgent(rig.iid, { type: "delegate" });
  assert.equal(delegating.outstanding, true);
  const output = await rig.host.awaitDelivery(rig.iid, delegating.deliveryId);
  assert.deepEqual(output?.answer, { kind: "output", actor: "child", output: { verdict: "fine" } });
});

test("a timer the Machine set itself holds the pick, and no reply came: it moved, and nothing ran", async () => {
  const rig = await started();
  const waiting = rig.host.sendToAgent(rig.iid, { type: "wait" });
  assert.equal(waiting.outstanding, true, "the `after` back into the Agent's state holds Rest");
  const answer = await rig.host.awaitDelivery(rig.iid, waiting.deliveryId);
  assert.equal(answer?.answered, true);
  assert.equal(answer?.answer, undefined, "the Machine's own timer is no reply");
  assert.equal(value(rig), JSON.stringify({ work: "rest" }));
});

test("a chain: the answer is the LAST reply since the pick — no false Rest between two links", async () => {
  const rig = await started();
  const chained = rig.host.sendToAgent(rig.iid, { type: "chain" });
  const polled = rig.host.awaitDelivery(rig.iid, chained.deliveryId);
  rig.tests.settle("built");
  await waitFor(() => value(rig) === JSON.stringify({ work: "second" }));
  assert.deepEqual(
    rig.host.status(rig.runId)?.held.map((h) => h.pick),
    ["chain"],
    "still held between links",
  );
  rig.host.sendToGate(rig.runId, "second", { type: "approve" });
  assert.deepEqual((await polled)?.answer, {
    kind: "event",
    event: "approve",
    sender: { party: "gate", id: "second" },
    payload: {},
  });
});

test("a route that leaves the Agent's state: the Turn is over, and the answer goes as a notice to the next continued Turn", async () => {
  const rig = await started();
  const shipping = rig.host.sendToAgent(rig.iid, { type: "ship" });
  const polled = rig.host.awaitDelivery(rig.iid, shipping.deliveryId);
  rig.tests.settle({ pushed: "abc123" });
  const answer = await polled;
  assert.deepEqual(
    { turnComplete: answer?.turnComplete, allowed: answer?.allowed },
    { turnComplete: true, allowed: [] },
  );
  await waitFor(() => rig.coder.admits.length === 2);
  assert.equal(rig.coder.admits[1]!.prompt, "Carry on.", "the next state's prompt is the author's");
  assert.deepEqual(rig.coder.notices[1], [
    {
      kind: "pick-answer",
      scope: "conversation",
      pick: "ship",
      cut: false,
      answer: { kind: "output", actor: "tests", output: { pushed: "abc123" } },
    },
  ]);
});

test("an Orchestrator restart during a hold: the restored host refuses from the Machine, and answers the same poll", async () => {
  const rig = await started();
  const receipt = rig.host.sendToAgent(rig.iid, { type: "ask" });
  const saved = await rig.store.load(rig.runId);
  assert.match(JSON.stringify(saved?.snapshot), new RegExp(receipt.deliveryId), "the hold is saved with the snapshot");
  await rig.host.stop(rig.runId);
  assert.equal(rig.host.parkedDelivery(rig.iid, receipt.deliveryId), true, "parked: its poll is asked again, not over");

  const second = new RunHost({ store: rig.store });
  const clients = { coders: [] as MockFlueClient[], reviewers: [] as MockFlueClient[] };
  second.register(heldDef(clients, controllable()));
  assert.deepEqual((await second.restore()).reattached, [rig.runId]);
  assert.deepEqual(
    second.status(rig.runId)?.held.map((h) => h.pick),
    ["ask"],
  );
  assert.throws(
    () => second.sendToAgent(rig.iid, { type: "finish" }),
    (err: Error) => err instanceof OutstandingError && err.outstanding === "ask",
    "refused after the restart: decided from the restored Machine and the saved hold",
  );
  const polled = second.awaitDelivery(rig.iid, receipt.deliveryId);
  second.sendToGate(rig.runId, "review", { type: "approve", note: "after the restart" });
  const answer = await polled;
  assert.equal(answer?.answered, true);
  assert.deepEqual(answer?.answer, {
    kind: "event",
    event: "approve",
    sender: { party: "gate", id: "review" },
    payload: { note: "after the restart" },
  });
});

test("a delivery that was never outstanding is unknown to the poll", async () => {
  const rig = await started();
  assert.equal(await rig.host.awaitDelivery(rig.iid, "no-such-delivery", 10), undefined);
});

// --- A Harness restart while the Agent's state is busy (ADR-0031) ---------------------------------

test("a Harness restart while a pick is outstanding is no agent.fault: at Rest, jr2 re-admits the same conversation with the answer", async () => {
  const rig = await started();
  const asking = rig.host.sendToAgent(rig.iid, { type: "ask" });
  assert.equal(asking.outstanding, true);
  // The Instance Harness came back: its rebuilt stream settles the cut Submission failed (ADR-0031).
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted (pod restart)");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(value(rig), JSON.stringify({ work: "asking" }), "no fault routed: the Gate still waits");
  assert.equal(rig.coder.admits.length, 1, "nobody is asked while the workflow is busy");

  rig.host.sendToGate(rig.runId, "review", { type: "approve", note: "lgtm" });
  await waitFor(() => rig.coder.admits.length === 2);
  const readmit = rig.coder.admits[1]!;
  assert.equal(readmit.instanceId, rig.iid, "the same conversation: the rebuilt Harness holds it");
  assert.match(readmit.prompt ?? "", /^Your previous turn was cut: the process that ran you restarted/);
  assert.deepEqual(rig.coder.notices[1], [
    {
      kind: "pick-answer",
      scope: "conversation",
      pick: "ask",
      cut: true,
      answer: { kind: "event", event: "approve", sender: { party: "gate", id: "review" }, payload: { note: "lgtm" } },
    },
  ]);
  assert.equal(rig.host.status(rig.runId)?.status, "active");
  // The re-admitted Turn picks on: `finish` is taken, the Turn ends.
  assert.equal(rig.host.sendToAgent(rig.iid, { type: "finish" }).turnComplete, true);
});

test("a Harness restart after the answer was read at Rest but never reached the model: re-admitted at once", async () => {
  const rig = await started();
  const testing = rig.host.sendToAgent(rig.iid, { type: "run_tests" });
  rig.tests.settle("3 passed");
  await waitFor(() => value(rig) === JSON.stringify({ work: "rest" }));
  // Answered at Rest — but the poll that would have carried it died with the Harness.
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
  await waitFor(() => rig.coder.admits.length === 2);
  assert.deepEqual(rig.coder.notices[1]?.[0], {
    kind: "pick-answer",
    scope: "conversation",
    pick: "run_tests",
    cut: true,
    answer: { kind: "output", actor: "tests", output: "3 passed" },
  });
  assert.equal(value(rig), JSON.stringify({ work: "rest" }));
  void testing;
});

test("a Harness restart at Rest with nothing unread is the fault it always was", async () => {
  const rig = await started();
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
  await waitFor(() => rig.host.status(rig.runId) === undefined);
  assert.equal((await rig.host.read(rig.runId))?.value, "faulted");
});

test("a Sandbox Harness restart the watch sees while a pick is outstanding: no fault, the same Turn re-admitted at Rest (ADR-0021, ADR-0031)", async () => {
  const listeners = new Set<(seen: HarnessRestarts) => void>();
  let seen: HarnessRestarts = { restartCount: 0 };
  const port = {
    harnessRestarts: (_name: string, listener: (seen: HarnessRestarts) => void) => {
      listeners.add(listener);
      queueMicrotask(() => listeners.has(listener) && listener(seen));
      return () => listeners.delete(listener);
    },
    memoryFault: async () => undefined,
  } as unknown as SandboxPort;
  const rig = await started(undefined, port);
  await new Promise((r) => setTimeout(r, 5));
  rig.host.sendToAgent(rig.iid, { type: "run_tests" });
  seen = { restartCount: 1, lastTerminated: { reason: "Error", exitCode: 137, finishedAt: "2026-10-06T10:00:00Z" } };
  for (const l of listeners) l(seen);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(value(rig), JSON.stringify({ work: "testing" }), "no fault: the command still runs");
  assert.equal(rig.tests.runs(), 1);
  rig.tests.settle("green");
  await waitFor(() => rig.coder.admits.length === 2);
  assert.equal(rig.coder.admits[1]!.instanceId, rig.iid);
  assert.equal(rig.coder.notices[1]?.[0]?.kind, "pick-answer");
  // The re-admitted Turn is held to the new mark: the same restart does not cut it again.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rig.host.status(rig.runId)?.status, "active");
});
