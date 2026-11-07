---
title: Cut a Worktree
description: Make a Worktree with worktree(), choose what a cut refuses, and remove a Worktree.
---

Make each [Worktree](../reference/glossary.md#worktree) that your [Machine](../reference/glossary.md#machine) needs,
with the [`worktree()`](../reference/authoring-surface/worktree.md) [Effect](../reference/glossary.md#effect).

A [Workspace](../reference/glossary.md#workspace) only clones each [Repo](../reference/glossary.md#repo). The body of
the Workspace does a [Cut](../reference/glossary.md#cut) of each Worktree in a state of its own. In this
[Workflow](../reference/glossary.md#workflow), a coder [Agent](../reference/glossary.md#agent) works on a new branch. A
reviewer reads the coder's commit in a second Worktree, with no branch. Then the Machine removes the review Worktree,
and pushes the commit that the reviewer read. Save the file as `workflows/fix-a-bug.ts` in your
[Instance](../reference/glossary.md#instance):

::: tabs key:provider

== Anthropic

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts

== Local

<<< @/examples/guides/cut-a-worktree/local/fix-a-bug.ts

:::

Write your GitHub user name in place of `<you>`. The Agents use the model of the tab.
[Push and sign a branch](push-and-sign-a-branch.md) tells how to give the push a credential.

## Name the path

The path of a Worktree is exactly `/work/<slot>/<name>`. `<slot>` is a [Repo Slot](../reference/glossary.md#repo-slot).
`<name>` is one folder name that you choose. It is not `default`, and it starts with neither `.` nor `-`. It does not
change with the name of the branch.

Make the path from `context.workspace.repos`, and add `as const`. Then the compiler can read the slot, and it refuses a
slot that the Workspace does not have:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#paths

The check of the compiler is a help. It sees only a literal path under `jr2Setup`. jr2 also checks each path when the
run gets to it.

## Cut a branch

Invoke the Effect with `{ path, branch }`. `branch` is required, unless you give `detach`. The Machine names the branch,
so jr2 never reads it from the folder or from `HEAD`.

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#cutting

The cut fetches, then finds the branch in this order:

1. A local branch.
2. `origin/<branch>`. The new local branch tracks it.
3. A new branch, with no upstream. It starts from `from`, or from the base of the
   [Binding](../reference/glossary.md#binding) when the input has no `from`.

The output is `ready`, `refused` or `unknown`. Each Effect outcome is open, so give the last arm of `onDone` no guard.
[`isReady`](../reference/authoring-surface/isready.md) is the guard for `ready`.

| The field of `ready` | What it holds                                                                |
| -------------------- | ---------------------------------------------------------------------------- |
| `slot`, `path`       | The Repo Slot and the path of the Worktree.                                  |
| `branch`             | The branch of the cut, or `null` for a detached cut.                         |
| `head`               | The tip of the branch, or the commit of a detached cut. It is never `HEAD`.  |
| `found`              | How the cut found it: `local`, `remote`, `none`, `held` or `commit`.         |
| `stale`              | The warning of git when the fetch failed. The cut used what the clone holds. |

`held` means that a cut made this path before, so the Worktree holds earlier work. No fetch happens, and the cut does
not check `expect` again. Thus a cut of the same path also reads a Worktree:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#reading

[`readyOf`](../reference/authoring-surface/readyof.md) gives the `ready` output to an action, because xstate does not
carry the guard to the action.

## Choose what a cut refuses

`expect` says if the branch can exist. It is an option of `worktree()`, so a run cannot change it:

- `worktree()`: use a local branch, then a branch of the remote, then make a new branch.
- `worktree({ expect: "new" })`: refuse a branch that exists, local or on the remote. Use it for a name that a planner
  or a run input chooses for new work. A name that collides is then a refusal, and not the branch of a different person.
- `worktree({ expect: "existing" })`: refuse a branch that does not exist, and make nothing. Use it when a run must
  continue a branch that exists.

The example gives the coder a new branch for each run:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#cuts

A pick param or a run input that names a branch can use the schema
[`branchName`](../reference/authoring-surface/branchname.md). It is the rule of the cut and of the push. Thus jr2
refuses a bad name at the [Menu](../reference/glossary.md#menu) or at the door, before the cut.

## Read a commit with no branch

Invoke the Effect with `{ path, detach }` to hold one commit, with no branch. The example gives this Worktree to a
reviewer. Each cut forces the folder to the commit, and cleans it. Files that the commit's own `.gitignore` ignores
stay, so that a reviewer can run the tests. A `.gitignore` or `.gitattributes` that an Agent wrote goes first, so it
keeps nothing and changes no byte. A folder that ignores itself (a Python `.venv`) goes too, unless the commit's
`.gitignore` ignores it. An ignored `AGENTS.md`, `CLAUDE.md` or skill goes, so that the reviewer's system prompt has
only what the commit has. A git config, an ignore rule or an index that an Agent wrote does not change the files that
the cut writes:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#detaching

`expect` applies only to a branch. A slot with `expect` can thus also make a detached cut, as `cut` does here. A cut
that you lend to a [Chart](../reference/glossary.md#chart) must state `expect`, so a Chart uses such a slot too.

## Give the Worktree to each step

Each step names its Worktree by its path:

| The step                                | The key of its input |
| --------------------------------------- | -------------------- |
| A [Turn](../reference/glossary.md#turn) | `cwd`                |
| A `command`                             | `worktree`           |
| A `push`                                | `worktree`           |
| An `http` Effect with a file            | `worktree`           |

Each key is required under Repo Slots. A Turn that wants the folder above the Repo Slots states `cwd: "/work"`. To read
a slot that has no Worktree, use `/work/<slot>/default`. A Workspace with no Repo Slot, and an Agent with
`workspace: "none"`, need no `cwd`.

A Turn of a Working Agent that names a path where no Worktree exists does not start. The
[Harness](../reference/glossary.md#harness) refuses it, and the Machine gets `agent.fault` with
``the Turn's `cwd` <path> does not exist: cut the Worktree first``.

A `push` has no branch in its input. jr2 finds the cut of that path, and reads the branch there. An Agent can move
`HEAD`, and it cannot change that record:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#publishing

## Run more than one coder

The author chooses how many Agents work in a Workspace. Agents in one Worktree share git, as people in one checkout do.
Give each coder that needs its own branch a Worktree of its own, with its own path and its own branch. Each Worktree
uses the one clone. To merge the branches, cut a Worktree for the merge target, and run `git merge` in a `command`
there. No fetch is necessary, because each branch is in the clone. Then push once.

Cuts of one clone wait for each other, so they do not collide.

## Remove a Worktree

jr2 has no Effect that removes a Worktree. To remove one, run `git worktree remove` in a `command`:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#remove

Invoke the `command` in a different Worktree. The clone is always there, so the example names it:

<<< @/examples/guides/cut-a-worktree/anthropic/fix-a-bug.ts#removing

- The branch stays. Only the folder goes.
- A Worktree with changes or with untracked files stays too, and git exits with a code that is not 0. Route on `exited`
  to see it, or add `--force` to the argv to drop those changes. Ignored files do not stop the removal.
- jr2 keeps its record of the cut. A cut of the same path and the same branch makes the folder again. Its `found` is
  `local`. A detached cut makes the folder again too.
- jr2 deletes each Worktree with the [Sandbox](../reference/glossary.md#sandbox). Thus a Machine needs this recipe only
  to free the disk during a run.

## Rules

These settle as `refused`, and nothing changes. Route them to your last arm:

- a path that is not a Worktree path: `"<path>" is not a Worktree path: /work/<slot>/<name>, with one segment in <name>`
- the path of the clone: `"<path>" is the clone: it stays as the attach left it; cut a sibling`
- a name that starts with `.` or `-`: `"<path>": a Worktree's name starts with neither . nor -`
- a slot that the Workspace does not have:
  `"<path>" names Repo Slot "<slot>", which its Workspace does not carry (<slots>)`
- no branch and no commit, or both: ``a cut names a branch, or a commit in `detach` ``
- `from` on a detached cut: ``a detached cut takes no `from` ``
- `expect: "new"` on a branch that exists: `<branch> exists, and this cut makes only a new branch`
- `expect: "existing"` on a branch that does not exist: `<branch> does not exist, and this cut makes nothing`
- a re-cut that does not agree with the first cut: `<path> was cut for <branch>, not <other>`,
  `<path> was cut detached, not for <branch>`, or `<path> was cut from <from>, not <other>`
- a folder that no cut made: `<path> is a folder and no Worktree: a cut removes nothing it did not make`
- a detached cut of a Worktree that no cut made:
  `<path> is a Worktree no cut made, and a detached cut forces only its own`
- a commit that the clone does not hold, also after a fetch: `no commit "<sha>" in this clone`
- a branch that `default/` or a different Worktree holds: `<path> holds <branch>: read it there, or cut another branch`
- a name that the clone does not hold, after a fetch that failed:
  `<branch> is not in this clone, and the remote did not answer, so it may exist there: <warning>`
- a `from` on a branch that exists:
  ``<branch> exists, and it is not at `from` "<from>": `from` starts a new branch and moves no branch``

A name that git or the push refuses also settles `refused`. The `reason` says why, for example
`"<name>" is not a branch name`.

These are not `refused`, because no word of a run can cause them:

- `createMachine` refuses an Effect's `onDone` with a guard on its last arm:
  `machine "<id>": state "<state>" (Effect "<slot>") has an onDone with no unguarded last arm — … (ADR-0075)`
- `jr2 up` refuses a `worktree()` in a Workspace with no Repo Slot:
  `workflow "<workflow>": worktree "<slot>" runs in Workspace of workflow "<workflow>", which has no Repo Slot: a cut makes a Worktree of a Repo Slot, and there is none — declare one: repos: { app: "<url>" } (ADR-0075)`
- when a `worktree()` starts, it refuses the same Workspace:
  `worktree "<slot>" runs under a Workspace with no Repo Slot: a cut makes a Worktree of a Repo Slot, and there is none — declare one: repos: { app: "<url>" } (ADR-0075)`
- a Repo Slot name that starts with `.`, because `/work/.jr2/` is reserved for jr2. See
  [Bind a shipped Machine's Open parts](bind-open-parts.md).

## Read next

- [Workspaces](../concepts/workspaces.md): the clone, the folders, and what names a Worktree.
- [Effects](../concepts/effects.md): where a cut runs, and what a restart does to it.
- [Push and sign a branch](push-and-sign-a-branch.md): the `push` Effect.
- [Set an Agent's access and Dials](set-an-agents-access-and-dials.md): a reviewer in a detached Worktree.
- [Let an Agent write a Chart](let-an-agent-write-a-chart.md): a cut that you lend to a Chart.
- Reference: [`worktree`](../reference/authoring-surface/worktree.md),
  [`WorktreeOptions`](../reference/authoring-surface/type-worktreeoptions.md),
  [`WorktreeInput`](../reference/authoring-surface/type-worktreeinput.md),
  [`WorktreeOutput`](../reference/authoring-surface/type-worktreeoutput.md) and
  [`branchName`](../reference/authoring-surface/branchname.md).
- [ADR-0075](../reference/decisions/0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md): a Machine cuts a
  Worktree, and the Workspace only clones.
