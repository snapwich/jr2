---
title: Converge
description: What jr2 up makes in the cluster from your Instance folder, which images it builds, and how it cleans up.
---

To converge is to make a cluster agree with your [Instance](../reference/glossary.md#instance) folder. One command does
it: [`jr2 up`](../reference/cli.md#up). It reads the folder, builds the images that the folder needs, and applies the
objects to the cluster of your current kubectl context. You can run it again at any time. When nothing changed, it
changes nothing.

## Why one command

A [Workflow](../reference/glossary.md#workflow) needs many parts in the cluster: the
[Orchestrator](../reference/glossary.md#orchestrator), its Secret, its images and the operator. Some Workflows also need
a [Sandbox Image](../reference/glossary.md#sandbox-image) or the
[Instance Harness](../reference/glossary.md#instance-harness). If you put each part there by hand, you must remember the
steps and their order. When you forget a step, the cluster is not correct, and you find the problem only when a run
fails. `jr2 up` does every step, in the correct order, each time. It tells you what it does at each step.

The Instance folder holds no record of a cluster. The kubectl context is the address, and the namespace is the identity.
Thus the same folder converges into kind on your computer and into a shared cluster. Only the kubectl context changes,
and, for a cluster that is not kind, the value that [`registry`](../reference/config.md#registry) reads from `.env`.

## Setup and usage

The diagram shows what `jr2 up` makes, and what [`jr2 run`](../reference/cli.md#run) and
[`jr2 send`](../reference/cli.md#send) use after it.

```mermaid
flowchart LR
  subgraph computer["Your computer"]
    folder["Instance folder"]
    up["jr2 up"]
    use["jr2 run, jr2 send"]
  end
  subgraph cluster["Cluster of the current kubectl context"]
    operator["operator, in jr2-system"]
    images["images"]
    subgraph ns["namespace of the Instance"]
      secret["jr2-instance Secret"]
      orch["Orchestrator"]
    end
  end
  folder --> up
  up --> images
  up --> operator
  up --> secret
  up --> orch
  use --> secret
  use --> orch
```

`jr2 up` reads the Instance folder. `jr2 run` and `jr2 send` do not apply objects to the cluster. They read the Instance
token from the `jr2-instance` Secret. Then they open a port forward to the Orchestrator for the time of the command. The
Orchestrator starts the run, and it makes each [Sandbox](../reference/glossary.md#sandbox) that the run needs. For all
the parts of the cluster, see [Architecture](architecture.md).

## What jr2 up does

`jr2 up` does its steps in this order. Steps 1 to 3 change nothing in the cluster:

1. It writes the docs index of the [Kit version](../reference/glossary.md#kit-version) between the two `jr2-docs`
   markers in `AGENTS.md`. This step changes the folder, not the cluster. Thus a converge that fails still leaves the
   index correct.
2. It typechecks the Instance with the Instance's own TypeScript compiler.
3. It loads each Workflow in `workflows/`. It reads the parts that each [Machine](../reference/glossary.md#machine)
   carries: its [Agents](../reference/glossary.md#agent), its [Repos](../reference/glossary.md#repo), its Sandbox Images
   and its [Effects](../reference/glossary.md#effect).
4. It checks the Kubernetes version of the cluster.
5. It checks that the namespace is this Instance's. Before it uses a namespace for the first time, it asks you.
6. It checks that the cluster keeps pod-level resources.
7. It finds the platforms of the nodes, and it decides the address of each image.
8. It applies the operator. Then it builds the image of the Orchestrator and the Sandbox Images.
9. It makes the values of the Secrets, and checks each Secret that the config names but that `jr2 up` does not write.
   For a Repo with an ssh url, it asks where the deploy key comes from.
10. When the config sets a custom model provider, `jr2 up` checks each model of that provider that an Agent uses. For
    each model, it starts a pod in the cluster, and the pod asks the provider for one tool call.
11. It applies the Secrets and the Orchestrator, and waits for the rollout. When the Machines need them, it also waits
    for the Repo cache, the Instance Harness and the [Instance Effector](../reference/glossary.md#instance-effector).
12. It removes the images that nothing uses now.

`jr2 up` says `converged` only when each pod that it rolled out runs the image that it expected. The labels and the
records that `jr2 up` writes help it to skip work. They do not prove that the cluster is correct. The pods do.

The Machines decide some parts. When no registered Machine makes a Sandbox, `jr2 up` builds no Sandbox Image and runs no
Repo cache. When no Agent has `workspace: "none"`, there is no Instance Harness. When the Machines stop using the Repo
cache or the Instance Harness, `jr2 up` removes it from the namespace. The image sweep removes a Sandbox Image that
nothing names.

## The images

Each image that a converge uses is one of these kinds:

| Image                                                 | Who owns it | What `jr2 up` does                                                                                                                                                                   |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The image of the Orchestrator                         | You         | It builds this image from the Kit and the Instance folder, other than `node_modules`, `.git`, `.jr2`, `.npmrc` and `.env` files, each time that one of them changes.                 |
| [Kit image](../reference/glossary.md#kit-image)       | jr2         | It builds nothing. The cluster pulls `jr2-harness` and `jr2-operator` at the tag of the Kit version.                                                                                 |
| [Pinned image](../reference/glossary.md#pinned-image) | Upstream    | It builds nothing. The cluster pulls the Envoy image of the [Custodian](../reference/glossary.md#custodian), by its tag and its digest.                                              |
| Sandbox Image, from a `file:` URL                     | You         | It builds the folder that a [`workspace()`](../reference/authoring-surface.md#workspace) names, and the `images/default/` folder that [`jr2 init`](../reference/cli.md#init) writes. |
| Sandbox Image, from a registry                        | You         | It builds nothing. The cluster pulls the image.                                                                                                                                      |

The Custodian is a container in each [Harness](../reference/glossary.md#harness) pod.
[Workspaces](workspaces.md#the-sandbox-image) explains what a Sandbox Image holds.

The tag of each image that `jr2 up` builds is a hash of the inputs of that image and of its platforms. Thus a new tag
means new content, and the same tag means the same content. This rule has three results:

- When the inputs of an image do not change, `jr2 up` does not build it again. A converge with no change builds no
  image.
- When an input changes, the tag changes. The Orchestrator and the other pods that `jr2 up` rolls out then start again
  on the new image. A Sandbox that runs does not, as the text below explains.
- `--force` builds each image again, even when its tag did not change.

The Kit images are at `ghcr.io/snapwich` by default. A cluster that cannot pull from there pulls from a mirror. A mirror
holds the same tags. [`kitRegistry`](../reference/config.md#kitregistry) names the mirror, and
[`jr2 kit push`](../reference/cli.md#kit-push) fills it. `jr2 up` never pushes to `kitRegistry`. `kitRegistry` also
changes where the cluster pulls the Pinned image, and `jr2 kit push` copies it to the mirror too.

`jr2 up` sends each image that it builds to the nodes in one of two ways:

- When you set `registry`, it pushes the image to that registry, and the nodes pull it.
- When you do not set `registry`, on a kind cluster it loads the image into the nodes with `kind load`. A context whose
  name starts with `kind-` is a kind cluster.

A change to a Sandbox Image changes only the Sandboxes that start after the converge. A Sandbox that runs keeps its
image, because a new pod would lose its [Worktrees](../reference/glossary.md#worktree) and the commits that you did not
push. `jr2 up` tells you how many running [Workspaces](../reference/glossary.md#workspace) keep each older image. The
Instance folder also goes into the image of the Orchestrator. Thus a change under `images/` also starts the Orchestrator
again.

## Kit version and Handoff

An Instance has one Kit version: the version of the `@jr2/orchestrator` package that the Instance installs. That package
is in the image of the Orchestrator, so it is the jr2 that runs your Workflows. The tags of the Kit images have the same
version. `jr2 init` pins `@jr2/orchestrator` and `@jr2/cli` to one exact version in `package.json`.

You install the [jr2 CLI](../reference/glossary.md#jr2-cli) two times: one time with `npm i -g`, and one time in the
Instance, from its `package.json`. In an Instance folder, the global `jr2` runs the Instance's own `@jr2/cli`, with the
same arguments. This is the [Handoff](../reference/glossary.md#handoff). Thus the CLI that runs is always the one that
the Instance pins. In the Instance, the version of your global `jr2` does not matter.
[`jr2 version`](../reference/cli.md#version) shows the CLI that runs, the global CLI that handed off, the Kit version of
the Instance, and what the cluster runs.

All the Instances on a cluster share one operator. `jr2 up` upgrades an older operator. It does not downgrade an
operator that a different Instance upgraded to a later version.

## Clean up

When each tag is a content hash, each change makes a new image. Ten changes to a Dockerfile make ten images. Thus
`jr2 up` removes the old images at the end of each converge that succeeds.

An image is garbage when no live root in the cluster names it. The roots are the image map of each Instance on the
cluster, the image of each Sandbox, and the images of the pods that run. jr2 removes only an image that it built and
labeled. It removes the image from your computer and, on a kind cluster, from the nodes. It never removes an image that
it did not build, such as the Pinned image. The output gives the size that it removed:
`swept <count> image(s) (<size>)`.

`jr2 up` and [`jr2 down`](../reference/cli.md#down) remove the images. [`jr2 gc`](../reference/cli.md#gc) does the same
work at a different time, for example when your disk is full. It also removes each Repo resource that no Machine binds
and that no run used in the last 7 days, by default. `--repo-ttl` changes the time. `jr2 gc --dry-run` shows what it
would remove, and removes nothing.

`jr2 down` deletes the namespace of the Instance. The runs, the store of the runs and the Sandboxes go with it.
`jr2 down --all` also removes the operator.

## Rules

- `jr2 up` changes nothing in the cluster when the Instance does not typecheck.
- `jr2 up` changes nothing in the cluster when a registered Machine has an [Open](../reference/glossary.md#open) part
  that is not bound. Examples are a [Repo Slot](../reference/glossary.md#repo-slot) with no url and an Agent with no
  model.
- `jr2 up` refuses a cluster that runs a Kubernetes version earlier than 1.35. It also refuses a cluster that does not
  keep pod-level resources.
- `jr2 up` refuses a namespace that belongs to a different Instance. It asks you before it uses a namespace for the
  first time. `--yes` gives the answer for CI.
- `jr2 up` refuses a cluster that is not kind when `registry` is not set.
- Each verb that reads the Instance, other than `jr2 version`, refuses when the Instance and the CLI do not use the same
  copy of `@jr2/orchestrator`.
- `jr2 up` never downgrades the operator.
- `jr2 up` never replaces the pod of a Sandbox that runs.
- A converge that fails removes no image.
- `jr2 gc`, `jr2 up` and `jr2 down` remove only images that jr2 built and that no live root names.

[Fix a failed converge](../guides/fix-a-failed-converge.md) gives the refusal text of each rule, and the fix.

## Read next

- [Iterate on a Machine on kind](../guides/iterate-on-a-machine-on-kind.md)
- [Move from kind to a shared cluster](../guides/move-from-kind-to-a-shared-cluster.md)
- [Mirror the Kit images](../guides/mirror-the-kit-images.md)
- [Upgrade the Kit version](../guides/upgrade-the-kit-version.md)
- [Clean up](../guides/clean-up.md)
- [Fix a failed converge](../guides/fix-a-failed-converge.md)
- Reference: [`jr2 up`](../reference/cli.md#up), [`jr2 down`](../reference/cli.md#down),
  [`jr2 gc`](../reference/cli.md#gc), [`jr2 kit push`](../reference/cli.md#kit-push),
  [`jr2 version`](../reference/cli.md#version), [`registry`](../reference/config.md#registry),
  [`kitRegistry`](../reference/config.md#kitregistry) and [`platforms`](../reference/config.md#platforms)
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): one converging command
  against the current context
- [ADR-0038](../reference/decisions/0038-jr2-up-builds-every-image-it-deploys.md): `jr2 up` builds each image that the
  Instance runs
- [ADR-0039](../reference/decisions/0039-image-garbage-collects-by-reachability.md): `jr2 gc` removes the images that
  nothing reaches
- [ADR-0041](../reference/decisions/0041-a-build-the-host-already-holds-is-not-spent-again.md): a build that the
  computer already holds is not done again
- [ADR-0044](../reference/decisions/0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md): the Kit images
  and their mirror
- [ADR-0045](../reference/decisions/0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md): the
  platform is a part of the image tag
- [ADR-0046](../reference/decisions/0046-a-converge-failure-carries-its-diagnosis.md): a failed converge says why
- [ADR-0056](../reference/decisions/0056-a-global-jr2-hands-off-to-the-instances-own-and-an-instance-has-one-kit-version.md):
  the Handoff, and one Kit version for each Instance
