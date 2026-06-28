// A dev-only `AgentRunPort` for booting an instance WITHOUT a live flue Harness. `j2 dev` (and the
// instance bootstrap, src/instance.ts) needs *some* port to fill each workflow's `agentRun` slot;
// the real `@flue/sdk`-backed adapter is a later slice and needs a reachable Harness + vLLM. Until
// then this stub lets the orchestrator come up, discover workflows, restore snapshots, and serve the
// HTTP surface so the control/observe loop is exercisable end-to-end.
//
// Behaviour: `admit` resolves to a promise that never settles — the run is "admitted" and stays live
// (no model work, no tool calls, so no `agent.offset` telemetry ever flows). That is exactly the
// shape the run-lifecycle actor expects of a long-running stream, so a stubbed run sits in its
// initial Machine state, is observable via `GET /runs`, persists as `live`, and re-attaches cleanly
// on restore. `cancel` is the usual abandon no-op (flue exposes no cancel primitive — ADR-0002).
//
// What it does NOT do: drive the Machine forward. Domain transitions come from the Agent calling the
// MCP callback tools; with no Agent there is nothing to call them. Tests/humans can still drive a
// stubbed run by hand over `mcpServer(instanceId)` (the in-memory or HTTP MCP client), which is how
// the run-host/http suites already exercise the up-channel.

import type { AgentRunPort } from "./actor.ts";

/** Build a no-flue `AgentRunPort`: admits and stays live; never surfaces tool calls; abandon is a no-op. */
export function stubAgentRunClient(): AgentRunPort {
  return {
    admit(): Promise<void> {
      // Stay live indefinitely — a real run's stream is long-lived; durability/cancel ends it.
      return new Promise<void>(() => {});
    },
    async cancel(): Promise<void> {
      // No-op abandon (ADR-0002 / PoC #4): flue has no cancel primitive; durability reaps the run.
    },
  };
}
