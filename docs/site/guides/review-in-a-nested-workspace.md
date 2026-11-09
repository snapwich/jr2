---
title: Review in a nested Workspace
description: Give a commit to a final reviewer in a new Sandbox, as a Handoff, and publish the commit that it approved.
---

Run the final review of a commit in a new [Sandbox](../reference/glossary.md#sandbox), with a new
[Agent](../reference/glossary.md#agent) that sees only that commit.

The Sandbox is the security boundary. Inside one Sandbox, each Agent can change each file, each Worktree and each object
of the clone. Thus a coder and a reviewer in one [Workspace](../reference/glossary.md#workspace) are a quick loop, not
an independent review. For a review that you can trust, the body of the coder's Workspace invokes a nested
`workspace()`. The nested Workspace gets its own Sandbox and its own clone of the [Repo](../reference/glossary.md#repo).
The commit goes in as a [Handoff](../reference/glossary.md#handoff), and it enters the clone only at the
[Cut](../reference/glossary.md#cut) of the nested Workspace.

In this [Workflow](../reference/glossary.md#workflow), a coder fixes a bug. A final reviewer in a nested Workspace
reviews the commit. When it asks for changes, the coder works again, and a new nested Workspace reviews the new commit.
When it approves, the parent pushes the commit that it approved. Save the file as `workflows/fix-with-final-review.ts`
in your [Instance](../reference/glossary.md#instance):

::: tabs key:provider

== Anthropic

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts

== Local

<<< @/examples/guides/review-in-a-nested-workspace/local/final-review.ts

:::

Write your GitHub user name in place of `<you>`. The Agents use the model of the tab.
[Push and sign a branch](push-and-sign-a-branch.md) tells how to give the push a credential.

## Hand off a commit

A Handoff is the `ready` output of a cut in the parent: `{ slot, path, branch, head }`. To get the commit that the coder
made, cut the coder's Worktree again. A cut of the same path reads the Worktree, and `head` is the tip of the branch:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#reading

The Machine keeps the Handoff in its context. jr2 adds no Effect and no state for it.

## Take the Handoff at the cut

The door of the nested Workspace takes the Handoff as data. Use the schema
[`handoff`](../reference/authoring-surface/handoff.md) for its field:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#door

The parent invokes the nested Workspace as each other actor:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#actor

In the nested body, give the Handoff to [`worktree()`](../reference/authoring-surface/worktree.md) with
`{ path, handoff }`:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#cutting

The cut makes a branch Worktree at the commit of the Handoff:

- The branch has the name of the parent's branch. To use a different name, add `branch` to the input:
  `{ path, handoff, branch: "review/123" }`.
- The branch tracks `origin/<branch>` when the remote has that branch.
- `found` is `handoff`.
- The `expect` of the slot applies to the branch, as at a cut of a branch. With `worktree({ expect: "new" })`, a
  `branch` cannot name a branch that the remote has, so a push from the nested Workspace cannot go to it.

jr2 does not trust a field of a Handoff. A door can get its input from a pick or from a
[Chart](../reference/glossary.md#chart), and an Agent can write each field. Thus the cut finds the Handoff in the
records of the run, and it refuses a Handoff when one fact does not agree:

- A cut of the run made the commit at that path, in a Workspace that encloses the nested Workspace. A commit of an
  earlier cut of the path is also good.
- The branch of the Handoff is the branch of that cut.
- The Repo Slot holds the same Repo in the two Workspaces.

A Handoff of the nested Workspace's own cut, of a sibling Workspace or of a different run is refused. The refusal is the
output `refused`, as each other refusal of a cut. Route it on the last arm of `onDone`. In the example, the nested body
routes it to `fail()`.

A detached Handoff has no branch. Give it one with `branch`, or the cut refuses it.

## Run one nested Workspace for each round

Invoke a new nested Workspace for each round of the final review, with the newest Handoff. A cut of the same path with a
different Handoff is refused. Give the final reviewer what it must know of the earlier rounds through the door, as data.
The example gives the notes of each round:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#round

The parent and the nested Workspace end together. When the parent leaves the state that invoked it, jr2 stops the nested
Workspace and deletes its Sandbox.

Thus, between two rounds, the parent must leave the state that invokes the nested Workspace. In the example, the parent
goes back to `coding`. Do not invoke the next round from the same state in one transition (for example with
`reenter: true`). Then the new nested Workspace gets the Sandbox of the last one: its cut with the new Handoff is
refused, and its cut with the same Handoff gives the Worktree of the last round, with the commits of the last reviewer.

## Publish the reviewed commit

`push({ pin: true })` with `sha: handoff.head` pushes exactly the commit that the final reviewer approved, also when the
coder made more commits after it:

<<< @/examples/guides/review-in-a-nested-workspace/anthropic/final-review.ts#publishing

You choose where to publish. The nested Workspace can also push its own Worktree: `push` is available in each Workspace.

## What the final reviewer sees

The final reviewer does not need to know jr2. In the nested Sandbox, git looks ordinary:

- `/work/<slot>/default` is a clone of the Repo. `origin` is the real remote, and `git remote -v` shows only `origin`.
- The Worktree holds a local branch, at the commit of the Handoff, with the name of the parent's branch.
- `git log` shows the commits of the parent's Agents, with their authors and their messages.
- Only the commit and its ancestors enter the clone. The other branches, files and caches of the parent's Sandbox stay
  there.
- The git of the final reviewer has `safe.bareRepository=explicit`, as each Agent's git has. Thus a bare repository that
  the commit holds starts no program of its config when the reviewer runs git in its folder (see
  [What the image must have](add-tools-to-the-sandbox.md#what-the-image-must-have)). A test suite that runs git in a
  bare repository by its folder fails for the same reason: give `--git-dir` there, or see that page for how to turn the
  setting off.

The final reviewer can run the tests of the commit in its own Sandbox.

## Rules

These settle as `refused`, and nothing changes. `<handoff>` is `the Handoff of <path> at <head>`:

- no cut of the run made that commit at that path: `<handoff>: no ready cut of this run made that commit at that path`
- the nested Workspace's own cut made it:
  `<handoff>: this nested Workspace's own cut made it, and a Handoff comes from an enclosing Workspace`
- a Workspace that does not enclose this one made it:
  `<handoff>: a Workspace that does not enclose this one made it, and a Handoff comes from an enclosing Workspace`
- the slot of the Handoff is not the slot of the cut: `<handoff>: the cut made it in Repo Slot "<slot>", not "<other>"`
- the two Repo Slots hold different Repos:
  `<handoff>: Repo Slot "<slot>" of the enclosing Workspace holds <url>, and Repo Slot "<slot>" here holds <url>: a Handoff stays in one Repo`
- the branch of the Handoff is not the branch of the cut: `<handoff>: the cut made it on <branch>, not on <other>`
- a detached Handoff with no `branch`:
  `<handoff>: the Handoff is detached, so the cut names the branch: { path, handoff, branch }`
- a value that is not a Handoff: ``a cut's `handoff` is a Handoff, { slot, path, branch, head }: <field>: <why>``
- `from` or `detach` beside `handoff`: ``a cut at a Handoff takes no `from`: the Handoff's commit is the start`` or
  ``a cut at a Handoff takes no `detach`: it makes a branch``
- the clone does not hold the commit: `this clone does not hold the Handoff's commit <head>`
- a local branch of that name at a different commit:
  `the branch <branch> of this clone is at <sha>, not at the Handoff's commit <head>`
- a different Worktree holds the branch: `<holder> holds <branch>: a cut at a Handoff makes its own Worktree`
- a folder that no cut made: `<path> is a folder that no cut made, and a cut at a Handoff makes its own Worktree`
- a re-cut with a different Handoff, which occurs when the parent invoked the round from the same state:
  `<path> was cut at the Handoff <head>, not <other>: this Sandbox takes one Handoff, and a nested Workspace that its parent invokes again before it leaves the invoking state takes over the Sandbox of the last one`
- `expect: "new"` on a branch that exists: `<branch> exists, and this cut makes only a new branch`
- `expect: "existing"` on a branch that does not exist: `<branch> does not exist, and this cut makes nothing`
- with `expect: "new"`, a fetch that failed for a branch that the clone does not hold:
  `<branch> is not in this clone, and the remote did not answer, so it may exist there: <warning>`
- a re-cut with no Handoff: `<path> was cut at the Handoff <head>, and a re-cut names that Handoff`
- a Handoff at a path that a different cut made: `<path> was cut for <branch>, not at a Handoff`
- the parent's clone does not hold the commit: `<handoff>: the parent's clone does not hold the commit <head>`
- the bundle step passed its deadline, for example at a FIFO in the parent's clone:
  `<handoff>: the bundle step passed its deadline of 300 s`
- the bundle is not a regular file: `<handoff>: the bundle is not a regular file`
- the bundle and its Git LFS objects pass the bound of 1 GiB:
  `<handoff>: the Handoff's files are <n> bytes (the bundle and <k> Git LFS objects), more than the bound of 1073741824 bytes`
  or `<handoff>: the Handoff's files pass the bound of 1073741824 bytes` or
  `<handoff>: its files pass the bound of 1 GiB`
- more than 100 000 Git LFS objects:
  `<handoff>: the Handoff's files hold <k> Git LFS objects, more than the bound of 100000` or
  `<handoff>: the Handoff's files hold more than 100000 Git LFS objects` or
  `<handoff>: its files hold more than 100000 Git LFS objects`
- git in the parent's clone fails, for example:
  `<handoff>: the parent's clone's remote-tracking refs could not be read: <git's words>`
- the nested Workspace's clone does not hold a commit that the bundle builds on, for example because the remote was
  force-pushed after the parent fetched:
  `this clone does not hold the commit <sha>, which the Handoff's bundle builds on: the remote may have lost it (a force push) after the parent fetched`.
  When the remote did not answer the cut's fetch:
  `this clone does not hold the commit <sha>, which the Handoff's bundle builds on, and the remote did not answer, so it may hold it: <git's words>`
- git's fsck refuses an object of the handed-off commits:
  `git refused the Handoff's commit <head>: error: <git's words>`
- the bundle that came has a ref that is not at the commit, or more than one ref:
  `the ref of the Handoff's bundle is at <sha>, not at <head>` or
  `the Handoff's bundle has <n> refs, and a Handoff's bundle has one`
- the files that came are not a bundle: `the Handoff's bundle cannot be read: <git's words>` or
  `the Handoff's bundle is not a regular file`

A Git LFS object that came with the Handoff goes into the nested Workspace's clone only when a pointer of the handed-off
commits names it and its sha256 is its oid. The cut leaves out each other object, and asks the node cache for each large
file that it still does not have. When the cache cannot get one, the cut is `refused`, and the reason names the file.

These settle as `unknown`, and the Machine can cut again. The reason is
`the files of the Handoff were not carried: <why>`:

- the Workspace that made the Handoff does not run: `the Workspace <sandbox> that made it is not running`
- the parent's Harness does not answer: `the source Harness (<sandbox>) did not answer: <error>`
- the parent's Harness answers with an error: `the source Harness (<sandbox>) answered <status>: <error>`
- the parent's Harness cannot run the bundle step: `the source Harness: <why>`
- the stream from the parent's Harness breaks, for example: `the source Harness's answer ended before its last frame` or
  `the source Harness's stream broke: <error>`
- the nested Workspace's Harness does not take the files: `the child's Harness (<sandbox>) did not take them: <error>`,
  `the child's Harness (<sandbox>) answered <status>: <error>` or
  `the child's Harness (<sandbox>) answered <status> before it took them all: <error>`
- the carry passed its own time (the bound at 1 MiB/s, and one idle wait of 360 s; the cut's `timeout` does not include
  the carry): `the carry passed its time of 1384 s`

Each cut at a Handoff carries the files first, also a re-cut with the same Handoff, which gives the held Worktree. So
such a re-cut settles `refused` or `unknown` too when its carry does, for example when the parent's Harness does not
answer.

A Chart gives a Handoff as a reference, such as `"{{context.handoff}}"`. The door refuses a literal Handoff. A reference
that resolves to a value that is not a Handoff is the error of that invoke. A cut that you lend to a Chart must state
`expect`, as for each cut, and the door refuses `expect: "existing"` beside a lent force push.

## Read next

- [Workspaces](../concepts/workspaces.md#a-nested-workspace-and-a-handoff): a nested Workspace and a Handoff.
- [Cut a Worktree](cut-a-worktree.md): the cut, its outcomes and its rules.
- [Push and sign a branch](push-and-sign-a-branch.md): the `push` Effect and `pin`.
- [Set an Agent's access and Dials](set-an-agents-access-and-dials.md): the quick review in one Workspace.
- Reference: [`worktree`](../reference/authoring-surface/worktree.md),
  [`handoff`](../reference/authoring-surface/handoff.md) and
  [`Handoff`](../reference/authoring-surface/type-handoff.md).
- [ADR-0080](../reference/decisions/0080-a-nested-workspace-takes-a-handoff-at-its-cut.md): a nested Workspace takes a
  Handoff at its cut.
