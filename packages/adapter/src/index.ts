// @jr2/adapter — the Agent's MCP surface, hosted in the Sandbox (ADR-0013).
//
// This package exists because of where its code RUNS, not what it does: it is the one process in a
// Sandbox pod that holds an Orchestrator credential, and it is not the process the Agent can
// execute code in. See adapter.ts.

export * from "./adapter.ts";
export * from "./serve.ts";
