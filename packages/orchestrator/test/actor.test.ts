import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, sendTo } from "xstate";
import { DEFAULT_CODER_MENU } from "@j2/agent-protocol";
import type { ControlEvent } from "@j2/agent-protocol";
import { agentRunActorWith } from "../src/actor.ts";
import type { AgentRunInput, AgentToolCall, FlueClient } from "../src/actor.ts";

/** A FlueClient the test drives by hand: capture the admission + push synthetic tool calls. */
class MockFlueClient implements FlueClient {
  admitted: AgentRunInput | undefined;
  push: ((call: AgentToolCall) => void) | undefined;
  cancelled: string[] = [];

  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void> {
    this.admitted = input;
    this.push = onToolCall;
    // The agent run stays live until abandoned; never settle on its own.
    return new Promise<void>(() => {});
  }

  cancel(instanceId: string): Promise<void> {
    this.cancelled.push(instanceId);
    return Promise.resolve();
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

test("a request_review tool call becomes an agent.requestReview ControlEvent", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.push?.({ name: "request_review", args: { summary: "PR ready" }, offset: 7 });
  await tick();

  const event = received.find((e) => e.type === "agent.requestReview") as ControlEvent | undefined;
  assert.ok(event, "expected an agent.requestReview event");
  assert.deepEqual(event, { type: "agent.requestReview", instanceId: "inst-42", summary: "PR ready" });
});

test("surfaces the stream offset up as telemetry for the durable handle", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.push?.({ name: "done", args: { summary: "finished" }, offset: 11 });
  await tick();

  const offset = received.find((e) => e.type === "agent.offset");
  assert.deepEqual(offset, { type: "agent.offset", instanceId: "inst-42", offset: 11 });
  const done = received.find((e) => e.type === "agent.done");
  assert.deepEqual(done, { type: "agent.done", instanceId: "inst-42", summary: "finished" });
});

test("check_inbox poll calls are not mapped to up-events", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);

  mock.push?.({ name: "check_inbox", args: {}, offset: 3 });
  await tick();

  assert.equal(
    received.some((e) => e.type.startsWith("agent.") && e.type !== "agent.offset"),
    false,
  );
});

test("a CANCEL sent to the actor abandons the run on the client", async () => {
  const mock = new MockFlueClient();
  const { actor } = harness(mock, baseInput);

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.deepEqual(mock.cancelled, ["inst-42"]);
});
