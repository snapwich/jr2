// Shared test harness for the Machine-host suites (run-host + http). Extracted verbatim from the
// original inline copy in run-host.test.ts so both test files drive ONE real template, ONE mock
// FlueClient, and ONE in-memory MCP wiring — the up-channel is exercised the real way (a real MCP
// Client over an in-memory transport), never bypassed.

import { setup, fromCallback, assign } from "xstate";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CODER_MENU, defineEvent } from "@j2/agent-protocol";
import type { ControlEvent, EventFrom } from "@j2/agent-protocol";
import { gate } from "../src/gate.ts";
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

// ---- Gate fixtures (ADR-0011): a workflow that parks on an addressable gate. -----------------

export const approveDef = defineEvent({ name: "approve", input: z.object({}) });
export const requestChangesDef = defineEvent({
  name: "request_changes",
  description: "Ask for changes before approving.",
  input: z.object({ notes: z.string() }),
});

type GatedCtx = { notes?: string };

/** Parks in `review` holding gate "F-1"; an external `approve`/`request_changes` moves it. The
 * targets are non-final so the run STAYS LIVE after the gate closes (gate gone ≠ run gone). */
export const gatedTemplate = setup({
  types: {} as { context: GatedCtx; events: EventFrom<typeof approveDef | typeof requestChangesDef> },
  actors: { gate },
}).createMachine({
  id: "gated",
  context: {},
  initial: "review",
  states: {
    review: {
      invoke: {
        src: "gate",
        input: { gate: "F-1", accepts: ["approve", "request_changes"], meta: { prUrl: "https://forge/pr/1" } },
      },
      on: {
        approve: "approved",
        request_changes: { target: "changes", actions: assign({ notes: ({ event }) => event.notes }) },
      },
    },
    approved: {},
    changes: {},
  },
});

/** The gated workflow def, with its `events` manifest (pass `events: []` to test unlisted names). */
export function gatedDef(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    name: "gated",
    machine: gatedTemplate,
    events: [approveDef, requestChangesDef],
    provide: () => ({}),
    ...overrides,
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
