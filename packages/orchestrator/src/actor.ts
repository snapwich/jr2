// The run-lifecycle Actor (ADR-0002, refined for the multi-run instance): an xstate `fromCallback`
// actor that drives one Agent run over an `AgentRunPort`. It admits (or re-attaches to) the run,
// surfaces the durable stream's advancing offset as telemetry, accepts a down-channel CANCEL, and
// abandons the run on stop.
//
// It does NOT translate the Agent's domain tool calls into events. Under the host-owned MCP mux
// (ADR-0002 "Refined: multi-run instance wiring"), domain `ControlEvent`s come up the **MCP**
// channel via the host's `ControlPlane` and are routed into the Machine by the host — not derived
// from the flue stream here. So the channel split is concrete: this Actor owns **flue = lifecycle +
// offset telemetry**; the ControlPlane owns **MCP = domain events**. The Actor therefore emits only
// telemetry (`agent.offset`, `agent.fault`), never domain events.
//
// The port — `AgentRunPort`, not `@flue/sdk` — is the dependency, so the actor is unit-testable
// without a live Harness/cluster: `agentRunActorWith(mockClient)` is the seam. `agentRunActor` binds
// the same logic to a default port wired in the orchestrator slice — and because `@flue/sdk` is
// never imported here, requiring this module (and the mock-driven tests) never pulls it in. (The
// port is deliberately NOT named `FlueClient`: `@flue/sdk` exports its own, much wider, `FlueClient`,
// which the real adapter consumes to *implement* this narrow port.)
//
// Durable handle (ADR-0002/0007): the re-attach key is `(agentName, instanceId) + offset`. The
// actor cannot persist anything itself (context lives in the parent Machine), so it *surfaces* the
// advancing stream offset as an `agent.offset` telemetry event. The host folds that offset into
// Machine context; on restore it rewrites the child's input (`attachOffset`) to resume the stream
// instead of re-POSTing the prompt.

import { fromCallback } from "xstate";
import type { Menu } from "@j2/agent-protocol";

/** What the actor is invoked with: the durable handle plus this turn's prompt and menu. */
export type AgentRunInput = {
  agentName: string;
  instanceId: string;
  prompt?: string;
  /**
   * Resume the durable stream from this opaque offset (re-attach) instead of admitting a fresh
   * prompt. Set by the host on restore (which also drops `prompt`); see {@link AgentToolCall.offset}.
   */
  attachOffset?: string;
  menu: Menu;
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

/** Everything the actor sends up to the parent Machine — telemetry only, never domain events. */
export type AgentRunUpEvent = OffsetTelemetry | FaultTelemetry;

/** The only event the parent sends down: an interrupt that abandons the run. */
export type AgentRunReceiveEvent = { type: "CANCEL" };

/**
 * The port the Actor drives. Narrow by design — admit a run (handing it a sink for the run's
 * stream tool calls) and abandon it — so a test can supply a synthetic client and feed tool calls
 * by hand. The real, `@flue/sdk`-backed implementation is composed in the orchestrator slice and is
 * never needed at test time.
 */
export interface AgentRunPort {
  /**
   * Admit (or, when `input.attachOffset` is set, re-attach to) a run, invoking `onToolCall` for
   * each stream tool call until the run settles. Resolving means the stream ended; rejecting means
   * it faulted.
   */
  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void>;
  /** Abandon the run (flue exposes no cancel primitive — drop and let durability reap it). */
  cancel(instanceId: string): Promise<void>;
}

/**
 * Build the run-lifecycle actor logic over an injected `AgentRunPort`.
 *
 * On start it admits the run, then for each stream tool call sends up an `agent.offset` telemetry
 * event carrying the new offset (so the host persists the durable handle). A `CANCEL` received from
 * the parent (or the actor being stopped) abandons the run via the port; a stream fault surfaces as
 * `agent.fault` so the Machine can react rather than hang on a dead stream.
 */
export function agentRunActorWith(client: AgentRunPort) {
  return fromCallback<AgentRunReceiveEvent, AgentRunInput>(({ input, sendBack, receive }) => {
    const { instanceId } = input;
    let stopped = false;

    const abandon = () => {
      if (stopped) return;
      stopped = true;
      void client.cancel(instanceId).catch(() => {});
    };

    // Down-channel: interrupts only (ADR-0002 split-channel model).
    receive((event) => {
      if (event.type === "CANCEL") abandon();
    });

    // Up-channel: the flue stream carries lifecycle + offset, not domain events. Every tool call
    // advances the offset; the host persists it as the durable re-attach handle.
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

/**
 * The default port. The real, durable-stream-backed adapter is composed in the orchestrator slice
 * with the full `(agentName, instanceId)` handle; binding it here would pull `@flue/sdk` onto the
 * module-load path and into every unit test. So the default throws, and any real run supplies its
 * port via `agentRunActorWith` (the instance host injects the flue adapter or a dev stub).
 */
const defaultAgentRunPort: AgentRunPort = {
  async admit(): Promise<void> {
    throw new Error("the default AgentRunPort is wired by the instance host; inject a port via agentRunActorWith");
  },
  async cancel(): Promise<void> {
    // No-op: flue exposes no cancel primitive (ADR-0002 / PoC #4); durability reaps the run.
  },
};

/** Default actor logic over the host-wired AgentRunPort. */
export const agentRunActor = agentRunActorWith(defaultAgentRunPort);
