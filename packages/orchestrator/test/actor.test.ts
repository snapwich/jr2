// Run-lifecycle actor tests. The actor does two things on start — registers its invocation's
// event surface in the host table (ADR-0011) and admits the run over the port built from
// `input.endpoint` — and undoes both on stop. On the wire side it emits only telemetry
// (`agent.offset`, `agent.fault`); domain events come up the MCP channel via the registration,
// never from the flue stream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, sendTo } from "xstate";
import { z } from "zod";
import { defineEvent, eventMap } from "@j2/agent-protocol";
import { agentRunActorWith } from "../src/actor.ts";
import type { AgentRunInput, AgentToolCall, AgentRunPort } from "../src/actor.ts";
import { bindRun, mcpAddress, RegistrationTable } from "../src/registration.ts";

/** An AgentRunPort the test drives by hand: capture the admission + push synthetic tool calls. */
class MockFlueClient implements AgentRunPort {
  admitted: AgentRunInput | undefined;
  push: ((call: AgentToolCall) => void) | undefined;
  cancelled: string[] = [];
  endpoints: string[] = [];
  private rejectAdmit: ((err: unknown) => void) | undefined;

  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void> {
    this.admitted = input;
    this.push = onToolCall;
    // Stays live until abandoned, unless the test faults it via `fault()`.
    return new Promise<void>((_resolve, reject) => {
      this.rejectAdmit = reject;
    });
  }

  cancel(instanceId: string): Promise<void> {
    this.cancelled.push(instanceId);
    return Promise.resolve();
  }

  /** Simulate the run's stream faulting (infra failure). */
  fault(reason: string): void {
    this.rejectAdmit?.(new Error(reason));
  }
}

const pingEvent = defineEvent({ name: "ping", input: z.object({}) });

/**
 * `sendBack` needs a parent to land in, so wrap the actor in a tiny machine that records every
 * event the child sends up and forwards a CANCEL down on request. The actor resolves its run
 * binding from the actor system, so the test binds one before start (what RunHost.track does).
 */
function harness(client: AgentRunPort, input: AgentRunInput) {
  const received: Array<{ type: string; [k: string]: unknown }> = [];
  const errors: unknown[] = [];
  const table = new RegistrationTable();

  const machine = setup({
    actors: { run: agentRunActorWith((endpoint) => ((client as MockFlueClient).endpoints?.push(endpoint), client)) },
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
  bindRun(actor.system, { runId: "run-1", workflow: "test", events: eventMap("test", [pingEvent]), table });
  actor.subscribe({ error: (err) => errors.push(err) }); // xstate reports invoke errors here, not out of start()
  actor.start();
  return { actor, received, table, errors };
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-42",
  endpoint: "http://sandbox-7.harness.local:8080",
  prompt: "do the thing",
  tools: ["ping"],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

test("admits the run with the right handle, over a port built from input.endpoint", () => {
  const mock = new MockFlueClient();
  harness(mock, baseInput);

  assert.equal(mock.admitted?.agentName, "coder");
  assert.equal(mock.admitted?.instanceId, "inst-42");
  assert.deepEqual(mock.endpoints, ["http://sandbox-7.harness.local:8080"]);
});

test("registers its event surface on start; delivery lands on the invoking state", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);

  const reg = table.lookup(mcpAddress("inst-42"));
  assert.equal(reg?.kind, "agent");
  assert.deepEqual([...(reg?.defs.keys() ?? [])], ["ping"]);

  table.deliver(mcpAddress("inst-42"), "ping", {});
  await tick();
  assert.ok(received.some((e) => e.type === "ping"));
});

test("a tools name outside the workflow's manifest errors the invoke at start", () => {
  const mock = new MockFlueClient();
  // The harness machine's "*" catches the xstate error event (a real workflow without a handler
  // would escalate and error the run — see gate.test.ts for the host-level path).
  const { received } = harness(mock, { ...baseInput, tools: ["ping", "zap"] });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /workflow "test" does not declare event "zap" \(declared: ping\)/);
});

test("surfaces the stream offset up as telemetry for the durable handle", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.push?.({ name: "some_tool", args: { summary: "PR ready" }, offset: "11" });
  await tick();

  const offset = received.find((e) => e.type === "agent.offset");
  assert.deepEqual(offset, { type: "agent.offset", instanceId: "inst-42", offset: "11" });
});

test("does not emit domain events — those come over MCP, not the flue stream", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  // Even a "domain-looking" stream tool call only advances the offset.
  mock.push?.({ name: "done", args: { summary: "finished" }, offset: "5" });
  await tick();

  assert.deepEqual(
    received.map((e) => e.type),
    ["agent.offset"],
  );
});

test("surfaces a stream fault as agent.fault telemetry", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.fault("stream reset by peer");
  await tick();

  const fault = received.find((e) => e.type === "agent.fault");
  assert.deepEqual(fault, { type: "agent.fault", instanceId: "inst-42", reason: "stream reset by peer" });
});

test("a CANCEL sent to the actor abandons the run and destroys the registration", async () => {
  const mock = new MockFlueClient();
  const { actor, table } = harness(mock, baseInput);
  assert.ok(table.lookup(mcpAddress("inst-42")));

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.deepEqual(mock.cancelled, ["inst-42"]);
  assert.equal(table.lookup(mcpAddress("inst-42")), undefined);
});
