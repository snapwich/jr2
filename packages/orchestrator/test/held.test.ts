// The held answer (ADR-0024, ADR-0013): a pick that moves the workflow to work inside the Agent's
// state is OUTSTANDING until the workflow is back at Rest there. Its POST answers at once with a
// delivery id; the answer — the last reply since the pick, and the Allowed picks read after the
// route — is read at `awaitDelivery` (what `GET /agents/:iid/deliveries/:id` serves). No Effects
// exist yet: the child states are a plain `fromPromise`, a Gate, another Agent, a child Machine and
// a timer. Socket-free, through the real `jr2Setup` walk and the real `RunHost`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, createMachine, fromCallback, fromPromise, raise, sendTo } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { OutstandingError } from "../src/registration.ts";
import { answer } from "../src/pick.ts";
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
const decide = ev("decide");
const settle = ev("settle");
const finish = ev("finish");
const bounce = ev("bounce");
const draft = ev("draft");

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
/** A decision Machine that is final as it starts: its output replies inside the pick's own send. */
const decider = createMachine({
  initial: "f",
  states: { f: { type: "final" } },
  output: () => ({ verdict: "sync" }),
});

function heldMachine(
  coder: ReturnType<typeof agentActorWith>,
  reviewer: ReturnType<typeof agentActorWith>,
  tests: ReturnType<typeof controllable>["logic"],
) {
  const endpoint = "http://harness.invalid";
  return jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [
      run_tests,
      ask,
      approve,
      consult,
      advice,
      delegate,
      wait,
      chain,
      ship,
      decide,
      settle,
      finish,
      bounce,
      draft,
    ],
    actors: { coder, reviewer, tests, child, decider },
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
              decide: "deciding",
              settle: "settling",
              bounce: "bouncing",
              draft: "drafting",
            },
          },
          // A guard straight back: entered and left inside the pick's own send.
          bouncing: { always: "rest" },
          // A mode: no invoke, at Rest there, with other Allowed picks — `draft` again targets the
          // state it is taken in, and enters nothing it leaves.
          drafting: { on: { finish: "#wf.done", draft: "drafting" } },
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
          deciding: { invoke: { src: "decider", onDone: "rest" } },
          settling: { invoke: { src: "decider", onDone: "#wf.next" } },
        },
      },
      next: {
        invoke: { src: "coder", input: { prompt: "Carry on.", endpoint, continue: true } },
        on: { finish: "#wf.done", "agent.fault": "#wf.faulted" },
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

test("a child that replies inside the pick's own send: the receipt is the answer — the reply is not lost", async () => {
  const rig = await started();
  const receipt = rig.host.sendToAgent(rig.iid, { type: "decide" });
  assert.equal(receipt.outstanding, undefined, "back at Rest before the POST answers: nothing to poll");
  assert.equal(receipt.answered, true);
  assert.deepEqual(receipt.answer, { kind: "output", actor: "decider", output: { verdict: "sync" } });
  assert.equal(receipt.turnComplete, false);
  assert.ok(receipt.allowed.includes("run_tests"), "the Allowed picks after the route: back in `rest`");
  assert.equal(value(rig), JSON.stringify({ work: "rest" }));
  assert.deepEqual(rig.host.status(rig.runId)?.held, [], "nothing is held");
});

test("a guard straight back: answered, it moved and nothing ran; a move to a mode: the plain receipt", async () => {
  const rig = await started();
  const back = rig.host.sendToAgent(rig.iid, { type: "bounce" });
  assert.deepEqual(
    { moved: back.moved, answered: back.answered, answer: back.answer, turnComplete: back.turnComplete },
    { moved: true, answered: true, answer: undefined, turnComplete: false },
  );
  assert.equal(back.straightBack, true, "the one answer that says nothing ran");
  assert.equal(back.outstanding, undefined, "back at Rest before the POST answers: nothing to poll");
  assert.ok(back.allowed.includes("run_tests"), "the Allowed picks after the route: back in `rest`");
  assert.equal(value(rig), JSON.stringify({ work: "rest" }));

  const mode = rig.host.sendToAgent(rig.iid, { type: "draft" });
  assert.deepEqual(
    { moved: mode.moved, answered: mode.answered, turnComplete: mode.turnComplete, allowed: mode.allowed },
    { moved: true, answered: undefined, turnComplete: false, allowed: ["draft", "finish"] },
  );
  assert.equal(value(rig), JSON.stringify({ work: "drafting" }));

  // A target to the state the pick is taken in: the same state value, and its target still active.
  // It entered nothing it left, so it is no guard straight back: the plain receipt.
  const self = rig.host.sendToAgent(rig.iid, { type: "draft" });
  assert.deepEqual(
    { moved: self.moved, answered: self.answered, turnComplete: self.turnComplete, allowed: self.allowed },
    { moved: true, answered: undefined, turnComplete: false, allowed: ["draft", "finish"] },
  );
  assert.equal(value(rig), JSON.stringify({ work: "drafting" }));
});

test("a child that replies inside the pick's own send and routes out: the Turn is over, and the answer goes as a notice", async () => {
  const rig = await started();
  const receipt = rig.host.sendToAgent(rig.iid, { type: "settle" });
  assert.deepEqual(
    { answered: receipt.answered, turnComplete: receipt.turnComplete, allowed: receipt.allowed },
    { answered: true, turnComplete: true, allowed: [] },
  );
  await waitFor(() => rig.coder.admits.length === 2);
  assert.deepEqual(rig.coder.notices[1], [
    {
      kind: "pick-answer",
      scope: "conversation",
      pick: "settle",
      cut: false,
      answer: { kind: "output", actor: "decider", output: { verdict: "sync" } },
    },
  ]);
});

test("a timer the Machine set itself holds the pick, and no reply came: answered with no reply, never a guard straight back", async () => {
  const rig = await started();
  const waiting = rig.host.sendToAgent(rig.iid, { type: "wait" });
  assert.equal(waiting.outstanding, true, "the `after` back into the Agent's state holds Rest");
  const answer = await rig.host.awaitDelivery(rig.iid, waiting.deliveryId);
  assert.equal(answer?.answered, true);
  assert.equal(answer?.answer, undefined, "the Machine's own timer is no reply");
  assert.equal(answer?.straightBack, undefined, "it was outstanding: not a guard straight back");
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

test("a FRESH picking Turn whose route leaves: no notice — a later continued Turn of the same slot never made the pick", async () => {
  const tests = controllable();
  const coders: MockFlueClient[] = [];
  const endpoint = "http://harness.invalid";
  const machine = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [ship, settle, finish],
      actors: { coder, tests: tests.logic, decider },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "work",
      states: {
        work: {
          // No `continue`: this Turn's conversation is its own, and ends with it.
          invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: {
            rest: { on: { ship: "shipping", settle: "settling" } },
            shipping: { invoke: { src: "tests", onDone: "#wf.next" } },
            settling: { invoke: { src: "decider", onDone: "#wf.next" } },
          },
        },
        next: {
          invoke: { src: "coder", input: { prompt: "Carry on.", endpoint, continue: true } },
          on: { finish: "#wf.done" },
        },
        done: { type: "final" },
      },
    });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "fresh",
    machine: machine(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => {
      const coder = new MockFlueClient();
      coders.push(coder);
      return { actors: { coder: agentActorWith(() => coder, coderDefinition), tests: tests.logic } };
    },
  });

  // Held, then answered out of the Agent's state.
  await host.start("fresh");
  await waitFor(() => coders[0]!.admits.length === 1);
  const shipping = host.sendToAgent(coders[0]!.admits[0]!.instanceId, { type: "ship" });
  assert.equal(shipping.outstanding, true);
  const polled = host.awaitDelivery(coders[0]!.admits[0]!.instanceId, shipping.deliveryId);
  tests.settle({ pushed: "abc123" });
  assert.equal((await polled)?.turnComplete, true);
  await waitFor(() => coders[0]!.admits.length === 2);
  assert.equal(coders[0]!.admits[1]!.prompt, "Carry on.");
  assert.deepEqual(coders[0]!.notices[1], [], "the continued Turn hears no pick it never made");

  // Answered inside the pick's own send, out of the Agent's state.
  await host.start("fresh");
  await waitFor(() => coders[1]!.admits.length === 1);
  const settled = host.sendToAgent(coders[1]!.admits[0]!.instanceId, { type: "settle" });
  assert.equal(settled.turnComplete, true);
  await waitFor(() => coders[1]!.admits.length === 2);
  assert.deepEqual(coders[1]!.notices[1], [], "nor one answered in the pick's own send");
});

test("a per-step timeout brings the Machine back to Rest inside the Agent's state while the second link runs: the answer is the first link's reply, the last since the pick", async () => {
  const go = ev("go");
  const endpoint = "http://harness.invalid";
  const rig = async () => {
    const coders: MockFlueClient[] = [];
    const work = fromPromise(async () => ({ built: true }));
    const never = fromPromise(() => new Promise<never>(() => {}));
    const machine = (coder: ReturnType<typeof agentActorWith>) =>
      jr2Setup({
        types: {} as { context: Record<string, never> },
        events: [go, finish],
        actors: { coder, work, never },
      }).createMachine({
        id: "t",
        context: {},
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint, sandbox: "ws-1" } },
            on: { finish: "#t.done" },
            initial: "rest",
            states: {
              rest: { on: { go: "first" } },
              first: { invoke: { src: "work", onDone: "second" } },
              // A per-step timeout: it exits the second link and comes back to Rest.
              second: { invoke: { src: "never", onDone: "rest" }, after: { 40: "rest" } },
            },
          },
          done: { type: "final" },
        },
      });
    const host = new RunHost({ store: await mkStore() });
    host.register({
      name: "step-timeout",
      machine: machine(agentActorWith(() => new MockFlueClient(), coderDefinition)),
      provide: () => {
        const coder = new MockFlueClient();
        coders.push(coder);
        return { actors: { coder: agentActorWith(() => coder, coderDefinition), work, never } };
      },
    });
    const { runId } = await host.start("step-timeout");
    await waitFor(() => coders[0]?.admits.length === 1);
    return { host, runId, coder: coders[0]!, iid: coders[0]!.admits[0]!.instanceId };
  };
  const built = { kind: "output", actor: "work", output: { built: true } };

  // The poll reads it.
  {
    const { host, iid } = await rig();
    const going = host.sendToAgent(iid, { type: "go" });
    assert.equal(going.outstanding, true);
    const answer = await host.awaitDelivery(iid, going.deliveryId);
    assert.deepEqual(
      { turnComplete: answer?.turnComplete, answer: answer?.answer, allowed: answer?.allowed },
      { turnComplete: false, answer: built, allowed: ["finish", "go"] },
    );
    assert.ok(answer && !("stopped" in answer), "no answer kind beyond the reply (ADR-0024)");
    await host.close();
  }
  // A Harness restart cut the poll: the re-admission's notice carries the same answer.
  {
    const { host, runId, coder, iid } = await rig();
    host.sendToAgent(iid, { type: "go" });
    coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
    await waitFor(() => coder.admits.length === 2);
    assert.deepEqual(coder.notices[1], [
      { kind: "pick-answer", scope: "conversation", pick: "go", cut: true, answer: built },
    ]);
    assert.equal(host.status(runId)?.status, "active");
    await host.close();
  }
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

test("a restore that ends the held Turn and starts another at the same address before anything settles: the hold is the first Turn's", async () => {
  const go = ev("go");
  const bounce = ev("bounce");
  const endpoint = "http://harness.invalid";
  // The child below the Agent's state sends `bounce` as it starts — on the restore only. `bounce`
  // re-enters the Agent's state: the restored Turn ends, and a new one registers the same address
  // (`continue: true`), all before the first persist after the restore.
  let restoring = false;
  const bouncer = fromCallback(({ sendBack }) => {
    if (restoring) sendBack({ type: "bounce" });
  });
  const coders: MockFlueClient[] = [];
  const def = (): WorkflowDef => ({
    name: "bounce",
    machine: jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [go, bounce, finish],
      actors: { coder: agentActorWith(() => new MockFlueClient(), coderDefinition), bouncer },
    }).createMachine({
      id: "t",
      context: {},
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint, sandbox: "ws-1", continue: true } },
          on: { bounce: { target: "#t.w", reenter: true }, finish: "#t.done" },
          initial: "rest",
          states: { rest: { on: { go: "running" } }, running: { invoke: { src: "bouncer" } } },
        },
        done: { type: "final" },
      },
    }),
    provide: () => {
      const coder = new MockFlueClient();
      coders.push(coder);
      return { actors: { coder: agentActorWith(() => coder, coderDefinition), bouncer } };
    },
  });
  const store = await mkStore();
  const first = new RunHost({ store });
  first.register(def());
  const { runId } = await first.start("bounce");
  await waitFor(() => coders[0]?.admits.length === 1);
  const iid = coders[0]!.admits[0]!.instanceId;
  const going = first.sendToAgent(iid, { type: "go" });
  assert.equal(going.outstanding, true);
  await new Promise((r) => setTimeout(r, 5));
  await first.stop(runId);

  restoring = true;
  const second = new RunHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  const answer = await second.awaitDelivery(iid, going.deliveryId, 1_000);
  assert.equal(answer?.answered, true, "answered, not held by a Turn that is not the pick's");
  assert.equal(answer?.turnComplete, true, "the restored Turn ended; the Turn at the same address is another");
  assert.deepEqual(answer?.allowed, []);
  await second.close();
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

test("a re-admission after a cut asks the rebuilt Harness for the conversation: one it cannot read is told (ADR-0062)", async () => {
  const rig = await started();
  rig.host.sendToAgent(rig.iid, { type: "ask" });
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted (pod restart)");
  rig.coder.held = false;
  const asked = rig.coder.heldAsked.length;
  rig.host.sendToGate(rig.runId, "review", { type: "approve" });
  await waitFor(() => rig.coder.admits.length === 2);
  assert.deepEqual(rig.coder.heldAsked.slice(asked), [rig.iid], "the re-admission asked for its conversation");
  assert.deepEqual(
    rig.coder.notices[1]?.map((n) => n.kind),
    ["conversation-new", "pick-answer"],
    "the lost conversation is news, then the cut pick's answer",
  );
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

test("a poll whose caller went away read nothing: the Harness restart that cut it re-admits with the answer (ADR-0031)", async () => {
  const rig = await started();
  const testing = rig.host.sendToAgent(rig.iid, { type: "run_tests" });
  // The killed Harness's last poll: the Orchestrator still holds it when the answer lands, but the
  // connection is gone, so no model reads what it would answer.
  const gone = new AbortController();
  const polled = rig.host.awaitDelivery(rig.iid, testing.deliveryId, 60_000, gone.signal);
  gone.abort();
  rig.tests.settle("3 passed");
  await waitFor(() => value(rig) === JSON.stringify({ work: "rest" }));
  assert.equal((await polled)?.outstanding, true, "the poll ended with its caller, before the answer");
  // The rebuilt Harness's stream says the restart only now: at Rest, with the answer unread.
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
  await waitFor(() => rig.coder.admits.length === 2);
  assert.deepEqual(rig.coder.notices[1]?.[0], {
    kind: "pick-answer",
    scope: "conversation",
    pick: "run_tests",
    cut: true,
    answer: { kind: "output", actor: "tests", output: "3 passed" },
  });
  assert.equal(rig.host.status(rig.runId)?.status, "active", "no agent.fault");
});

test("a stopping Harness cut a Turn that waited on a Gate: its poll read nothing, and the Gate's later answer re-admits the same conversation with it (ADR-0031)", async () => {
  const rig = await started();
  const asking = rig.host.sendToAgent(rig.iid, { type: "ask" });
  // The draining Harness drops the poll it holds, then settles the Turn as a restart.
  const cut = new AbortController();
  const polled = rig.host.awaitDelivery(rig.iid, asking.deliveryId, 60_000, cut.signal);
  cut.abort();
  assert.equal((await polled)?.outstanding, true, "the dropped poll took no answer");
  rig.coder.faultSettled(
    SUBMISSION_HARNESS_RESTARTED,
    "the Harness stopped while this Turn waited only on its pick's answer; the workflow runs on (ADR-0031)",
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(value(rig), JSON.stringify({ work: "asking" }), "no fault: the Gate still waits on its human");
  assert.equal(rig.coder.admits.length, 1, "nobody is asked while the workflow is busy");

  rig.host.sendToGate(rig.runId, "review", { type: "approve", note: "after the rollout" });
  await waitFor(() => rig.coder.admits.length === 2);
  assert.equal(rig.coder.admits[1]!.instanceId, rig.iid, "the same conversation");
  assert.match(rig.coder.admits[1]!.prompt ?? "", /^Your previous turn was cut/);
  assert.deepEqual(rig.coder.notices[1], [
    {
      kind: "pick-answer",
      scope: "conversation",
      pick: "ask",
      cut: true,
      answer: {
        kind: "event",
        event: "approve",
        sender: { party: "gate", id: "review" },
        payload: { note: "after the rollout" },
      },
    },
  ]);
  assert.equal(rig.host.status(rig.runId)?.status, "active");
});

test("a Harness restart at Rest with nothing unread is the fault it always was", async () => {
  const rig = await started();
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
  await waitFor(() => rig.host.status(rig.runId) === undefined);
  assert.equal((await rig.host.read(rig.runId))?.value, "faulted");
});

test("a Harness restart at Rest in the NEXT continued Turn: the earlier Turn's answer, gone as a notice, is not unread — the fault it always was", async () => {
  const rig = await started();
  const shipping = rig.host.sendToAgent(rig.iid, { type: "ship" });
  assert.equal(shipping.outstanding, true);
  // The route leaves the Agent's state: the Turn-end abort cuts the poll, so nothing reads the hold.
  rig.tests.settle({ pushed: "abc123" });
  await waitFor(() => rig.coder.admits.length === 2);
  assert.equal(rig.coder.admits[1]!.instanceId, rig.iid, "the next Turn continues the same address");
  assert.equal(rig.coder.notices[1]?.[0]?.kind, "pick-answer", "the answer went as a notice");
  // At Rest in `next`, nothing running and nothing unread of THIS Turn.
  rig.coder.faultSettled(SUBMISSION_HARNESS_RESTARTED, "Harness restarted");
  await waitFor(() => rig.host.status(rig.runId) === undefined);
  assert.equal((await rig.host.read(rig.runId))?.value, "faulted");
  assert.equal(rig.coder.admits.length, 2, "nobody is re-admitted");
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

test("a timer with no target holds nothing: the pick is answered at once, and the timer's assign opens the guarded picks later", async () => {
  const revise = ev("revise");
  const submit = ev("submit");
  const endpoint = "http://harness.invalid";
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: { read: boolean } },
      events: [ask, revise, submit],
      actors: { coder },
    }).createMachine({
      id: "wf",
      context: { read: false },
      initial: "notes",
      states: {
        notes: {
          invoke: { src: "coder", input: { prompt: "Notes.", endpoint, continue: true } },
          initial: "drafting",
          states: {
            drafting: { on: { ask: "reviewing" } },
            reviewing: {
              entry: assign({ read: false }),
              after: { 30: { actions: assign({ read: true }) } },
              on: {
                revise: { guard: ({ context }) => context.read, target: "drafting" },
                submit: { guard: ({ context }) => context.read, target: "#wf.done" },
              },
            },
          },
        },
        done: { type: "final" },
      },
    });
  const clients: MockFlueClient[] = [];
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "guarded",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => {
      const coder = new MockFlueClient();
      clients.push(coder);
      return { actors: { coder: agentActorWith(() => coder, coderDefinition) } };
    },
  });
  await host.start("guarded");
  await waitFor(() => (clients[0]?.admits.length ?? 0) > 0);
  const iid = clients[0]!.admits[0]!.instanceId;

  const asked = host.sendToAgent(iid, { type: "ask" });
  assert.equal(asked.outstanding, undefined, "answered at once: the timer moves the workflow to no state");
  assert.deepEqual(asked.allowed, [], "nothing is allowed yet");
  const early = host.sendToAgent(iid, { type: "submit" });
  assert.deepEqual({ moved: early.moved, allowed: early.allowed }, { moved: false, allowed: [] }, "the correction");
  await waitFor(() => (host.agentSurface(iid)?.allowed.length ?? 0) > 0);
  assert.deepEqual([...(host.agentSurface(iid)?.allowed ?? [])].sort(), ["revise", "submit"]);
  await host.close();
});

// --- The answer comes from below the Agent's state (ADR-0024) -------------------------------------

test("a reply from outside the states below the Agent's is no link: a sibling region's Gate and child answer nothing", async () => {
  const note = ev("note", z.object({ text: z.string() }));
  const side = controllable();
  const endpoint = "http://harness.invalid";
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [wait, note, finish],
      actors: { coder, side: side.logic },
    }).createMachine({
      id: "wf",
      context: {},
      type: "parallel",
      states: {
        main: {
          initial: "work",
          states: {
            work: {
              invoke: { src: "coder", input: { prompt: "Work.", endpoint, continue: true } },
              on: { finish: "#wf.main.done" },
              initial: "rest",
              states: { rest: { on: { wait: "waiting" } }, waiting: { after: { 40: "rest" } } },
            },
            done: { type: "final" },
          },
        },
        // The Pool's wake Gate shape: a Gate and a child in a sibling root region.
        aside: {
          initial: "open",
          states: {
            open: {
              invoke: [
                { src: "gate", id: "side", input: {} },
                { src: "side", id: "job" },
              ],
              on: { note: "noted" },
            },
            noted: {},
          },
        },
      },
    });
  const clients: MockFlueClient[] = [];
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "sibling",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => {
      const coder = new MockFlueClient();
      clients.push(coder);
      return { actors: { coder: agentActorWith(() => coder, coderDefinition), side: side.logic } };
    },
  });
  const { runId } = await host.start("sibling");
  await waitFor(() => (clients[0]?.admits.length ?? 0) > 0);
  const iid = clients[0]!.admits[0]!.instanceId;

  const waiting = host.sendToAgent(iid, { type: "wait" });
  assert.equal(waiting.outstanding, true);
  const polled = host.awaitDelivery(iid, waiting.deliveryId);
  side.settle({ unrelated: true });
  await new Promise((r) => setTimeout(r, 5));
  host.sendToGate(runId, "side", { type: "note", text: "unrelated" });
  const answer = await polled;
  assert.equal(answer?.answered, true);
  assert.equal(answer?.answer, undefined, "no reply came from below the Agent's state");
  await host.close();
});

// --- Who moved the Machine out: the route of the last reply, or something that stopped the work ---

/**
 * A pick `go` from `w.rest` into `w.running`, whose child states the case writes. The Agent's state
 * `w` leaves to `next` on `out` (a Machine-own event, or a timer), on `abort` from the `side` child
 * invoked ON `w` (outside the states below the Agent's), and on a Turn-timeout `after` when asked.
 * A case may invoke `report` below: it replies `abort` once and keeps running.
 */
async function routeRig(
  states: Record<string, unknown>,
  opts: { turnTimeout?: number } = {},
): Promise<{ host: RunHost; iid: string; coder: MockFlueClient; poke: () => void }> {
  const go = ev("go");
  const out = ev("out");
  const abort = ev("abort");
  const endpoint = "http://harness.invalid";
  const coders: MockFlueClient[] = [];
  let poke = () => {};
  const side = fromCallback(({ sendBack }) => {
    poke = () => sendBack({ type: "abort" });
  });
  const work = fromPromise(async () => ({ built: true }));
  // A child below that replies `abort` and keeps running.
  const report = fromCallback(({ sendBack }) => {
    const t = setTimeout(() => sendBack({ type: "abort" }), 5);
    return () => clearTimeout(t);
  });
  const never = fromPromise(() => new Promise<never>(() => {}));
  const fail = fromPromise<never>(async () => {
    throw new Error("secret-ish internals");
  });
  const machine = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [go, out, abort, finish],
      actors: { coder, side, work, report, never, fail },
    }).createMachine({
      id: "t",
      context: {},
      initial: "w",
      states: {
        w: {
          invoke: [
            { src: "coder", input: { prompt: "Fix the ticket.", endpoint, sandbox: "ws-1", continue: true } },
            { src: "side", id: "side" },
          ],
          on: { out: "#t.next", abort: "#t.next" },
          ...(opts.turnTimeout !== undefined ? { after: { [opts.turnTimeout]: "#t.next" } } : {}),
          initial: "rest",
          states: { rest: { on: { go: "running" } }, ...states } as never,
        },
        next: {
          invoke: { src: "coder", input: { prompt: "Carry on.", endpoint, continue: true } },
          on: { finish: "#t.done" },
        },
        done: { type: "final" },
      },
    });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "route",
    machine: machine(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => {
      const coder = new MockFlueClient();
      coders.push(coder);
      return { actors: { coder: agentActorWith(() => coder, coderDefinition), side, work, report, never, fail } };
    },
  });
  await host.start("route");
  await waitFor(() => coders[0]?.admits.length === 1);
  return { host, iid: coders[0]!.admits[0]!.instanceId, coder: coders[0]!, poke: () => poke() };
}

/** Pick `go`, run `then` while the pick is outstanding, and read the answer and the next Turn's notice. */
async function picked(rig: Awaited<ReturnType<typeof routeRig>>, then: () => void = () => {}) {
  const going = rig.host.sendToAgent(rig.iid, { type: "go" });
  assert.equal(going.outstanding, true, "the pick is outstanding");
  const polled = rig.host.awaitDelivery(rig.iid, going.deliveryId);
  then();
  const answer = await polled;
  await waitFor(() => rig.coder.admits.length === 2);
  await rig.host.close();
  return {
    answer: { turnComplete: answer?.turnComplete, stopped: answer?.stopped, answer: answer?.answer },
    notice: rig.coder.notices[1],
  };
}

const built = { kind: "output", actor: "work", output: { built: true } } as const;
const answeredBuilt = {
  answer: { turnComplete: true, stopped: undefined, answer: built },
  notice: [{ kind: "pick-answer", scope: "conversation", pick: "go", cut: false, answer: built }],
};
const stoppedNoReply = {
  answer: { turnComplete: true, stopped: true, answer: undefined },
  notice: [{ kind: "pick-answer", scope: "conversation", pick: "go", cut: false, stopped: true }],
};
const stoppedAfterBuilt = {
  answer: { turnComplete: true, stopped: true, answer: built },
  notice: [{ kind: "pick-answer", scope: "conversation", pick: "go", cut: false, stopped: true, answer: built }],
};

test("the reply's own route leaves through an immediate event the Machine sends itself: the answer is the reply, never stopped", async () => {
  const self = sendTo(({ self }) => self, { type: "out" });
  const cases: Record<string, Record<string, unknown>> = {
    "sendTo(self) in onDone": { running: { invoke: { src: "work", onDone: { actions: self } } } },
    "sendTo(self) in the next state's entry": {
      running: { invoke: { src: "work", onDone: "after" } },
      after: { entry: self },
    },
    "raise in onDone": { running: { invoke: { src: "work", onDone: { actions: raise({ type: "out" }) } } } },
  };
  for (const [name, states] of Object.entries(cases)) {
    assert.deepEqual(await picked(await routeRig(states)), answeredBuilt, name);
  }
});

test("a reply from a child that still runs, whose route sends the Machine an immediate event that leaves: the answer is the reply, never stopped", async () => {
  // The work below still runs when the Machine's own event moves it out, so only the rule that the
  // event is part of the reply's route keeps the answer from saying the work was stopped.
  const abortReply = { kind: "event", event: "abort", payload: {} };
  const states = {
    running: { invoke: { src: "report" }, on: { abort: { actions: sendTo(({ self }) => self, { type: "out" }) } } },
  };
  assert.deepEqual(await picked(await routeRig(states)), {
    answer: { turnComplete: true, stopped: undefined, answer: abortReply },
    notice: [{ kind: "pick-answer", scope: "conversation", pick: "go", cut: false, answer: abortReply }],
  });
});

test("something other than the pick's route leaves while the work below still runs: the work was stopped, and the answer says so", async () => {
  const running = { running: { invoke: { src: "never" } } };
  assert.deepEqual(
    await picked(await routeRig(running, { turnTimeout: 30 })),
    stoppedNoReply,
    "a Turn-timeout `after`",
  );
  const outside = await routeRig(running);
  assert.deepEqual(await picked(outside, outside.poke), stoppedNoReply, "an event from outside the states below");
});

test("a chain stopped in its second link keeps the first link's reply: the answer says the work stopped, and carries it", async () => {
  // The first link replied, and its route started the second; something other than a route leaves
  // while the second still runs. The first link's reply is the last since the pick: kept, never
  // dropped, and the answer says the pick's work did not finish.
  for (const [name, timer] of [
    ["delayed sendTo(self)", sendTo(({ self }) => self, { type: "out" }, { delay: 30 })],
    ["delayed raise", raise({ type: "out" }, { delay: 30 })],
  ] as const) {
    const chain = {
      running: { invoke: { src: "work", onDone: "second" } },
      second: { entry: timer, invoke: { src: "never" } },
    };
    assert.deepEqual(await picked(await routeRig(chain)), stoppedAfterBuilt, `a chain cut by a ${name}`);
  }
  const chain = { running: { invoke: { src: "work", onDone: "second" } }, second: { invoke: { src: "never" } } };
  assert.deepEqual(
    await picked(await routeRig(chain, { turnTimeout: 30 })),
    stoppedAfterBuilt,
    "a chain cut by a Turn timeout",
  );
  const outside = await routeRig(chain);
  assert.deepEqual(
    await picked(outside, () => setTimeout(outside.poke, 20)),
    stoppedAfterBuilt,
    "a chain cut by an event from outside the states below",
  );
});

test("a guard straight back is still answered `straightBack`: nothing ran, so nothing was stopped", async () => {
  const rig = await routeRig({ running: { always: "rest" } });
  const back = rig.host.sendToAgent(rig.iid, { type: "go" });
  await rig.host.close();
  assert.deepEqual(
    { answered: back.answered, straightBack: back.straightBack, stopped: back.stopped },
    { answered: true, straightBack: true, stopped: undefined },
  );
});

test("a child's error below the Agent's state gives the answer no reply; the operator reads it on the run's feed (ADR-0024)", async () => {
  const rig = await routeRig({ running: { invoke: { src: "fail", onError: "rest" } } });
  const runId = rig.host.agentSurface(rig.iid)!.runId;
  const feed: unknown[] = [];
  rig.host.subscribe(runId, (e) => {
    if (e.kind === "child-error") feed.push(e);
  });
  const going = rig.host.sendToAgent(rig.iid, { type: "go" });
  const answer = await rig.host.awaitDelivery(rig.iid, going.deliveryId);
  await rig.host.close();
  assert.equal(answer?.answer, undefined, "no reply: the Agent is not told");
  assert.doesNotMatch(JSON.stringify(answer), /secret-ish internals/);
  assert.deepEqual(feed, [
    { kind: "child-error", agent: "coder", pick: "go", child: "fail", error: "secret-ish internals" },
  ]);
});

test("an author tells the Agent a child's error explicitly: `answer(...)` on the `onError` route is the answer (ADR-0024, ADR-0067)", async () => {
  const told = answer(({ event }) => {
    const { error } = event as { error?: unknown };
    return { failed: error instanceof Error ? error.message : String(error) };
  });
  const rig = await routeRig({ running: { invoke: { src: "fail", onError: { target: "rest", actions: told } } } });
  const runId = rig.host.agentSurface(rig.iid)!.runId;
  const feed: unknown[] = [];
  rig.host.subscribe(runId, (e) => {
    if (e.kind === "child-error") feed.push(e);
  });
  const going = rig.host.sendToAgent(rig.iid, { type: "go" });
  assert.equal(going.outstanding, true);
  const answered = await rig.host.awaitDelivery(rig.iid, going.deliveryId);
  await rig.host.close();
  assert.deepEqual(answered?.answer, { kind: "answer", value: { failed: "secret-ish internals" } });
  assert.equal(answered?.turnComplete, false, "back at Rest: the Turn goes on");
  assert.equal(feed.length, 1, "the operator still reads the error on the feed");
});

test('work stopped back at Rest before it replied, or a child that errs: answered with no reply, never "nothing ran" (ADR-0024)', async () => {
  // A per-step `after` back to Rest stops `never` while it runs; an `onError` back to Rest takes a
  // child's error, which is a defect and no reply — its message never reaches the model.
  const cases: Record<string, Record<string, unknown>> = {
    "a per-step `after` back to Rest": { running: { invoke: { src: "never" }, after: { 30: "rest" } } },
    "a child's error": { running: { invoke: { src: "fail", onError: "rest" } } },
  };
  for (const [name, states] of Object.entries(cases)) {
    const rig = await routeRig(states);
    const going = rig.host.sendToAgent(rig.iid, { type: "go" });
    assert.equal(going.outstanding, true, `${name}: the pick is outstanding`);
    const answer = await rig.host.awaitDelivery(rig.iid, going.deliveryId);
    await rig.host.close();
    assert.deepEqual(
      {
        answered: answer?.answered,
        turnComplete: answer?.turnComplete,
        answer: answer?.answer,
        straightBack: answer?.straightBack,
      },
      { answered: true, turnComplete: false, answer: undefined, straightBack: undefined },
      name,
    );
    assert.doesNotMatch(JSON.stringify(answer), /secret-ish internals/, `${name}: no error text in the answer`);
  }
});

// The run records which Agent started each child (ADR-0067): a done event of one of them names the
// Agent whose pick an `answer` on a transition below no Agent's state shapes. The record is saved
// with the run, so after a park and a restore the same done event shapes the same pick — and only it.
test("the run records the Agent each pick's child is of; after a restore, a done event below no Agent's state shapes that pick only", async () => {
  const go = ev("go");
  const pickA = ev("pick_a");
  const pickB = ev("pick_b");
  /** A child Machine that ends when its Gate is answered `go`. */
  const waiter = (gate: string) =>
    jr2Setup({ events: [go] }).createMachine({
      initial: "w",
      states: { w: { invoke: { src: "gate", id: gate, input: {} }, on: { go: "f" } }, f: { type: "final" } },
      output: () => ({ waited: gate }),
    });
  const endpoint = "http://harness.invalid";
  const clients = { a: [] as MockFlueClient[], b: [] as MockFlueClient[] };
  const def = (): WorkflowDef => ({
    name: "pair",
    machine: jr2Setup({
      events: [pickA, pickB],
      actors: {
        coderA: agentActorWith(() => new MockFlueClient(), coderDefinition),
        coderB: agentActorWith(() => new MockFlueClient(), reviewerDefinition),
        waiterA: waiter("doneA"),
        waiterB: waiter("doneB"),
      },
    }).createMachine({
      id: "pair",
      type: "parallel",
      // Below no Agent's state: the root, on A's child's done event.
      on: { "xstate.done.actor.waitA": { actions: answer(({ event }) => `the root saw ${event.type}`) } },
      states: {
        ra: {
          invoke: { src: "coderA", input: { prompt: "A", endpoint, continue: true } },
          initial: "rest",
          states: { rest: {}, waiting: { invoke: { src: "waiterA", id: "waitA" } } },
          on: { pick_a: ".waiting" },
        },
        rb: {
          invoke: { src: "coderB", input: { prompt: "B", endpoint, continue: true } },
          initial: "rest",
          states: { rest: {}, waiting: { invoke: { src: "waiterB", id: "waitB" } } },
          on: { pick_b: ".waiting" },
        },
      },
    }),
    provide: () => {
      const a = new MockFlueClient();
      const b = new MockFlueClient();
      clients.a.push(a);
      clients.b.push(b);
      return {
        actors: {
          coderA: agentActorWith(() => a, coderDefinition),
          coderB: agentActorWith(() => b, reviewerDefinition),
        },
      };
    },
  });
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(def());
  const { runId } = await host.start("pair");
  await waitFor(() => clients.a[0]!.admits.length > 0 && clients.b[0]!.admits.length > 0);
  const ia = clients.a[0]!.admits[0]!.instanceId;
  const ib = clients.b[0]!.admits[0]!.instanceId;
  const pa = host.sendToAgent(ia, { type: "pick_a" });
  const pb = host.sendToAgent(ib, { type: "pick_b" });
  assert.equal(pa.outstanding, true);
  assert.equal(pb.outstanding, true);
  const saved = JSON.stringify((await store.load(runId))?.snapshot);
  assert.match(saved, /"startedBy":\{[^}]*"waitA":"coderA"/, "the run records the Agent whose pick started A's child");
  assert.match(saved, /"startedBy":\{[^}]*"waitB":"coderB"/, "and B's");
  await host.stop(runId);

  const second = new RunHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  const polledA = second.awaitDelivery(ia, pa.deliveryId);
  second.sendToGate(runId, "waitA.doneA", { type: "go" });
  const answeredA = await polledA;
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "the root saw xstate.done.actor.waitA" });
  const polledB = second.awaitDelivery(ib, pb.deliveryId);
  second.sendToGate(runId, "waitB.doneB", { type: "go" });
  const answeredB = await polledB;
  assert.deepEqual(answeredB?.answer, { kind: "output", actor: "waiterB", output: { waited: "doneB" } });
  await second.close();
});

// A child that the pick's later work started is its Agent's too (ADR-0067): one started while the
// Machine took a done event of the pick's own child. Saved with the run, so a restore attributes its
// done event to the same Agent; a child that ended is dropped from the record at the save.
test("a child the pick's later work started is recorded as its Agent's; after a restore, its done event below no Agent's state shapes that pick only", async () => {
  const go = ev("go");
  const pickA = ev("pick_a");
  const pickB = ev("pick_b");
  /** A child Machine that ends when its Gate is answered `go`. */
  const waiter = (gate: string) =>
    jr2Setup({ events: [go] }).createMachine({
      initial: "w",
      states: { w: { invoke: { src: "gate", id: gate, input: {} }, on: { go: "f" } }, f: { type: "final" } },
      output: () => ({ waited: gate }),
    });
  const endpoint = "http://harness.invalid";
  const clients = { a: [] as MockFlueClient[], b: [] as MockFlueClient[] };
  const def = (): WorkflowDef => ({
    name: "pair",
    machine: jr2Setup({
      events: [pickA, pickB],
      actors: {
        coderA: agentActorWith(() => new MockFlueClient(), coderDefinition),
        coderB: agentActorWith(() => new MockFlueClient(), reviewerDefinition),
        firstA: waiter("doneA1"),
        thenA: waiter("doneA2"),
        waiterB: waiter("doneB"),
      },
    }).createMachine({
      id: "pair",
      type: "parallel",
      // Below no Agent's state: the root, on the done event of the child A's first step started.
      on: { "xstate.done.actor.waitA2": { actions: answer(({ event }) => `the root saw ${event.type}`) } },
      states: {
        ra: {
          invoke: { src: "coderA", input: { prompt: "A", endpoint, continue: true } },
          initial: "rest",
          states: {
            rest: {},
            one: { invoke: { src: "firstA", id: "waitA1", onDone: "two" } },
            two: { invoke: { src: "thenA", id: "waitA2" } },
          },
          on: { pick_a: ".one" },
        },
        rb: {
          invoke: { src: "coderB", input: { prompt: "B", endpoint, continue: true } },
          initial: "rest",
          states: { rest: {}, waiting: { invoke: { src: "waiterB", id: "waitB" } } },
          on: { pick_b: ".waiting" },
        },
      },
    }),
    provide: () => {
      const a = new MockFlueClient();
      const b = new MockFlueClient();
      clients.a.push(a);
      clients.b.push(b);
      return {
        actors: {
          coderA: agentActorWith(() => a, coderDefinition),
          coderB: agentActorWith(() => b, reviewerDefinition),
        },
      };
    },
  });
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(def());
  const { runId } = await host.start("pair");
  await waitFor(() => clients.a[0]!.admits.length > 0 && clients.b[0]!.admits.length > 0);
  const ia = clients.a[0]!.admits[0]!.instanceId;
  const ib = clients.b[0]!.admits[0]!.instanceId;
  const pa = host.sendToAgent(ia, { type: "pick_a" });
  const pb = host.sendToAgent(ib, { type: "pick_b" });
  assert.equal(pa.outstanding, true);
  assert.equal(pb.outstanding, true);
  host.sendToGate(runId, "waitA1.doneA1", { type: "go" });
  await new Promise((r) => setTimeout(r, 50));
  const saved = JSON.stringify((await store.load(runId))?.snapshot);
  assert.match(saved, /"startedBy":\{[^}]*"waitA2":"coderA"/, "the child A's first step's end started is A's");
  assert.match(saved, /"startedBy":\{[^}]*"waitB":"coderB"/, "B's child is B's");
  assert.doesNotMatch(saved, /"waitA1":"coderA"/, "the child that ended is dropped at the save");
  await host.stop(runId);

  const second = new RunHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  const polledA = second.awaitDelivery(ia, pa.deliveryId);
  second.sendToGate(runId, "waitA2.doneA2", { type: "go" });
  const answeredA = await polledA;
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "the root saw xstate.done.actor.waitA2" });
  const polledB = second.awaitDelivery(ib, pb.deliveryId);
  second.sendToGate(runId, "waitB.doneB", { type: "go" });
  const answeredB = await polledB;
  assert.deepEqual(answeredB?.answer, { kind: "output", actor: "waiterB", output: { waited: "doneB" } });
  await second.close();
});

// A child a timer in the Agent's state started, while the Agent's pick is outstanding, is that
// pick's work by the Rest rule, so the run records it as that Agent's (ADR-0024): saved with the run,
// after a restore its done event below no Agent's state shapes that pick only.
test("a child a timer in the Agent's state started is recorded as its Agent's; after a restore, its done event below no Agent's state shapes that pick only", async () => {
  const go = ev("go");
  const pickA = ev("pick_a");
  const pickB = ev("pick_b");
  /** A child Machine that ends when its Gate is answered `go`. */
  const waiter = (gate: string) =>
    jr2Setup({ events: [go] }).createMachine({
      initial: "w",
      states: { w: { invoke: { src: "gate", id: gate, input: {} }, on: { go: "f" } }, f: { type: "final" } },
      output: () => ({ waited: gate }),
    });
  const endpoint = "http://harness.invalid";
  const clients = { a: [] as MockFlueClient[], b: [] as MockFlueClient[] };
  const def = (): WorkflowDef => ({
    name: "pair",
    machine: jr2Setup({
      events: [pickA, pickB],
      actors: {
        coderA: agentActorWith(() => new MockFlueClient(), coderDefinition),
        coderB: agentActorWith(() => new MockFlueClient(), reviewerDefinition),
        thenA: waiter("doneA2"),
        waiterB: waiter("doneB"),
      },
    }).createMachine({
      id: "pair",
      type: "parallel",
      // Below no Agent's state: the root, on the done event of the child A's timer started.
      on: { "xstate.done.actor.waitA2": { actions: answer(({ event }) => `the root saw ${event.type}`) } },
      states: {
        ra: {
          invoke: { src: "coderA", input: { prompt: "A", endpoint, continue: true } },
          initial: "rest",
          states: {
            rest: {},
            start: { after: { 30: "two" } },
            two: { invoke: { src: "thenA", id: "waitA2" } },
          },
          on: { pick_a: ".start" },
        },
        rb: {
          invoke: { src: "coderB", input: { prompt: "B", endpoint, continue: true } },
          initial: "rest",
          states: { rest: {}, waiting: { invoke: { src: "waiterB", id: "waitB" } } },
          on: { pick_b: ".waiting" },
        },
      },
    }),
    provide: () => {
      const a = new MockFlueClient();
      const b = new MockFlueClient();
      clients.a.push(a);
      clients.b.push(b);
      return {
        actors: {
          coderA: agentActorWith(() => a, coderDefinition),
          coderB: agentActorWith(() => b, reviewerDefinition),
        },
      };
    },
  });
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(def());
  const { runId } = await host.start("pair");
  await waitFor(() => clients.a[0]!.admits.length > 0 && clients.b[0]!.admits.length > 0);
  const ia = clients.a[0]!.admits[0]!.instanceId;
  const ib = clients.b[0]!.admits[0]!.instanceId;
  const pa = host.sendToAgent(ia, { type: "pick_a" });
  const pb = host.sendToAgent(ib, { type: "pick_b" });
  assert.equal(pa.outstanding, true);
  assert.equal(pb.outstanding, true);
  await new Promise((r) => setTimeout(r, 100));
  const saved = JSON.stringify((await store.load(runId))?.snapshot);
  assert.match(saved, /"startedBy":\{[^}]*"waitA2":"coderA"/, "the child A's timer started is A's");
  assert.match(saved, /"startedBy":\{[^}]*"waitB":"coderB"/, "B's child is B's");
  await host.stop(runId);

  const second = new RunHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  const polledA = second.awaitDelivery(ia, pa.deliveryId);
  second.sendToGate(runId, "waitA2.doneA2", { type: "go" });
  const answeredA = await polledA;
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "the root saw xstate.done.actor.waitA2" });
  const polledB = second.awaitDelivery(ib, pb.deliveryId);
  second.sendToGate(runId, "waitB.doneB", { type: "go" });
  const answeredB = await polledB;
  assert.deepEqual(answeredB?.answer, { kind: "output", actor: "waiterB", output: { waited: "doneB" } });
  await second.close();
});
