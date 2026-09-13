# j2

Next-generation `jr` orchestrator. A kit for building agentic workflows modeled as [xstate](https://stately.ai/docs)
state machines, where each Agent runs in its own host-isolated Kubernetes pod (Sandbox), hosted by j2's own Harness
(ADR-0027, built on [pi-agent-core](https://github.com/earendil-works/pi)). Local development runs on
[kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker).

See [CONTEXT.md](./CONTEXT.md) for the glossary (the terms below are defined there),
[docs/architecture.md](./docs/architecture.md) for the diagrams (what runs where, one Turn, setup and usage, composing a
Workflow), and [docs/adr/](./docs/adr/) for architecture decisions.

## Packages

| Path                       | Lang | What it is                                                                                                   |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `packages/cli/`            | TS   | The `j2` binary: `init`, `up`, `down`, `gc`, `kit push`, `run`, `send`, `status`, `runs`, `logs` (ADR-0009). |
| `packages/orchestrator/`   | TS   | The Orchestrator: xstate runtime, HTTP API + Console, Actors, and the kit pieces a Workflow imports.         |
| `packages/harness/`        | TS   | j2's own Harness (ADR-0027): hosts the Agents inside a Sandbox and on the Instance Harness.                  |
| `packages/adapter/`        | TS   | The Adapter (ADR-0013): serves the Turn's Menu over MCP and forwards picks as Gate deliveries.               |
| `packages/agent-protocol/` | TS   | The Orchestrator↔Agent wire: `defineEvent` and nothing else — a pure leaf.                                   |
| `operator/`                | Go   | Kubernetes operator: the `Sandbox` and `Repo` CRDs, the controller, and the per-node cache agent (ADR-0051). |

`packages/*` are pnpm workspace packages; `operator/` is a standalone Go module. `harness`, `adapter`, and `operator`
ship as the three Kit images (ADR-0038).

## Status

Greenfield. Design in progress via `/grill-with-docs`; see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/). Only
scaffolding exists so far.

## Prerequisites

- Node.js >= 22, pnpm
- Go >= 1.24, [kubebuilder](https://kubebuilder.io/) (operator)
- Docker, [kind](https://kind.sigs.k8s.io/), kubectl, [just](https://github.com/casey/just)
