---
title: Look inside a Sandbox
description: Open a shell in the Sandbox of a run, and read the branch that its Agent works on.
---

Open a shell in the [Sandbox](../reference/glossary.md#sandbox) of a run, and read the branch that its
[Agent](../reference/glossary.md#agent) works on.

A [Workspace](../reference/glossary.md#workspace) of the run makes the Sandbox, and deletes it when the body of the
Workspace gets to its final state. The [Rules](#rules) give the cases in which the Sandbox stays. The Sandbox is a pod.
Its `harness` container runs the [Harness](../reference/glossary.md#harness), and the Agent's
[Working tools](../reference/glossary.md#working-tools) run in it. When you use `kubectl exec`, you get a shell in the
same container. An Agent that has only the [Menu](../reference/glossary.md#menu) has no Sandbox. To read its
conversation, see [Watch a run](watch-a-run.md).

In the commands on this page, replace these values:

- `<namespace>`: the namespace of your [Instance](../reference/glossary.md#instance). It is the
  [`name`](../reference/config.md#name) in `jr2.config.ts`. When `jr2.config.ts` sets no `name`, it is the name of the
  Instance folder.
- `<run id>`: the full run id. [`jr2 run`](../reference/cli.md#run) prints it in the line
  `run <run id> (<workflow>) — attached`. [`jr2 runs`](../reference/cli.md#runs) prints the `runId` of each live run. A
  prefix does not work here, because `kubectl` does not know the run ids.

Give each `jr2` command in the Instance folder.

## Find the Sandbox

The label `jr2.dev/run` on each Sandbox holds the full id of its run:

```sh
kubectl -n <namespace> get sandboxes -l jr2.dev/run=<run id>
```

<!-- output: not run -->

```text
NAME        PHASE   ENDPOINT                                AGE
<sandbox>   Ready   http://<sandbox>.<namespace>.svc:8080   3m
```

- `<sandbox>` is the name of the Sandbox. It starts with `ws-`, then the first 8 characters of the run id. The pod has
  the same name.
- A run that has two Workspaces at the same time has two rows.
- `PHASE` is `Pending` until the pod is ready and its node has a fresh cache of each Repo. Then it is `Ready`. It is
  `Lost` when the pod is gone, and a `Lost` Sandbox does not get a new pod. A delete removes the Sandbox at once, so you
  seldom see the phase `Terminating`.
- When the run has no Sandbox now, `kubectl` prints `No resources found in <namespace> namespace.`
- When a [Workflow](../reference/glossary.md#workflow) puts `branch` and `worktree` in the `meta` of a
  [Gate](../reference/glossary.md#gate), as the `review` Gate of [`task`](../reference/machines.md#task) does,
  [`jr2 status <run id>`](../reference/cli.md#status) prints them in `gates`. Give this command on your computer, not in
  the Sandbox. Then you can copy the Worktree from the status.

## Open a shell

```sh
kubectl -n <namespace> exec -it <sandbox> -c harness -- bash
```

The default [Sandbox Image](../reference/glossary.md#sandbox-image) that [`jr2 init`](../reference/cli.md#init) writes
starts from `node:24-slim`, which has `bash`. If your Sandbox Image has no `bash`, use `sh`.

## Find the Worktree

Each [Repo Slot](../reference/glossary.md#repo-slot) of the Workspace has a folder in `/work`. In it, `default` is a
clone of the [Repo](../reference/glossary.md#repo), and the [Worktree](../reference/glossary.md#worktree) of the branch
is beside it. To show the folders of the Repo Slots, use this command:

```sh
ls /work
```

Replace `<Repo Slot>` with the name of a slot, such as `target`:

```sh
git -C /work/<Repo Slot>/default worktree list
```

<!-- output: not run -->

```text
/work/<Repo Slot>/default     <commit> [<default branch>]
/work/<Repo Slot>/<worktree>  <commit> [<branch>]
```

- `<branch>` is the name of the branch. `<worktree>` is the folder of its Worktree: the name of the branch, with each
  `/` changed to `-`. For example, the branch `jr2/task-<instance id>` has the Worktree
  `/work/target/jr2-task-<instance id>`.
- A Workspace that has a commit to review has one more Worktree, `/work/<Repo Slot>/<worktree>-review`. It holds that
  commit, with no branch.
- The attach makes the folders and the Worktrees after the Sandbox is `Ready`. Until then, `/work` has no folder for the
  Repo Slot.

## Read the branch

Go into the Worktree:

```sh
cd /work/<Repo Slot>/<worktree>
```

Show the files that the Agent changed and did not commit:

```sh
git status
```

Show the commits of the branch, newest first. The history of its base comes after them:

```sh
git log --oneline
```

Show the changes in the last commit:

```sh
git show --stat HEAD
```

You can also give one command, with no shell:

```sh
kubectl -n <namespace> exec <sandbox> -c harness -- git -C /work/<Repo Slot>/<worktree> log --oneline
```

## Push the branch

The Agent has no credential to push with. To keep its commits after the Sandbox goes, push the branch from the Worktree.
Replace `<branch>` with the name of the branch:

```sh
git push origin <branch>
```

`origin` fetches through the [Repo cache](../concepts/architecture.md#the-repo-cache) of the node, and pushes to the
Repo. When the Repo url starts with `https://`, `git push` asks for a user name and a password. Give your user name.
Give a token that can push to the Repo as the password.

A [Machine](../reference/glossary.md#machine) can also push the branch with an
[Effect](../reference/glossary.md#effect). See [Push and sign a branch](push-and-sign-a-branch.md).

:::caution

The Agent works in the same files as your shell, so it sees each change that you make there. When the Sandbox goes, a
commit that you did not push goes with it.

:::

## Rules

- The Workspace deletes its Sandbox when its body gets to its final state. When the body of each Workspace of the run
  has got to its final state, no Sandbox has the label of the run.
- A Workspace that its parent stops after Placing, for example with an `after` on the state that holds it, does not
  delete its Sandbox. The [operator](../concepts/architecture.md#the-operator) deletes it 30 minutes after the last
  renewal of its [Lease](../reference/glossary.md#lease).
- [`jr2 send`](../reference/cli.md#send) `<run id> --event CANCEL` deletes the Sandboxes of the run. To keep them, add
  `--keep`. See [Cancel a run](cancel-a-run.md).
- A run that faults keeps its Sandboxes. After a fault, and after a CANCEL with `--keep`, nothing renews the Lease of
  its Workspace. The operator deletes the Sandbox 30 minutes after the last renewal.
- A Workspace in [Placing](../reference/glossary.md#placing) deletes its Sandbox at once, also after a fault and after a
  CANCEL with `--keep`. Its Sandbox has no node yet, so it has nothing to look inside.

## Read next

- [Workspaces](../concepts/workspaces.md)
- [ADR-0004](../reference/decisions/0004-worktree-provisioning-model.md): the clone and the Worktree.
- [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md): the containers of a Sandbox.
- [ADR-0012](../reference/decisions/0012-workspace-wrapper-machine.md): when a Workspace deletes its Sandbox.
- [Watch a run](watch-a-run.md)
