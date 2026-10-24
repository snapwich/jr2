// In-Turn modes (ADR-0015, ADR-0029): an Agent's state with CHILD states, each a mode with its own
// picks, inside ONE Turn. Driven through the real `jr2Setup.createMachine` walk and the real
// delivery path (`RunHost.sendToAgent`, what `POST /agents/:iid/events` calls), socket-free.
//
//   ticket (invokes coder; own pick: abandon)
//     coding     run_tests -> testing, ask_review -> reviewing
//     testing    invokes `tests` (a command stand-in); onDone -> coding
//     reviewing  revise -> coding, submit -> out of `ticket` (ends the Turn)

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, createActor, createMachine, fromPromise, sendTo, type AnyActorRef } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { bindRun, OutstandingError, RegistrationTable } from "../src/registration.ts";
import { RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { admittedIid, coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import type { HarnessRestarts, SandboxPort } from "../src/workspace.ts";

const run_tests = defineEvent({ name: "run_tests", description: "Run the test suite.", input: z.object({}) });
const ask_review = defineEvent({ name: "ask_review", description: "Ask for a review.", input: z.object({}) });
const revise = defineEvent({ name: "revise", description: "Go back to coding.", input: z.object({}) });
const submit = defineEvent({
  name: "submit",
  description: "Submit the work.",
  input: z.object({ summary: z.string() }),
});
const abandon = defineEvent({ name: "abandon", description: "Give up.", input: z.object({}) });

/** A command stand-in the test settles by hand: each run of `tests` waits on the next `settle`. */
function controllableTests() {
  let settle: ((out: string) => void) | undefined;
  const runs: number[] = [];
  const logic = fromPromise<string>(
    () =>
      new Promise<string>((resolve) => {
        runs.push(runs.length + 1);
        settle = resolve;
      }),
  );
  return { logic, runs, settle: (out: string) => settle?.(out) };
}

function modesMachine(coder: ReturnType<typeof agentActorWith>, tests: ReturnType<typeof controllableTests>["logic"]) {
  return jr2Setup({
    types: {} as { context: { summary?: string } },
    events: [run_tests, ask_review, revise, submit, abandon],
    actors: { coder, tests },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint: "http://harness.invalid" } },
        on: { abandon: "#wf.done" },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "testing", ask_review: "reviewing" } },
          testing: { invoke: { src: "tests", onDone: "coding" } },
          reviewing: { on: { revise: "coding", submit: "#wf.done" } },
        },
      },
      done: { type: "final" },
    },
  });
}

function modesDef(clients: Map<string, MockFlueClient>, tests: ReturnType<typeof controllableTests>): WorkflowDef {
  return {
    name: "modes",
    machine: modesMachine(
      agentActorWith(() => new MockFlueClient(), coderDefinition),
      tests.logic,
    ),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition), tests: tests.logic } };
    },
  };
}

const MENU = ["abandon", "ask_review", "revise", "run_tests", "submit"];

test("one Turn, three modes: the Menu never changes, the Allowed picks follow the active child", async () => {
  const clients = new Map<string, MockFlueClient>();
  const tests = controllableTests();
  const host = new RunHost({ store: await mkStore() });
  host.register(modesDef(clients, tests));
  const { runId, instanceId } = await host.start("modes");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  const value = () => JSON.stringify(host.status(runId)?.value);

  // The derivation descends: the Turn's derived set and the Menu both hold every mode's picks.
  assert.deepEqual([...client.admits[0]!.tools].sort(), MENU, "derived set = own + ancestors + modes");
  assert.deepEqual(client.admits[0]!.menu, MENU, "the Menu, sorted");
  const menuBytes = JSON.stringify(host.agentSurface(iid)!.menu);
  const surface = () => {
    const s = host.agentSurface(iid)!;
    assert.equal(JSON.stringify(s.menu), menuBytes, "byte-identical Menu in every mode");
    return s.allowed;
  };

  // coding
  assert.deepEqual(surface(), ["abandon", "ask_review", "run_tests"]);

  // A pick on the Menu, not Allowed in this mode: delivered, moves nothing, Allowed unchanged.
  const wrong = host.sendToAgent(iid, { type: "revise" });
  assert.deepEqual(
    { moved: wrong.moved, turnComplete: wrong.turnComplete, allowed: wrong.allowed },
    { moved: false, turnComplete: false, allowed: ["abandon", "ask_review", "run_tests"] },
  );
  assert.equal(value(), JSON.stringify({ ticket: "coding" }));

  // run_tests -> testing: same Turn. The pick is OUTSTANDING while the command runs (ADR-0024): the
  // POST answers at once with a delivery id, and nothing is allowed — not even the parent's
  // `abandon` — until the workflow is back at Rest.
  const toTesting = host.sendToAgent(iid, { type: "run_tests" });
  assert.deepEqual(
    {
      moved: toTesting.moved,
      turnComplete: toTesting.turnComplete,
      allowed: toTesting.allowed,
      outstanding: toTesting.outstanding,
    },
    { moved: true, turnComplete: false, allowed: [], outstanding: true },
  );
  assert.equal(value(), JSON.stringify({ ticket: "testing" }));
  assert.deepEqual(surface(), []);

  // The command settles; the Machine routes back to coding, and the held answer carries the output
  // and the Allowed picks read after the route.
  const polled = host.awaitDelivery(iid, toTesting.deliveryId);
  tests.settle("pass");
  const answer = await polled;
  assert.deepEqual(
    {
      answered: answer?.answered,
      turnComplete: answer?.turnComplete,
      allowed: answer?.allowed,
      answer: answer?.answer,
    },
    {
      answered: true,
      turnComplete: false,
      allowed: ["abandon", "ask_review", "run_tests"],
      answer: { kind: "output", actor: "tests", output: "pass" },
    },
  );
  assert.equal(value(), JSON.stringify({ ticket: "coding" }));
  assert.deepEqual(surface(), ["abandon", "ask_review", "run_tests"]);

  // coding -> reviewing
  const toReview = host.sendToAgent(iid, { type: "ask_review" });
  assert.deepEqual(toReview.allowed, ["abandon", "revise", "submit"]);
  assert.deepEqual(surface(), ["abandon", "revise", "submit"]);

  // reviewing -> coding -> reviewing: modes may cycle inside one Turn.
  assert.deepEqual(host.sendToAgent(iid, { type: "revise" }).allowed, ["abandon", "ask_review", "run_tests"]);
  assert.deepEqual(host.sendToAgent(iid, { type: "ask_review" }).allowed, ["abandon", "revise", "submit"]);

  // The Agent's invoke never restarted: one admission, one registration, the whole time.
  assert.equal(client.admits.length, 1, "one admission across every mode change");
  assert.deepEqual(client.aborts, [], "no abort: the invoking state never exited");

  // submit leaves `ticket`: the Turn is over (ADR-0024).
  const done = host.sendToAgent(iid, { type: "submit", summary: "fixed" });
  assert.deepEqual(
    { moved: done.moved, turnComplete: done.turnComplete, allowed: done.allowed },
    {
      moved: true,
      turnComplete: true,
      allowed: [],
    },
  );
  assert.equal(host.agentSurface(iid), undefined, "no surface: the Turn is over");
  assert.equal(tests.runs.length, 1);
});

test("a pick written ONLY below a nested Agent's state is that Agent's, never the outer one's", async () => {
  const verdict = defineEvent({ name: "verdict", input: z.object({}) });
  const outer = new MockFlueClient();
  const inner = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [run_tests, verdict, submit],
    actors: {
      coder: agentActorWith(() => outer, coderDefinition),
      reviewer: agentActorWith(() => inner, { ...coderDefinition, name: "reviewer" } as typeof coderDefinition),
    },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "review" } },
          // A child that invokes ANOTHER Agent: the descent stops here.
          review: {
            invoke: { src: "reviewer", input: { prompt: "review", endpoint: "http://x" } },
            on: { verdict: "coding" },
            initial: "reading",
            states: { reading: { on: { submit: "#wf.done" } } },
          },
        },
      },
      done: { type: "final" },
    },
  });
  const { actor, table } = hostless(machine);
  await waitFor(() => outer.admits.length === 1);
  assert.deepEqual(outer.admits[0]!.tools, ["run_tests"], "the outer Turn does not see the nested Agent's picks");
  assert.deepEqual(outer.admits[0]!.menu, ["run_tests"]);
  table.deliver(`agent/${outer.admits[0]!.instanceId}`, "run_tests", {});
  await waitFor(() => inner.admits.length === 1);
  assert.deepEqual([...inner.admits[0]!.tools].sort(), ["submit", "verdict"], "the nested Turn: own + its modes");
  actor.stop();
});

test("a Gate's state below the Agent's state: its answers never enter the Agent's Menu", async () => {
  const approve = defineEvent({ name: "approve", audience: "any", input: z.object({}) });
  const outer = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [ask_review, approve],
    actors: { coder: agentActorWith(() => outer, coderDefinition) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        initial: "coding",
        states: {
          coding: { on: { ask_review: "human" } },
          human: { invoke: { src: "gate", input: {} }, on: { approve: "coding" } },
        },
      },
    },
  });
  const { actor } = hostless(machine);
  await waitFor(() => outer.admits.length === 1);
  assert.deepEqual(outer.admits[0]!.menu, ["ask_review"], "the descent stops at a Gate: `approve` is its caller's");
  actor.stop();
});

test("restore mid-mode: the restored Turn's Allowed picks are the restored child's", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const tests = controllableTests();
  const host = new RunHost({ store });
  host.register(modesDef(clients, tests));
  const { runId, instanceId } = await host.start("modes");
  const iid = await admittedIid(clients.get(instanceId)!);
  host.sendToAgent(iid, { type: "ask_review" });
  let stored: unknown;
  await waitFor(() => {
    void store.load(runId).then((s) => (stored = s?.snapshot));
    return JSON.stringify(stored ?? "").includes("reviewing");
  });
  await host.stop(runId);

  const second = new RunHost({ store });
  const clients2 = new Map<string, MockFlueClient>();
  second.register(modesDef(clients2, controllableTests()));
  assert.deepEqual((await second.restore()).reattached, [runId]);
  assert.deepEqual(second.agentSurface(iid)?.allowed, ["abandon", "revise", "submit"]);
  assert.deepEqual(
    second.agentSurface(iid)?.menu.map((e) => e.name),
    MENU,
  );
});

/** Run a jr2Setup machine under a bare binding (no RunHost), as setup.test.ts does. */
function hostless(machine: Parameters<typeof createActor>[0]) {
  const table = new RegistrationTable();
  let bound = false;
  const actor = createActor(machine, {
    inspect: (ev) => {
      if (!bound && ev.type === "@xstate.actor") {
        bound = true;
        bindRun((ev.actorRef as AnyActorRef).system, { runId: "run-1", workflow: "wf", table });
      }
    },
  });
  actor.start();
  return { actor, table };
}

// --- Edges ---------------------------------------------------------------------------------------

test("edge: one pick name in two modes (different targets and guards), and on the parent too — the deepest active handler wins", async () => {
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: { ready: boolean } },
    events: [run_tests, abandon, revise],
    actors: { coder: agentActorWith(() => mock, coderDefinition) },
  }).createMachine({
    id: "wf",
    context: { ready: false },
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        // `abandon` on the parent AND on `b`: in `b` the child's handler is tried first; its guard
        // is false, so xstate falls back to the parent's — `can()` agrees.
        on: { abandon: "#wf.gaveUp" },
        initial: "a",
        states: {
          a: { on: { run_tests: "b" } },
          b: {
            on: {
              run_tests: { target: "a", guard: ({ context }) => context.ready },
              abandon: { target: "a", guard: () => false },
              revise: "a",
            },
          },
        },
      },
      gaveUp: { type: "final" },
    },
  });
  const { actor, table } = hostless(machine);
  await waitFor(() => mock.admits.length === 1);
  const iid = mock.admits[0]!.instanceId;
  assert.deepEqual(mock.admits[0]!.menu, ["abandon", "revise", "run_tests"], "one Menu entry per name");
  table.deliver(`agent/${iid}`, "run_tests", {});
  assert.deepEqual(actor.getSnapshot().value, { ticket: "b" });
  assert.equal(actor.getSnapshot().can({ type: "run_tests" }), false, "b's guarded handler: not allowed in b");
  assert.equal(actor.getSnapshot().can({ type: "abandon" }), true, "b's false guard falls back to the parent");
  table.deliver(`agent/${iid}`, "abandon", {});
  assert.equal(actor.getSnapshot().status, "done", "the parent's abandon ran");
  actor.stop();
});

test("edge: one name, two schemas is impossible — a vocabulary holds one def per name (load refusal)", () => {
  const a = defineEvent({ name: "report", input: z.object({ text: z.string() }) });
  const b = defineEvent({ name: "report", input: z.object({ code: z.number() }) });
  assert.throws(
    () =>
      jr2Setup({ types: {} as { context: Record<string, never> }, events: [a, b] }).createMachine({
        id: "wf",
        context: {},
      }),
    /report/,
  );
});

test("edge: a mode nothing enters still puts its picks on the Menu, never Allowed — and the build warns", async () => {
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [run_tests, submit],
    actors: { coder: agentActorWith(() => mock, coderDefinition) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "coding" } },
          orphan: { on: { submit: "#wf.done" } }, // no transition targets it, not initial
        },
      },
      done: { type: "final" },
    },
  });
  const { actor } = hostless(machine);
  await waitFor(() => mock.admits.length === 1);
  assert.deepEqual(mock.admits[0]!.menu, ["run_tests", "submit"], "built, and `submit` is on the Menu");
  assert.match(loadWarningsOf(machine).join("\n"), /mode "wf\.ticket\.orphan".*nothing enters it/);
  actor.stop();
});

test("edge: an `external` event on a child state never enters the Agent's Menu", async () => {
  const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [run_tests, approve],
    actors: { coder: agentActorWith(() => mock, coderDefinition) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        initial: "coding",
        states: { coding: { on: { run_tests: "coding", approve: "coding" } } },
      },
    },
  });
  const { actor } = hostless(machine);
  await waitFor(() => mock.admits.length === 1);
  assert.deepEqual(mock.admits[0]!.menu, ["run_tests"]);
  actor.stop();
});

test("the ask-again rule: an in-Turn pick, then the model stops — nudged, because picks are still allowed (ADR-0016)", async () => {
  // After a settle, a live Turn whose Allowed picks are not empty is asked again (ADR-0016).
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(modesDef(clients, controllableTests()));
  const { runId, instanceId } = await host.start("modes");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  host.sendToAgent(iid, { type: "ask_review" }); // a mode change: moved, Turn open
  client.complete(); // the model ends its Submission without a Turn-ending pick
  await waitFor(() => client.admits.length === 2);
  assert.equal(client.admits[1]!.instanceId, iid, "the nudge is on the same conversation");
  assert.match(client.admits[1]!.prompt ?? "", /still waiting for your pick/);
  assert.deepEqual(host.status(runId)?.value, { ticket: "reviewing" }, "still in the mode");
  // The nudged Submission ends with the Turn-ending pick: no further nudge.
  host.sendToAgent(iid, { type: "submit", summary: "done" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.admits.length, 2);
});

test("the ask-again rule: a live Turn whose Allowed picks are EMPTY (a busy mode) is not nudged", async () => {
  const clients = new Map<string, MockFlueClient>();
  const tests = controllableTests();
  const host = new RunHost({ store: await mkStore() });
  // A Machine whose only Allowed pick while testing would be the parent's `abandon` — so a variant
  // with no parent pick: in `testing`, nothing is allowed.
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [run_tests, submit],
    actors: { coder: agentActorWith(() => new MockFlueClient(), coderDefinition), tests: tests.logic },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid" } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "testing", submit: "#wf.done" } },
          testing: { invoke: { src: "tests", onDone: "coding" } },
        },
      },
      done: { type: "final" },
    },
  });
  host.register({
    name: "busy",
    machine,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition), tests: tests.logic } };
    },
  });
  const { runId, instanceId } = await host.start("busy");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  host.sendToAgent(iid, { type: "run_tests" });
  assert.deepEqual(host.agentSurface(iid)?.allowed, []);
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.admits.length, 1, "nothing is allowed: not asked again");
  assert.equal(host.status(runId)?.status, "active", "no fault");
});

/** An Agent's state with no pick of its own: in `human` and `held` (Gates) NOTHING is allowed. `reviewing`
 * may `ask` again, so a Machine can open and close picks under one Turn as often as the model
 * likes. A fault routes to `faulted`. */
function gateWaitDef(clients: Map<string, MockFlueClient>, options: { nudgeBudget?: number } = {}): WorkflowDef {
  const ask = defineEvent({ name: "ask", description: "Ask a human.", input: z.object({}) });
  const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });
  const leave = defineEvent({ name: "leave", audience: "external", input: z.object({}) });
  const hold = defineEvent({ name: "hold", audience: "external", input: z.object({}) });
  const resume = defineEvent({ name: "resume", audience: "external", input: z.object({}) });
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [ask, approve, leave, hold, resume, submit],
      actors: { coder },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "ticket",
      states: {
        ticket: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid" } },
          on: { "agent.fault": "#wf.faulted" },
          initial: "coding",
          states: {
            coding: { on: { ask: "human" } },
            human: {
              invoke: { src: "gate", input: { gate: "approval" } },
              on: { approve: "reviewing", leave: "#wf.done", hold: "held" },
            },
            // A second wait with nothing to pick: the Machine moves, and the list stays empty.
            held: {
              invoke: { src: "gate", input: { gate: "resumption" } },
              on: { resume: "reviewing" },
            },
            reviewing: { on: { submit: "#wf.done", ask: "human" } },
          },
        },
        done: { type: "final" },
        faulted: { type: "final" },
      },
    });
  return {
    name: "gate-wait",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition, options) } };
    },
  };
}

test("the wake: a model that stopped with NOTHING allowed is asked once, with the nudge's text, when a Gate's answer opens a pick (ADR-0016)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(gateWaitDef(clients));
  const { runId, instanceId } = await host.start("gate-wait");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);

  host.sendToAgent(iid, { type: "ask" });
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "waiting on the Gate: nothing to pick");
  client.complete(); // correct: nothing to pick, so it stops
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.admits.length, 1, "the list stays empty: nobody is asked");

  // The human answers: a pick opens, and the stopped model is asked on the same conversation.
  host.sendToGate(runId, "approval", { type: "approve" });
  await waitFor(() => client.admits.length === 2);
  assert.equal(client.admits[1]!.instanceId, iid);
  assert.match(
    client.admits[1]!.prompt ?? "",
    /^Your previous turn ended, and the workflow is still waiting for your pick\./,
  );
  assert.equal(host.status(runId)?.status, "active", "no fault");

  host.sendToAgent(iid, { type: "submit", summary: "done" });
  client.complete();
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(client.admits.length, 2, "asked once");
});

test("no wake while the list stays empty: the Machine moves from one wait to another, and nobody is asked (ADR-0016)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(gateWaitDef(clients));
  const { runId, instanceId } = await host.start("gate-wait");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);

  host.sendToAgent(iid, { type: "ask" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  host.sendToGate(runId, "approval", { type: "hold" });
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === JSON.stringify({ ticket: "held" }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(host.agentSurface(iid)?.allowed, []);
  assert.equal(client.admits.length, 1, "the state changed and the list did not: no ask");

  host.sendToGate(runId, "resumption", { type: "resume" });
  await waitFor(() => client.admits.length === 2);
  assert.equal(host.status(runId)?.status, "active", "no fault");
});

test("the wake spends the nudge's budget: a Machine that opens and closes picks faults, it does not loop (ADR-0016)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(gateWaitDef(clients, { nudgeBudget: 1 }));
  const { runId, instanceId } = await host.start("gate-wait");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  const seen: RunFeedEvent[] = [];
  host.subscribe(runId, (event) => seen.push(event));

  // Round one: the wake spends the one ask the budget has.
  host.sendToAgent(iid, { type: "ask" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  host.sendToGate(runId, "approval", { type: "approve" });
  await waitFor(() => client.admits.length === 2);

  // Round two: the woken model closes the picks again and stops. When they open, the budget is spent.
  host.sendToAgent(iid, { type: "ask" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  host.sendToGate(runId, "approval", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(client.admits.length, 2, "no third ask");
  const values = seen.flatMap((event) => (event.kind === "status" ? [event.status.value] : []));
  assert.equal(values.at(-1), "faulted", "the spent budget is the nudge's fault");
  const retries = seen.flatMap((event) => (event.kind === "retry" ? [event.attempt] : []));
  assert.deepEqual(retries, [1], "one ask, counted against the nudge's budget");
});

test("the wake after a Gate says `kept`, and a Harness that lost the conversation while the Turn waited refuses it: the Turn is admitted again with its task, told its conversation is new (ADR-0016, ADR-0062)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(gateWaitDef(clients));
  const { runId, instanceId } = await host.start("gate-wait");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  const seen: RunFeedEvent[] = [];
  host.subscribe(runId, (event) => seen.push(event));

  host.sendToAgent(iid, { type: "ask" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  // While the Turn waited at the Gate, its Harness restarted and lost the conversation.
  client.keeps = false;
  host.sendToGate(runId, "approval", { type: "approve" });
  await waitFor(() => client.admits.length === 2);
  assert.equal(client.refused.length, 1, "the wake was refused: no empty conversation was seated");
  assert.match(client.refused[0]!.prompt ?? "", /^Your previous turn ended/);
  const again = client.admits[1]!;
  assert.equal(again.instanceId, iid);
  assert.equal(again.prompt, "go", "the Turn's task, and no re-admit text: nothing was cut");
  assert.deepEqual(client.notices[1], [
    { kind: "conversation-new", scope: "conversation", reason: "the Harness no longer holds it" },
  ]);
  assert.deepEqual(client.kept, [false, false], "the new conversation is not a kept one");
  const retries = seen.flatMap((event) => (event.kind === "retry" ? [`${event.attempt} ${event.reason}`] : []));
  assert.deepEqual(retries, ["1 picks allowed again", "1 re-admitted on a new conversation"]);

  // The budget is the nudge's, as before: the next stop with a pick allowed is the last ask.
  client.keeps = true;
  client.complete();
  await waitFor(() => client.admits.length === 3);
  assert.equal(client.kept[2], true, "the nudge on the new conversation says kept too");
  client.complete();
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(client.admits.length, 3, "two asks, then the fault");
});

/** The `@model` mode-stop reviewer: it reads for a moment, then approves. Its output is the answer to
 * the `ask_review` that started it (ADR-0024). */
const modeStopReviewer = createMachine({
  initial: "reading",
  states: { reading: { after: { 5: "done" } }, done: { type: "final" } },
  output: () => ({ verdict: "approved", comments: "Clear and accurate." }),
});

/** The `@model` mode-stop shape: `drafting` allows `ask_review`; in `reviewing` a reviewer child holds
 * the pick until it answers, and the picks stay closed until a TARGETLESS timer marks the review
 * read (so Rest is not held after the answer), then `revise` and `submit`. A fault routes to
 * `faulted` with its reason, as the claim workflow's does. */
function modeStopDef(clients: Map<string, MockFlueClient>, sandbox?: string): WorkflowDef {
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: { read: boolean; fault?: string } },
      events: [ask_review, revise, submit],
      actors: { coder, reviewer: modeStopReviewer },
    }).createMachine({
      id: "wf",
      context: { read: false },
      initial: "notes",
      states: {
        notes: {
          invoke: {
            src: "coder",
            input: { prompt: "go", endpoint: "http://harness.invalid", ...(sandbox === undefined ? {} : { sandbox }) },
          },
          on: {
            "agent.fault": {
              target: "#wf.faulted",
              actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
            },
          },
          initial: "drafting",
          states: {
            drafting: { on: { ask_review: "reviewing" } },
            reviewing: {
              entry: assign({ read: false }),
              after: { 40: { actions: assign({ read: true }) } },
              on: {
                revise: { guard: ({ context }) => context.read, target: "drafting" },
                submit: { guard: ({ context }) => context.read, target: "#wf.done" },
              },
              initial: "reading",
              states: { reading: { invoke: { src: "reviewer", onDone: "answered" } }, answered: {} },
            },
          },
        },
        done: { type: "final" },
        faulted: { type: "final" },
      },
    });
  return {
    name: "mode-stop",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition) } };
    },
  };
}

/** `ask_review` in the mode-stop shape: outstanding while the reviewer reads, then answered at Rest
 * with the reviewer's output and nothing allowed — the answer a model reads before it stops. */
async function askReview(host: RunHost, iid: string): Promise<void> {
  const receipt = host.sendToAgent(iid, { type: "ask_review" });
  assert.equal(receipt.moved, true);
  assert.equal(receipt.outstanding, true, "held while the reviewer reads");
  const answered = await host.awaitDelivery(iid, receipt.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "output",
    actor: "reviewer",
    output: { verdict: "approved", comments: "Clear and accurate." },
  });
  assert.deepEqual(answered?.allowed, [], "answered while the picks are still closed");
  assert.equal(answered?.turnComplete, false);
}

/** Drive the mode-stop sequence to its second wake: ask_review, stop, wake, revise, ask_review,
 * stop, wake. Each stop is a correct one (nothing allowed); each wake spends the one budget. */
async function toTheSecondWake() {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(modeStopDef(clients));
  const { runId, instanceId } = await host.start("mode-stop");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  const seen: RunFeedEvent[] = [];
  host.subscribe(runId, (event) => seen.push(event));

  await askReview(host, iid);
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "the reviewer answered: still nothing to pick");
  client.complete();
  await waitFor(() => client.admits.length === 2);
  assert.deepEqual(host.agentSurface(iid)?.allowed, ["revise", "submit"]);
  assert.equal(host.sendToAgent(iid, { type: "revise" }).moved, true);
  await askReview(host, iid); // the mode re-entered
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "its entry closed the picks again");
  client.complete();
  await waitFor(() => client.admits.length === 3);
  for (const admit of client.admits.slice(1)) {
    assert.equal(admit.instanceId, iid, "the same conversation");
    assert.match(admit.prompt ?? "", /^Your previous turn ended, and the workflow is still waiting for your pick\./);
  }
  return { host, runId, iid, client, seen };
}

test("a kernel kill while a Turn waits for its wake is the fault's notice, which names the Turn's Agent — the wake's read of the last end raises none (ADR-0061, ADR-0062)", async () => {
  const listeners = new Set<(seen: HarnessRestarts) => void>();
  let seen: HarnessRestarts = { restartCount: 0 };
  const port = {
    harnessRestarts: (_name: string, listener: (seen: HarnessRestarts) => void) => {
      listeners.add(listener);
      queueMicrotask(() => listeners.has(listener) && listener(seen));
      return () => listeners.delete(listener);
    },
    memoryFault: async () =>
      seen.lastTerminated?.reason === "OOMKilled"
        ? { reason: "memory limit (OOMKilled, limit 1920Mi): …", limit: "1920Mi", at: seen.lastTerminated.finishedAt }
        : undefined,
  } as unknown as SandboxPort;
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store, sandbox: port });
  host.register(modeStopDef(clients, "ws-1"));
  const { runId, instanceId } = await host.start("mode-stop");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  await new Promise((r) => setTimeout(r, 5));

  // The model stops with nothing allowed; while the Turn waits for its wake, the kernel kills the
  // Harness container.
  await askReview(host, iid);
  client.complete();
  await new Promise((r) => setTimeout(r, 5));
  seen = {
    restartCount: 1,
    lastTerminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-23T10:00:00Z" },
  };
  for (const l of listeners) l(seen);
  await waitFor(() => host.status(runId) === undefined);
  const pending =
    ((await store.load(runId))?.snapshot as { notices?: { pending?: Array<{ notice: unknown }> } })?.notices?.pending ??
    [];
  assert.deepEqual(
    pending.map((p) => p.notice),
    [{ kind: "memory-limit", scope: "workspace", agent: "coder", limit: "1920Mi" }],
  );
});

/** A kill in the pod's list, at now — after the Turn under test started. */
const idleKill = (id: string, told: Array<{ agent: string; instanceId: string }> = []) => ({
  id,
  at: new Date().toISOString(),
  peak: "1.9Gi",
  limit: "2Gi",
  told,
});
const idleNotice = { kind: "memory-limit", scope: "workspace", peak: "1.9Gi", limit: "2Gi" };

test("a wake carries the guard kills from the pod's list that no bash call of its conversation answered (ADR-0016, ADR-0062)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(modeStopDef(clients, "ws-1"));
  const { instanceId } = await host.start("mode-stop");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  assert.deepEqual(client.notices[0], []);

  // The reviewer reads, nothing is allowed, and the model stops: the Turn waits for its wake. A dev
  // server it started passes the limit then — no `bash` call ran, so the Agent was told nothing.
  await askReview(host, iid);
  client.podKills = [idleKill("k-1")];
  client.complete();
  await waitFor(() => client.admits.length === 2);
  assert.match(client.admits[1]!.prompt ?? "", /^Your previous turn ended/, "the wake");
  assert.deepEqual(client.notices[1], [idleNotice], "the woken Agent is the first that can act on it");

  // The second wake reads the same list, and the kill is delivered: nothing again. A kill that this
  // conversation's own `bash` call answered is in its context already, and waits for the next Turn.
  assert.equal(host.sendToAgent(iid, { type: "revise" }).moved, true);
  await askReview(host, iid);
  client.podKills = [idleKill("k-1"), idleKill("k-2", [{ agent: "coder", instanceId: iid }])];
  client.complete();
  await waitFor(() => client.admits.length === 3);
  assert.deepEqual(client.notices[2], []);
});

test("a kill a wake carried is raised again when the state exits before the Harness reads the surface (ADR-0026, ADR-0062)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(modeStopDef(clients, "ws-1"));
  const { runId, instanceId } = await host.start("mode-stop");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  // The Turn's first Submission read its surface; the Instance ID is `served`.
  host.agentSurfaceServed(iid);

  await askReview(host, iid);
  client.podKills = [idleKill("k-1")];
  client.complete();
  await waitFor(() => client.admits.length === 2);
  assert.deepEqual(client.notices[1], [idleNotice]);
  // The review is read and the Agent's pick ends the Turn — before the Harness read the wake's
  // surface, so no model heard the notice. It is pending again, for the next Turn in the Workspace.
  await waitFor(() => (host.agentSurface(iid)?.allowed ?? []).length > 0);
  assert.equal(host.sendToAgent(iid, { type: "submit", summary: "v1" }).turnComplete, true);
  let pending: unknown[] = [];
  await waitFor(() => {
    void store.load(runId).then((loaded) => {
      const notices = (loaded?.snapshot as { notices?: { pending?: Array<{ notice: unknown }> } })?.notices;
      pending = (notices?.pending ?? []).map((p) => p.notice);
    });
    return pending.length > 0 || host.status(runId) === undefined;
  });
  assert.deepEqual(pending, [idleNotice]);
});

test("mode-stop's sequence: two wakes, one per correct stop, then the pick that ends the Turn — no fault (ADR-0016, ADR-0024)", async () => {
  const { host, runId, iid, client, seen } = await toTheSecondWake();
  assert.equal(host.status(runId)?.status, "active", "no fault after the second wake");
  assert.equal(host.sendToAgent(iid, { type: "submit", summary: "v2.3" }).turnComplete, true);
  client.complete();
  await waitFor(() => host.status(runId) === undefined);
  const values = seen.flatMap((event) => (event.kind === "status" ? [event.status.value] : []));
  assert.equal(values.at(-1), "done");
  const retries = seen.flatMap((event) => (event.kind === "retry" ? [`${event.attempt} ${event.reason}`] : []));
  assert.deepEqual(retries, ["1 picks allowed again", "2 picks allowed again"]);
  assert.equal(client.admits.length, 3, "asked twice after the Frame, never more");
});

test("mode-stop's sequence, then a third stop with picks left: the spent budget is the one fault, and it names the picks (ADR-0016)", async () => {
  // What the tier's note `said ask_review (nudge) revise ask_review (nudge); ended done/faulted`
  // reads as, when the model answers the second wake without a pick: the nudge and the wake share
  // one budget (default 2), so the third ask is a fault, not an ask.
  const { host, runId, client, seen } = await toTheSecondWake();
  client.complete(); // text only: no pick
  await waitFor(() => host.status(runId) === undefined);
  const statuses = seen.flatMap((event) => (event.kind === "status" ? [event.status] : []));
  assert.equal(statuses.at(-1)?.value, "faulted");
  assert.equal(
    (statuses.at(-1)?.context as { fault?: string }).fault,
    "agent completed its turn without a pick that ends it; still allowed: revise, submit",
  );
  assert.equal(client.admits.length, 3, "no third ask");
});

test("no wake after the Turn ended: a Gate's answer that leaves the Agent's state asks nobody (ADR-0016)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(gateWaitDef(clients));
  const { runId, instanceId } = await host.start("gate-wait");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);

  host.sendToAgent(iid, { type: "ask" });
  client.complete();
  await new Promise((r) => setTimeout(r, 30));
  host.sendToGate(runId, "approval", { type: "leave" });
  await waitFor(() => host.status(runId) === undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.admits.length, 1, "the Turn is over: no wake");
});

test("no wake from a snapshot between macrosteps: Rest is read after the mailbox drains, so a state that sends to itself into busy work wakes nobody (ADR-0016, ADR-0024)", async () => {
  // `booting` runs work; when it settles, `mid` sends `go` to the Machine itself (the mailbox), which
  // moves on into `busy2`, more work. The snapshot with `mid` active is not Rest: its mailbox holds `go`.
  const go = defineEvent({ name: "go", audience: "external", input: z.object({}) });
  const clients = new Map<string, MockFlueClient>();
  const tests = controllableTests();
  const never = fromPromise<string>(() => new Promise<string>(() => {}));
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [go, submit],
      actors: { coder, tests: tests.logic, never },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "ticket",
      states: {
        ticket: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid" } },
          on: { submit: "#wf.done", "agent.fault": "#wf.faulted" },
          initial: "booting",
          states: {
            booting: { invoke: { src: "tests", onDone: "mid" } },
            mid: { entry: sendTo(({ self }: { self: AnyActorRef }) => self, { type: "go" }), on: { go: "busy2" } },
            busy2: { invoke: { src: "never" } },
          },
        },
        done: { type: "final" },
        faulted: { type: "final" },
      },
    });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "self-send",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition), tests: tests.logic, never } };
    },
  });
  const { runId, instanceId } = await host.start("self-send");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "booting: nothing to pick");
  client.complete(); // correct: nothing to pick, so it stops
  await new Promise((r) => setTimeout(r, 30));

  tests.settle("ok");
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === JSON.stringify({ ticket: "busy2" }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "busy2: nothing to pick");
  assert.equal(client.admits.length, 1, "the list never opened at Rest: nobody is asked");
  assert.equal(host.status(runId)?.status, "active", "no fault");
});

test("a pick on the Menu that ANOTHER state of the Agent handles: answered with the correction receipt, never delivered to the Machine (ADR-0029) — and refused while a nested Agent runs below (ADR-0024)", async () => {
  // `x` is on the coder's Menu only through `later`; in `ticket.review` the nested reviewer handles
  // an `x` of its own. At Rest in `ticket.coding`, the coder's `x` is answered `moved: false`. While
  // the reviewer runs below the coder's state, that state is not at Rest, so every pick of the coder
  // is refused — and the reviewer's transition is never taken (a widening, ADR-0015).
  const x = defineEvent({ name: "x", input: z.object({ why: z.string() }) });
  const next = defineEvent({ name: "next", input: z.object({}) });
  const consult = defineEvent({ name: "consult", input: z.object({}) });
  const clients = new Map<string, MockFlueClient>();
  const reviewerDefinition = { ...coderDefinition, name: "reviewer" } as typeof coderDefinition;
  const machineWith = (coder: ReturnType<typeof agentActorWith>, reviewer: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [x, next, consult],
      actors: { coder, reviewer },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "ticket",
      states: {
        ticket: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid" } },
          on: { next: "later" },
          initial: "coding",
          states: {
            coding: { on: { consult: "review" } },
            review: {
              invoke: { src: "reviewer", input: { prompt: "review", endpoint: "http://harness.invalid" } },
              on: { x: "#wf.hijacked" },
            },
          },
        },
        later: {
          invoke: { src: "coder", input: { prompt: "again", endpoint: "http://harness.invalid" } },
          on: { x: "#wf.done" },
        },
        hijacked: { type: "final" },
        done: { type: "final" },
      },
    });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "other-state",
    machine: machineWith(
      agentActorWith(() => new MockFlueClient(), coderDefinition),
      agentActorWith(() => new MockFlueClient(), reviewerDefinition),
    ),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return {
        actors: {
          coder: agentActorWith(() => client, coderDefinition),
          reviewer: agentActorWith(() => new MockFlueClient(), reviewerDefinition),
        },
      };
    },
  });
  const { runId, instanceId } = await host.start("other-state");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  assert.deepEqual(client.admits[0]!.menu, ["consult", "next", "x"], "`x` is on the Menu through `later`");
  assert.deepEqual(host.agentSurface(iid)?.allowed, ["consult", "next"]);

  // Any arguments, even ones the schema refuses: the pick is not allowed, whatever its arguments.
  for (const payload of [{ why: "now" }, {}]) {
    const receipt = host.sendToAgent(iid, { type: "x", ...payload });
    assert.deepEqual(
      { delivered: receipt.delivered, moved: receipt.moved, turnComplete: receipt.turnComplete },
      { delivered: true, moved: false, turnComplete: false },
    );
    assert.deepEqual(receipt.allowed, ["consult", "next"], "the correction receipt names the Allowed picks");
  }
  // A name off the Menu is still refused before delivery.
  assert.throws(() => host.sendToAgent(iid, { type: "merge" }), /does not accept "merge"/);

  // The reviewer runs below the coder's state: not at Rest, so the coder may pick nothing.
  const consulting = host.sendToAgent(iid, { type: "consult" });
  assert.equal(consulting.outstanding, true, "the pick runs a nested Agent: outstanding");
  assert.deepEqual(host.agentSurface(iid)?.allowed, [], "no Allowed picks while not at Rest");
  for (const pick of ["x", "next"]) {
    assert.throws(
      () => host.sendToAgent(iid, { type: pick, why: "now" }),
      (err: Error) => err instanceof OutstandingError && err.outstanding === "consult",
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(host.status(runId)?.value, { ticket: "review" }, "the reviewer's `x` was never taken");
});
