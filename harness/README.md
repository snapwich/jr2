# @j2/harness

The **Sandbox image** (server side). A flue [Harness](../CONTEXT.md) hosting the [Agents](../CONTEXT.md) that run inside
a Sandbox.

At runtime this is a long-running flue server that the Orchestrator's Actors drive via a flue client. Agent definitions
(worker personas — coder, reviewer, etc.) live in `src/agents/`.

## Status

Placeholder. The flue server bootstrap and Agent definitions are not yet implemented — pending resolution of the Actor ↔
Harness protocol (see `docs/adr/` and the open design questions).
