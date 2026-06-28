// Run-lifecycle actor tests. After the multi-run trim the actor emits only telemetry
// (`agent.offset`, `agent.fault`) — domain events come up the MCP channel via the ControlPlane,
// not from the flue stream — so these tests assert admission, offset surfacing, fault surfacing,
// the absence of any domain event, and CANCEL abandonment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, sendTo } from "xstate";
import { DEFAULT_CODER_MENU } from "@j2/agent-protocol";
import { agentRunActorWith } from "../src/actor.ts";
import type { AgentRunInput, AgentToolCall, FlueClient } from "../src/actor.ts";

/** A FlueClient the test drives by hand: capture the admission + push synthetic tool calls. */
class MockFlueClient implements FlueClient {
  admitted: AgentRunInput | undefined;
  push: ((call: AgentToolCall) => void) | undefined;
  cancelled: string[] = [];
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

/**
 * `sendBack` needs a parent to land in, so wrap the actor in a tiny machine that records every
 * event the child sends up and forwards a CANCEL down on request. Returns the live handles.
 */
function harness(client: FlueClient, input: AgentRunInput) {
  const received: Array<{ type: string; [k: string]: unknown }> = [];

  const machine = setup({
    actors: { run: agentRunActorWith(client) },
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
  actor.start();
  return { actor, received };
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-42",
  prompt: "do the thing",
  menu: DEFAULT_CODER_MENU,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

test("admits the run with the right agentName + instanceId", () => {
  const mock = new MockFlueClient();
  harness(mock, baseInput);

  assert.equal(mock.admitted?.agentName, "coder");
  assert.equal(mock.admitted?.instanceId, "inst-42");
});

test("surfaces the stream offset up as telemetry for the durable handle", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.push?.({ name: "request_review", args: { summary: "PR ready" }, offset: 11 });
  await tick();

  const offset = received.find((e) => e.type === "agent.offset");
  assert.deepEqual(offset, { type: "agent.offset", instanceId: "inst-42", offset: 11 });
});

test("does not emit domain events — those come up the MCP channel, not the flue stream", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  // Even a "domain-looking" tool call only advances the offset; it is not mapped to a ControlEvent.
  mock.push?.({ name: "done", args: { summary: "finished" }, offset: 5 });
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

test("a CANCEL sent to the actor abandons the run on the client", async () => {
  const mock = new MockFlueClient();
  const { actor } = harness(mock, baseInput);

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.deepEqual(mock.cancelled, ["inst-42"]);
});
