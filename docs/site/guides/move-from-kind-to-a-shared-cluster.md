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
- Landlock ABI 3 or later in the kernel of each [Sandbox node](../reference/glossary.md#sandbox-node): Linux 6.2 or
  later, with `landlock` in its list of security modules. A distribution kernel can have it at an older version: the
  check, not the version, decides. The Harness confines each program of an Agent with it. The Repo cache agent on each
  Sandbox node checks it, and `jr2 up` refuses to converge while a Sandbox node has no Landlock. It names each such
  node. To keep a node out, use `sandbox.nodeSelector` or a taint (see
  [Choose the Sandbox nodes](#choose-the-sandbox-nodes)). A node that joins later and has no Landlock gets no working
  Sandbox: its Harness does not start.
- The two prerequisites of the [Fence](../reference/glossary.md#fence): Multus, and the DaemonSet of jr2 that loads a
  rule table into each node and puts the CNI plugins `bridge`, `static` and `tuning` there. `jr2 up` installs each one
  that the cluster lacks, after it asks. See [Prerequisites of the Fence](#prerequisites-of-the-fence).
- No node credential that a pod can get. At a cloud metadata address, the metadata service of a node can give the node's
  cloud credential to a pod. A Sandbox and the Instance Harness cannot dial such an address: the Custodian refuses each
  IP address that is not an entry of the Egress list, and its dial guard refuses a permitted name that resolves to a
  link-local address. The guard does not refuse Alibaba Cloud's `100.100.100.200`, because it is not link-local. No
  NetworkPolicy or service mesh applies to a pod behind a Fence. The other pods of the Instance, such as the
  Orchestrator and the Instance Effector, are on the network of the cluster. `jr2 up` does not check these. Do these
  checks:
  - Find the metadata address of your cloud provider. When the dial guard does not refuse it, put no name that resolves
    to it on an Egress list.
  - Give pods no node credential. On GKE, use Workload Identity. On AWS, use IMDSv2 with a hop limit of 1. Then a pod
    gets no node credential from the metadata service, also a pod that is not behind a Fence.
- Your kubectl user can apply objects outside the namespace of the Instance. `jr2 up` applies the operator in the
  `jr2-system` namespace, with its CustomResourceDefinitions, ClusterRoles and ClusterRoleBindings. It also applies two
  PriorityClasses, unless you name your own.

All the Instances on a cluster share one operator. `jr2 up` does not downgrade it. See
[Converge](../concepts/converge.md#kit-version-and-forward).

### Prerequisites of the Fence

The Fence is the only network of a Sandbox and of the [Instance Harness](../reference/glossary.md#instance-harness). It
is a second pod network, apart from the network of the cluster. `jr2 up` installs the
[Custodian](../reference/glossary.md#custodian), its uplink on each Sandbox node and its resolver. The Fence needs two
parts on the cluster, and nothing else on a node:

- Multus, with `namespaceIsolation: true` and no global namespace, so that a Sandbox pod gets the Fence as its only
  network, and a pod can use an attachment of its own namespace only. When the cluster has no Multus, `jr2 up` applies
  the thick form v4.3.2 to `kube-system`, from the file `manifests/fence/multus-v4.3.2.yaml` of the `@jr2/cli` package.
  Its DaemonSet has the annotation `jr2.dev/multus`. When the cluster has a Multus that jr2 did not install, `jr2 up`
  reads its settings and never changes it. With other settings, `jr2 up` refuses and names the setting to change. See
  [A Multus of another owner](#a-multus-of-another-owner).
- The DaemonSet `jr2-system/jr2-fence-node` on each Linux node. `jr2 up` applies it. At each start, its pod does these
  steps:
  1. It loads the rule table `inet jr2_fence` into the node, in one transaction that replaces the table. The table
     matches the bridge `jr2fence0` alone. A packet from the bridge skips the connection tracking of the node, so the
     NAT of kube-proxy does not change a dial of a Sandbox to a Service address. No packet goes between the bridge and
     the network stack of the node, or between the bridge and another interface. This step comes first, so that each
     node gets the table, also a node that the next steps refuse.
  2. It waits up to 180 s for a CNI configuration in `/etc/cni/net.d` and a file in `/opt/cni/bin`, because on a new
     node the primary CNI writes them after this pod can start.
  3. When the node has a `bridge`, it runs the file to read its version, and fails when it is older than v1.8.0 or
     prints no version. An older plugin does not do what the attachments of jr2 say. A `bridge` that is a link to a file
     in another folder fails too: the pod sees only `/opt/cni/bin`, so it cannot run the file.
  4. It copies each stock CNI plugin `bridge`, `static` and `tuning` of v1.10.0 from the operator image into
     `/opt/cni/bin`, when the node has no file or link of that name. It never replaces one: a node that has the plugins
     keeps them. It writes the name of the first CNI configuration of the node, and its type. For a Multus configuration
     of the thin form, it also writes its `namespaceIsolation` and its `globalNamespaces`.

  Then it idles as a user that is not root, so a node that joins later gets the plugins and the table too. The pod runs
  as root on the network of the node, with no privilege escalation, no other host namespace and no token. The step that
  loads the table has the capability `NET_ADMIN`, and each other step has no capability. It mounts `/opt/cni/bin` and,
  read-only, `/etc/cni/net.d` of the node. A policy of the cluster must permit such a pod in `jr2-system`.

  `jr2 up` checks a node only when it runs. Nothing keeps a Sandbox off a node that joins later and whose pod of
  `jr2-fence-node` fails, until the next `jr2 up` refuses that node. On such a node with a `bridge` older than v1.3.0,
  each port of a Sandbox keeps VLAN 1, so a Sandbox there can reach the other pods on the bridge of that node. Put the
  stock plugins of v1.8.0 or later on a node before it joins, or run `jr2 up` after a node joins.

The first time that `jr2 up` installs one of them, it writes a list of each part that it will apply, and asks (`--yes`
answers it). The list says that the DaemonSet runs as root on the network of the node, runs the `bridge` of the node,
writes into `/opt/cni/bin` and loads the rule table with `NET_ADMIN`. For Multus, it says that the manifest has a
cluster-wide CustomResourceDefinition and ClusterRole, and a privileged DaemonSet that writes the first CNI
configuration of each node, so that the cluster makes each new pod through Multus. Then a converge that finds both asks
nothing. A later `jr2 up` of a newer Kit changes the DaemonSet to its version, and does not ask. It asks before it
changes Multus.

`jr2 down --all` removes the rule table and the bridge `jr2fence0` from each node, then the DaemonSet, and the Multus
that jr2 installed, with its CustomResourceDefinition. That definition goes with each NetworkAttachmentDefinition of the
cluster. So when the cluster has a NetworkAttachmentDefinition that is not jr2's, `jr2 down --all` keeps jr2's Multus
and the definition, names them, and gives the commands that remove them. The plugin files and the kernel module `8021q`
stay on the nodes. A bridge that a pod is still on stays too, and `jr2 down --all` names its node.

`jr2 up` does not install when that is not safe. Before it applies anything, it refuses, and names what to change, for:

- a Multus that jr2 did not install, with no `namespaceIsolation`, with a global namespace, or with settings that jr2
  cannot tell (see [A Multus of another owner](#a-multus-of-another-owner));
- the CustomResourceDefinition of Multus (`network-attachment-definitions.k8s.cni.cncf.io`) with no Multus DaemonSet
  that jr2 can find. When it stays from a Multus that is gone, and no NetworkAttachmentDefinition uses it, delete it.
  When your Multus is of a form that jr2 does not know, run it in one of the forms below;
- Cilium with `cni-exclusive: "true"`, in the ConfigMap `cilium-config` of the namespace of the Cilium DaemonSet, or in
  a `CiliumNodeConfig` of a Sandbox node. Cilium then removes the configuration of Multus. Set it to `"false"`. When jr2
  cannot read those objects, it says that it cannot tell, and goes on;
- a Multus that jr2 did not install that mounts a CNI folder other than `/opt/cni/bin` and `/etc/cni/net.d`. Keep such
  nodes out of the Sandbox nodes (see [Choose the Sandbox nodes](#choose-the-sandbox-nodes)).

After it applies the namespace `jr2-system` and the DaemonSet, and before it applies Multus, `jr2 up` refuses a Sandbox
node where the pod of `jr2-fence-node`:

- finds no CNI configuration in `/etc/cni/net.d`, or no file in `/opt/cni/bin`, in 180 s, or the kubelet cannot mount
  one of the two folders in that time. The container runtime of the node reads another folder. Keep the node out of the
  Sandbox nodes;
- finds a `bridge` that is older than v1.8.0, prints no version, or is a link to a file in another folder. Replace it
  with the file of a stock plugin of v1.8.0 or later, or delete it, so that jr2 writes v1.10.0;
- cannot write into `/opt/cni/bin`, for example on a node where the folder is read-only;
- finds a first CNI configuration of Multus when jr2 found no Multus DaemonSet and is about to install its own;
- finds a first CNI configuration of the thin Multus with no `namespaceIsolation` or with a global namespace, when the
  cluster has a Multus of another owner. The node uses that file, whatever the API says. Restart the pods of your
  Multus, so that they write the file again;
- cannot load the rule table: the node needs nftables with the inet family;
- has no pod, because a policy of the cluster refused it;
- is not ready in 300 s.

These refusals come after the apply, so the namespace `jr2-system` and the DaemonSet stay, with the plugins that it
wrote and the rule table on each node where it loaded. The table loads before the checks of a node, so a node that they
refuse has the table too. `jr2 down --all` removes the DaemonSet and the table.

The bridge plugin makes the bridge `jr2fence0` and its VLANs from the attachments of each Instance. Each port of a
Sandbox is in its own VLAN only, the uplink of the Custodian is in the VLANs of its Instance only, and the side of the
node is in VLAN 1 only, which no pod uses. That VLAN state keeps a Sandbox off the node and off other pods, also with no
rule table. The rule table keeps the NAT of the node from changing the frames of a Sandbox, so that each dial reaches
the Custodian, and it is a second barrier. After a restart of the node, the plugin makes the bridge again when the pods
of the node start again, and the pod of `jr2-fence-node` loads the table again: there is nothing to do.

After the Custodian is ready, `jr2 up` runs a short pod on the Fence of each Sandbox node. It refuses to converge while
a node fails, and it names the node, the part and the likely causes. The check dials the address of the API Service: on
a node with no rule table, the NAT of the node changes that dial, the dial gets no answer, and the check fails. Then
`jr2 up` replaces the pod of `jr2-fence-node` on that node, which loads the table again. The check has no privilege on
the node, so it sees what the VLANs and the table do, not the VLANs and the table. A managed cluster that permits no
second CNI plugin cannot have the Fence.

### A Multus of another owner

jr2 uses a Multus that it did not install only when it knows its form and reads its settings where that form reads them.
It finds a Multus by the command of the container of a DaemonSet, not by a name or a label. So an add-on beside Multus,
such as `rke2-multus-dnc`, is not a Multus. It reads:

| Command of the container                    | Where jr2 reads `namespaceIsolation` and `globalNamespaces`                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multus-daemon` (thick)                     | The configuration file of the daemon (`-config`, by default `/etc/cni/net.d/multus.d/daemon-config.json`), a key of a ConfigMap that the container mounts.                                                                       |
| `/thin_entrypoint` (thin)                   | With `--multus-conf-file=auto` (the default): the flags `--namespace-isolation` and `--global-namespaces`. With a path: the key of the ConfigMap that is mounted at that path. A ConfigMap that it does not read does not count. |
| `/entrypoint.sh` of a multus-cni image (v3) | As the thin form, but the script reads only `--flag=value`, and the isolation is on only for `--namespace-isolation=true`.                                                                                                       |

For a thin form, the node uses the Multus configuration that the pod of Multus wrote when it started. So `jr2 up` also
reads that file on each Sandbox node, and refuses a node where the file has no isolation or has a global namespace,
whatever the API says. After you change a setting, restart the pods of your Multus.

When jr2 cannot tell the settings, for example a multus-cni image with another command, it refuses, says that it cannot
tell, and names what it saw. Run your Multus in one of these forms, with `namespaceIsolation` and no global namespace.

### An optional route

One setting of a node is optional. jr2 does not need it, does not make it and does not check it. Make it at boot (a
unit, or the provisioning of the node), because a restart loses it: an `unreachable` route for the segment
(`198.19.0.0/20`, or `segment` of [`fence`](../reference/config.md#fence)). Then a connection from the node, or from a
pod on the network of the cluster, to the address of a Sandbox fails at once, not after a timeout.

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
the Envoy image of the Custodian from `docker.io`. When the nodes cannot reach those registries, see
[Mirror the Kit images](mirror-the-kit-images.md).

`jr2 up` also checks each model that an [Agent](../reference/glossary.md#agent) names, from a pod in the cluster. That
pod uses the Harness Kit image, so it needs no other image.

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
the [Instance Effector](../reference/glossary.md#instance-effector). `jr2-sandbox` is for the Sandboxes and the Instance
Harness. An ordinary pod cannot preempt a Sandbox, and a Sandbox that waits for a node preempts no pod.

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
  placing: waits for quota — pods "ws-94af9d4b-x-0-1033891ffd2a" is forbidden: exceeded quota: team-quota, requested: limits.memory=1Gi, used: limits.memory=2Gi, limited: limits.memory=512Mi
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
sandbox image "default": building <registry>/jr2-sandbox-my-instance-default:5e601a543032-amd64
  no USER declared — the pod's uid-1000 fallback applies
  user context: none (no USER, so the home is jr2's emptyDir)
  push → <registry>
…
assembly: publishing 42e515b3343d (no current Assembly)
assembly: 42e515b3343d is current — workflows: hold, ping
…
converged — `jr2 run <workflow>` when ready
```

In this output, the cluster runs Kubernetes v1.36.1 and has one node, `jr2-control-plane`, with the label
`pool: agents`, and it has the [prerequisites of the Fence](#prerequisites-of-the-fence) already. On a cluster that
lacks one, the question also says what `jr2 up` will install, and lines that start with `fence:` show the install. The
Workflows are `ping` and `hold`, a Workflow with a Workspace. `<version>` is the
[Kit version](../reference/glossary.md#kit-version) of the Instance. `5e601a543032` changes when the inputs of the image
change. `42e515b3343d` is the hash of the [Assembly](../reference/glossary.md#assembly) of the Instance. Your version of
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
- `jr2 up` refuses a cluster where it cannot install a prerequisite of the Fence safely. Some of these refusals come
  before it applies anything, and some after it applies the DaemonSet `jr2-fence-node`. See
  [Prerequisites of the Fence](#prerequisites-of-the-fence) and [Fix a failed converge](fix-a-failed-converge.md#rules).
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
