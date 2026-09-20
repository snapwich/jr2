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

Docs, glossary, and architecture decisions: [github.com/snapwich/jr2](https://github.com/snapwich/jr2).
