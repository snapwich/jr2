// The duplex Actor — the one primitive every Machine is built on (ADR-0002).
//
// An xstate `fromCallback` actor that drives ONE Agent run on a remote Harness:
//   • entry: POST the prompt to `POST /agents/:name/:id`, persist the durable
//     handle `(name, instanceId) + offset`, and own its slot in the MCP control
//     plane.
//   • UP: Agent tool calls arrive at the control plane and are `sendBack`'d as
//     xstate events; flue's Durable Stream is consumed as passive telemetry.
//   • DOWN: `receive` answers a deferred `request_approval` (solicited),
//     enqueues a steer (2nd POST or inbox), or abandons on cancel.
//
// Re-attach: pass `attachOffset` to skip the POST and resume an in-flight run's
// stream from a persisted checkpoint — a restarted Orchestrator re-attaches by
// `(name, instanceId) + offset` (PoC #4 Finding 1), it does not restart the run.

import { fromCallback } from "xstate";
import { createFlueClient } from "@flue/sdk";
import type { ControlEvent, ControlPlane } from "./control-plane.ts";

export interface AgentRunInput {
  controlPlane: ControlPlane;
  harnessBase: string;
  agentName: string;
  instanceId: string;
  /** The prompt to admit. Omit together with `attachOffset` to re-attach only. */
  prompt?: string;
  /** Resume an in-flight run's stream from this offset instead of POSTing. */
  attachOffset?: string;
}

/** Events the Actor emits UP to the Machine. */
export type AgentUpEvent =
  | ControlEvent
  | { type: "actor.admitted"; instanceId: string; offset: string; submissionId: string }
  | { type: "actor.telemetry"; instanceId: string; kind: string; detail?: string }
  | { type: "actor.settled"; instanceId: string; outcome: string }
  | { type: "actor.error"; instanceId: string; message: string };

/** Events the Machine sends DOWN to the Actor. */
export type AgentDownEvent =
  | { type: "APPROVE"; decision?: string }
  | { type: "DENY"; decision?: string }
  | { type: "STEER"; message: string; mode?: "prompt" | "inbox" }
  | { type: "CANCEL" };

export const agentRunActor = fromCallback<AgentDownEvent, AgentRunInput>(({ sendBack, receive, input }) => {
  const { controlPlane, harnessBase, agentName, instanceId, prompt, attachOffset } = input;
  const client = createFlueClient({ baseUrl: harnessBase });
  const streamAbort = new AbortController();
  let abandoned = false;

  // Up control: route every control-plane tool call to the Machine verbatim.
  controlPlane.register(instanceId, (event) => sendBack(event));

  // Down: solicited approval, steer, cancel.
  receive((event) => {
    switch (event.type) {
      case "APPROVE":
        controlPlane.answerApproval(instanceId, event.decision ?? "APPROVED");
        break;
      case "DENY":
        controlPlane.answerApproval(instanceId, event.decision ?? "DENIED");
        break;
      case "STEER":
        // PoC #4 Finding 2: a 2nd POST lands at the NEXT turn boundary (FIFO),
        // not mid-turn. `inbox` mode instead defers to the Agent's check_inbox.
        if (event.mode === "inbox") {
          controlPlane.postInbox(instanceId, event.message);
        } else {
          void client.agents
            .send(agentName, instanceId, { message: event.message })
            .catch((e) => sendBack({ type: "actor.error", instanceId, message: `steer failed: ${e}` }));
        }
        break;
      case "CANCEL":
        // No flue cancel primitive exists (Finding 2): abandon the run — stop
        // consuming, release the deferred, and let DurabilityConfig.timeoutMs reap it.
        abandoned = true;
        streamAbort.abort("cancelled");
        break;
    }
  });

  // Entry: admit the prompt (unless we are re-attaching to an in-flight run).
  let startOffset: string | Promise<string> = attachOffset ?? "";
  if (!attachOffset) {
    if (!prompt) throw new Error("agentRunActor: prompt or attachOffset is required");
    startOffset = client.agents.send(agentName, instanceId, { message: prompt }).then((admission) => {
      sendBack({ type: "actor.admitted", instanceId, offset: admission.offset, submissionId: admission.submissionId });
      return admission.offset;
    });
  }

  // Up progress: consume the Durable Stream as passive telemetry. Lossy/optional
  // — control flow rides the MCP tools, not this stream.
  void (async () => {
    try {
      const offset = await startOffset;
      const stream = client.agents.stream(agentName, instanceId, {
        offset: offset || "-1",
        live: true,
        signal: streamAbort.signal,
      });
      for await (const e of stream) {
        if (abandoned) break;
        if (e.type === "tool_start") {
          sendBack({
            type: "actor.telemetry",
            instanceId,
            kind: "tool_start",
            detail: (e as { toolName?: string }).toolName,
          });
        } else if (e.type === "submission_settled") {
          sendBack({ type: "actor.settled", instanceId, outcome: (e as { outcome?: string }).outcome ?? "unknown" });
        }
      }
    } catch (err) {
      if (!abandoned) sendBack({ type: "actor.error", instanceId, message: `stream: ${err}` });
    }
  })();

  // Cleanup on actor stop.
  return () => {
    streamAbort.abort("actor stopped");
    controlPlane.unregister(instanceId);
  };
});
