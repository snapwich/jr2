// @j2/agent-protocol — the Orchestrator↔Agent wire.
//
// The minimal shared vocabulary both sides must agree on to talk: the `defineEvent` mechanism
// (workflows declare their own control events — j2 ships none, ADR-0011), an example event set,
// and the instance-ID addressing rule. A pure leaf — no MCP server, no flue, no xstate.

export * from "./define-event.ts";
export * from "./examples.ts";
export * from "./addressing.ts";
