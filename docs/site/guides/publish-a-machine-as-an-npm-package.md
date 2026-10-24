---
title: Publish a Machine as an npm package
description: Ship a Machine in an npm package that names the Kit as a peer, and register it in an Instance.
---

Publish a [Machine](../reference/glossary.md#machine) as an npm package, so that each
[Instance](../reference/glossary.md#instance) can install it and register it as a
[Workflow](../reference/glossary.md#workflow).

The example package is `@you/labeler`. It exports one Machine, `labeler`: an [Agent](../reference/glossary.md#agent)
reads an issue and chooses one label for it. The Machine gives the label as its output. The package leaves the model of
the Agent [Open](../reference/glossary.md#open), because it cannot know which model each Instance uses. `@jr2/machines`
has the same shape.

Replace `@you` with your npm scope in each file and each command on this page.

## The package

The package has three files:

```text
labeler/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:

<<< @/examples/guides/publish-a-machine-as-an-npm-package/labeler/package.json

- `peerDependencies` names `@jr2/orchestrator`, `xstate` and `zod`. The package has no `dependencies`. Replace
  `<version>` with the [Kit version](../reference/glossary.md#kit-version) that the package is for, such as `0.4.1`.
  Write the exact version, with no `^` and no `~`.
- `devDependencies` also names the three packages, at the same versions, and `typescript` and `@types/node`. With them,
  you can typecheck the package.
- `exports` gives the `.ts` files, and `files` ships `src`. The package has no build step. jr2 loads `.ts` files from
  `node_modules`, the same as it loads `@jr2/orchestrator` and `@jr2/machines`.

`tsconfig.json` uses the options of an Instance. The typecheck of an Instance also checks the `.ts` files of each
package that it imports, so the package must pass the same options:

<<< @/examples/guides/publish-a-machine-as-an-npm-package/labeler/tsconfig.json

`src/index.ts` exports the Machine, and the type of its output:

<<< @/examples/guides/publish-a-machine-as-an-npm-package/labeler/src/index.ts

The Machine carries all of its parts: its run input, its [Vocabulary](../reference/glossary.md#vocabulary) and its
Agent. The model is [`open`](../reference/authoring-surface.md#open), so the Instance binds it with
[`customize()`](../reference/authoring-surface.md#customize). On the export, write TSDoc that gives its Open parts and
its run input, as [`task`](../reference/machines.md#task) does. An [Assistant](../reference/glossary.md#assistant) that
reads `node_modules` reads that text.

## Check the package

In the folder of the package, install the `devDependencies`. Then typecheck the package:

```sh
npm install
npm run typecheck
```

Then see what the package ships:

```sh
npm pack --dry-run
```

```text
npm notice
npm notice 📦  @you/labeler@1.0.0
npm notice Tarball Contents
npm notice 623B package.json
npm notice 2.4kB src/index.ts
npm notice Tarball Details
npm notice name: @you/labeler
npm notice version: 1.0.0
npm notice filename: you-labeler-1.0.0.tgz
npm notice package size: 1.4 kB
npm notice unpacked size: 3.0 kB
npm notice shasum: b4b5fd9c9ddff44b1be2e852e89969bdbe76750c
npm notice integrity: sha512-5CXrYzHDj/Qy8[...]70mtq84+C6+6w==
npm notice total files: 2
npm notice
you-labeler-1.0.0.tgz
```

The list holds `package.json` and the files of `src`. Your sizes and sums are different.

## Publish the package

Log in to your registry with `npm login`. Then publish the package. npm publishes a package with a scope, such as
`@you`, as restricted, unless you give `--access public`:

```sh
npm publish --access public
```

## Register the Machine in an Instance

In the Instance folder, install the package. Use npm's `--save-exact`, so that `package.json` names one version:

```sh
npm install --save-exact @you/labeler@1.0.0
```

Make sure that the Instance has one copy of `@jr2/orchestrator`:

```sh
npm ls @jr2/orchestrator
```

```text
my-instance@0.0.0 <path>
├─┬ @jr2/cli@0.4.1
│ └── @jr2/orchestrator@0.4.1 deduped
├── @jr2/orchestrator@0.4.1
└─┬ @you/labeler@1.0.0
  └── @jr2/orchestrator@0.4.1 deduped
```

`<path>` is the path of your Instance folder, and the version is your Kit version. Each line names the same version.
Each `deduped` line tells you that the package uses the copy of the Instance.

Save this file as `workflows/label.ts`. It binds the Open model of the Agent `labeler` to the model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/publish-a-machine-as-an-npm-package/anthropic/label.ts

== Local

<<< @/examples/guides/publish-a-machine-as-an-npm-package/local/label.ts

:::

Run [`jr2 up`](../reference/cli.md#up):

```sh
jr2 up
```

```text
…
jr2 up — instance "my-instance" → context <context> / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
seats: workflow "label" — who may send what, per state (ADR-0015)
  labeler.labeling agent:labeler: [label]
…
```

The first line (`…`) is the `.env` line, when `.env` sets a variable that your shell does not set. `<context>` is your
kubectl context. The `seats:` lines show that jr2 reads the Vocabulary of the Machine. [Start a run](start-a-run.md)
tells how to run the Workflow `label`.

## Rules

- Name `@jr2/orchestrator`, `xstate` and `zod` in `peerDependencies`, never in `dependencies`.
- When the package names `@jr2/orchestrator` in `dependencies` at a different version, npm installs a second copy under
  the package, with no error. A Machine that loads a second copy has empty [Menus](../reference/glossary.md#menu). Thus
  `jr2 up` refuses the Instance before it applies anything. It gives one line for each Kit package that has a second
  copy, such as `@jr2/orchestrator` and `@jr2/agent-protocol`:

  ```text
  error: cannot stage the Assembly: it would carry a second copy of a Kit package (ADR-0069)
    <path> is a second copy of <name>, nested by <package>@<package version> (<package path>): the Orchestrator's image ships <name> for @jr2/orchestrator <version>, and an Assembly that carries its own copy loads Machines whose Menus are empty (ADR-0054) — align that dependency with the <name> @jr2/orchestrator uses, or remove it, and reinstall
  ```

  Run `npm ls @jr2/orchestrator` to find the second copy.

- Name `@jr2/orchestrator` at the exact Kit version. When the Instance has a different Kit version, npm refuses to
  install the package:

  ```text
  npm error code ERESOLVE
  npm error ERESOLVE unable to resolve dependency tree
  …
  npm error Could not resolve dependency:
  npm error peer @jr2/orchestrator@"<version>" from <package>@<package version>
  …
  ```

  `<package>@<package version>` is the package and the version that you install.

  Do not install with `--force` or `--legacy-peer-deps`. Publish a version of the package for the Kit version of the
  Instance. Thus each [upgrade of the Kit version](upgrade-the-kit-version.md) needs a new version of the package.

- In the Instance, the package must be in `dependencies`, not in `devDependencies`. The
  [Assembly](../reference/glossary.md#assembly) holds only `dependencies`. Without the package, the
  [Orchestrator](../reference/glossary.md#orchestrator) cannot load the Workflow, and it refuses the Assembly.
- The typecheck of `jr2 up` includes the `.ts` files of the package. A type error in it stops the converge:
  `refusing: this instance does not typecheck — nothing was built and nothing was applied`.
- Use only TypeScript that jr2 can erase: no `enum`, no `namespace`, and no parameter properties in a constructor. The
  typecheck accepts them, but `jr2 up` cannot load the Workflow. It stops with a JavaScript syntax error, such as
  `error: Unexpected token 'export'`.
- Write each relative import in the package with the `.ts` extension, as `./util.ts`. With `.js`, the typecheck passes,
  but `jr2 up` stops: `error: Cannot find module '<path>/util.js' imported from <path>/index.ts`.
- A package exports Machines, never Workflows. A Workflow is a file in the `workflows/` folder of an Instance.
- `jr2 up` refuses a Workflow that leaves a part Open. It prints the `customize()` line that binds it:
  `refusing: workflow "<workflow>" leaves Agent "<slot>" open — bind it where the Machine is registered: export const machine = customize(<import>, { agents: { <slot>: { model: "<provider>/<model>" } } })  (ADR-0054)`.
  [Bind a shipped Machine's Open parts](bind-open-parts.md) gives the refusals for the other Open parts.
- A new version of the package can change the [Machine shape](../reference/glossary.md#machine-shape): its states, its
  invokes or its transitions. Then the Orchestrator does not continue a run that the old version started. Its status is
  `drifted`. See [Machine shape and drift](../concepts/durable-runs.md#machine-shape-and-drift).

## Read next

- [Composition](../concepts/composition.md)
- [Bind a shipped Machine's Open parts](bind-open-parts.md)
- [Durable runs](../concepts/durable-runs.md)
- Reference: [`customize()`](../reference/authoring-surface.md#customize),
  [`open`](../reference/authoring-surface.md#open), [`@jr2/machines`](../reference/machines.md)
- [ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md): the kit
  ships Machines, and a shipped Machine leaves its parts Open
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine carries its
  parts and composes by invoke
