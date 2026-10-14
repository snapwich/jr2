---
title: Workspaces
description: How a Workflow gets a git Worktree in a Sandbox, and how long it keeps it.
---

A [Workspace](../reference/glossary.md#workspace) is a [Machine](../reference/glossary.md#machine) that runs a body
Machine in a [Sandbox](../reference/glossary.md#sandbox). The Sandbox is a pod of its own, with a git
[Worktree](../reference/glossary.md#worktree) of each [Repo](../reference/glossary.md#repo) on one branch. You make a
Workspace with [`workspace()`](../reference/authoring-surface.md#workspace). The Workspace makes the Sandbox when the
run enters it, and deletes the Sandbox when the body reaches a final state.

## Why Workspaces exist

An [Agent](../reference/glossary.md#agent) that works on code runs programs, writes files and opens ports. Two Agents on
one host would share the filesystem, the ports and the processes. A Sandbox gives each unit of work its own pod, with
its own filesystem, network and processes.

The Workspace holds the life of that pod, so that your Machine does not. Your body Machine does the work: it codes,
reviews and waits for a person. The Workspace makes the Sandbox before the body starts, and removes it after the body
ends. A coder and a reviewer in one body share one Workspace: the isolation is for each unit of work, not for each
Agent.

## A Workspace and its body

This example is a [Workflow](../reference/glossary.md#workflow). A coder changes the `app` Repo, and reads the
`handbook` Repo beside it. Then a person approves the change at a [Gate](../reference/glossary.md#gate), and the Machine
pushes the branch:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/workspaces/anthropic/docs-fix.ts

== Local

<<< @/examples/concepts/workspaces/local/docs-fix.ts

:::

[Agents and Turns](agents-and-turns.md) tells how to define an Agent.

The options of `workspace()` say what the Sandbox is. [`jr2 up`](../reference/cli.md#up) reads them before a run starts.
Only `spec` and a per-run [Repo Slot](../reference/glossary.md#repo-slot) read the run input:

- `input` is the schema of the run input: what [`jr2 run`](../reference/cli.md#run) gives with `--input`. Put it on the
  `workspace()`, not on the body.
- `repos` gives the Repo Slots that the Sandbox clones.
- `spec` is a function from the run input to the branch. At a root `workspace()`, its input also holds `instanceId` (see
  [`HostInjectedInput`](../reference/authoring-surface.md#type-hostinjectedinput)).
- `resources` is the [Size](../reference/glossary.md#size). `image`, `user` and `effector` name the images of the pod's
  containers.
- `secrets` names the [Held secrets](../reference/glossary.md#held-secret) that the Sandbox can use (see
  [Secrets and trust](secrets-and-trust.md)).

The body gets the run input, plus `workspace`: the handles of the Workspace (see
[`WorkspaceHandles`](../reference/authoring-surface.md#type-workspacehandles)). `workspace.repos` gives the absolute
path of each Worktree, and `workspace.branch` gives the branch. Give a path to an Agent's
[Turn](../reference/glossary.md#turn) as its `cwd`, as the example does. Type the body's input with
[`Workspaced`](../reference/authoring-surface.md#type-workspaced).

The Agents with [Working tools](../reference/glossary.md#working-tools) in the body run in the Sandbox. An Agent with
`workspace: "none"` runs on the [Instance Harness](../reference/glossary.md#instance-harness), also when its state is in
a body. A `command` and a `push` [Effect](../reference/glossary.md#effect) in the body also run in the Sandbox (see
[Effects](effects.md)).

## Repos and Repo Slots

A Repo is a git repository. Its url names it: the host and the path. The scheme, the user and `.git` do not change which
Repo it is. `jr2.config.ts` has no list of Repos. A Machine names each Repo that it uses in a Repo Slot.

A Repo Slot is a key of the `repos` option. The key is your Machine's name for the Repo, and it is the folder of the
Repo under `/work`. Each slot is one of three kinds:

- **Bound**: the Machine gives the url, or a [Binding](../reference/glossary.md#binding) `{ url, ref }`. `ref` is the
  branch or the commit that the Worktree starts from. Without `ref`, the Worktree starts from the Repo's default branch.
- **[Open](../reference/glossary.md#open)**: the Machine gives [`open`](../reference/authoring-surface.md#open). The
  [Instance](../reference/glossary.md#instance) that registers the Machine binds the slot with
  [`customize()`](../reference/authoring-surface.md#customize) (see [Composition](composition.md)).
- **Per-run**: the Machine gives a function of the run input, `({ input }) => url`. Each run chooses its Repo.

A Machine that names no slot writes `repos: open` for the whole map. Then the composer names each slot.
`workspace.repos` keeps the slots in the order that `repos` declares them. jr2 gives no slot a special meaning. Your
Machine says which Worktree each Agent works in.

The cluster keeps one read-only cache of each Repo on each node. A Sandbox clones from that cache, and a fetch in the
pod goes through it. [Architecture](architecture.md) tells about the Repo cache. Run
[`jr2 status`](../reference/cli.md#status) with no run id to see the Repos of the Instance, for each node.

## The folders in the Sandbox

Each Repo Slot gets a folder under `/work`. The clone of the Repo is `/work/<slot>/default/`. The Worktree of the branch
is beside it, at `/work/<slot>/<branch>`. In the folder name, each `/` of the branch becomes `-`. For example, the
branch `docs/T-12` of the slot `app` is at `/work/app/docs-T-12`. This is the
[Project layout](../reference/glossary.md#project-layout).

`spec` returns a [`WorkspaceSpec`](../reference/authoring-surface.md#type-workspacespec). It gives the branch, and two
optional fields:

- `reviewSha`: a commit for a reviewer. jr2 checks it out in a second Worktree, at `/work/<slot>/<branch>-review`. The
  body gets its paths as `workspace.review`.
- `workGroup`: the group id that owns the files in `/work`. The default is 2000.

Your Machine chooses the branch name. jr2 makes the branch in each Repo Slot.

## The pod

A Sandbox pod has two containers, and two more when the Machine needs them:

| Container                                                         | What runs in it                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The [Harness](../reference/glossary.md#harness) container         | The Harness, the Agent's Working tools, and a `command` that names no [Effect secret](../reference/glossary.md#effect-secret)                    |
| The [Custodian](../reference/glossary.md#custodian)               | jr2's own container. It holds the pod's Held secrets, and the Harness's calls out of the pod go through it (see [Architecture](architecture.md)) |
| The [User Container](../reference/glossary.md#user-container)     | Your own image, with its own entrypoint. Only when `user` names one.                                                                             |
| The [Sandbox Effector](../reference/glossary.md#sandbox-effector) | A `push`, an `http` Effect with a Worktree file, and a `command` that names an Effect secret. Only when an Effect needs it.                      |

### The Sandbox Image

The [Sandbox Image](../reference/glossary.md#sandbox-image) is the image of the Harness container. It holds the tools
that an Agent's Working tools can use, and the shell that you get when you run `kubectl exec` into the pod. The image is
yours. Its floor is glibc, git and a writable `HOME`. [Add tools to the Sandbox](../guides/add-tools-to-the-sandbox.md)
gives the full list. jr2 adds nothing to the image. It mounts its own runtime into the pod at `/opt/jr2`, and starts the
Harness from there. Thus the `ENTRYPOINT` and the `CMD` of the image do not run.

`image` names it in one of two forms:

- A `file:` URL to a docker context that your module ships, such as `import.meta.resolve("./image")`. `jr2 up` builds
  it.
- A registry ref, for an image that you build and push yourself. jr2 does not build it.

Without `image`, the Sandbox uses the Instance's `images/default`, which `jr2 init` writes. When the Instance has no
`images/default`, it uses jr2's Harness image. [Converge](converge.md) tells how `jr2 up` builds and loads the image.

### The User Container

The User Container is an optional third container, for a program that must run without an Agent, such as an sshd. It
runs its own entrypoint, with `/work` mounted. jr2 never builds into it, probes it or sends it commands. `user` names
its image, in the same two forms as `image`.

The pod has one network. Thus the User Container cannot use the ports of jr2's containers: `8080`, `8082` and `15021`,
and `8081` and `15001` on loopback.

## Size

The Size is the most memory and cpu that the whole Sandbox can use. jr2 reserves all of it on the node. Thus a Sandbox
never gets less than its Size, and never uses more. jr2 also enforces the cpu limit.

The Size is a fact of the Machine, as its image is. It is never set for one run. jr2 finds it in this way:

1. The Machine's Size is the `resources` of its `workspace()`. Each field that `customize(machine, { resources })` gives
   replaces the same field. For example, `customize()` with memory `6Gi`, over a `workspace()` with memory `3Gi` and cpu
   `2`, gives memory `6Gi` and cpu `2`.
2. When the Machine states a Size, jr2 uses it. A field that it does not state comes from the kit default: memory `2Gi`,
   cpu `1`.
3. When the Machine states no Size, jr2 uses [`sandbox.resources`](../reference/config.md#sandbox-resources) in
   `jr2.config.ts`. A field that it does not state comes from the kit default.

A Size is `{ limits: { memory, cpu } }`, and nothing else (see [`Size`](../reference/authoring-surface.md#type-size)).
Inside the pod, the Custodian gets a small fixed part. A User Container gets the part that `user` gives it, or shares
the rest. The Harness container gets the rest. `jr2 up` refuses a Size that leaves the Harness container less than 256Mi
of memory.

## Placing

A Sandbox waits until a node has room for its Size. It can also wait for room under a quota of the cluster. This wait is
the Workspace's [Placing](../reference/glossary.md#placing) state. jr2 sets no time limit on it, because jr2 cannot tell
"full now" from "never fits". When your Machine needs a limit, put an `after` on the state that holds the Workspace.

The wait shows in the [Console](../reference/glossary.md#console) and in the CLI. [`jr2 runs`](../reference/cli.md#runs)
marks a run that has a Workspace in `placing`. `jr2 status <run id>` gives the reason, in the words of the scheduler or
the quota. `<run id>` is the id that `jr2 run` printed, or a prefix of it. The body gets no event.

A Sandbox lands where an ordinary pod lands. To limit the nodes, set
[`sandbox.nodeSelector`](../reference/config.md#sandbox-nodeselector) and
[`sandbox.tolerations`](../reference/config.md#sandbox-tolerations) in `jr2.config.ts`. After Placing, the pod has 120
seconds to become ready. A Sandbox that waits for the Repo cache to clone has 25 minutes.

## The life of a Workspace

A Workspace goes through these states:

1. `placing`: jr2 writes the Sandbox, and waits for a node.
2. `provisioning`: the pod starts.
3. `attaching`: the Harness clones each Repo Slot and makes its Worktree.
4. `running`: the body runs.
5. `teardown`: the body is in a final state, and jr2 deletes the Sandbox.

The output of the Workspace is the output of the body.

A final state of the body deletes the Sandbox, with each commit in it. Push the work before the body ends: with a
[`push`](../reference/authoring-surface.md#push) Effect, or by hand while the run waits. A body that must keep its
Sandbox waits in a state that is not final, such as at a Gate. The Sandbox stays while the run waits.

When a run faults after its Sandbox was placed, the Sandbox stays, so that you can look inside it. jr2's operator
removes it after an idle timeout of 30 minutes. jr2 immediately deletes a Sandbox that it never placed. `CANCEL` deletes
the Workspaces of the run, unless you send it with `--keep` (see [`jr2 send`](../reference/cli.md#send)).

## Lease and Continuity

Nothing in the cluster stands for a run. Thus the [Orchestrator](../reference/glossary.md#orchestrator) must say that it
still wants each Sandbox. The [Lease](../reference/glossary.md#lease) does this: about every 5 minutes, the Workspace
writes an annotation on its Sandbox. It does this from the write of the Sandbox to its teardown, `placing` included.
When the Lease stops for 30 minutes, the operator removes the Sandbox. Thus a Sandbox that nobody wants does not stay.

[Continuity](../reference/glossary.md#continuity) asks a different question: is the Sandbox still the one that the body
attached to? A Sandbox has one pod for its life. The work in `/work` is only in that pod. When a person or the cluster
deletes or evicts the pod, or its node goes, the Sandbox is Lost. jr2 does not make the pod again, because a new pod has
none of the work.

The Orchestrator watches its Sandboxes. While the body runs, when it sees a Sandbox that is Lost or gone, it sends
[`workspace.lost`](../reference/mechanism-events.md#workspace-lost) to the body, with the reason. The body decides what
to do. In the example, the body goes to its `lost` state, and the run ends. A restart of the Harness container does not
lose the Workspace: the pod and `/work` stay.

## Rules

- `workspace()` takes the run input in `input`. It refuses a body that declares its own `input`.
- `repos` names at least one Repo Slot, or is `open`. A slot key starts with a letter, because it is a folder name.
- `jr2 up` refuses a Workflow with an Open Repo Slot that nobody bound.
- A per-run url must match an entry of [`git.credentials`](../reference/config.md#git-credentials). jr2 refuses the url
  before it makes the Sandbox when no entry matches it. Thus a run cannot send the cluster's credentials to a host that
  it chooses.
- `spec` returns a `branch`. When a run enters the Workspace, it faults if `spec` gives no `branch`, or the branch
  `default`, because `default` is the folder of the clone.
- A Size has only `limits.memory` and `limits.cpu`. jr2 refuses `requests` and each other key.
- `jr2 up` refuses a Size that leaves the Harness container less than 256Mi of memory, or no cpu.
- Under a Workspace with more than one Repo Slot, a Turn states its `cwd`, and a `command` and a `push` name their slot.

The guides and the Reference give the refusal text of each rule.

## Read next

- [Look inside a Sandbox](../guides/look-inside-a-sandbox.md)
- [Add tools to the Sandbox](../guides/add-tools-to-the-sandbox.md)
- [Size a Workspace](../guides/size-a-workspace.md)
- [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md)
- [Effects](effects.md), [Composition](composition.md), [Architecture](architecture.md)
- Reference: [`workspace`](../reference/authoring-surface.md#workspace),
  [`RepoSlot`](../reference/authoring-surface.md#type-reposlot), [`Size`](../reference/authoring-surface.md#type-size),
  [`UserContainer`](../reference/authoring-surface.md#type-usercontainer),
  [`workspace.lost`](../reference/mechanism-events.md#workspace-lost), [`sandbox`](../reference/config.md#sandbox)
- [ADR-0012](../reference/decisions/0012-workspace-wrapper-machine.md): `workspace()` wraps a body Machine and owns only
  Sandbox lifecycle
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): a Repo is a slot
  on the `workspace()` and a cache on the node
- [ADR-0060](../reference/decisions/0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md): a Workspace states
  its Size, and jr2 reserves all of it
- [ADR-0064](../reference/decisions/0064-a-workspace-waits-for-capacity.md): a Workspace waits for capacity
- [ADR-0021](../reference/decisions/0021-workspace-continuity-is-a-lease-that-answers-back.md): Workspace Continuity is
  watched, and the Lease asserts
- [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md) and
  [ADR-0037](../reference/decisions/0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md): the pod, and
  the Sandbox Image
