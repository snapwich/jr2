# @jr2/orchestrator

The jr2 Orchestrator: the runtime that executes Machines — xstate actors driving Agents in Kubernetes Sandboxes — plus
the HTTP API, the Console it serves, and the kit pieces a Workflow imports (`agent()`, `workspace()`, `gate()`,
`customize()`, …).

An Instance depends on it and its `workflows/` import from it; `jr2 up` bakes the engine and those workflows into one
image, so this package is run in-cluster, never on the host. Its version is the kit's version: the Kit images an
installed kit pulls carry the same tag (one release train).

```ts
// workflows/task.ts
import { customize } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

export const machine = customize(task, {
  repos: { target: { url: "https://github.com/you/repo.git" } },
  agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
});
```

Scaffold one with `@jr2/cli`. Docs, glossary, and architecture decisions:
[github.com/snapwich/jr2](https://github.com/snapwich/jr2).
