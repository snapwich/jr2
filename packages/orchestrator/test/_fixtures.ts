// Shared test harness for the Machine-host suites (run-host + http). Extracted verbatim from the
// original inline copy in run-host.test.ts so both test files drive ONE real template, ONE mock
// FlueClient, and ONE in-memory MCP wiring — the up-channel is exercised the real way (a real MCP
// Client over an in-memory transport), never bypassed.

import { setup, fromCallback, assign } from "xstate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CODER_MENU } from "@j2/agent-protocol";
import type { ControlEvent } from "@j2/agent-protocol";
import { agentRunActorWith } from "../src/actor.ts";
import type {
  AgentRunInput,
  AgentRunPort,
  AgentRunReceiveEvent,
  AgentToolCall,
  OffsetTelemetry,
} from "../src/actor.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import type { RunHost, WorkflowDef } from "../src/run-host.ts";

/** An AgentRunPort the test drives by hand: capture admission, push synthetic stream tool calls. */
export class MockFlueClient implements AgentRunPort {
  admitted: AgentRunInput | undefined;
  push: ((call: AgentToolCall) => void) | undefined;
  cancelled: string[] = [];

  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void> {
    this.admitted = input;
    this.push = onToolCall;
    return new Promise<void>(() => {}); // stays live until abandoned
  }
  cancel(instanceId: string): Promise<void> {
    this.cancelled.push(instanceId);
    return Promise.resolve();
  }
}

export type Ctx = { instanceId: string; offsets: Record<string, string>; summary?: string; action?: string };

/** A minimal real template standing in for a coding workflow. `agentRun` is a noop slot the host fills. */
export const codingTemplate = setup({
  types: {} as { context: Ctx; input: { instanceId: string }; events: ControlEvent | OffsetTelemetry },
  actors: { agentRun: fromCallback<AgentRunReceiveEvent, AgentRunInput>(() => {}) },
}).createMachine({
  id: "m",
  context: ({ input }) => ({ instanceId: input.instanceId, offsets: {} }),
  initial: "active",
  states: {
    active: {
      invoke: {
        id: "agentRun",
        src: "agentRun",
        input: ({ context }): AgentRunInput => ({
          agentName: "coder",
          instanceId: context.instanceId,
          prompt: "do work",
          menu: DEFAULT_CODER_MENU,
        }),
      },
      initial: "running",
      // Offset telemetry can arrive in any sub-state; record it without changing state.
      on: {
        "agent.offset": {
          actions: assign({
            offsets: ({ context, event }) => ({ ...context.offsets, [event.instanceId]: event.offset }),
          }),
        },
      },
      states: {
        running: {
          on: {
            "agent.requestReview": { target: "review", actions: assign({ summary: ({ event }) => event.summary }) },
            "agent.requestApproval": {
              target: "awaitingApproval",
              actions: assign({ action: ({ event }) => event.action }),
            },
            "agent.done": "#m.done",
          },
        },
        review: { on: { "agent.done": "#m.done" } },
        awaitingApproval: {
          on: {
            "agent.requestReview": { target: "review", actions: assign({ summary: ({ event }) => event.summary }) },
            "agent.done": "#m.done",
          },
        },
      },
    },
    done: { type: "final" },
  },
});

/** Build a workflow def whose `agentRun` slot is a fresh MockFlueClient, recorded per instance. */
export function codingDef(clients: Map<string, MockFlueClient>): WorkflowDef {
  return {
    name: "coding",
    machine: codingTemplate,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { agentRun: agentRunActorWith(client) } };
    },
  };
}

export async function mkStore(): Promise<SnapshotStore> {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  return store;
}

/** Connect a real MCP Client to a run's control-plane server. */
export async function connectMcp(
  server: ReturnType<RunHost["mcpServer"]>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => void (await Promise.all([client.close(), server.close()])) };
}

export const tick = () => new Promise((r) => setTimeout(r, 10));
export async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}
