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
import type { AgentAdmission, AgentRunInput, AgentRunPort, AgentRunReceiveEvent } from "../src/actor.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import type { WorkflowDef } from "../src/run-host.ts";

/** An AgentRunPort the test drives by hand: capture admissions/attaches, settle or fault them. */
export class MockFlueClient implements AgentRunPort {
  /** Every fresh admit this port served, in order (a nudge is a later admit on the same iid). */
  admits: AgentRunInput[] = [];
  /** The admission minted on the LATEST admit. Distinct per admit so ledgers are assertable. */
  minted: AgentAdmission | undefined;
  /** Every admission `settle()` was asked to follow (fresh AND re-attached). */
  settled: AgentAdmission[] = [];
  /** Set when the actor abandons an in-flight settle (stop/CANCEL). */
  abandoned = false;
  /** Every submission the actor ended remotely (ADR-0024), in order. */
  aborts: Array<{ agentName: string; instanceId: string }> = [];
  /** Hold aborts unresolved, so a test can drive the abort→next-admit ORDERING by hand. */
  holdAborts = false;
  private heldAborts: Array<() => void> = [];
  private pending: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private seq = 0;

  /** The one fresh admit, in the single-turn suites (undefined on a pure re-attach). */
  get admitted(): AgentRunInput | undefined {
    return this.admits[0];
  }

  admit(input: AgentRunInput): Promise<AgentAdmission> {
    this.admits.push(input);
    this.minted = {
      streamUrl: `http://mock/agents/${input.agentName}/${input.instanceId}`,
      offset: `adm-${++this.seq}`,
      submissionId: `sub-${this.seq}`,
    };
    return Promise.resolve(this.minted);
  }

  settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void> {
    this.settled.push(admission);
    // Stays live until completed, faulted, or abandoned (the mechanics-tier default is "admitted,
    // never settles").
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      opts?.signal?.addEventListener("abort", () => (this.abandoned = true), { once: true });
    });
  }

  abort(agentName: string, instanceId: string): Promise<void> {
    this.aborts.push({ agentName, instanceId });
    if (!this.holdAborts) return Promise.resolve();
    return new Promise<void>((resolve) => this.heldAborts.push(resolve));
  }

  /** Let a held abort resolve — what the next turn on that iid is waiting on. */
  releaseAborts(): void {
    for (const resolve of this.heldAborts.splice(0)) resolve();
  }

  /** Simulate the current submission settling COMPLETED (the no-signal case, unless a domain
   * event was delivered first). */
  complete(): void {
    this.pending.pop()?.resolve();
  }

  /** Simulate the current submission settling failed (infra fault, post flue-side retries). */
  fault(reason: string): void {
    this.pending.pop()?.reject(new Error(reason));
  }

  /** Simulate a settlement with a TYPED `SettlementError` — the rejection carries `settlement`
   * the way the wire client's `SettlementFault` does, so the actor can switch on `error.type`
   * (ADR-0035's runaway class) without this suite touching the wire. */
  faultSettled(type: string, message: string): void {
    this.pending.pop()?.reject(
      Object.assign(new Error(`submission settled failed: ${message}`), {
        settlement: { submissionId: `sub-${this.seq}`, outcome: "failed", error: { type, message } },
      }),
    );
  }
}

export type Ctx = { instanceId: string; sandbox?: string; summary?: string };

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
  context: ({ input }) => ({ instanceId: input.instanceId, sandbox: input.sandbox }),
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

/**
 * TWO turns of ONE conversation: both states invoke `agentRun` with the same instance id — what
 * `session: "continue"` derives (ADR-0016). It is the shape ADR-0024's ordering rule exists for:
 * the second turn's admission must queue behind the first turn's abort, and the pick that ended
 * the first turn must read `turnComplete` even though the next state re-registers that address.
 */
export const continuedTemplate = j2Setup({
  types: {} as { context: Ctx; input: { instanceId: string } },
  events: [doneEvent, requestReviewEvent],
  actors: { agentRun: fromCallback<AgentRunReceiveEvent, AgentRunInput>(() => {}) },
}).createMachine({
  id: "c",
  context: ({ input }) => ({ instanceId: input.instanceId }),
  initial: "first",
  states: {
    first: {
      invoke: {
        src: "agentRun",
        input: ({ context }): AgentRunInput => ({
          agentName: "coder",
          instanceId: context.instanceId,
          endpoint: "http://harness.invalid",
          prompt: "turn one",
          tools: ["request_review"],
        }),
      },
      on: { request_review: "second" },
    },
    second: {
      invoke: {
        src: "agentRun",
        input: ({ context }): AgentRunInput => ({
          agentName: "coder",
          instanceId: context.instanceId, // the SAME conversation
          endpoint: "http://harness.invalid",
          prompt: "turn two",
          tools: ["done"],
        }),
      },
      on: { done: "#c.done" },
    },
    done: { type: "final" },
  },
});

/** The two-turn workflow, over one MockFlueClient per run (both turns share it, as one Harness). */
export function continuedDef(clients: Map<string, MockFlueClient>): WorkflowDef {
  return {
    name: "continued",
    machine: continuedTemplate,
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
 * (`workspace()` invokes its body exactly this way, and the Console joins on that key). */
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
 * It declares NO events: the gate two levels down resolves against the BODY that invokes it
 * (ADR-0049), which declares `approve` itself, so the root has no reason to name it. */
export const pipelineTemplate = j2Setup({
  types: {} as { context: Record<string, never> },
  events: [],
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

// ---- Derived-gate fixtures (ADR-0011) ------------------------------------------------
// The fan-out shape with NO authored gate ids: the id derives from the gate's own actor path
// (spawn id + invoke id + the state key the walk stamped), so concurrent children cannot collide
// by construction — the claim that lets one machine be safe standalone AND under a pool.

type DerivedInput = { feature: string };

/** Parks on a fully-derived gate: NO input at all — id and accepts both derive. */
const derivedBody = j2Setup({
  types: {} as { context: DerivedInput; input: DerivedInput },
  events: [approveDef],
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: { invoke: { src: "gate" }, on: { approve: "shipped" } },
    shipped: { type: "final" },
  },
});

/** The per-feature wrapper (the `workspace()` shape): invokes the body under the id "body". */
const derivedWrapper = createMachine({
  types: {} as { context: DerivedInput; input: DerivedInput },
  id: "ws",
  context: ({ input }) => input,
  initial: "running",
  states: { running: { invoke: { id: "body", src: derivedBody, input: ({ context }) => context } } },
});

/** Root: fans out two children running the SAME body code — the case authored ids get wrong.
 * Declares no events of its own: `approve` belongs to the body that invokes the gate (ADR-0049). */
export const derivedFanoutTemplate = j2Setup({
  types: {} as { context: Record<string, never> },
  events: [],
  actors: { feature: derivedWrapper },
}).createMachine({
  id: "fanout",
  context: {},
  initial: "working",
  states: {
    working: {
      entry: [
        spawnChild("feature", { id: "F-1", input: { feature: "F-1" } }),
        spawnChild("feature", { id: "F-2", input: { feature: "F-2" } }),
      ],
    },
  },
});

export function derivedFanoutDef(): WorkflowDef {
  return { name: "fanout", machine: derivedFanoutTemplate, provide: () => ({}) };
}

/** Two live gates under ONE authored id (parallel regions, so both register at start): the
 * authored-bug case the registration table must keep failing loudly on. */
export const collidingGatesTemplate = j2Setup({
  types: {} as { context: Record<string, never> },
  events: [approveDef],
}).createMachine({
  id: "colliding",
  context: {},
  type: "parallel",
  states: {
    left: {
      initial: "review",
      states: {
        review: { invoke: { src: "gate", input: { gate: "review" } }, on: { approve: "done" } },
        done: {},
      },
    },
    right: {
      initial: "review",
      states: {
        review: { invoke: { src: "gate", input: { gate: "review" } }, on: { approve: "done" } },
        done: {},
      },
    },
  },
});

/** Two UNNAMED gates in one state's invoke array — the one place the state key alone would
 * collide, so the walk suffixes the invoke ordinal. */
export const twinGatesTemplate = j2Setup({
  types: {} as { context: Record<string, never> },
  events: [approveDef],
}).createMachine({
  id: "twin",
  context: {},
  initial: "review",
  states: {
    review: { invoke: [{ src: "gate" }, { src: "gate" }], on: { approve: "done" } },
    done: {},
  },
});

// ---- Same name, two Machines (ADR-0011, ADR-0049) -----------------------------------------------
// The pair per-Machine scoping exists for: an `approve` carrying a note in one Machine and an
// `approve` carrying a score in another, live in ONE run. Under the retired run-wide set this was
// a collision the root had to resolve; now neither Machine ever sees the other's def.

const approveNote = defineEvent({ name: "approve", input: z.object({ note: z.string() }) });
const approveScore = defineEvent({ name: "approve", input: z.object({ score: z.number() }) });

/** The nested Machine: its own `approve`, its own payload, its own gate. */
const scoredInner = j2Setup({
  types: {} as { context: { score?: number }; output: { score?: number } },
  events: [approveScore],
}).createMachine({
  id: "inner",
  context: {},
  initial: "waiting",
  states: {
    waiting: {
      invoke: { src: "gate" },
      on: { approve: { target: "done", actions: assign({ score: ({ event }) => event.score }) } },
    },
    done: { type: "final" },
  },
  // The score leaves as OUTPUT, so what the nested Machine's own `approve` delivered is still
  // assertable once the run has settled and its children are gone.
  output: ({ context }) => ({ score: context.score }),
});

/** The root: parallel, so its own gate and the nested Machine's are open at the same moment. */
export const sameNameTemplate = j2Setup({
  types: {} as { context: { note?: string; innerScore?: number } },
  events: [approveNote],
  actors: { inner: scoredInner },
}).createMachine({
  id: "outer",
  context: {},
  type: "parallel",
  states: {
    own: {
      initial: "waiting",
      states: {
        waiting: {
          invoke: { src: "gate" },
          on: { approve: { target: "done", actions: assign({ note: ({ event }) => event.note }) } },
        },
        done: { type: "final" },
      },
    },
    nested: {
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "inner",
            src: "inner",
            onDone: { target: "done", actions: assign({ innerScore: ({ event }) => event.output.score }) },
          },
        },
        done: { type: "final" },
      },
    },
  },
});

export function sameNameDef(): WorkflowDef {
  return { name: "same-name", machine: sameNameTemplate, provide: () => ({}) };
}
