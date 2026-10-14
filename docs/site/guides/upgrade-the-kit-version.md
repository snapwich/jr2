---
title: Upgrade the Kit version
description: Move an Instance to a new Kit version. jr2 up converges it and updates the jr2 block in AGENTS.md.
---

Move your [Instance](../reference/glossary.md#instance) to a new [Kit version](../reference/glossary.md#kit-version),
and converge it.

An Instance has one Kit version: the version of `@jr2/orchestrator` that it installs. `package.json` pins
`@jr2/orchestrator` and `@jr2/cli` to that one exact version. To upgrade, you change the two pins to the new version,
install, and run [`jr2 up`](../reference/cli.md#up). Each upgrade ends in `jr2 up`. It converges the cluster to the new
version, and it updates the jr2 block in `AGENTS.md`, which your [Assistant](../reference/glossary.md#assistant) reads.

In the commands on this page, `<version>` is the new Kit version, such as `0.3.0`, and `<old version>` is the version
that the Instance has now.

## Before you start

- An Instance that you made with `jr2 init`, with its dependencies installed with npm.
- The new version. To see the latest release, run `npm view @jr2/cli version`.
- If the Instance sets [`kitRegistry`](../reference/config.md#kitregistry), write access to that registry. See
  [Mirror the Kit images](mirror-the-kit-images.md).

## See the Kit version now

Run this command in the Instance folder:

```sh
jr2 version --local
```

<!-- output: not run -->

```text
…
cli:       <old version>    <instance folder>/node_modules/@jr2/cli
global:    <global version>    <global folder>
kit:       <old version>    <instance folder>/node_modules/@jr2/orchestrator  ok
instance:  my-instance  <instance folder>  (installed kit → ghcr.io/snapwich)
node:      v24.18.0
```

- `cli` is the CLI that runs: the Instance's own `@jr2/cli`.
- `global` is your global `jr2`. In an Instance folder, it runs the Instance's own `@jr2/cli`. This is the
  [Handoff](../reference/glossary.md#handoff). Thus the version of the global `jr2` does not change what the Instance
  runs.
- `kit` is the Kit version. `ok` means that the CLI and the Instance use the same copy of `@jr2/orchestrator`.

`<global version>` is the version of your global `jr2`. `<instance folder>` and `<global folder>` are paths on your
computer, and `node` gives your version of Node.js. The first line (`…`) is the `.env` line, when `.env` sets a variable
that your shell does not set.

## Install the new version

Change the two pins in one command:

```sh
npm install --save-exact @jr2/orchestrator@<version> @jr2/cli@<version>
```

npm keeps `@jr2/orchestrator` in `dependencies` and `@jr2/cli` in `devDependencies`. `--save-exact` writes the version
with no range, as `jr2 init` does.

When the Instance also uses [`@jr2/machines`](../reference/machines.md), upgrade it in the same command. It must have
the same version:

```sh
npm install --save-exact @jr2/orchestrator@<version> @jr2/cli@<version> @jr2/machines@<version>
```

::: warning

Do not upgrade one of the packages alone. If you upgrade only `@jr2/orchestrator`, npm shows
`npm warn ERESOLVE overriding peer dependency` and installs it. The CLI and the Kit then have different versions.

:::

Then check the result:

```sh
jr2 version --local
```

<!-- output: not run -->

```text
…
cli:       <version>    <instance folder>/node_modules/@jr2/cli
global:    <global version>    <global folder>
kit:       <version>    <instance folder>/node_modules/@jr2/orchestrator  ok
instance:  my-instance  <instance folder>  (installed kit → ghcr.io/snapwich)
node:      v24.18.0
```

The `cli` line and the `kit` line must show the same version, and the `kit` line must end in `ok`.

Your global `jr2` can stay at its version. Its version matters only for `jr2 init` and for commands outside an Instance.
In an Instance, it runs the Instance's own `@jr2/cli`. To upgrade it too, run `npm i -g @jr2/cli@<version>`.

## Mirror the new images

Do this step only when the Instance sets `kitRegistry`. The mirror does not have the images of the new version yet, and
`jr2 up` never pushes them. In the Instance folder, run:

```sh
jr2 kit push <registry>
```

`<registry>` is the value of `kitRegistry`. The Instance's own `@jr2/cli` runs, so the command copies the images of the
new version. [Mirror the Kit images](mirror-the-kit-images.md) shows its output.

## Compare with the cluster

`jr2 version`, with no `--local`, also reads what the cluster runs. Before the converge, it tells you that the cluster
is at the old version:

```sh
jr2 version
```

<!-- output: not run -->

```text
…
orchestrator:  <old version>  hash <hash>  <image>
operator:      <old version>  ghcr.io/snapwich/jr2-operator:<old version>
…
skew:          deployed <old version> predates this kit <version> — `jr2 up` converges it
```

`<hash>` and `<image>` are the hash and the image of the [Orchestrator](../reference/glossary.md#orchestrator) that runs
in the cluster.

When the Orchestrator in the cluster is newer than the Kit version of the Instance, the `skew` line says
``deployed <deployed version> is newer than this kit <version> — `jr2 up` would roll the orchestrator back; the operator is never downgraded``.
`<deployed version>` is the version in the cluster.

`jr2 version` does not refuse a Kit version mismatch. It shows `MISMATCH` on the `kit` line. When `package.json` pins a
version that is not installed, the `kit` line ends in `; package.json pins <version> — reinstall`.

## Converge

```sh
jr2 up
```

<!-- output: not run -->

```text
…
AGENTS.md: jr2 block updated for <version>
jr2 up — instance "my-instance" → context <context> / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
…
images: installed kit — the published v<version> Harness and operator, pulled from ghcr.io/snapwich
…
operator: applying v<version> (ghcr.io/snapwich/jr2-operator:<version>) over v<old version>
…
converged — `jr2 run <workflow>` when ready
```

`<context>` is the kubectl context of the cluster.

`jr2 up` does these things for the upgrade:

- **`AGENTS.md`.** Before the cluster work, it writes the docs index of the new Kit version between the two `jr2-docs`
  markers. It changes nothing outside the markers. A converge that fails still updates the block. `jr2 up` does not
  change an `AGENTS.md` that has no markers. When the markers are not a correct pair, `jr2 up` does not change the file,
  and the converge continues: `warning: AGENTS.md: <reason>, so the jr2 block was not updated`.
- **The typecheck.** It typechecks the Instance against the new Kit. A [Workflow](../reference/glossary.md#workflow)
  that the new version does not accept stops the converge before the cluster changes. See the Rules.
- **The images.** The nodes pull the [Kit images](../reference/glossary.md#kit-image) at the tag of the new version.
  `jr2 up` builds the image of the Orchestrator again, because the Kit is in it. A
  [Sandbox Image](../reference/glossary.md#sandbox-image) does not change, because the runtime of jr2 is not in it.
- **The operator.** All the Instances on the cluster share one operator. `jr2 up` upgrades an older operator, so the
  upgrade of one Instance upgrades the operator for each Instance on the cluster. `jr2 up` never downgrades the
  operator. When a different Instance upgraded the operator to a later version, `jr2 up` keeps it:
  `operator: leaving v<deployed version> (newer than this kit's v<version> — never downgraded)`.

## What happens to the runs

The new Orchestrator starts, and it continues each run from its snapshot. A run that waits at a
[Gate](../reference/glossary.md#gate) continues to wait, when its [Machine](../reference/glossary.md#machine) has the
same shape. A run whose Machine has a different shape after the upgrade does not continue. Its status is `drifted`. The
new Kit version can change the shape of a Machine that your Workflow composes, such as a
[Workspace](../reference/glossary.md#workspace), or a shipped Machine of `@jr2/machines`. To keep a run, let it end
before you converge, or cancel it. See [Machine shape and drift](../concepts/durable-runs.md#machine-shape-and-drift).

A [Sandbox](../reference/glossary.md#sandbox) that runs keeps its pod, with the
[Harness](../reference/glossary.md#harness) of the old version. `jr2 up` does not replace the pod, because the new pod
would lose the commits that nobody pushed. A Sandbox that starts after the converge uses the new version.

## Rules

- `jr2 up` refuses an Instance that does not typecheck against the new Kit. It builds nothing and applies nothing. The
  lines after the refusal are the errors of the compiler:
  `refusing: this instance does not typecheck — nothing was built and nothing was applied`
- Each verb that reads the Instance, other than `jr2 version`, refuses when the Instance and the CLI do not use the same
  copy of `@jr2/orchestrator`. The refusal gives the two copies, and its last line gives the fix:

  ```text
  error: Kit version mismatch — an Instance has one (ADR-0056):
    @jr2/orchestrator resolves to <instance kit version> (<path>)
    this jr2 (<cli version>) runs against <cli kit version> (<path>)
    pin "@jr2/orchestrator" and "@jr2/cli" at ONE exact version in <instance folder>/package.json and reinstall
  ```

  `<instance kit version>` is the version of `@jr2/orchestrator` that the Instance installs. `<cli version>` is the
  version of the `jr2` that runs, and `<cli kit version>` is the version of the `@jr2/orchestrator` beside that `jr2`.
  When the Instance has no `@jr2/cli` of its own, the last line is
  `add "@jr2/cli": "<instance kit version>" to devDependencies in <instance folder>/package.json and reinstall — the Instance's own jr2 then runs`.
  When nothing is installed, the refusal says `@jr2/orchestrator does not resolve from <instance folder>`.

## Read next

- [Converge](../concepts/converge.md)
- [Durable runs](../concepts/durable-runs.md)
- [ADR-0056](../reference/decisions/0056-a-global-jr2-hands-off-to-the-instances-own-and-an-instance-has-one-kit-version.md):
  the Handoff, and one Kit version for each Instance.
- [ADR-0072](../reference/decisions/0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md): the
  docs in the Kit, and the block in `AGENTS.md`.
- [ADR-0030](../reference/decisions/0030-a-snapshot-names-the-machine-it-was-written-under.md): a run whose Machine has
  a different shape.
- [Mirror the Kit images](mirror-the-kit-images.md)
