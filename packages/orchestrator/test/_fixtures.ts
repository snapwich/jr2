// Shared test harness for the Machine-host suites (run-host + http + auth): ONE real template and
// ONE mock FlueClient, so every suite drives the same wiring.
//
// The Agent's up-channel is exercised the real way — through the registration table, via the same
// `sendToAgent` / `POST /agents/:iid/events` path the Adapter uses (ADR-0013). There is no MCP here
// because there is no MCP in the Orchestrator: that surface lives in the Sandbox now.

import { fromCallback, assign, createMachine, spawnChild } from "xstate";
import { z } from "zod";
import { defineEvent, doneEvent, requestReviewEvent } from "@j2/agent-protocol";
import { j2Setup } from "../src/setup.ts";
import { agentRunActorWith } from "../src/actor.ts";
import type { AgentRunInput, AgentRunPort, AgentRunReceiveEvent, AgentToolCall } from "../src/actor.ts";
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
 * the events are the WORKFLOW's vocabulary — `request_review`, not a j2 name), authored via
 * j2Setup (ADR-0015: vocabulary rides the machine; the mechanism events are injected into the
 * union). `agentRun` is overridden with a noop; tests fill it with a MockFlueClient via `provide`.
 *
 * `sandbox` rides the run input into the `agentRun` invocation, so a test can register an agent
 * surface that BELONGS to a Sandbox (what a Sandbox token is scoped against — ADR-0013) or, by
 * omitting it, one that belongs to no pod at all (a workspace-less run against the stub Harness).
 */
export const codingTemplate = j2Setup({
  types: {} as { context: Ctx; input: { instanceId: string; sandbox?: string } },
  events: [doneEvent, requestReviewEvent],
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
 * targets are non-final so the run STAYS LIVE after the gate closes (gate gone ≠ run gone).
 * `gate` is pre-registered by j2Setup — nothing to list (ADR-0015). */
export const gatedTemplate = j2Setup({
  types: {} as { context: GatedCtx },
  events: [approveDef, requestChangesDef],
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

/** Invokes its gate with an accepts name the workflow does NOT declare. createMachine's typo
 * check cannot see invoke-input strings, so this builds fine and fails at INVOKE time via
 * `resolveAccepts` (ADR-0011's check, unchanged by ADR-0015). */
export const gatedOverreachTemplate = j2Setup({
  types: {} as { context: GatedCtx },
  events: [approveDef], // request_changes deliberately missing
}).createMachine({
  id: "gated",
  context: {},
  initial: "review",
  states: {
    review: {
      invoke: { src: "gate", input: { gate: "F-1", accepts: ["approve", "request_changes"] } },
      on: { approve: "approved" },
    },
    approved: {},
  },
});

/** The gated workflow def; vocabulary rides the machine (ADR-0015). */
export function gatedDef(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    name: "gated",
    machine: gatedTemplate,
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

// ---- Child-machine fixtures ---------------------------------------------------------------------
// `coding`'s actual shape, in miniature: the root is a coordinator that `spawnChild`s a wrapper per
// feature, and the wrapper invokes its body as an INLINE machine. So the run's real state is two
// levels below the root's `value`, which is what `RunStatus.children` exists to carry — and each
// level holds a secret in context, which is what the observation projection must never carry.

type FeatureInput = { feature: string; secret: string };

/** Level 2: the body. Where the work — and a secret — actually is. It parks on its own GATE, named
 * for its feature, which is how a test moves a GRANDCHILD through the real delivery seam (a gate
 * registers from wherever it is invoked, at any depth — ADR-0011). */
const featureBody = j2Setup({
  types: {} as { context: FeatureInput; input: FeatureInput },
  events: [approveDef],
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: {
      invoke: { src: "gate", input: ({ context }) => ({ gate: context.feature, accepts: ["approve"] }) },
      on: { approve: "shipped" },
    },
    shipped: { type: "final" },
  },
});

/** Level 1: the per-feature wrapper, reached by `spawnChild`. `createMachine`, not `setup`, so `src`
 * can be the body MACHINE OBJECT — the INLINE shape, whose `src` xstate rewrites to a generated key
 * (`workspace()` invokes its body exactly this way, and the visualizer joins on that key). */
const featureWorkspace = createMachine({
  types: {} as { context: FeatureInput; input: FeatureInput },
  id: "ws",
  context: ({ input }) => input,
  initial: "provisioning",
  states: {
    provisioning: { after: { 5: "running" } },
    running: { invoke: { id: "body", src: featureBody, input: ({ context }) => context } },
  },
});

/** The root: a coordinator that spawns a wrapper per feature and then just sits there — which is
 * the whole problem the child diagrams solve. Its `value` stays "discover" while the run works.
 * The root carries the workflow's vocabulary (ADR-0015: discovery reads the EXPORTED machine),
 * even though the gate that uses `approve` is invoked two levels down. */
export const pipelineTemplate = j2Setup({
  types: {} as { context: Record<string, never> },
  events: [approveDef],
  actors: { feature: featureWorkspace },
}).createMachine({
  id: "pipeline",
  context: {},
  initial: "discover",
  states: {
    discover: {
      entry: [
        spawnChild("feature", { id: "F-1", input: { feature: "F-1", secret: "SECRET-1" } }),
        spawnChild("feature", { id: "F-2", input: { feature: "F-2", secret: "SECRET-2" } }),
      ],
    },
  },
});

export function pipelineDef(): WorkflowDef {
  return { name: "pipeline", machine: pipelineTemplate, provide: () => ({}) };
}
