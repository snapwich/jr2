// @jr2/agent-protocol — the Orchestrator↔Agent wire.
//
// The minimal shared vocabulary both sides must agree on to talk: the `defineEvent` mechanism
// (workflows declare their own control events — jr2 ships none, ADR-0011) and an example event
// set. A pure leaf — no MCP server, no flue, no xstate. (The old `mcpPath` addressing rule died
// with ADR-0013: the Harness reads its Menu at `/agents/<iid>/surface` and builds its own paths.)

export * from "./define-event.ts";
export * from "./examples.ts";
