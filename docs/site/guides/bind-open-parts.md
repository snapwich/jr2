---
title: Bind a shipped Machine's Open parts
description: Register a Machine from a package as a Workflow, and bind the parts that it leaves Open with customize().
---

Register a [Machine](../reference/glossary.md#machine) from a package as a
[Workflow](../reference/glossary.md#workflow), and bind the parts that it leaves [Open](../reference/glossary.md#open)
with [`customize()`](../reference/authoring-surface.md#customize).

A package does not know your [Repo](../reference/glossary.md#repo), and it cannot pay for your model. Thus a Machine in
a package marks these parts with [`open`](../reference/authoring-surface.md#open), and you bind them on the line that
registers it. [`jr2 up`](../reference/cli.md#up) refuses a Workflow with an Open part that nobody bound.

The examples on this page register [`task`](../reference/machines.md#task), the Machine that `@jr2/machines` ships.
`task` leaves two parts Open: its whole [Repo Slot](../reference/glossary.md#repo-slot) map, and the model of its
[Agent](../reference/glossary.md#agent) `coder`.

## Install the package

Install `@jr2/machines` at the [Kit version](../reference/glossary.md#kit-version) of your
[Instance](../reference/glossary.md#instance). `<version>` is the version of `@jr2/orchestrator` in your `package.json`:

```sh
npm install --save-exact @jr2/machines@<version>
```

## Find the Open parts

Register the Machine as it is. Save this file as `workflows/fix-app.ts`:

<<< @/examples/guides/bind-open-parts/unbound/fix-app.ts

Then run `jr2 up`. It stops before it changes the cluster. For each Open part, it prints the `customize()` line that
binds the part:

```sh
jr2 up
```

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
refusing: workflow "fix-app" leaves its Repo Slots open — bind it where the Machine is registered: export const machine = customize(<import>, { repos: { <slot>: "<url>" } })  (ADR-0051)
refusing: workflow "fix-app" leaves Agent "coder" open — bind it where the Machine is registered: export const machine = customize(<import>, { agents: { coder: { model: "<provider>/<model>" } } })  (ADR-0054)
```

[The Reference of `@jr2/machines`](../reference/machines.md) also gives the Open parts of each Machine.

## Bind the Open parts

Replace the file with one `customize()` call that binds the two parts. The coder works in the Repo `app`. It can read
the Repo `handbook`.

::: tabs key:provider

== Anthropic

<<< @/examples/guides/bind-open-parts/anthropic/fix-app.ts

== Local

<<< @/examples/guides/bind-open-parts/local/fix-app.ts

:::

Write the owner of your Repos in place of `<you>`. A private Repo needs a git credential in the cluster.
[Give the cluster git credentials](give-the-cluster-git-credentials.md) tells how.

The coder uses the model of the tab. Connect that model in `jr2.config.ts` and `.env` before you run `jr2 up`.
[Connect a model](../get-started/connect-a-model.md) tells how. Run `jr2 up` again. It converges. Then start a run with
a prompt:

```sh
jr2 run fix-app --input '{"prompt":"Make the failing test in test/greet.test.ts pass."}'
```

[An Agent in a Sandbox](../get-started/an-agent-in-a-sandbox.md) gives a full run of `task`, with the `review`
[Gate](../reference/glossary.md#gate).

### A Repo Slot

The key of each Repo Slot is the name of the slot, and the directory `/work/<slot>` in the
[Sandbox](../reference/glossary.md#sandbox). The value is one of these:

- a url: `"https://github.com/<you>/handbook.git"`. The [Worktree](../reference/glossary.md#worktree) starts from the
  default branch of the Repo.
- a [Binding](../reference/glossary.md#binding): `{ url, ref }`. The Worktree starts from `ref`, a branch or a commit.
- a function of the run input: `({ input }) => url`, or `({ input }) => ({ url, ref })`. Each run chooses its Repo. The
  url must agree with an entry of [`git.credentials`](../reference/config.md#git-credentials) in `jr2.config.ts`.
- `open`, to leave the slot Open for the Instance that registers your Machine.

`task` leaves the whole map Open. Thus you name every slot, and you name one slot or more. The order has the meaning
that the Machine gives it. For `task`, the first slot is the Repo that the coder works in, and the coder can read the
others. A Machine that names its slots, such as `repos: { app: open }`, takes only those keys.

### An Agent

`agents` takes the fields of the definition of an Agent, by slot. Each field goes over the field that the author wrote.
Thus `{ model }` changes only the model, and the coder keeps the instructions of `task`. You can also change other
fields, such as `thinkingLevel` or `instructions`.
[`AgentDefinition`](../reference/authoring-surface.md#type-agentdefinition) gives the fields.

## Bind the parts of a Machine that you compose

When your Machine invokes a packaged Machine as a child, the Open parts of the child are Open in your Machine too. Bind
them in one of two ways:

- Bind them on the import, before you put it under `actors`: `const coding = customize(task, { repos, agents })`. Then
  use `coding` as the child. [Composition](../concepts/composition.md) has an example.
- Bind them on your Machine, through the slot of the child:
  `customize(yours, { actors: { <slot>: { repos, agents } } })`.

`jr2 up` names the child in the refusal, and it prints the line with `actors`. For example, a Machine `outer` puts
`task` under `actors` as `coding`, and binds nothing:

```text
…
refusing: workflow "outer" leaves its Repo Slots open (on the Machine composed as "coding") — bind it where the Machine is registered: export const machine = customize(<import>, { actors: { coding: { repos: { <slot>: "<url>" } } } })  (ADR-0051)
refusing: workflow "outer" leaves Agent "coder" open (on the Machine composed as "coding") — bind it where the Machine is registered: export const machine = customize(<import>, { actors: { coding: { agents: { coder: { model: "<provider>/<model>" } } } } })  (ADR-0054)
```

When `task` is a child of your Machine, give it `branch` in its input. Only the root Machine of a run gets the id that
`task` makes a branch name from.

## Bind the Open parts of an Effect

A packaged Machine can leave the url of an `http` [Effect](../reference/glossary.md#effect), the argv of a `command`, or
the name of a secret Open. Bind them with `effects`, by the slot of the Effect:
`customize(machine, { effects: { notify: { url } } })`. One object binds all the Open parts of one Effect. You bind each
part one time, to a value. No run chooses it. [`EffectBinding`](../reference/authoring-surface.md#type-effectbinding)
gives the values, and [Run a command or call a URL with an Effect](run-a-command-or-call-a-url.md) shows an Effect.

## Rules

- `jr2 up` refuses a registered Machine that leaves a part Open. It changes nothing in the cluster:
  `refusing: workflow "<name>" leaves <part> open — bind it where the Machine is registered: export const machine = customize(<import>, <binding>)  (<adr>)`.
  `<part>` is one of `its Repo Slots`, `Repo Slot "<slot>"`, `Agent "<slot>"`, or `the <parts> of Effect "<slot>"`,
  where `<parts>` is such as `url` or `url and secret`. For a child Machine, `(on the Machine composed as "<slot>")`
  comes after `open`.
- `jr2 up` refuses an Open part on a Machine that a state writes in its `invoke.src`, because no `customize()` gets to
  it. Put that Machine under `actors`:
  `refusing: workflow "<name>" leaves <part> open on a Machine invoked inline — no customize() reaches an actor without a slot key; declare that Machine under setup({ actors }) and bind it there  (ADR-0049, <adr>)`
- The compiler refuses a key for a part that the Machine does not declare, such as an Agent slot that it does not have.
  The text of the compiler is:
  `Object literal may only specify known properties, and '<slot>' does not exist in type '<type>'.` Then `jr2 up` prints
  `refusing: this instance does not typecheck — nothing was built and nothing was applied`.
- `customize()` refuses a slot that the compiler did not see. `jr2 up` prints the refusal as `error: <refusal>`:
  - `customize(): machine "<id>" carries no Agent slot "<slot>" — its Agents are: <slots> (ADR-0049). Only declared parts can be retuned; a Machine that needs another Agent is a new Machine.`
  - `customize(): machine "<id>" composes no Machine under "<slot>" — the Machines it composes are: <slots> (ADR-0049).`
  - `customize(): machine "<id>" declares no Repo Slot "<slot>" — its slots are: <slots> (ADR-0051)`
  - `customize(): machine "<id>" carries no Effect slot "<slot>" — its Effects are: <slots> (ADR-0067). Only declared parts can be bound.`
- `customize()` refuses an Open map that you bind with no slot:
  ``customize(): machine "<id>" declares its Repo Slots open as a map — name at least one: `repos: { app: "https://…" }` (ADR-0051).``
- `customize()` refuses a Repo Slot key that is not a directory name. The key becomes `/work/<slot>`:
  ``customize(): Repo Slot key "<slot>" is not a directory name — a slot becomes `/work/<slot>` and its order matters, so it starts with a letter and matches /^[A-Za-z][A-Za-z0-9._-]*$/ (ADR-0051).``
- `customize()` refuses an empty url:
  ``customize(): Repo Slot "<slot>" is bound to an empty url (got <value>) — a slot is `open`, a url, `{ url, ref? }`, or a mapper `({ input }) => url | { url, ref? }` over the door (ADR-0051).``
  For an empty `ref`, the text says `bound with an empty ref`.
- `customize()` refuses a url that names no Repo, such as a relative path:
  `customize(): Repo Slot "<slot>" binds "<url>", which names no Repo — <reason> (ADR-0051).`
- `customize()` refuses `open` or a function as the value of an Effect's part:
  ``customize(): the <kind> Effect "<slot>"'s <part> is bound once, to a value — not `open` again: no run chooses an Effect's <part> (ADR-0054)``.
  For a function, the text says `a function of the run` in place of `` `open` again ``.
- An Agent does not start a [Turn](../reference/glossary.md#turn) while its model is Open:
  ``agent "<slot>" has an Open model — nobody bound it; bind it where the Machine is registered (`customize(<machine>, { agents: { <slot>: { model: "<provider>/<model>" } } })`), because a packaged Machine cannot pick a model on your behalf (ADR-0054)``.
  `jr2 up` refuses this case first.
- `task` inside a different Machine refuses to start without `branch` in its input:
  ``task: no `branch` on the door and no Instance ID to derive one from — `jr2/task-<instance id>` needs the id the host injects beside the door of the ROOT machine (ADR-0033), and this run of `task` was started by a parent Machine instead. Pass `branch` in the run input.``

## Read next

- [Composition](../concepts/composition.md)
- [ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md): the kit
  ships Machines, and a shipped Machine leaves its parts Open.
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine carries its
  parts, and `customize()` changes them.
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): a Repo is a slot
  on the `workspace()`.
- [Workspaces](../concepts/workspaces.md)
- [Publish a Machine as an npm package](publish-a-machine-as-an-npm-package.md), to leave parts Open in a Machine of
  your own.
- Reference: [`customize()`](../reference/authoring-surface.md#customize),
  [`Customize`](../reference/authoring-surface.md#type-customize), [`open`](../reference/authoring-surface.md#open),
  [`RepoSlot`](../reference/authoring-surface.md#type-reposlot), [`task`](../reference/machines.md#task)
