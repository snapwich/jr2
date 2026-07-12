// @j2/agent-protocol — the Orchestrator↔Agent wire.
//
// The minimal shared vocabulary both sides must agree on to talk: the MCP callback toolset,
// the up-channel event union it maps to, the flat control-surface menu mechanism, and the
// instance-ID addressing rule. A pure leaf — no MCP server, no flue, no xstate.

export * from "./define-event.ts";
export * from "./tools.ts";
export * from "./events.ts";
export * from "./menu.ts";
export * from "./addressing.ts";
