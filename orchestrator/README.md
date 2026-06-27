# @j2/orchestrator

The **Orchestrator pod image** (client side). The xstate runtime plus the kit: the [Actor](../CONTEXT.md) that drives a
remote Agent run via a flue client, the composable pieces (worktree setup, memory, ...), and example
[Machines](../CONTEXT.md) — including the feature/task coding Machine.

The Orchestrator runs in its own pod, loads a Machine, and interprets it to completion.

## Status

The core primitive exists (PoC #5 — [`poc/actor`](../poc/actor/)):

- `src/control-plane.ts` — the MCP control plane (Sandbox → Orchestrator ingress), one server routed per Instance ID.
- `src/actor.ts` — the duplex `fromCallback` Actor that drives one Agent run (ADR-0002).
- `src/machine.ts` — a minimal driving Machine (approval gate) the PoC drives end-to-end against real flue + vLLM.

The remaining pieces (worktree setup, memory, work-source, the coding Machine) and the pod entrypoint are still to come.

Runs under Node's native TypeScript type-stripping (`node src/index.ts`); `pnpm typecheck` is the type gate. The pod
image build is still a placeholder (see `Dockerfile`).

## Likely future split

The Actor↔Harness **protocol** (the flue SSE event shapes mapped into xstate events) is shared with `@j2/harness` and
may graduate into its own package once it stabilizes.
