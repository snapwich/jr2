// The duplex Actor (ADR-0002): an xstate `fromCallback` actor that drives one Agent run over a
// `FlueClient` port. It admits the run, maps the Agent's callback tool calls up into the Machine
// via `sendBack` as `ControlEvent`s, accepts down-channel interrupts via `receive`, and abandons
// the run on stop. `menu` scopes which picks the run advertises in this state (ADR-0006).
//
// The port (not `@flue/sdk`) is the dependency, so the actor is unit-testable without a live
// Harness/cluster: `agentRunActorWith(mockClient)` is the seam. `agentRunActor` binds the same
// logic to a default client wired in the orchestrator slice — and because `@flue/sdk` is never
// imported here, requiring this module (and the mock-driven tests) never pulls it in.
//
// Mapping lives here, not in the port: the port surfaces raw `(name, args, offset)` tool calls;
// the actor translates each to the `ControlEvent` the Machine consumes, stamping the run's
// `instanceId` (the addressing rule — events are addressed by who owns the run, not by args).
//
// Durable handle (ADR-0002/0007): the re-attach key is `(agentName, instanceId) + offset`. The
// actor cannot persist anything itself (context lives in the parent Machine), so it *surfaces*
// the advancing stream offset as an `agent.offset` telemetry event sent up before each tool call
// it forwards. The host folds that offset into Machine context; on restore it rewrites the
// child's input (`attachOffset`) to resume the stream instead of re-POSTing the prompt.

import { fromCallback } from "xstate";
import type { Menu, ControlEvent } from "@j2/agent-protocol";

/** What the actor is invoked with: the durable handle plus this turn's prompt and menu. */
export type AgentRunInput = {
  agentName: string;
  instanceId: string;
  prompt?: string;
  /** Resume the stream from this offset (re-attach) instead of admitting a fresh prompt. */
  attachOffset?: number;
  menu: Menu;
};

/** One raw Agent callback tool call surfaced by the port, paired with its stream offset. */
export type AgentToolCall = {
  /** The callback tool the Agent invoked (e.g. `request_review`, `done`, `check_inbox`). */
  name: string;
  /** The tool's (already JSON-parsed) arguments. */
  args?: Record<string, unknown>;
  /** Monotonic logical offset of this call in the run's durable stream. */
  offset: number;
};

/** Telemetry sent up so the host can persist the durable handle's advancing offset. */
export type OffsetTelemetry = {
  type: "agent.offset";
  instanceId: string;
  offset: number;
};

/** Everything the actor sends up to the parent Machine. */
export type AgentRunUpEvent = ControlEvent | OffsetTelemetry;

/** The only event the parent sends down: an interrupt that abandons the run. */
export type AgentRunReceiveEvent = { type: "CANCEL" };

/**
 * The port the Actor drives. Narrow by design — admit a run (handing it a sink for the run's
 * callback tool calls) and abandon it — so a test can supply a synthetic client and feed tool
 * calls by hand. The real, `@flue/sdk`-backed implementation is composed in the orchestrator
 * slice and is never needed at test time.
 */
export interface FlueClient {
  /**
   * Admit (or, when `input.attachOffset` is set, re-attach to) a run, invoking `onToolCall` for
   * each callback tool call until the run settles. Resolving means the stream ended; rejecting
   * means it faulted.
   */
  admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void>;
  /** Abandon the run (flue exposes no cancel primitive — drop and let durability reap it). */
  cancel(instanceId: string): Promise<void>;
}

/**
 * Build the duplex actor logic over an injected `FlueClient` port.
 *
 * On start it admits the run, then for each callback tool call sends up an `agent.offset`
 * telemetry event carrying the new offset (so the host persists the durable handle *before* it
 * acts) followed by the mapped `ControlEvent` when the tool maps to one. A `CANCEL` received
 * from the parent (or the actor being stopped) abandons the run via the port.
 */
export function agentRunActorWith(client: FlueClient) {
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

    // Up-channel: surface the offset for the durable handle, then forward the mapped event.
    const onToolCall = (call: AgentToolCall) => {
      if (stopped) return;
      // Offset advances on every call (even non-domain polls like check_inbox).
      sendBack({ type: "agent.offset", instanceId, offset: call.offset } satisfies OffsetTelemetry);
      const event = mapToolCall(call.name, call.args, instanceId);
      if (event) sendBack(event);
    };

    // Admit kicked off async; the synchronous callback returns the cleanup fn immediately.
    void (async () => {
      try {
        await client.admit(input, onToolCall);
      } catch (err) {
        if (stopped) return;
        // An infra fault on the up-channel is surfaced as a blocked report so the Machine can
        // react (re-attach, fail the run) rather than hang waiting on a dead stream.
        sendBack({
          type: "agent.reportBlocked",
          instanceId,
          reason: err instanceof Error ? err.message : String(err),
        } satisfies ControlEvent);
      }
    })();

    // Stop (parent stopped the child) == abandon. Idempotent with an explicit CANCEL.
    return abandon;
  });
}

/**
 * Map a callback tool call to its up-channel `ControlEvent`, stamping the run's `instanceId`.
 * Non-domain tools (`check_inbox`, anything off the callback toolset) map to `null` — they
 * advance the offset but are not events the Machine transitions on.
 */
export function mapToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  instanceId: string,
): ControlEvent | null {
  const a = args ?? {};
  switch (name) {
    case "done":
      return { type: "agent.done", instanceId, summary: asString(a["summary"]) };
    case "request_review":
      return { type: "agent.requestReview", instanceId, summary: asString(a["summary"]) ?? "" };
    case "report_blocked":
      return { type: "agent.reportBlocked", instanceId, reason: asString(a["reason"]) ?? "" };
    case "request_approval":
      return {
        type: "agent.requestApproval",
        instanceId,
        action: asString(a["action"]) ?? "",
        reason: asString(a["reason"]),
      };
    default:
      return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * The default client. The real, durable-stream-backed adapter is composed in the orchestrator
 * slice with the full `(agentName, instanceId)` handle; binding it here would pull `@flue/sdk`
 * onto the module-load path and into every unit test. So the default throws, and any real run
 * supplies its client via `agentRunActorWith`.
 */
const defaultFlueClient: FlueClient = {
  async admit(): Promise<void> {
    throw new Error("the default FlueClient is wired in the orchestrator slice; inject a client via agentRunActorWith");
  },
  async cancel(): Promise<void> {
    // No-op: flue exposes no cancel primitive (ADR-0002 / PoC #4); durability reaps the run.
  },
};

/** Default actor logic over the orchestrator-wired FlueClient. */
export const agentRunActor = agentRunActorWith(defaultFlueClient);
