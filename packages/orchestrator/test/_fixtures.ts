// Shared test harness for the Machine-host suites (run-host + http + auth): ONE real template and
// ONE mock FlueClient, so every suite drives the same wiring.
//
// The Agent's up-channel is exercised the real way — through the registration table, via the same
// `sendToAgent` / `POST /agents/:iid/events` path the Adapter uses (ADR-0013). There is no MCP here
// because there is no MCP in the Orchestrator: that surface lives in the Sandbox now.

import { setup, fromCallback, assign } from "xstate";
import { z } from "zod";
import { defineEvent, exampleEvents, doneEvent, requestReviewEvent } from "@j2/agent-protocol";
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
import type { WorkflowDef } from "../src/run-host.ts";

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

export type Ctx = { instanceId: string; sandbox?: string; offsets: Record<string, string>; summary?: string };

/**
 * A minimal real template standing in for a coding workflow, on the example event set (ADR-0011:
 * the events are the WORKFLOW's vocabulary — `request_review`, not a j2 name). `agentRun` is a
 * noop slot; tests fill it with a MockFlueClient port via `provide`.
 *
 * `sandbox` rides the run input into the `agentRun` invocation, so a test can register an agent
 * surface that BELONGS to a Sandbox (what a Sandbox token is scoped against — ADR-0013) or, by
 * omitting it, one that belongs to no pod at all (a workspace-less run against the stub Harness).
 */
export const codingTemplate = setup({
  types: {} as {
    context: Ctx;
    input: { instanceId: string; sandbox?: string };
    events: EventFrom<typeof doneEvent | typeof requestReviewEvent> | OffsetTelemetry | FaultTelemetry;
  },
  actors: { agentRun: fromCallback<AgentRunReceiveEvent, AgentRunInput>(() => {}) },
}).createMachine({
  id: "m",
  context: ({ input }) => ({ instanceId: input.instanceId, sandbox: input.sandbox, offsets: {} }),
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
          sandbox: context.sandbox,
          prompt: "do work",
          tools: ["done", "request_review"],
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
            done: "#m.done",
          },
        },
        review: { on: { done: "#m.done" } },
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

export const tick = () => new Promise((r) => setTimeout(r, 10));
export async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}
