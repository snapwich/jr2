---
title: Composition
description: How a Machine composes Machines that you import, and how you bind the parts that they leave Open.
---

Composition is how you make a [Workflow](../reference/glossary.md#workflow) from
[Machines](../reference/glossary.md#machine) that exist already. It has three parts. A Machine invokes a different
Machine as its child. [`customize()`](../reference/authoring-surface/customize.md) changes the parts that a Machine
carries. And you bind the parts that a Machine leaves [Open](../reference/glossary.md#open). The kit ships Machines for
you to compose in this way, in the package [`@jr2/machines`](../reference/machines.md).

## Why it exists

A Machine that you import must work in your [Instance](../reference/glossary.md#instance) with no change to its module.
Thus a Machine carries all that it needs: its [Vocabulary](../reference/glossary.md#vocabulary), its
[Agents](../reference/glossary.md#agent), its [Effects](../reference/glossary.md#effect), its
[Sandbox Image](../reference/glossary.md#sandbox-image) and its [Repo Slots](../reference/glossary.md#repo-slot). The
Machine does not need an Agent list or event names from the Instance. The Instance gives only access and defaults.
Access is the model provider and its key, the secrets, and the git credentials. A default is a Sandbox Image or a
[Size](../reference/glossary.md#size) for a Machine that states none.

A package cannot know some parts. It does not know your [Repo](../reference/glossary.md#repo), and it cannot pay for
your model. The package leaves these parts Open. You bind them where you register the Machine as a Workflow, or where
you compose it. If you do not bind an Open part, [`jr2 up`](../reference/cli.md#up) stops before it converges. Thus a
missing part does not become a run that spends money on a model that nobody chose.

## A Machine inside a Machine

A Machine composes a different Machine as an xstate child. It imports the Machine, puts it under `actors`, and a state
invokes it by its key. The key is a slot, the same as the slot of an Agent.

This Machine composes the shipped Machine [`task`](../reference/machines.md#task) two times. A
[Menu](../reference/glossary.md#menu)-only Agent, `triager`, reads the prompt first. Then the run goes to one of the two
copies of `task`. The copies differ only in the thinking level of their coder.

The Workflow, with the model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/composition/anthropic/route.ts

== Local

<<< @/examples/concepts/composition/local/route.ts

:::

::: graph @/examples/concepts/composition/anthropic/route.ts

:::

To use `@jr2/machines`, add it to the Instance at the [Kit version](../reference/glossary.md#kit-version):
`npm install --save-exact @jr2/machines@<version>`. `<version>` is the version of `@jr2/orchestrator` in your
`package.json`.

A composed Machine is a part of the run of its parent:

- The run has one run id and one snapshot. A child Machine does not start a second run.
- The [Gates](../reference/glossary.md#gate) of the child show in the run of the parent. Its
  [Emits](../reference/glossary.md#emit) go to the same feed.
- Each Machine keeps its own Vocabulary. The `approve` of a child is not an event of its parent, and the parent does not
  declare it again.
- The parent gets to the child by `import`. It does not use the Workflow name that [`jr2 run`](../reference/cli.md#run)
  uses.
- Only the root Machine of a run gets `instanceId`
  ([`HostInjectedInput`](../reference/authoring-surface/type-hostinjectedinput.md)) beside the run input. A child gets
  only the input that its parent gives it. Thus the example gives each `task` a `branch`.

### Composing a Workflow

::: diagram layers The Workflow route, and the Machines that it composes

- **route**: the Machine that workflows/route.ts registers as the Workflow route
  - **triager** (Agent): picks deep or quick
  - **deep** (Machine): thinking high
  - **quick** (Machine): thinking low
- ↓ deep → coding: customize() · quick → coding: customize()
- **coding**: binds the Open parts of task
  - **Repo Slot target**: your app
  - **coder model**: the model of the tab
- ↓ coding is a customize() of task
- **task**: from @jr2/machines
  - **coder** (Agent): edits and commits
  - **Repo Slots**: Open
  - **coder model**: Open

:::

The file `workflows/route.ts` registers the Machine `route` as the Workflow `route`. The Machine declares three slots of
its own: the Agent `triager` and the two Machines `deep` and `quick`. Each of the two is a `customize()` of `coding`,
and `coding` is a `customize()` of `task`. `task` leaves its Repo Slots and the model of its coder Open. `coding` binds
them, so `deep` and `quick` have them too.

## customize()

[`customize(machine, parts)`](../reference/authoring-surface/customize.md) gives a new Machine with the parts changed.
The Machine that you give it does not change. Thus two calls on one import give two Machines, as `deep` and `quick`
show.

[`Customize`](../reference/authoring-surface/type-customize.md) gives the parts that you can change:

| Key         | What it changes                                                                       |
| ----------- | ------------------------------------------------------------------------------------- |
| `agents`    | The definition of an Agent, by slot, field by field. `{ model }` keeps the rest.      |
| `effects`   | The Open url, argv or secret of an Effect, by slot.                                   |
| `actors`    | A Machine that this Machine composes, by slot. The value has the same keys, one down. |
| `repos`     | The Repo Slots of the [`workspace()`](../reference/authoring-surface/workspace.md).   |
| `image`     | The Sandbox Image of the `workspace()`.                                               |
| `user`      | The [User Container](../reference/glossary.md#user-container) of the `workspace()`.   |
| `resources` | The Size of the `workspace()`, field by field.                                        |

The type comes from the Machine. It offers only the Agents, Effects, Machines and Repo Slots that the Machine declares.
A slot that the Machine does not have does not compile.

`workspace()` and [`pool()`](../reference/authoring-surface/pool.md) wrap a Machine. `customize()` goes through each
wrapper to the Machine inside it. Thus `customize(task, { agents })` changes the Agents of the Machine in the
`workspace()` of `task`, and you do not name the wrapper's own slot. `repos`, `image`, `user` and `resources` go down to
the first `workspace()` on that path.

## Open parts

A Machine marks a part Open with [`open`](../reference/authoring-surface/open.md). These parts can be Open:

- a Repo Slot with no url, or the whole Repo Slot map (`repos: open`)
- the model of an Agent (`agent({ model: open, … })`)
- the url of an `http` Effect, the argv of a `command`, or the name of the secret of an Effect (`secret(open)`)

An Open part has no default. You bind it with `customize()`. Each Open part has two checks:

- `jr2 up` reads every registered Machine. It refuses an Open part that nobody bound, and it prints the `customize()`
  line that binds it.
- At run time, the part refuses too. An Agent does not start a [Turn](../reference/glossary.md#turn) with an Open model.
  An Effect does not run while it is Open.

[Bind a shipped Machine's Open parts](../guides/bind-open-parts.md) shows each binding.

## @jr2/machines

`@jr2/machines` is the package of Machines that the kit ships. It ships Machines and never Workflows. A Machine becomes
a Workflow only when a file in your `workflows/` folder exports it.

It ships `task`: a coder Agent works on one prompt in a [Workspace](../reference/glossary.md#workspace), and a person
approves the work at the `review` Gate. `task` leaves two parts Open: the whole Repo Slot map and the model of `coder`.
The first Repo Slot that you name is the Repo that the coder works in. The coder can read the other Repos. It also ships
[`body`](../reference/machines.md#body), the Machine inside `task`, for a `workspace()` of your own.

The version of `@jr2/machines` is the Kit version. It names `@jr2/orchestrator` at that exact version as a peer
dependency.

## A Machine as an npm package

A package exports a Machine and nothing more. The run input, the Vocabulary, the Agents, the Effects, the Sandbox Image
and the Repo Slots are all on the Machine. A Workflow uses an imported Machine in one of three ways:

- as it is, when it leaves no part Open: `export const machine = imported;`
- changed: `export const machine = customize(task, { … });`
- composed in a Machine of your own, as in the example above

`task` cannot be used as it is, because it leaves two parts Open.

A file in `workflows/` uses the same code. A package has no API of its own.

A Machine package names `@jr2/orchestrator`, `xstate` and `zod` as peer dependencies, never as dependencies. jr2 keeps
the parts of a Machine in the one copy of `@jr2/orchestrator` and of `xstate` that the Instance loads. A Machine made
with a second copy of either has empty Menus and Gates that accept nothing. `jr2 up` shows no error for it, and prints
no `seats:` line for it. Its run stops with the status `error` when an Agent or a Gate of the Machine starts.
`@jr2/machines` has this shape, and your package copies it.

A package can ship a docker context for its Sandbox Image. The Machine names the folder with
`import.meta.resolve("./image")`, and `jr2 up` builds it.

## Rules

- A nested Machine is a child in the same run. jr2 has no second run for a child, and no invoke by Workflow name.
- An [`agent()`](../reference/authoring-surface/agent.md), an Effect or a `workspace()` is a key of `actors`. jr2
  refuses one that a state writes in its `invoke.src`.
  [`jr2Setup()`](../reference/authoring-surface/jr2setup.md)`.createMachine` refuses it, and `jr2 up` refuses it too.
- `customize()` changes only the parts that a Machine declares. You cannot add a part. A Machine that needs one more
  Agent is a new Machine.
- For a part that the Machine does not declare, the compiler refuses the key, and `customize()` refuses it at run time.
  `image`, `user` and `resources` compile on every Machine. `customize()` refuses them when the Machine composes no
  `workspace()`.
- `jr2 up` refuses a registered Machine that leaves a part Open, and it names the Workflow and the part.
- `jr2 up` also refuses an Open part on a Machine that a state writes in its `invoke.src`, because no `customize()` can
  get to it. Put that Machine under `actors`.
- A Repo Slot map that is Open takes the slots that you name. Name one slot or more. Their order means what the Machine
  says it means.
- An Effect's Open part is bound one time, to a value. A run does not choose it, and a second `customize()` cannot
  change it.
- A file in `workflows/` that a different Workflow imports is also a Workflow. Give a Machine that is only for
  composition a file name that starts with `_`, or keep it outside `workflows/`.
- `task` inside a different Machine needs `branch` in its input. Without it, `task` refuses to start.

## Read next

- [Bind a shipped Machine's Open parts](../guides/bind-open-parts.md)
- [Publish a Machine as an npm package](../guides/publish-a-machine-as-an-npm-package.md)
- [Machines and Workflows](machines-and-workflows.md)
- [Workspaces](workspaces.md)
- [Pools and Sources](pools-and-sources.md)
- Reference: [`customize()`](../reference/authoring-surface/customize.md),
  [`Customize`](../reference/authoring-surface/type-customize.md), [`open`](../reference/authoring-surface/open.md),
  [`@jr2/machines`](../reference/machines.md), [`jr2 up`](../reference/cli.md#up)
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine carries its
  parts and composes by invoke
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): a Repo is a slot
  on the Workspace
- [ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md): the kit
  ships Machines, and a shipped Machine leaves its parts Open
