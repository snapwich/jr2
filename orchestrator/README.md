# @j2/orchestrator

The **Orchestrator pod image** (client side). The xstate runtime plus the kit: the [Actor](../CONTEXT.md) that drives a
remote Agent run via a flue client, the composable pieces (worktree setup, memory, ...), and example
[Machines](../CONTEXT.md) — including the feature/task coding Machine.

The Orchestrator runs in its own pod, loads a Machine, and interprets it to completion.

## Status

Placeholder. The Actor, pieces, and Machines are not yet implemented — pending resolution of the Actor ↔ Harness
protocol (see `docs/adr/` and the open design questions).

## Likely future split

The Actor↔Harness **protocol** (the flue SSE event shapes mapped into xstate events) is shared with `@j2/harness` and
may graduate into its own package once it stabilizes.
