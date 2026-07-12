// Shared test harness for the Machine-host suites (run-host + http). Extracted verbatim from the
// original inline copy in run-host.test.ts so both test files drive ONE real template, ONE mock
// FlueClient, and ONE in-memory MCP wiring — the up-channel is exercised the real way (a real MCP
// Client over an in-memory transport), never bypassed.

import { setup, fromCallback, assign } from "xstate";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineEvent, exampleEvents, doneEvent, requestReviewEvent, requestApprovalEvent } from "@j2/agent-protocol";
import type { EventFrom } from "@j2/agent-protocol";
import { gate } from "../src/gate.ts";
import { agentRunActorWith } from "../src/actor.ts";
import type {
  AgentRunInput,
  AgentRunPort,
  AgentRunReceiveEvent,
  AgentToolCall,
  FaultTelemetry,
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

/** A minimal real template standing in for a coding workflow, on the example event set
 * (ADR-0011: the events are the WORKFLOW's vocabulary — `request_review`, not a j2 name).
 * `agentRun` is a noop slot; tests fill it with a MockFlueClient port via `provide`. */
export const codingTemplate = setup({
  types: {} as {
    context: Ctx;
    input: { instanceId: string };
    events:
      | EventFrom<typeof doneEvent | typeof requestReviewEvent | typeof requestApprovalEvent>
      | OffsetTelemetry
      | FaultTelemetry;
  },
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
          endpoint: "http://harness.invalid", // the mock port never dials it
          prompt: "do work",
          tools: ["done", "request_review", "request_approval", "check_inbox"],
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
            request_review: { target: "review", actions: assign({ summary: ({ event }) => event.summary }) },
            request_approval: {
              target: "awaitingApproval",
              actions: assign({ action: ({ event }) => event.action }),
            },
            done: "#m.done",
          },
        },
        review: { on: { done: "#m.done" } },
        awaitingApproval: {
          on: {
            request_review: { target: "review", actions: assign({ summary: ({ event }) => event.summary }) },
            done: "#m.done",
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
    events: [...exampleEvents],
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { agentRun: agentRunActorWith(() => client) } };
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

/** Connect a real MCP Client to a run's control-plane server (throws if nothing is registered). */
export async function connectMcp(
  server: ReturnType<RunHost["mcpServer"]>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  if (!server) throw new Error("connectMcp: no live registration for that instance");
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
