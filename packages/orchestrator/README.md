# @jr2/orchestrator

The jr2 Orchestrator: the runtime that executes Machines — xstate actors driving Agents in Kubernetes Sandboxes — plus
the HTTP API, the Console it serves, and the Authoring surface.

The Authoring surface is what this package exports from its root: the names that an author writes in a workflow module
or in `jr2.config.ts`, and no other names.

- **Machine and events:** `jr2Setup()`, `defineEvent()`, `sentBy()`, and the type `HostInjectedInput`.
- **Agents:** `agent()`, and the types `AgentDefinition` and `ThinkingLevel`.
- **Workspaces and Repos:** `workspace()`, and the types `Workspaced`, `RepoSlot` and `Binding`.
- **Effects:** `command()`, `arg()`, `http()`, `secret()`, `bearer()`, `basic()`, `text()`, `file()`, `push()`,
  `dispatch()`, `fromPick()`, `paramsOf()`, `answer()`, and the types `CommandOutput`, `HttpOutput`, `PushOutput` and
  `DispatchOutput`.
- **Composition:** `open`, `customize()`, `pool()`, `source()`, and the types `Customize`, `EffectBinding`, `Size` and
  `UserContainer`.
- **Charts:** `openBody()`, `chartSchema`, `chartSchemaFor()`, and the types `OpenBodyDeclaration` and `OpenBodyOutput`.
- **Config:** `defineConfig()`, and the type `JR2Config`.

A state that needs outside input invokes the Gate as `src: "gate"`. You do not import it: `jr2Setup()` registers it.

The kit's own packages import `@jr2/orchestrator/internal`. It is not for workflow authors. It has no stability promise,
and any name in it can change in any release.

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
