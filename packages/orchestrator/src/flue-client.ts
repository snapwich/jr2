// The real, `@flue/sdk`-backed `AgentRunPort` (ADR-0002/0007/0016) — the adapter that drives one
// Agent run over flue's durable agent surface — and the canonical `agentRun` actor built on it
// (ADR-0011: workflows import it statically; the client is constructed from `input.endpoint`).
//
// This is the ONE module that imports `@flue/sdk`. Keeping it here (not in `actor.ts`) is what lets
// the run-lifecycle actor and its unit tests stay flue-free (see actor.ts header). The adapter is
// built over an INJECTED flue client (`flueAgentRunPort(flue)`) so its mapping logic is unit-testable
// against a fake; `createFlueAgentRunClient(opts)` is the convenience that builds the real client.
//
// Channel split (ADR-0002, refined by ADR-0016): the flue surface carries **lifecycle only** —
// domain events go up the MCP channel via the Adapter. Since flue ≥ beta.8 the SDK's own
// `send`/`wait` pair is exactly that lifecycle surface: `send` answers with a serializable
// admission (`{ streamUrl, offset, submissionId }` — j2's durable re-attach handle, stored in the
// host ledger), and `wait(admission)` replays the conversation stream from the admission offset to
// the submission's settlement — flue's reconnect-from-offset machinery, so j2 no longer hand-rolls
// `tool_start`-cadence offset checkpointing. Re-attach after a restart is `wait` with the SAME
// persisted admission; replay cost is bounded by one submission's chunks.
//
// `agents.abort()` (beta.8+; ADR-0002's "flue exposes no cancel primitive" is stale) is the third
// verb, and ADR-0024 wires it to the END OF THE INVOCATION: a turn ends with the state that asked
// for it. It aborts the running submission and everything queued behind it, and settles them to
// flue's distinct `aborted` outcome — worth having for observability, though j2 never reads it
// (the actor is stopped by then; see actor.ts).

import { createFlueClient, FlueExecutionError } from "@flue/sdk";
import type { CreateFlueClientOptions, FlueClient as FlueSdkClient } from "@flue/sdk";
import { agentRunActorWith } from "./actor.ts";
import type { AgentRunPort, AgentRunInput, AgentAdmission } from "./actor.ts";

/** The narrow slice of the flue SDK client this adapter depends on (the injectable seam). */
export type FlueAgentRunDep = { agents: Pick<FlueSdkClient["agents"], "send" | "wait" | "abort"> };

/** A submission that flue settled failed/aborted — surfaced to the actor as an `agent.fault`. */
export class FlueRunFault extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(faultMessage(cause));
    this.name = "FlueRunFault";
    this.cause = cause;
  }
}

/** Build an `AgentRunPort` over an injected flue client. Stateless — the admission IS the handle. */
export function flueAgentRunPort(flue: FlueAgentRunDep): AgentRunPort {
  return {
    async admit(input: AgentRunInput, opts?: { signal?: AbortSignal }): Promise<AgentAdmission> {
      if (input.prompt === undefined) {
        throw new Error("flue admit needs a prompt (a re-attach rides input.attach, set by the host on restore)");
      }
      return await flue.agents.send(input.agentName, input.instanceId, {
        message: input.prompt,
        signal: opts?.signal,
      });
    },

    async settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void> {
      try {
        await flue.agents.wait(admission, { signal: opts?.signal });
      } catch (err) {
        // A local abort is the actor abandoning consumption — let it propagate untranslated
        // (the stopped actor swallows it). Only flue's own settlement failures become faults.
        if (err instanceof FlueExecutionError) throw new FlueRunFault(err.error ?? err.message);
        throw err;
      }
    },

    async abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void> {
      // The result (`{ aborted }` — whether there was work to end) is dropped: by the time this
      // runs the state has already moved on, and an idle instance is exactly as fine as a
      // stopped one. Settlement is asynchronous and nothing here is listening (ADR-0024).
      await flue.agents.abort(agentName, instanceId, { signal: opts?.signal });
    },
  };
}

/** Convenience: build the real flue SDK client from connection options, then the `AgentRunPort`. */
export function createFlueAgentRunClient(options: CreateFlueClientOptions): AgentRunPort {
  return flueAgentRunPort(createFlueClient(options));
}

/**
 * THE `agentRun` actor (ADR-0011): pre-registered by `j2Setup` (ADR-0015), importable statically.
 * Everything live is constructed per-invocation from serializable input: the flue client from
 * `input.endpoint` (which Sandbox's Harness — or a wire-compatible dev stub; either way it's only
 * a URL, one code path). Lives here, not in actor.ts, so the actor logic and its unit tests never
 * load `@flue/sdk`.
 */
export const agentRun = agentRunActorWith((endpoint) => createFlueAgentRunClient({ baseUrl: endpoint }));

/** A readable fault message from a settled-failed error payload. */
function faultMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && typeof (cause as { message?: unknown }).message === "string") {
    return `flue submission failed: ${(cause as { message: string }).message}`;
  }
  if (typeof cause === "string") return `flue submission failed: ${cause}`;
  return cause === undefined ? "flue submission failed" : `flue submission failed: ${String(cause)}`;
}
