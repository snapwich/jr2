# @jr2/cli

The `jr2` binary: the interface to a jr2 [Instance](https://github.com/snapwich/jr2/blob/main/CONTEXT.md) — a folder of
workflows deployed to whatever cluster the current `kubectl` context names.

```sh
npm i -g @jr2/cli
jr2 init my-instance && cd my-instance
npm install
jr2 up
jr2 run <workflow>
```

`init` scaffolds an Instance pinned at this CLI's version; `up` converges the target namespace to match it (operator,
Orchestrator, Sandboxes, secrets), and every other verb (`run`, `runs`, `status`, `logs`, `send`, `down`, `gc`,
`kit push`) talks to what `up` deployed. Node 24, a kube context, and docker for the image `up` builds.

Inside an Instance, the global `jr2` hands off to the Instance's own `@jr2/cli` (the gulp model), so the version that
runs is the one the Instance pins and the global's stops mattering. An Instance has one kit version: `@jr2/cli` and
`@jr2/orchestrator` at the same exact number — every verb refuses a mismatch by name. Upgrade by editing both lines and
reinstalling.

Docs, glossary, and architecture decisions: [github.com/snapwich/jr2](https://github.com/snapwich/jr2).
