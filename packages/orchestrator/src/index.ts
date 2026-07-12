// @j2/orchestrator — the deployed app that runs Machines: workflow config, the MCP control
// plane, the duplex Actor over flue, and durable snapshot persistence (ADR-0002/0006/0007).
// Builds on the `@j2/agent-protocol` wire contract.

export * from "./config.ts";
export * from "./control-plane.ts";
export * from "./durability.ts";
export * from "./snapshot-store.ts";
export * from "./actor.ts";
export * from "./gate.ts";
// Type-only: what a workflow event delivery looks like (the registration TABLE stays internal —
// ADR-0011: workflows speak only defineEvent/agentRun/gate).
export type { DeliveredEvent } from "./registration.ts";
export * from "./machine-doc.ts";
export * from "./run-host.ts";
export * from "./http.ts";
export * from "./flue-client.ts";
export * from "./stub-harness.ts";
export * from "./instance.ts";
