// The run-lifecycle Actor (ADR-0002/0011): an xstate `fromCallback` actor that drives one Agent
// run. It does two things on start, and undoes both on stop:
//
//   1. REGISTERS the invocation's event surface: `tools` names are resolved against the
//      workflow's own `events` manifest (per-workflow scoping — an unlisted name fails at
//      invoke time) and registered in the host's table under the instance's MCP address, with a
//      deliver closure over THIS invocation's `sendBack`. The Agent's domain tool calls arrive
//      over MCP (`/mcp/<iid>`), are validated by the table, and land on the state that invoked
//      the agent — at any nesting depth, no routing, no `instanceId` on domain events (the
//      closure IS the provenance). `tools/list` serves exactly this registration, so menus are
//      state-scoped by lifecycle (ADR-0006's dynamic advertisement, for free).
//
//   2. ADMITS the run over the Harness at `input.endpoint` — the port is constructed
//      per-invocation from serializable input (ADR-0007/0011 doctrine), so restore re-attaches
//      to the right Harness by rewriting the persisted child input, and a dev stub is just a
//      different URL, never a different code path. The flue stream carries **lifecycle + offset
//      telemetry only** (`agent.offset`, `agent.fault` — these keep `instanceId`: they are
//      telemetry about a stream, not domain events); domain events never ride it.
//
// The port factory — `(endpoint) => AgentRunPort`, not `@flue/sdk` — is the dependency, so the
// actor is unit-testable without a live Harness: `agentRunActorWith(() => mock)` is the seam,
// and the canonical `agentRun` (bound to the real flue client) lives in flue-client.ts so this
// module never pulls the SDK onto the test load path.
//
// Durable handle (ADR-0002/0007): the re-attach key is `(agentName, instanceId) + offset`. The
// actor cannot persist anything itself (context lives in the parent Machine), so it *surfaces*
// the advancing stream offset as `agent.offset`; the host folds it into Machine context and on
// restore rewrites the child's input (`attachOffset`, drop `prompt`) to resume, not re-prompt.

import { fromCallback } from "xstate";
import { mcpAddress, resolveAccepts, runBindingOf } from "./registration.ts";

/** What the actor is invoked with: the durable handle, the Harness, and this turn's surface. */
export type AgentRunInput = {
  agentName: string;
  instanceId: string;
  /** The Harness base URL (which Sandbox). Rides the persisted child input so restore
   * re-attaches to the right Harness; a dev stub is just a different URL (ADR-0011). */
  endpoint: string;
  prompt?: string;
  /**
   * Resume the durable stream from this opaque offset (re-attach) instead of admitting a fresh
   * prompt. Set by the host on restore (which also drops `prompt`); see {@link AgentToolCall.offset}.
   */
  attachOffset?: string;
  /** Event names (from the workflow's `events` manifest) this invocation accepts over MCP. */
  tools: readonly string[];
};

/** One raw Agent stream tool call surfaced by the port, paired with its stream offset. */
export type AgentToolCall = {
  /** The tool the Agent invoked. The actor uses only `offset`; the name is informational. */
  name: string;
  /** The tool's (already JSON-parsed) arguments. */
  args?: Record<string, unknown>;
  /**
   * The run's durable-stream resume checkpoint as of this call. An **opaque string** — flue's
   * Durable Streams offset (`FlueEventStream.offset` / `AgentSendResult.offset`), not a numeric
   * index — so it is compared and stored verbatim, never arithmetic'd.
   */
  offset: string;
};

/** Telemetry sent up so the host can persist the durable handle's advancing offset. */
export type OffsetTelemetry = {
  type: "agent.offset";
  instanceId: string;
  /** Opaque durable-stream offset (see {@link AgentToolCall.offset}). */
  offset: string;
};

/** Telemetry sent up when the run's stream faults (infra failure, not an Agent-reported block). */
export type FaultTelemetry = {
  type: "agent.fault";
  instanceId: string;
  reason: string;
};

/** What the actor itself originates upward — telemetry. Domain events also flow through its
 * `sendBack`, but they are the registration table's deliveries, typed by the workflow's defs. */
export type AgentRunUpEvent = OffsetTelemetry | FaultTelemetry;

/** The only event the parent sends down: an interrupt that abandons the run. */
export type AgentRunReceiveEvent = { type: "CANCEL" };

/**
 * The port the Actor drives. Narrow by design — admit a run (handing it a sink for the run's
 * stream tool calls) and abandon it — so a test can supply a synthetic client and feed tool
 * calls by hand. The real, `@flue/sdk`-backed implementation lives in flue-client.ts.
 */
export interface AgentRunPort {
  /**
   * Admit (or, when `input.attachOffset` is set, re-attach to) a run, invoking `onToolCall` for
   * each stream tool call until the run settles. Resolving means the stream ended; rejecting
   * means it faulted.
   */
  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void>;
  /** Abandon the run (flue exposes no cancel primitive — drop and let durability reap it). */
  cancel(instanceId: string): Promise<void>;
}

/** Build a port for one invocation from its serializable input (ADR-0011 static-import doctrine). */
export type AgentRunPortFactory = (endpoint: string) => AgentRunPort;

/**
 * Build the run-lifecycle actor logic over an injected port factory.
 *
 * On start it registers the invocation's event surface, then admits the run; each stream tool
 * call sends up an `agent.offset` telemetry event (so the host persists the durable handle). A
 * `CANCEL` from the parent (or the actor being stopped) abandons the run and destroys the
 * registration; a stream fault surfaces as `agent.fault` so the Machine can react rather than
 * hang on a dead stream.
 */
export function agentRunActorWith(portFactory: AgentRunPortFactory) {
  return fromCallback<AgentRunReceiveEvent, AgentRunInput>(({ input, system, sendBack, receive }) => {
    const { instanceId } = input;

    // Register this invocation's event surface (throws on a name outside the manifest —
    // ADR-0011's invoke-time check — which errors the run loudly at the invoking state).
    const binding = runBindingOf(system);
    const dispose = binding.table.register({
      address: mcpAddress(instanceId),
      runId: binding.runId,
      kind: "agent",
      id: instanceId,
      defs: resolveAccepts(binding, input.tools),
      deliver: (event) => sendBack(event),
    });

    const client = portFactory(input.endpoint);
    let stopped = false;

    const abandon = () => {
      if (stopped) return;
      stopped = true;
      dispose();
      void client.cancel(instanceId).catch(() => {});
    };

    // Down-channel: interrupts only (ADR-0002 split-channel model).
    receive((event) => {
      if (event.type === "CANCEL") abandon();
    });

    // Up-channel: the flue stream carries lifecycle + offset, not domain events. Every tool
    // call advances the offset; the host persists it as the durable re-attach handle.
    const onToolCall = (call: AgentToolCall) => {
      if (stopped) return;
      sendBack({ type: "agent.offset", instanceId, offset: call.offset } satisfies OffsetTelemetry);
    };

    // Admit kicked off async; the synchronous callback returns the cleanup fn immediately.
    void (async () => {
      try {
        await client.admit(input, onToolCall);
      } catch (err) {
        if (stopped) return;
        sendBack({
          type: "agent.fault",
          instanceId,
          reason: err instanceof Error ? err.message : String(err),
        } satisfies FaultTelemetry);
      }
    })();

    // Stop (parent stopped the child) == abandon. Idempotent with an explicit CANCEL.
    return abandon;
  });
}
