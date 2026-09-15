# @j2/machines

The Machines the kit ships (ADR-0054). A fourth published package beside `@j2/{cli,orchestrator,agent-protocol}`, on the
same release train, exporting named Machines from its index.

It ships **Machines**, never Workflows: a Workflow is the name an Instance registers a Machine under, and only the
Instance's `workflows/` file can do that. So the consumer line is one file of your own —

```ts
// workflows/task.ts  →  the workflow "task"
import { customize } from "@j2/orchestrator";
import { task } from "@j2/machines";

export const machine = customize(task, {
  repos: { target: { url: "https://github.com/you/repo.git" } },
  agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
});
```

## The Open parts

A packaged Machine leaves the parts a package cannot honestly fill **Open** — a Repo Slot with no url, an Agent with no
model — because a package cannot know your repository or pay for your model. `j2 up` walks the registered Machines,
refuses an Open part nobody bound before anything is built, and prints the `customize` line that binds it.

`task` has two: the Repo Slot `target` and the Agent `coder`. Both are bound above.

## Peer dependencies

`@j2/orchestrator`, `xstate` and `zod` are **peer** dependencies, never regular ones. Every part a Machine carries is
keyed in maps `@j2/orchestrator` holds and in xstate's own machinery; a second copy of either is a Machine whose Menus
are empty and whose Gates accept nothing, with no error anywhere. Your own Machine package copies this shape.

## Machines

- **`task`** — one prompt, one Workspace, one human says done. The coder works in a Sandbox on `j2/task-<run id>` (or
  the branch you pass), `finish` parks the run at the `review` Gate, `request_changes` sends it back on the same
  conversation, `approve` ends the run and tears the Workspace down. It does not push: while the run is parked you can
  `exec` into the Sandbox, read the branch, and push it yourself with your own credential.
