# j2

Next-generation `jr` orchestrator. A kit for building agentic workflows modeled as [xstate](https://stately.ai/docs)
state machines, where each Agent runs in its own host-isolated Kubernetes pod (Sandbox), hosted by j2's own Harness
(ADR-0027, built on [pi-agent-core](https://github.com/earendil-works/pi)). Local development runs on
[kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker).

See [CONTEXT.md](./CONTEXT.md) for the glossary (the terms below are defined there) and [docs/adr/](./docs/adr/) for
architecture decisions.

## Packages

| Path            | Lang | What it is                                                                                   |
| --------------- | ---- | -------------------------------------------------------------------------------------------- |
| `operator/`     | Go   | Kubernetes operator reconciling the `Sandbox` CRD into Pods + Services (the controller).     |
| `harness/`      | TS   | The Sandbox image: j2's own Harness (ADR-0027) hosting the Agents inside a Sandbox (server). |
| `orchestrator/` | TS   | The Orchestrator pod image: xstate runtime + Harness client + Actors, pieces, Machines.      |

`harness` and `orchestrator` are pnpm workspace packages; `operator` is a standalone Go module.

## Status

Greenfield. Design in progress via `/grill-with-docs`; see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/). Only
scaffolding exists so far.

## Prerequisites

- Node.js >= 22, pnpm
- Go >= 1.24, [kubebuilder](https://kubebuilder.io/) (operator)
- Docker, [kind](https://kind.sigs.k8s.io/), kubectl, [just](https://github.com/casey/just)
