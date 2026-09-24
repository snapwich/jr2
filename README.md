# jr2

Next-generation [`jr`](https://www.richsnapp.com/article/2026/03-30-automating-your-agents) orchestrator. A kit for
building agentic workflows modeled as [xstate](https://stately.ai/docs) state machines, where each Agent runs in its own
host-isolated Kubernetes pod (Sandbox), hosted by jr2's own Harness (ADR-0027, built on
[pi-agent-core](https://github.com/earendil-works/pi)). Local development runs on [kind](https://kind.sigs.k8s.io/)
(Kubernetes in Docker).

See [CONTEXT.md](./CONTEXT.md) for the glossary (the terms below are defined there),
[docs/architecture.md](./docs/architecture.md) for the diagrams (what runs where, one Turn, setup and usage, composing a
Workflow), and [docs/adr/](./docs/adr/) for architecture decisions.

## Packages

| Path                       | Lang | What it is                                                                                                    |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `packages/cli/`            | TS   | The `jr2` binary: `init`, `up`, `down`, `gc`, `kit push`, `run`, `send`, `status`, `runs`, `logs` (ADR-0009). |
| `packages/orchestrator/`   | TS   | The Orchestrator: xstate runtime, HTTP API + Console, Actors, and the kit pieces a Workflow imports.          |
| `packages/harness/`        | TS   | jr2's own Harness (ADR-0027): hosts the Agents inside a Sandbox and on the Instance Harness.                  |
| `packages/adapter/`        | TS   | The Adapter (ADR-0013): serves the Turn's Menu over MCP and forwards picks as Gate deliveries.                |
| `packages/agent-protocol/` | TS   | The Orchestrator↔Agent wire: `defineEvent` and nothing else — a pure leaf.                                    |
| `operator/`                | Go   | Kubernetes operator: the `Sandbox` and `Repo` CRDs, the controller, and the per-node cache agent (ADR-0051).  |

`packages/*` are pnpm workspace packages; `operator/` is a standalone Go module. `harness`, `adapter`, and `operator`
ship as the three Kit images (ADR-0038).

## Status

Pre-1.0. Design in progress via `/grill-with-docs`; see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/). The
instance-facing packages publish to npm as `@jr2/{cli,orchestrator,agent-protocol,machines}`; 0.x minors break.

## Prerequisites

- Node.js >= 24, pnpm
- Go >= 1.24, [kubebuilder](https://kubebuilder.io/) (operator)
- Docker, [kind](https://kind.sigs.k8s.io/), kubectl, [just](https://github.com/casey/just)

## Releasing

One release train (ADR-0019/0055): the npm version is the Kit image tag, every manifest carries the one number, and the
tag push is the release.

```sh
just release minor          # bump, gate, commit `release: x.y.0`, tag vx.y.0
git push origin main vx.y.0
```

The tag runs `.github/workflows/release.yml`: every tier on a runner kind cluster, the Kit images to `ghcr.io/snapwich`,
then the four packages **staged** on npm by trusted publishing. Approve them with 2FA, dependencies first
(`npm stage list`, then `npm stage approve <stage-id>`, or the Staged Packages tab on npmjs.com), and the release is
live. Or, when a release cannot wait on the job, `just publish` from the pushed tag does the same half by hand — images,
then `npm publish` with a 2FA prompt per package — and the job converges behind it. Either way the guard is the
credential: the job holds no token, and a login without its second factor publishes nothing.

## License

[MIT](./LICENSE) © Rich Snapp
