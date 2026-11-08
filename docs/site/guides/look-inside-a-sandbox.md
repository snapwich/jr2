---
title: Look inside a Sandbox
description: Open a shell in the Sandbox of a run, and read the branch that its Agent works on.
---

Open a shell in the [Sandbox](../reference/glossary.md#sandbox) of a run, and read the branch that its
[Agent](../reference/glossary.md#agent) works on.

A [Workspace](../reference/glossary.md#workspace) of the run makes the Sandbox, and deletes it when the body of the
Workspace gets to its final state or fails. The [Rules](#rules) give the cases in which the Sandbox stays. The Sandbox
is a pod. Its `harness` container runs the [Harness](../reference/glossary.md#harness), and the Agent's
[Working tools](../reference/glossary.md#working-tools) run in it. `jr2 workspace shell` gives you a shell in the same
container, as the Agent's tools run. An Agent that has only the [Menu](../reference/glossary.md#menu) has no Sandbox. To
read what an Agent said and did, see [Read a conversation](read-a-conversation.md).

In the commands on this page, replace `<run id>` with the run id, or its first 4 characters or more.
[`jr2 run`](../reference/cli.md#run) prints it in the line `run <run id> (<workflow>) — attached`.
[`jr2 runs`](../reference/cli.md#runs) prints the `runId` of each live run.

Give each `jr2` command in the [Instance](../reference/glossary.md#instance) folder. The `jr2 workspace` commands read
the Sandbox resources from the cluster with your kubectl credentials. They do not use the
[Orchestrator](../reference/glossary.md#orchestrator), so they also work when the Orchestrator is down.

## Find the Sandbox

Run [`jr2 workspace ls`](../reference/cli.md#workspace-ls) with the run id. Without a run id, it lists each Workspace of
the Instance:

```sh
jr2 workspace ls <run id>
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
WORKSPACE     SANDBOX                       WORKFLOW  PHASE  AGE  RUN
7a0e8b50/x:0  ws-7a0e8b50-x-0-b35f14dc370a  task      Ready  32s  held
```

- `WORKSPACE` is the handle of the Workspace: the first 8 characters of the run id, then the path of the Workspace in
  the run. In the commands below, write it in place of `<workspace>`. You can also give the name of the Sandbox, or the
  first characters of the run id, then `/` and the path.
- `SANDBOX` is the name of the Sandbox, here `ws-7a0e8b50-x-0-b35f14dc370a`. Your name is different. The pod has the
  same name.
- A run that has two Workspaces at the same time has two rows.
- `PHASE` is `Pending` until the pod is ready and its node has a fresh cache of each
  [Repo](../reference/glossary.md#repo). Then it is `Ready`. It is `Lost` when the pod is gone, and a `Lost` Sandbox
  does not get a new pod. A delete removes the Sandbox at once, so you seldom see the phase `Terminating`.
- `RUN` tells if a run holds the Sandbox. `held`: a run holds it, or an Orchestrator that stopped held it. `released`:
  its run does not hold it now. `idle`: nothing renewed its [Lease](../reference/glossary.md#lease) for its idle time.
  `unknown`: the Sandbox has no mark.
- When the run has no Sandbox now, the table has only its header.
- `--json` prints the list as one JSON object.
- [`jr2 status <run id>`](../reference/cli.md#status) prints each [Worktree](../reference/glossary.md#worktree) that the
  run cut, with its path and its branch, in `worktrees` and in one `worktree:` line for each cut. Give this command on
  your computer, not in the Sandbox.
- When a [Workflow](../reference/glossary.md#workflow) puts `branch` and `worktree` in the `meta` of a
  [Gate](../reference/glossary.md#gate), as the `review` Gate of [`task`](../reference/machines.md#task) does,
  `jr2 status <run id>` prints them in `gates` too.

## Open a shell

Run [`jr2 workspace shell`](../reference/cli.md#workspace-shell) with the handle:

```sh
jr2 workspace shell <workspace>
```

`jr2 completion bash|zsh|fish` completes the handles; see [`jr2 completion`](../reference/cli.md#completion).

The shell runs as the Agent's tools run. The Harness starts it in the same Landlock domain as the Agents, in `/work`.
Thus it has the same files, the same limits and the same [Stand-ins](../reference/glossary.md#stand-in) as an Agent's
`bash`, and it cannot read the credential with which the Harness speaks for the Agents. It can see and stop a process
that an Agent started, such as a dev server. The shell is `bash`, or `sh` when the image has no `bash`. The default
[Sandbox Image](../reference/glossary.md#sandbox-image) that [`jr2 init`](../reference/cli.md#init) writes starts from
`node:24-slim`, which has `bash`.

To run one command and not a shell, give it after `--`:

```sh
jr2 workspace shell <workspace> -- git -C /work status
```

A command after `--` has no terminal. Ctrl-C stops `jr2`, and the command gets the end of its input but no signal. Thus
a command that does not stop at the end of its input, such as a dev server, can continue to run.

When the Workspace has a [User Container](../reference/glossary.md#user-container), add `--user` to open a shell in it.
[Add tools to the Sandbox](add-tools-to-the-sandbox.md#run-a-service-beside-the-agent) tells how to reach a service in
it.

## Find the Worktree

Each [Repo Slot](../reference/glossary.md#repo-slot) of the Workspace has a folder in `/work`. In it, `default` is a
clone of the Repo, and each [Worktree](../reference/glossary.md#worktree) that the Machine cut is beside it. To show the
folders of the Repo Slots, use this command:

```sh
ls /work
```

Replace `<Repo Slot>` with the name of a slot, such as `target`:

```sh
git -C /work/<Repo Slot>/default worktree list
```

For the slot `target` of a run of `task`, the output is:

```text
/work/target/default  9f67321f (detached HEAD)
/work/target/task     9f67321f [jr2/task-48ebf9ad-1e5d-4997-a330-d91ec762f83c]
```

The first line is the clone, on the base of the Repo Slot. Here the base is a tag, so the clone is detached. On a
branch, the line shows the branch. The second line is the Worktree that `task` cut. Your commits and your instance id
are different.

- In the commands below, `<branch>` is the name of the branch, and `<worktree>` is the name of the folder of its
  Worktree. Your Machine chooses each one. The name of the folder does not come from the branch. `task` names the folder
  `task`.
- A detached Worktree, such as the Worktree of a reviewer, shows `(detached HEAD)` in place of a branch.
- The attach makes the folders and the clones after the Sandbox is `Ready`. Until then, `/work` has no folder for the
  Repo Slot. The Machine cuts each Worktree in a state of its body. See [Cut a Worktree](cut-a-worktree.md).

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
jr2 workspace shell <workspace> -- git -C /work/<Repo Slot>/<worktree> log --oneline
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

When the Repo keeps its large files with Git LFS, `git push` also uploads the large files of the branch to the LFS
server. The upload uses your credential, not a credential of jr2. git-lfs can ask for your user name and token again.

A [Machine](../reference/glossary.md#machine) can also push the branch with an
[Effect](../reference/glossary.md#effect). See [Push and sign a branch](push-and-sign-a-branch.md).

::: warning

The Agent works in the same files as your shell, so it sees each change that you make there. When the Sandbox goes, a
commit that you did not push goes with it.

:::

## Remove a Sandbox that no run holds

A Sandbox that a cancel with `--keep` or a fault left stays until the operator deletes it. To delete it before then, run
[`jr2 workspace rm`](../reference/cli.md#workspace-rm):

```sh
jr2 workspace rm <workspace>
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
removed Workspace 7a0e8b50/x:0 (ws-7a0e8b50-x-0-b35f14dc370a)
```

`jr2 workspace rm` removes only a Sandbox that `jr2 workspace ls` shows as `released` or `idle`. To remove the Sandbox
of a live run, cancel the run. See [Cancel a run](cancel-a-run.md).

## Rules

- The Workspace deletes its Sandbox when its body gets to its final state. When the body of each Workspace of the run
  has got to its final state, no Sandbox has the label of the run.
- A run that a Machine fails deletes its Sandboxes, as a final state does. See
  [Fail the run](write-a-workflow.md#fail-the-run). To keep the work, wait at a [Gate](../reference/glossary.md#gate)
  before the state that fails.
- A Workspace that its parent stops after Placing, for example with an `after` on the state that holds it, does not
  delete its Sandbox. The [operator](../concepts/architecture.md#the-operator) deletes it 30 minutes after the last
  renewal of its [Lease](../reference/glossary.md#lease).
- [`jr2 send`](../reference/cli.md#send) `<run id> --event CANCEL` deletes the Sandboxes of the run. To keep them, add
  `--keep`. See [Cancel a run](cancel-a-run.md).
- A run that faults keeps its Sandboxes. After a fault, and after a CANCEL with `--keep`, nothing renews the Lease of
  its Workspace. The operator deletes the Sandbox 30 minutes after the last renewal.
- A Workspace in [Placing](../reference/glossary.md#placing) deletes its Sandbox at once, also after a fault and after a
  CANCEL with `--keep`. Its Sandbox has no node yet, so it has nothing to look inside.
- The `jr2 workspace` commands need your kubectl credentials to list the Sandbox resources. Without them, the command
  says: `cannot list the Sandboxes in namespace <namespace>: <message>`
- With no kube context, the `jr2 workspace` commands say:
  ``no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up` ``
- A handle that names no Workspace is an error. The command exits with `1`:
  ``no Workspace "<handle>" — `jr2 workspace ls` lists them``
- A handle that names more than one Workspace is an error. The command lists each Workspace that it names, and exits
  with `1`: `"<handle>" names <n> Workspaces — give more of the run id:`
- `jr2 workspace rm` refuses the Sandbox of a live run, and exits with `1`. There is no option to force it:
  ``Workspace <handle> (<sandbox>) is not removed: run <run id> holds it — cancel the run first (`jr2 send <run id> --event CANCEL`)``
- `jr2 workspace rm` refuses a Sandbox with no hold mark (`RUN` is `unknown`), and exits with `1`:
  ``Workspace <handle> (<sandbox>) is not removed: it has no hold mark, so it may be held by run <run id> — cancel the run first (`jr2 send <run id> --event CANCEL`)``
- `jr2 workspace rm` refuses a Sandbox that a run started to hold again after `jr2 workspace rm` read it:
  ``Workspace <handle> (<sandbox>) is not removed: it changed after it was read, so a run may hold it again — run `jr2 workspace ls` and try again``
- `jr2 workspace shell --user` refuses a Workspace with no User Container, and exits with `1`:
  ``Workspace <handle> has no User Container: its workspace() names no `user` image``
- A refusal of the Harness starts with `jr2 workspace shell: `.
- `jr2 workspace shell` needs `bash` or `sh` on the `PATH` of the Sandbox Image. When it has neither, the command says:
  `jr2 workspace shell: the Sandbox Image has no bash and no sh on its PATH`
- `jr2 workspace shell --user` with no command needs `sh` in the image of the User Container. When it has none, the
  command says: `the User Container's image has no sh: give it a shell, or name a command after --`
- `jr2 workspace shell --user -- <command>` says this when the User Container cannot run the command (exit `126` or
  `127`): `the User Container could not run <command> (exit <code>)`

## Read next

- [Workspaces](../concepts/workspaces.md)
- [Cut a Worktree](cut-a-worktree.md)
- [ADR-0004](../reference/decisions/0004-worktree-provisioning-model.md): the clone and the Worktree.
- [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md): the containers of a Sandbox.
- [ADR-0012](../reference/decisions/0012-workspace-wrapper-machine.md): when a Workspace deletes its Sandbox.
- [ADR-0021](../reference/decisions/0021-workspace-continuity-is-a-lease-that-answers-back.md): the Lease, and when a
  run holds its Sandbox.
- [ADR-0076](../reference/decisions/0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md): why
  your shell runs in the domain of the Agents.
- [Watch a run](watch-a-run.md)
