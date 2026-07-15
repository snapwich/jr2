// @j2/orchestrator — the deployed app that runs Machines: workflow config, the agent + gate
// delivery surfaces, the duplex Actor over flue, and durable snapshot persistence
// (ADR-0002/0006/0007). Builds on the `@j2/agent-protocol` wire contract.
//
// It does NOT speak MCP (ADR-0013): the Agent's MCP surface is hosted by the Adapter, in the
// Sandbox. What lives here is the registration table and two thin HTTP adapters over it.

// The wire contract, re-exported: a workflow authors against ONE package (`defineEvent`,
// `j2Setup`, `workspace`, … all import from "@j2/orchestrator" — ADR-0015).
export * from "@j2/agent-protocol";
export * from "./config.ts";
export * from "./setup.ts";
export * from "./vocabulary.ts";
export * from "./tokens.ts";
export * from "./durability.ts";
export * from "./snapshot-store.ts";
export * from "./actor.ts";
export * from "./gate.ts";
export * from "./workspace.ts";
export * from "./sandbox-kubectl.ts";
export * from "./repos.ts";
// Type-only: what a workflow event delivery looks like (the registration TABLE stays internal —
// ADR-0011: workflows speak only defineEvent/agentRun/gate).
export type { DeliveredEvent } from "./registration.ts";
export * from "./machine-doc.ts";
export * from "./run-host.ts";
export * from "./http.ts";
export * from "./flue-client.ts";
export * from "./stub-harness.ts";
export * from "./instance.ts";
