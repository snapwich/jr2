// Run-lifecycle actor tests. The actor does two things on start — registers its invocation's
// event surface in the host table (ADR-0011) and admits (or re-attaches) the run over the port
// built from `input.endpoint` (ADR-0016) — and undoes both on stop. On the wire side it emits
// only telemetry (`agent.fault`); domain events come up the MCP channel via the registration,
// never from the flue surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, sendTo } from "xstate";
import { z } from "zod";
import { defineEvent, eventMap } from "@j2/agent-protocol";
import { agentRunActorWith, type AgentRunOptions } from "../src/actor.ts";
import type { AgentAdmission, AgentRunInput, AgentRunPort } from "../src/actor.ts";
import { bindRun, agentAddress, RegistrationTable, type RetryTelemetry } from "../src/registration.ts";
import { MockFlueClient } from "./_fixtures.ts";

const pingEvent = defineEvent({ name: "ping", input: z.object({}) });

/**
 * `sendBack` needs a parent to land in, so wrap the actor in a tiny machine that records every
 * event the child sends up and forwards a CANCEL down on request. The actor resolves its run
 * binding from the actor system, so the test binds one before start (what RunHost.track does) —
 * including the admission-ledger write half, captured into `ledger`.
 */
function harness(client: AgentRunPort, input: AgentRunInput, options?: AgentRunOptions) {
  const received: Array<{ type: string; [k: string]: unknown }> = [];
  const errors: unknown[] = [];
  const ledger: Record<string, AgentAdmission> = {};
  const telemetry: RetryTelemetry[] = [];
  const table = new RegistrationTable();
  const endpoints: string[] = [];

  const machine = setup({
    actors: { run: agentRunActorWith((endpoint) => (endpoints.push(endpoint), client), options) },
  }).createMachine({
    id: "parent",
    initial: "running",
    states: {
      running: {
        invoke: { id: "run", src: "run", input },
        on: {
          CANCEL_RUN: { actions: sendTo("run", { type: "CANCEL" }) },
          "*": { actions: ({ event }) => received.push(event) },
        },
      },
    },
  });

  const actor = createActor(machine);
  bindRun(actor.system, {
    runId: "run-1",
    workflow: "test",
    events: eventMap("test", [pingEvent]),
    table,
    recordAdmission: (iid, admission) => (ledger[iid] = admission),
    telemetry: (event) => telemetry.push(event),
  });
  actor.subscribe({ error: (err) => errors.push(err) }); // xstate reports invoke errors here, not out of start()
  actor.start();
  return { actor, received, table, errors, ledger, endpoints, telemetry };
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-42",
  endpoint: "http://sandbox-7.harness.local:8080",
  prompt: "do the thing",
  tools: ["ping"],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

test("admits the run over a port built from input.endpoint and ledgers the admission", async () => {
  const mock = new MockFlueClient();
  const { ledger, endpoints } = harness(mock, baseInput);
  await tick();

  assert.equal(mock.admitted?.agentName, "coder");
  assert.equal(mock.admitted?.instanceId, "inst-42");
  assert.deepEqual(endpoints, ["http://sandbox-7.harness.local:8080"]);
  // The durable handle went to the HOST ledger the moment flue admitted (ADR-0016)…
  assert.deepEqual(ledger["inst-42"], mock.minted);
  // …and the actor is now following that admission to settlement.
  assert.deepEqual(mock.settled, [mock.minted]);
});

test("input.attach (set by the host on restore) re-attaches without re-admitting", async () => {
  const mock = new MockFlueClient();
  const attach: AgentAdmission = {
    streamUrl: "http://mock/agents/coder/inst-42",
    offset: "adm-9",
    submissionId: "sub-9",
  };
  const { ledger } = harness(mock, { ...baseInput, prompt: undefined, attach });
  await tick();

  assert.equal(mock.admitted, undefined, "re-attach must not admit a fresh prompt");
  assert.deepEqual(mock.settled, [attach], "settlement follows the PERSISTED admission");
  assert.deepEqual(ledger, {}, "nothing new to ledger — the admission was already durable");
});

test("registers its event surface on start; delivery lands on the invoking state", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);

  const reg = table.lookup(agentAddress("inst-42"));
  assert.equal(reg?.kind, "agent");
  assert.deepEqual([...(reg?.defs.keys() ?? [])], ["ping"]);

  table.deliver(agentAddress("inst-42"), "ping", {});
  await tick();
  assert.ok(received.some((e) => e.type === "ping"));
});

test("no endpoint and no enclosing workspace → the invoke errors loudly at start (ADR-0016)", () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, endpoint: undefined });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /no Harness to admit against/);
});

test("a tools name outside the workflow's vocabulary errors the invoke at start", () => {
  const mock = new MockFlueClient();
  // The harness machine's "*" catches the xstate error event (a real workflow without a handler
  // would escalate and error the run — see gate.test.ts for the host-level path).
  const { received } = harness(mock, { ...baseInput, tools: ["ping", "zap"] });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /workflow "test" does not declare event "zap" \(declared: ping\)/);
});

test("a failed settlement surfaces as agent.fault telemetry", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);
  await tick();

  mock.fault("stream reset by peer");
  await tick();

  const fault = received.find((e) => e.type === "agent.fault");
  assert.deepEqual(fault, { type: "agent.fault", instanceId: "inst-42", reason: "stream reset by peer" });
});

test("no-signal: a completed turn with no menu call is re-prompted on the SAME iid (ADR-0016)", async () => {
  const mock = new MockFlueClient();
  const { received, ledger, telemetry } = harness(mock, baseInput);
  await tick();

  mock.complete(); // the turn settled COMPLETED, but no `ping` was ever delivered
  await tick();

  assert.equal(mock.admits.length, 2, "a nudge is a fresh admission");
  assert.equal(mock.admits[1]!.instanceId, "inst-42", "same iid — the conversation continues");
  assert.match(mock.admits[1]!.prompt ?? "", /calling exactly one of: ping/);
  assert.deepEqual(ledger["inst-42"], mock.minted, "the nudge's admission is ledgered like any other");
  // `child` is the invoking parent's actor id — meaningful in real trees ("F-1", "body"); the
  // root harness here gets a generated one, so assert the shape, not the label.
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.kind, "retry");
  assert.equal(telemetry[0]!.attempt, 1);
  assert.equal(telemetry[0]!.reason, "no-signal nudge");
  assert.equal(typeof telemetry[0]!.child, "string");
  assert.ok(!received.some((e) => e.type === "agent.fault"), "budget not exhausted — no fault yet");
});

test("no-signal budget exhausted → ONE terminal agent.fault naming the menu", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput, { nudgeBudget: 0 });
  await tick();

  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1, "budget 0: no nudge");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /without calling any of: ping/);
});

test("a completed turn that DID signal is simply over — no nudge, no fault", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);
  await tick();

  table.deliver(agentAddress("inst-42"), "ping", {});
  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1, "no nudge after a delivered signal");
  assert.ok(!received.some((e) => e.type === "agent.fault"));
  assert.ok(received.some((e) => e.type === "ping"));
});

test("a menuless invocation (tools: []) never nudges — there is nothing to demand", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, tools: [] });
  await tick();

  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1);
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

test("a CANCEL abandons the run locally and destroys the registration", async () => {
  const mock = new MockFlueClient();
  const { actor, table, received } = harness(mock, baseInput);
  await tick();
  assert.ok(table.lookup(agentAddress("inst-42")));

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.equal(mock.abandoned, true, "abandon aborts the local settle consumption");
  assert.equal(table.lookup(agentAddress("inst-42")), undefined);
  // Local abandon never fabricates a fault: the durable run stays alive for restore.
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});
