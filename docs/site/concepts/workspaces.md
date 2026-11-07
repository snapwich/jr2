---
title: Workspaces
description: How a Workflow gets a Sandbox with a git Worktree or a shared folder, and how long it keeps it.
---

A [Workspace](../reference/glossary.md#workspace) is a [Machine](../reference/glossary.md#machine) that runs a body
Machine in a [Sandbox](../reference/glossary.md#sandbox). The Sandbox is a pod of its own, with a folder, `/work`, that
the Agents and Effects of the body share. When the Workspace names [Repos](../reference/glossary.md#repo), `/work` holds
a clone of each Repo. The body cuts each git [Worktree](../reference/glossary.md#worktree) that it needs. A Workspace
that names no Repo has only the folder (see [A Workspace with no Repo](#a-workspace-with-no-repo)). You make a Workspace
with [`workspace()`](../reference/authoring-surface/workspace.md). The Workspace makes the Sandbox when the run enters
it, and deletes the Sandbox when the body reaches a final state.

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
`handbook` Repo beside it. The Machine first cuts the coder's Worktree. Then a person approves the change at a
[Gate](../reference/glossary.md#gate), and the Machine pushes the branch:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/workspaces/anthropic/docs-fix.ts

== Local

<<< @/examples/concepts/workspaces/local/docs-fix.ts

:::

::: graph @/examples/concepts/workspaces/anthropic/docs-fix.ts

:::

[Agents and Turns](agents-and-turns.md) tells how to define an Agent.

The options of `workspace()` say what the Sandbox is. [`jr2 up`](../reference/cli.md#up) reads them before a run starts.
Only a per-run [Repo Slot](../reference/glossary.md#repo-slot) reads the run input:

- `input` is the schema of the run input: what [`jr2 run`](../reference/cli.md#run) gives with `--input`. Put it on the
  `workspace()`, not on the body.
- `repos` gives the Repo Slots that the Sandbox clones. Leave it out for a Workspace with no Repo.
- `resources` is the [Size](../reference/glossary.md#size). `image`, `user` and `effector` name the images of the pod's
  containers.
- `secrets` names the [Held secrets](../reference/glossary.md#held-secret) that the Sandbox can use (see
  [Secrets and trust](secrets-and-trust.md)).
- `workGroup` is the group id that owns the files in `/work`. The default is 2000.

The body gets the run input, plus `workspace`: the handles of the Workspace (see
[`WorkspaceHandles`](../reference/authoring-surface/type-workspacehandles.md)). `workspace.repos` gives the folder of
each Repo Slot, `/work/<slot>`. This folder is not a Worktree. Give the path of a Worktree to an Agent's
[Turn](../reference/glossary.md#turn) as its `cwd`, as the example does. Type the body's input with
[`Workspaced`](../reference/authoring-surface/type-workspaced.md), also when the run input is `z.object({})`.

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
  branch, the tag or the commit that the clone stays on, and a new branch starts from it. Without `ref`, it is the
  Repo's default branch.
- **[Open](../reference/glossary.md#open)**: the Machine gives [`open`](../reference/authoring-surface/open.md). The
  [Instance](../reference/glossary.md#instance) that registers the Machine binds the slot with
  [`customize()`](../reference/authoring-surface/customize.md) (see [Composition](composition.md)).
- **Per-run**: the Machine gives a function of the run input, `({ input }) => url`. Each run chooses its Repo.

A Machine that names no slot writes `repos: open` for the whole map. Then the composer names each slot.
`workspace.repos` keeps the slots in the order that `repos` declares them. jr2 gives no slot a special meaning. Your
Machine says where each Agent works.

The cluster keeps one read-only cache of each Repo on each node. A Sandbox clones from that cache, and a fetch in the
pod goes through it. [Architecture](architecture.md) tells about the Repo cache. Run
[`jr2 status`](../reference/cli.md#status) with no run id to see the Repos of the Instance, for each node.

## The folders in the Sandbox

Each Repo Slot gets a folder under `/work`. The clone of the Repo is `/work/<slot>/default/`. It stays on the base of
the Binding: a branch is attached, and a tag or a commit is detached. No work happens in `default/`. A slot that an
Agent only reads needs nothing more: the Agent reads `/work/<slot>/default`. This is the
[Project layout](../reference/glossary.md#project-layout). `/work/.jr2/` is reserved for jr2.

The Workspace only clones. Your Machine cuts each Worktree with the
[`worktree()`](../reference/authoring-surface/worktree.md) Effect, in a state of the body. You give the path, and the
branch or the commit:

- `{ path: "/work/app/fix", branch: "docs/123" }` cuts a branch Worktree. The cut finds a local branch, then
  `origin/<branch>`, tracked, after a fetch. With neither, it makes a new branch from `from` or the base of the Binding.
- `{ path: "/work/app/review", detach: sha }` cuts a detached Worktree for a reviewer. Each cut forces it to the commit
  and cleans it. Ignored files stay, so that the reviewer can run the tests.

The path is exactly `/work/<slot>/<name>`. The name is one segment that is not `default` and starts with neither `.` nor
`-`. So your Machine knows the path before the cut, and the folder name does not change with the branch name.

The output of a cut is `ready`, `refused` or `unknown`. A later outcome can come, so route the last arm of `onDone` with
no guard. A bad path or a bad branch name is `refused`, and nothing changes. A cut is idempotent: the same cut again
reads the same Worktree, and its `head` is the tip of the branch.

`worktree({ expect: "new" })` refuses a branch that exists. `worktree({ expect: "existing" })` refuses a branch that
does not exist, and makes nothing.

The author chooses how many Agents work in a Workspace. Agents in one Worktree share git, as people in one checkout do.
Each coder that needs its own branch gets its own Worktree of the one clone.

Your Machine chooses the branch name. Give each run a different branch, so that two runs do not push to one branch. Make
it from a field of the run input, or from `instanceId` when the run input has no field that is different for each run.
Only a root `workspace()` gets `instanceId` from jr2. A `workspace()` that a different Machine invokes gets it only when
its parent gives it.

An Agent, a `command`, a `push`, and an `http` Effect with a file body each name their Worktree by its path: `cwd` for a
Turn, `worktree` for an Effect. A `push` has no branch in its input. jr2 reads the branch from the cut of that path. So
an Agent that moves `HEAD` does not change what is pushed.

jr2 has no Effect that removes a Worktree. To remove one, run `git worktree remove` in a `command`.
[Cut a Worktree](../guides/cut-a-worktree.md) gives the procedure.

## Large files and submodules

A Repo that keeps its large files with Git LFS needs nothing from your Machine or your image. The commit's
`.gitattributes` tells git which files are large. jr2's runtime has its own git-lfs, and the clone uses it. Each large
file is checked out with its contents, not as its pointer:

- The attach gets the large files of the base before it checks out `default/`. When the Repo cache cannot get one, the
  attach fails, and the Workspace fails in `attaching`.
- A cut gets the large files of its commit before it changes git. When the Repo cache cannot get one, the cut is
  `refused`, and the reason names the file.
- Each other checkout in the Sandbox, such as a `git checkout` by an Agent, asks the Repo cache for the large files that
  it needs.
- A `push` uploads the large files of its commits to the LFS server before it updates the branch (see
  [Push and sign a branch](../guides/push-and-sign-a-branch.md#push-large-files)).

The `.lfsconfig` file at the base of the Binding names the LFS server. Without it, the server is the one that git-lfs
gets from the Repo's url. The [Orchestrator](../reference/glossary.md#orchestrator) names that base from the run's
Binding. It ignores a base that the pod sends. Thus an Agent cannot send the Repo cache or the push to an LFS server of
its choice. [Architecture](architecture.md#large-files-in-the-repo-cache) tells which server gets the credential.

A large file uses the disk of `/work` more than one time. The clone keeps one copy of it in its own LFS store, and each
checkout of it, `default/` included, is one more copy.

The clone and each cut check out no submodule. The folder of a submodule stays empty. A Workspace that works in the code
of a submodule binds that Repo as a Repo Slot of its own. The example binds `handbook` beside `app` in this way.

## A Workspace with no Repo

Some work has no Repo: get data, write a report from it, edit the report, and send it. For this work, leave `repos` out.
The Sandbox then has only `/work`, and the steps of the body share it. A step is an Agent's Turn or an Effect of the
body. This is like one job of a GitHub Actions workflow, whose steps share one folder. Two Workspaces are two jobs, and
they share nothing.

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/workspaces/anthropic/weekly-report.ts

== Local

<<< @/examples/concepts/workspaces/local/weekly-report.ts

:::

::: graph @/examples/concepts/workspaces/anthropic/weekly-report.ts

:::

In a Workspace with no Repo:

- Type the body's input as `Workspaced<RunInput, never>`. The handles are `{ repos: {} }`.
- An Agent's Turn that gives no `cwd` works in `/work`. The Agent's `workspace` access is the same as in each Workspace:
  `"write"` gives it `write`, `edit` and `bash`, and `"read"` gives it `bash` only.
- A `command` with no Effect secret runs in `/work`.
- An `http` Effect sends a file of `/work` with `file(path)`. The path is relative to `/work`.
- A `worktree()` needs a Repo Slot, a `push` needs a branch, and a `command` with an Effect secret runs on a commit.
  Thus `jr2 up` refuses all three.

jr2 deletes `/work` with the Sandbox. Send what must stay before the body ends, as the example does with `upload`. The
secret `files` that `upload` names is an entry of the `secrets` list of `jr2.config.ts`, as each Effect secret is. A
Lost Sandbox has lost all of its work, because no commit was pushed.

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
that an Agent's Working tools can use, and the shell that you get with `jr2 workspace shell`. The image is yours. Its
floor is glibc, git and a writable `HOME`. [Add tools to the Sandbox](../guides/add-tools-to-the-sandbox.md) gives the
full list. jr2 adds nothing to the image. It mounts its own runtime into the pod at `/opt/jr2`, and starts the Harness
from there. Thus the `ENTRYPOINT` and the `CMD` of the image do not run.

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

A Size is `{ limits: { memory, cpu } }`, and nothing else (see [`Size`](../reference/authoring-surface/type-size.md)).
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
3. `attaching`: the Harness clones each Repo Slot, and gets the large files of its base. With no Repo Slot, this state
   has nothing to do.
4. `running`: the body runs.
5. `teardown`: the body is in a final state, and jr2 deletes the Sandbox.
6. `failing`: the body invoked [`fail`](../reference/authoring-surface/fail.md), and jr2 deletes the Sandbox. Then the
   Workspace sends the same [Failure](../reference/glossary.md#failure) up to its parent.

The output of the Workspace is the output of the body.

A final state of the body deletes the Sandbox, with each commit in it. Push the work before the body ends: with a
[`push`](../reference/authoring-surface/push.md) Effect, or by hand while the run waits. A body that must keep its
Sandbox waits in a state that is not final, such as at a Gate. The Sandbox stays while the run waits.

A Failure also deletes the Sandbox, with each commit in it. To keep the work for a person to read, wait at a Gate before
the state that fails.

A parent that invokes the same Machine again, with the same invoke id, gives the new Workspace the same Sandbox. That
happens on a retry after it catches a Failure, or when it enters the state again. jr2 does not delete that Sandbox. The
new Workspace takes it over, with the Worktree and each commit of the attempt before it, as a restore does.

When a run faults after its Sandbox was placed, the Sandbox stays, so that you can look inside it. jr2's operator
removes it after an idle timeout of 30 minutes. jr2 immediately deletes a Sandbox that it never placed. `CANCEL` deletes
the Workspaces of the run, unless you send it with `--keep` (see [`jr2 send`](../reference/cli.md#send)).

## Lease and Continuity

Nothing in the cluster stands for a run. Thus the Orchestrator must say that it still wants each Sandbox. The
[Lease](../reference/glossary.md#lease) does this: about every 5 minutes, the Workspace writes an annotation on its
Sandbox. It does this from the write of the Sandbox to its teardown, `placing` included. When the Lease stops for 30
minutes, the operator removes the Sandbox. Thus a Sandbox that nobody wants does not stay.

[Continuity](../reference/glossary.md#continuity) asks a different question: is the Sandbox still the one that the body
attached to? A Sandbox has one pod for its life. The work in `/work` is only in that pod. When a person or the cluster
deletes or evicts the pod, or its node goes, the Sandbox is Lost. jr2 does not make the pod again, because a new pod has
none of the work.

The Orchestrator watches its Sandboxes. While the body runs, when it sees a Sandbox that is Lost or gone, it sends
[`workspace.lost`](../reference/mechanism-events.md#workspace-lost) to the body, with the reason. The body decides what
to do. In the example, the body goes to its `lost` state, which invokes `fail`, and the run ends `failed`. A restart of
the Harness container does not lose the Workspace: the pod and `/work` stay.

## Rules

- `workspace()` takes the run input in `input`. It refuses a body that declares its own `input`.
- `repos` names at least one Repo Slot, or is `open`, or is not there. jr2 refuses `repos: {}`. A slot key starts with a
  letter, because it is a folder name.
- `jr2 up` refuses a Workflow with an Open Repo Slot that nobody bound.
- A per-run url must match an entry of [`git.credentials`](../reference/config.md#git-credentials). jr2 refuses the url
  before it makes the Sandbox when no entry matches it. Thus a run cannot send the cluster's credentials to a host that
  it chooses.
- `jr2 up` refuses a Repo Slot name that starts with `.`, because `/work/.jr2/` is reserved for jr2.
- A cut of the branch that `default/` holds is `refused`, and the reason names `/work/<slot>/default`.
- An attach whose base has a large file that the Repo cache cannot get fails, and the Workspace fails in `attaching`.
  The error is
  `the attach of slot "<slot>" failed at get the base's large files: the node cache cannot get <files> of <base>: <list>`.
- A cut whose large files the Repo cache cannot get, or cannot get in the time that the cut has, is `refused`. The
  reason names the files, as the attach error does. [Cut a Worktree](../guides/cut-a-worktree.md#rules) gives the form
  of `<list>`.
- A `push` whose large files the LFS server does not hold after the upload is `rejected`, and nothing is pushed.
- With no Repo Slot, `jr2 up` refuses a `worktree()`, a `push`, and a `command` that names an Effect secret.
- A Size has only `limits.memory` and `limits.cpu`. jr2 refuses `requests` and each other key.
- `jr2 up` refuses a Size that leaves the Harness container less than 256Mi of memory, or no cpu.
- Under a Workspace with Repo Slots, a Turn states its `cwd`, and a `command`, a `push` and an `http` Effect with a file
  body state their `worktree`. A Turn that wants `/work` states `cwd: "/work"`. An Agent with `workspace: "none"` needs
  no `cwd`.
- A `push`, a `command` that names an Effect secret, and an `http` Effect with a file body need a Worktree that a cut of
  this run made.
- Under a Workspace with more than one Repo Slot, a `push` names its `slot`.

The guides and the Reference give the refusal text of each rule.

## Read next

- [Cut a Worktree](../guides/cut-a-worktree.md)
- [Look inside a Sandbox](../guides/look-inside-a-sandbox.md)
- [Add tools to the Sandbox](../guides/add-tools-to-the-sandbox.md)
- [Size a Workspace](../guides/size-a-workspace.md)
- [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md)
- [Effects](effects.md), [Composition](composition.md), [Architecture](architecture.md)
- Reference: [`workspace`](../reference/authoring-surface/workspace.md),
  [`worktree`](../reference/authoring-surface/worktree.md),
  [`RepoSlot`](../reference/authoring-surface/type-reposlot.md), [`Size`](../reference/authoring-surface/type-size.md),
  [`UserContainer`](../reference/authoring-surface/type-usercontainer.md),
  [`workspace.lost`](../reference/mechanism-events.md#workspace-lost), [`sandbox`](../reference/config.md#sandbox)
- [ADR-0012](../reference/decisions/0012-workspace-wrapper-machine.md): `workspace()` wraps a body Machine and owns only
  Sandbox lifecycle
- [ADR-0075](../reference/decisions/0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md): a Machine cuts a
  Worktree, and the Workspace only clones
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): a Repo is a slot
  on the `workspace()` and a cache on the node
- [ADR-0053](../reference/decisions/0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md): a
  fetch inside the pod, and a large file, ask the node cache
- [ADR-0060](../reference/decisions/0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md): a Workspace states
  its Size, and jr2 reserves all of it
- [ADR-0064](../reference/decisions/0064-a-workspace-waits-for-capacity.md): a Workspace waits for capacity
- [ADR-0021](../reference/decisions/0021-workspace-continuity-is-a-lease-that-answers-back.md): Workspace Continuity is
  watched, and the Lease asserts
- [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md) and
  [ADR-0037](../reference/decisions/0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md): the pod, and
  the Sandbox Image
