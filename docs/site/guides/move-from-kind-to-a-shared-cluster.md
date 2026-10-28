---
title: Move from kind to a shared cluster
description: Converge an Instance into a shared cluster, with a registry, Sandbox nodes, priority classes and a quota.
---

Converge your [Instance](../reference/glossary.md#instance) into a shared Kubernetes cluster, after it runs on kind.

The [Workflows](../reference/glossary.md#workflow) of the Instance do not change. [`jr2 up`](../reference/cli.md#up)
converges into the cluster of the kubectl context, so you give it a different context. A shared cluster also needs some
facts that kind does not need. These facts are a registry for the images, the platforms of the nodes, the nodes for the
[Sandboxes](../reference/glossary.md#sandbox), and the priority classes. This `jr2.config.ts` gives all of them:

<<< @/examples/guides/move-from-kind-to-a-shared-cluster/jr2.config.ts

Add the fields to your own `jr2.config.ts`. Keep the fields that it has, such as `secrets` or `harness`. Each section
below explains one field. Set only the fields that your cluster needs.

## Before you start

- An Instance that converges on kind. See [Iterate on a Machine on kind](iterate-on-a-machine-on-kind.md).
- A kubectl context for the shared cluster. In the commands on this page, `<context>` is its name.
- An image registry that you can push to from your computer, and that the nodes can pull from. In the commands on this
  page, `<registry>` is its prefix, such as `registry.example.com/team`.
- Docker on your computer, logged in to the registry with `docker login`.

## Check the cluster

`jr2 up` checks the cluster before it applies the Instance. The cluster must have these properties:

- Kubernetes 1.35 or later. Each Sandbox mounts the runtime of jr2 as an image volume.
- Pod-level resources. A [Workspace](../reference/glossary.md#workspace) reserves its whole
  [Size](../reference/glossary.md#size) as one pod-level limit. The `PodLevelResources` feature gate must be on in the
  API server and in the kubelets.
- A container runtime that mounts image volumes, such as containerd 2.1 or later, or CRI-O 1.31 or later. `jr2 up` does
  not check the runtime. With an older runtime, the first Sandbox fails, and its pod events give the cause.
- Your kubectl user can apply objects outside the namespace of the Instance. `jr2 up` applies the operator in the
  `jr2-system` namespace, with its CustomResourceDefinitions, ClusterRoles and ClusterRoleBindings. It also applies two
  PriorityClasses, unless you name your own.

All the Instances on a cluster share one operator. `jr2 up` does not downgrade it. See
[Converge](../concepts/converge.md#kit-version-and-handoff).

## Set the registry

On kind, `jr2 up` loads each image that it builds into the nodes with `kind load`. A shared cluster is not kind, so
`jr2 up` pushes each image to [`registry`](../reference/config.md#registry), and the nodes pull it from there. These are
the [Sandbox Images](../reference/glossary.md#sandbox-image) that `jr2 up` builds: `images/default` and each `file:`
URL. When no registered Machine makes a [Sandbox](../reference/glossary.md#sandbox), `jr2 up` builds no image, and the
Instance needs no `registry`.

The example reads `registry` from `JR2_REGISTRY`. Put this line in `.env`:

```text
JR2_REGISTRY=<registry>
```

`jr2 up` reads `.env`. A variable of the shell wins over `.env`.

When `registry` is set, `jr2 up` pushes to it on kind too. To converge into kind again, remove `JR2_REGISTRY` from
`.env`, or set it only in the shell for the shared cluster.

jr2 sets no image pull secret on its pods. The nodes must pull from the registry with no pull secret, for example with
credentials on the nodes or with anonymous pulls.

The [Kit images](../reference/glossary.md#kit-image) do not go to `registry`. The image of the
[Orchestrator](../reference/glossary.md#orchestrator) is one of them. The nodes pull them from `ghcr.io/snapwich`, and
the Envoy image of the [Custodian](../reference/glossary.md#custodian) from `docker.io`. When the nodes cannot reach
those registries, see [Mirror the Kit images](mirror-the-kit-images.md).

`jr2 up` also checks each model that an [Agent](../reference/glossary.md#agent) names, from a pod in the cluster. That
pod uses the Harness Kit image and the Envoy image of the Custodian, so it needs no other image.

## Choose the platforms

`jr2 up` builds each image for the platforms of the nodes. It reads the architecture of each node on which a pod can
run, and of each [Sandbox node](../reference/glossary.md#sandbox-node). jr2 releases its images for `linux/amd64` and
`linux/arm64` only. `jr2 up` skips a node of a different architecture, and tells you. This output is from a cluster with
one `amd64` node and one `s390x` node:

```text
platforms: linux/amd64 (from 2 schedulable node(s))
  skipping node arch s390x — the kit publishes no Kit image for it, so no pod there could run
```

When the cluster has nodes of the two architectures, `jr2 up` builds each image for both, and pushes it as one manifest
list. This needs `registry`.

Set [`platforms`](../reference/config.md#platforms) when the nodes do not give the correct set:

- A node group that scales up from zero has no node to read yet.
- A node group that needs no image, such as an amd64 GPU group beside arm64 nodes, adds a platform that you do not want.

`platforms` replaces the set that `jr2 up` reads from the nodes. It does not add to that set. The example reads it from
`JR2_PLATFORMS`, as a list with commas, such as `JR2_PLATFORMS=linux/arm64`.

When you set `platforms`, `jr2 up` does not read the nodes. Thus it also does not check the Sandbox nodes or the Size.
See [Choose the Sandbox nodes](#choose-the-sandbox-nodes).

When a platform is not the platform of your computer, Docker emulates it with QEMU. `jr2 up` stops before the build when
your computer cannot do this, and gives the command that installs QEMU.

## Choose the Sandbox nodes

By default, a Sandbox runs on each node on which an ordinary pod can run. That is a node that is not cordoned and has no
`NoSchedule` or `NoExecute` taint. You do not add a label for jr2.

To put the Sandboxes on a node pool of their own, set [`sandbox`](../reference/config.md#sandbox).
[`sandbox.nodeSelector`](../reference/config.md#sandbox-nodeselector) gives the labels that a Sandbox node must have.
[`sandbox.tolerations`](../reference/config.md#sandbox-tolerations) gives the taints that a Sandbox tolerates. Both have
the shapes of the Kubernetes pod spec. The Repo cache runs on the same nodes as the Sandboxes.

When you do not set `platforms` and a Workflow uses a Workspace, `jr2 up` gives the Sandbox nodes that it finds. In this
output, the cluster has one node, `jr2-control-plane`:

```text
sandbox nodes: jr2-control-plane
```

When it finds none, it gives a warning and continues. It names each node and the reason that the node is not a Sandbox
node:

```text
warning: no Sandbox node right now — a Sandbox stays Pending until one appears:
  jr2-control-plane: lacks the label pool that sandbox.nodeSelector requires
  a Sandbox lands where an ordinary pod lands; to admit a tainted or labeled node, set `sandbox: { nodeSelector, tolerations }` in jr2.config.ts (raw pod-spec shapes, ADR-0052).
```

The Repo cache runs only on the Sandbox nodes, so it has no pod either. `jr2 up` says so later in its output:
`repo cache: WARNING — rollout succeeded but no pod matched app=jr2-repo-cache (nothing verified)`.

When no Sandbox node can hold the Size of a Workspace now, `jr2 up` also gives a warning and continues. In this output,
the Workflow `hold` asks for a Size of 512Gi of memory and 64 cpus:

```text
warning: no Sandbox node right now has the allocatable for a Size of memory 512Gi, cpu 64 (workflow "hold") — its Sandbox stays Pending until one does
```

The Workspace stays in [Placing](../reference/glossary.md#placing) until a Sandbox node can hold its Sandbox, for
example a node that an autoscaler adds.

Write `sandbox` in `jr2.config.ts` itself. Do not read it from `process.env`. The Orchestrator reads `jr2.config.ts`
again in the cluster, where your shell and `.env` are not available.

## Use the priority classes of the cluster

`jr2 up` creates two PriorityClasses by default. `jr2-control` is for the Orchestrator, the operator, the Repo cache and
the [Instance Effector](../reference/glossary.md#instance-effector). `jr2-sandbox` is for the Sandboxes and the
[Instance Harness](../reference/glossary.md#instance-harness). An ordinary pod cannot preempt a Sandbox, and a Sandbox
that waits for a node preempts no pod.

When the cluster has its own priority scheme, set [`priorityClasses`](../reference/config.md#priorityclasses) to the
names of its classes. `jr2 up` creates no class for a key that you set, and tells you which classes it uses:

```text
priority: the Instance's own — control "platform-critical", sandbox "batch-low"
```

`jr2 up` does not create a class that you name, so it must exist in the cluster. Write `priorityClasses` in
`jr2.config.ts` itself. Do not read it from `process.env`, for the same reason as `sandbox`.

::: warning

`sandbox` and `priorityClasses` apply in each cluster that the folder converges into. Thus a folder that sets them works
only in a cluster that has those classes and those labels. On kind, `jr2 up` fails, because Kubernetes creates no pod
that names a class that the cluster does not have. Also, a Sandbox waits for a node with the label `pool: agents`.

:::

## Work under a quota

jr2 writes no ResourceQuota, and it has no limit of its own on the number of Workspaces. The owner of the cluster can
put a ResourceQuota on the namespace of the Instance. Each Sandbox requests its whole Size, so the quota counts the
whole Size of each Sandbox.

When the quota refuses the pod of a Sandbox, the Workspace waits in Placing. It does the same when no node has room. jr2
sets no time limit on this wait. `jr2 run` shows the reason, in the words of the quota. In this output, the quota
`team-quota` permits 512Mi of memory limits, and the Size asks for 1Gi:

```text
…
  → active "placing"
  placing: waits for quota — pods "ws-5e817334-x-0-61ru0u" is forbidden: exceeded quota: team-quota, requested: limits.memory=1Gi, used: limits.memory=2Gi, limited: limits.memory=512Mi
```

For a Workspace that is not the root of the Workflow, the line adds the path of the child after `placing`.

[`jr2 runs`](../reference/cli.md#runs) marks each run that has a Workspace in Placing. To see why it waits, run
`jr2 status <run id>`. `<run id>` is the run id or a prefix of it (see [run ids](../reference/cli.md#run-ids)). To limit
the time that a Workflow waits, put `after` on the state of the [Machine](../reference/glossary.md#machine) that holds
the Workspace.

## Converge

Run `jr2 up` with the context of the shared cluster. For the first converge into a namespace, `jr2 up` asks you before
it continues. In CI, add `--yes`.

```sh
jr2 up --context <context>
```

```text
→ .env: JR2_REGISTRY, …
jr2 up — instance "my-instance" → context <context> / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
…
kubernetes: v1.36.1 (floor 1.35, ADR-0037)
first contact: deploy instance "my-instance" to context <context> (create namespace "my-instance")? [y/N] y
platforms: linux/amd64 (from 1 schedulable node(s))
sandbox nodes: jr2-control-plane
images: installed kit — the published v<version> Harness, operator and Orchestrator, pulled from ghcr.io/snapwich
…
priority: the Instance's own — control "platform-critical", sandbox "batch-low"
sandbox image "default": building <registry>/jr2-sandbox-my-instance-default:6389bdf72d50-amd64
  no USER declared — the pod's uid-1000 fallback applies
  push → <registry>
…
assembly: publishing 6355c2bb032a (no current Assembly)
assembly: 6355c2bb032a is current — workflows: hold, ping
…
converged — `jr2 run <workflow>` when ready
```

In this output, the cluster runs Kubernetes v1.36.1 and has one node, `jr2-control-plane`, with the label
`pool: agents`. The Workflows are `ping` and `hold`, a Workflow with a Workspace. `<version>` is the
[Kit version](../reference/glossary.md#kit-version) of the Instance. `6389bdf72d50` changes when the inputs of the image
change. `6355c2bb032a` is the hash of the [Assembly](../reference/glossary.md#assembly) of the Instance. Your version of
Kubernetes, your nodes and your hashes are different.

The other commands take the same `--context`, such as `jr2 run ping --context <context>`.

These things also change in a shared cluster:

- The pods must reach the model. A LAN address of your computer that works from kind can fail from a shared cluster. See
  [Use a local model](use-a-local-model.md) and [Use a hosted provider or a gateway](use-a-hosted-provider.md).
- The cluster needs the git credentials. See [Give the cluster git credentials](give-the-cluster-git-credentials.md).
- The cluster needs your Secrets. `jr2.config.ts` can name a Secret in the namespace of the Instance, with `valueFrom`
  in `secrets`, with `valueFrom` in `harness.env`, or with `harness.envFrom`. A Secret that you made on kind is not in
  the shared cluster. Make each of these Secrets in the namespace of the shared cluster before you converge.

## Rules

- On a cluster that is not kind, `jr2 up` refuses to build a Sandbox Image when you do not set `registry`. A kind
  cluster is a context whose name starts with `kind-`:
  ``error: context <context> is not a kind cluster and no `registry` is configured — set `registry` in jr2.config.ts (from env) so the image can be pushed (ADR-0019)``
- `jr2 up` refuses a cluster earlier than Kubernetes 1.35:
  `refusing: <context> runs Kubernetes <kubernetes version>; jr2 needs Kubernetes 1.35 or newer (every Sandbox mounts jr2's runtime as an image volume, ADR-0037). Nothing was applied.`
- `jr2 up` refuses a cluster that does not keep pod-level resources:
  `refusing: <context> (Kubernetes <kubernetes version>) drops pod-level resources — the PodLevelResources feature gate is off, and a Workspace's Size cannot hold (ADR-0060). Enable the gate on the API server and kubelets. The namespace was created; nothing else was applied.`
- `jr2 up` refuses a namespace that a different Instance owns:
  `refusing: namespace "<namespace>" on <context> belongs to another instance ("<instance>")`. Give a different
  namespace with `-n`, or a different context.
- A first converge into a namespace needs an answer. With no terminal and no `--yes`, `jr2 up` stops:
  `first contact: deploy instance "<name>" to context <context> (<what>)? — not a tty; pass --yes to proceed non-interactively`
- `platforms` holds `linux/amd64` and `linux/arm64` only:
  ``error: `platforms` names <platforms> — the kit releases images for linux/amd64, linux/arm64 and nothing else, so an image built for anything else could not be joined by a Kit image in the same pod. Set `platforms` in jr2.config.ts (docker platform strings, e.g. "linux/arm64") to name the set to build for.``
- When no node has a released platform, `jr2 up` refuses:
  ``error: this cluster's schedulable nodes report <architectures> — the kit releases images for linux/amd64, linux/arm64 and nothing else, so an image built for anything else could not be joined by a Kit image in the same pod. Set `platforms` in jr2.config.ts (docker platform strings, e.g. "linux/arm64") to name the set to build for.``
- When your computer cannot emulate a platform of the build, `jr2 up` stops before the build:
  `error: this host cannot build for <missing platforms>: a foreign architecture's RUN steps need qemu binfmt emulation, and none is registered (this builder targets <builder platforms>). Install it, then re-run:`,
  then `docker run --privileged --rm tonistiigi/binfmt --install <arches>`. `<missing platforms>` are the platforms that
  your builder cannot build, `<builder platforms>` are the platforms that it can build, and `<arches>` are the
  architectures of the missing platforms.
- `jr2 up` refuses a Secret that `jr2.config.ts` names and that is not in the namespace. For `valueFrom` in `secrets`:
  `error: secrets[<i>].valueFrom names Secret "<name>", which does not exist in the instance's namespace — create it first: kubectl create secret generic <name> --from-literal=<key>=... (ADR-0019, ADR-0059)`.
  For `harness.envFrom`:
  `error: harness.envFrom references Secret "<name>", which does not exist in namespace "<namespace>" — create it first: kubectl -n <namespace> create secret generic <name> --from-literal=KEY=...`.
- `priorityClasses` has the keys `control` and `sandbox` only, and each is a name that is not empty:
  `error: <file> at priorityClasses<path>: <problem> — { control?, sandbox? }, each the name of an existing PriorityClass (ADR-0060)`

## Read next

- [Converge](../concepts/converge.md)
- [Workspaces](../concepts/workspaces.md): the Size, the Sandbox nodes, and Placing.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): one command against the
  current context.
- [ADR-0045](../reference/decisions/0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md): the
  platforms.
- [ADR-0052](../reference/decisions/0052-a-sandbox-lands-where-an-ordinary-pod-lands-and-the-cache-follows-it.md): the
  Sandbox nodes.
- [ADR-0060](../reference/decisions/0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md): the Size and the
  priority classes.
- [ADR-0064](../reference/decisions/0064-a-workspace-waits-for-capacity.md): the wait for capacity and the quota.
- [Mirror the Kit images](mirror-the-kit-images.md)
