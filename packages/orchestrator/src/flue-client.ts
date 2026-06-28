// The real, `@flue/sdk`-backed `AgentRunPort` (ADR-0002/0007) — the adapter that drives one Agent
// run over flue's durable agent stream. This is the production fill for the `agentRun` slot the
// instance host injects; `stubAgentRunClient` is its no-flue dev counterpart.
//
// This is the ONE module that imports `@flue/sdk`. Keeping it here (not in `actor.ts`) is what lets
// the run-lifecycle actor and its unit tests stay flue-free (see actor.ts header). The adapter is
// built over an INJECTED flue client (`flueAgentRunPort(flue)`) so its mapping logic is unit-testable
// against a fake; `createFlueAgentRunClient(opts)` is the convenience that builds the real client.
//
// Channel split (ADR-0002, refined): the flue stream carries **lifecycle + offset telemetry**, not
// domain events — those go up the MCP channel via the ControlPlane. So the adapter's whole job on the
// up-side is to surface the durable stream's advancing **offset** (the `(agentName, instanceId)+offset`
// re-attach handle) and to detect terminal/fault. It does NOT translate stream events into domain
// `ControlEvent`s.
//
// Two correctness points worth stating:
//   - Offset cadence. flue streams are chatty (per-token `text_delta`s). Checkpointing the offset on
//     every event would make the Machine `assign` + persist on every token. So we surface the offset
//     only at sane checkpoints: a BASELINE right after admission, and each `tool_start` (a real tool
//     call — and the natural `AgentToolCall`). flue's offset is a resume checkpoint with at-least-once
//     semantics, so a coarse cadence only means a little replay on restore, never a skip.
//   - Baseline guarantee. The baseline checkpoint fires the instant a run is admitted, so
//     `context.offsets[instanceId]` is persisted immediately. Without it, a run that crashes before its
//     first tool call would restore with `attachOffset === undefined` and be wrongly re-`send`'d (a
//     duplicate prompt). With it, re-attach always has a real offset to resume from.

import { createFlueClient } from "@flue/sdk";
import type { AttachedAgentEvent, CreateFlueClientOptions, FlueClient as FlueSdkClient } from "@flue/sdk";
import type { AgentRunPort, AgentRunInput, AgentToolCall } from "./actor.ts";

/** The narrow slice of the flue SDK client this adapter depends on (the injectable seam). */
export type FlueAgentRunDep = { agents: Pick<FlueSdkClient["agents"], "send" | "stream"> };

/** A submission that flue settled as `failed` — surfaced to the actor as an `agent.fault`. */
export class FlueRunFault extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(faultMessage(cause));
    this.name = "FlueRunFault";
    this.cause = cause;
  }
}

/**
 * Build an `AgentRunPort` over an injected flue client. The returned port is shareable across runs:
 * it keys each run's live stream by `instanceId` so `cancel(instanceId)` abandons exactly one run.
 */
export function flueAgentRunPort(flue: FlueAgentRunDep): AgentRunPort {
  // instanceId → the controller abandoning that run's admission + stream.
  const live = new Map<string, AbortController>();

  return {
    async admit(input: AgentRunInput, onToolCall: (call: AgentToolCall) => void): Promise<void> {
      const { agentName, instanceId, prompt, attachOffset } = input;

      const controller = new AbortController();
      live.set(instanceId, controller);
      try {
        // Fresh run → admit the prompt and stream from the admission offset. Re-attach (host dropped
        // `prompt`, set `attachOffset` on restore) → resume the existing stream, no re-POST.
        let startOffset = attachOffset;
        if (startOffset === undefined) {
          if (prompt === undefined) {
            throw new Error("flue admit needs a prompt (fresh run) or attachOffset (re-attach)");
          }
          const admission = await flue.agents.send(agentName, instanceId, {
            message: prompt,
            signal: controller.signal,
          });
          startOffset = admission.offset;
        }

        const stream = flue.agents.stream(agentName, instanceId, {
          offset: startOffset,
          signal: controller.signal,
        });

        // Baseline checkpoint: persist the durable handle the moment the run is (re-)admitted.
        onToolCall({ name: "agent.stream", offset: startOffset });

        for await (const event of stream) {
          if (event.type === "tool_start") {
            // A real tool call — the natural `AgentToolCall`. `stream.offset` is the resume point.
            onToolCall({ name: event.toolName, args: asArgs(event.args), offset: stream.offset });
          } else if (event.type === "submission_settled") {
            if (event.outcome === "failed") throw new FlueRunFault(event.error);
            return; // completed → the run settled; resolve.
          }
        }
        // Stream ended without an explicit settle event — treat as a clean settle.
      } finally {
        live.delete(instanceId);
      }
    },

    async cancel(instanceId: string): Promise<void> {
      // flue exposes no cancel primitive (ADR-0002 / PoC #4): abandon by aborting our consumption and
      // let durability reap the durable run. Aborting the controller cancels an in-flight `send` and
      // the stream alike; the actor swallows the resulting admit rejection because it set `stopped`.
      const controller = live.get(instanceId);
      live.delete(instanceId);
      controller?.abort();
    },
  };
}

/** Convenience: build the real flue SDK client from connection options, then the `AgentRunPort`. */
export function createFlueAgentRunClient(options: CreateFlueClientOptions): AgentRunPort {
  return flueAgentRunPort(createFlueClient(options));
}

/** Coerce a flue event's `args` (typed `unknown`) to the `AgentToolCall.args` record shape. */
function asArgs(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
}

/** A readable fault message from a settled-failed event's error payload. */
function faultMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && typeof (cause as { message?: unknown }).message === "string") {
    return `flue submission failed: ${(cause as { message: string }).message}`;
  }
  return cause === undefined ? "flue submission failed" : `flue submission failed: ${String(cause)}`;
}

// Reference the type so a stream's element type is pinned to the SDK's even as it evolves.
export type FlueAgentStreamEvent = AttachedAgentEvent;
