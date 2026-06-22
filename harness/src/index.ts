// j2 Harness — the flue server that runs inside a Sandbox and hosts j2 Agents.
//
// This package builds the Sandbox container image. At runtime it is a long-running
// flue server (`POST /agents/<name>/<id>`, async dispatch, SSE streaming) that the
// Orchestrator's Actors drive via a flue client.
//
// TODO: replace this placeholder with the flue server bootstrap. Agent definitions
// (the worker personas — coder, reviewer, etc.) live in `src/agents/`.

export {};
