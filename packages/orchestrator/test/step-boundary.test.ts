// The step-boundary check, the Orchestrator's half (ADR-0029). The Harness reads the live surface
// at each step boundary and compares it with the last list its model READ
// (`packages/harness/src/between-steps.ts`). So this side owes two things: the surface is the truth
// at every moment of a Turn — after a Gate's answer, after a child's invoke settles, after a
// restart — and a pick's receipt carries exactly the list the surface serves next, so the Agent's
// own pick is never restated. Real `jr2Setup.createMachine` walk, real `RunHost`, socket-free. No
// new route, no new state.
//
//   ticket (invokes coder; own pick: abandon)
//     coding     run_tests -> testing, ask_approval -> human
//     testing    invokes `tests` (a command stand-in); onDone -> coding
//     human      invokes a Gate; approve (external) -> reviewing
//     reviewing  revise -> coding, submit -> out of `ticket`

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { admittedIid, coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const run_tests = defineEvent({ name: "run_tests", input: z.object({}) });
const ask_approval = defineEvent({ name: "ask_approval", input: z.object({}) });
const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });
const revise = defineEvent({ name: "revise", input: z.object({}) });
const submit = defineEvent({ name: "submit", input: z.object({}) });
const abandon = defineEvent({ name: "abandon", input: z.object({}) });

const CODING = ["abandon", "ask_approval", "run_tests"];
// Not at Rest (ADR-0024): the Gate or the command runs below the Agent's state, so nothing is allowed.
const BUSY: string[] = [];
const REVIEWING = ["abandon", "revise", "submit"];

function controllableTests() {
  let settle: ((out: string) => void) | undefined;
  const logic = fromPromise<string>(() => new Promise<string>((resolve) => (settle = resolve)));
  return { logic, settle: (out: string) => settle?.(out) };
}

function def(clients: Map<string, MockFlueClient>, tests: ReturnType<typeof controllableTests>): WorkflowDef {
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [run_tests, ask_approval, approve, revise, submit, abandon],
      actors: { coder, tests: tests.logic },
    }).createMachine({
      on: { "agent.fault": {} },
      id: "wf",
      context: {},
      initial: "ticket",
      states: {
        ticket: {
          invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint: "http://harness.invalid" } },
          on: { abandon: "#wf.done" },
          initial: "coding",
          states: {
            coding: { on: { run_tests: "testing", ask_approval: "human" } },
            testing: { invoke: { src: "tests", onDone: "coding" } },
            human: { invoke: { src: "gate", input: { gate: "approval" } }, on: { approve: "reviewing" } },
            reviewing: { on: { revise: "coding", submit: "#wf.done" } },
          },
        },
        done: { type: "final" },
      },
    });
  return {
    name: "push",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition), tests: tests.logic } };
    },
  };
}

test("the surface is the truth at every step boundary: a Gate's answer and a settled command each change it, with no pick and no new Turn", async () => {
  const clients = new Map<string, MockFlueClient>();
  const tests = controllableTests();
  const host = new RunHost({ store: await mkStore() });
  host.register(def(clients, tests));
  const { runId, instanceId } = await host.start("push");
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  const allowed = () => host.agentSurface(iid)?.allowed;
  const menu = JSON.stringify(host.agentSurface(iid)!.menu);
  assert.ok(!menu.includes('"approve"'), "the Gate's answer is not on the Agent's Menu");

  // The Agent's own pick: its receipt carries EXACTLY what the next boundary read serves — so the
  // Harness, which heard the receipt, has nothing to restate.
  const toHuman = host.sendToAgent(iid, { type: "ask_approval" });
  assert.deepEqual(toHuman.allowed, BUSY);
  assert.deepEqual(allowed(), toHuman.allowed, "receipt == next surface read");

  // The human answers the Gate while the Agent runs bash: the Allowed picks change, and NOTHING
  // told the Agent — this is the gap a boundary read closes.
  host.sendToGate(runId, "approval", { type: "approve" });
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === JSON.stringify({ ticket: "reviewing" }));
  assert.deepEqual(allowed(), REVIEWING, "what the next boundary read serves");

  // A command the Agent picked: outstanding (receipt: BUSY) until it settles, and the surface follows
  // it; the command settles and the Machine is back in coding.
  host.sendToAgent(iid, { type: "revise" });
  const toTesting = host.sendToAgent(iid, { type: "run_tests" });
  assert.deepEqual(toTesting.allowed, BUSY);
  tests.settle("3 passed");
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === JSON.stringify({ ticket: "coding" }));
  assert.deepEqual(allowed(), CODING, "changed with no pick");

  // Every change above was inside ONE Turn: one admission, no abort, the Menu byte-identical.
  assert.equal(client.admits.length, 1);
  assert.deepEqual(client.aborts, []);
  assert.equal(JSON.stringify(host.agentSurface(iid)!.menu), menu);

  // The Turn ends with the state: from here every boundary read is a 404 — silence.
  host.sendToAgent(iid, { type: "abandon" });
  assert.equal(host.agentSurface(iid), undefined);
});

test("across an Orchestrator restart: the restored surface serves the list the Machine was saved in — a change made before the restart is read at the next boundary after it", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(def(clients, controllableTests()));
  const { runId, instanceId } = await host.start("push");
  const iid = await admittedIid(clients.get(instanceId)!);
  host.sendToAgent(iid, { type: "ask_approval" }); // the Agent's model last read BUSY
  host.sendToGate(runId, "approval", { type: "approve" }); // …then the Gate moved it, unseen
  let stored = "";
  await waitFor(() => {
    void store.load(runId).then((s) => (stored = JSON.stringify(s?.snapshot ?? "")));
    return stored.includes("reviewing");
  });
  await host.stop(runId);

  const restored = new RunHost({ store });
  restored.register(def(new Map(), controllableTests()));
  assert.deepEqual((await restored.restore()).reattached, [runId]);
  assert.deepEqual(restored.agentSurface(iid)?.allowed, REVIEWING);
});
