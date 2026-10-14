---
title: An Agent in a Sandbox
description: A coder Agent fixes a bug in your fork of jr2, in a Sandbox. You push its branch, and approve.
---

At the end of this page, a coder [Agent](../reference/glossary.md#agent) has fixed a bug in your fork of jr2. The Agent
works in a [Sandbox](../reference/glossary.md#sandbox): a pod of its own, with a git checkout of your fork. You go into
the Sandbox and read the work. You ask for one more change, push the branch by hand, and approve the work.

## Before you start

- Do [A model decides](a-model-decides.md) first. Your [Instance](../reference/glossary.md#instance) `my-instance` has
  the model of your tab, and `kind-jr2` is the current kubectl context.
- You need a GitHub account.
- Open two terminals in `my-instance`. The first terminal shows the run. The second terminal sends commands to it.

## Fork jr2

The Agent works on a [Repo](../reference/glossary.md#repo) that you can push to, so you fork jr2. Your fork holds the
tutorial fixture, `docs/site/tutorial/greet/`. It is a small Node CLI with one bug, and its test `trims the name` fails.

1. Open `https://github.com/snapwich/jr2`.
2. Click **Fork**.
3. Clear **Copy the main branch only**, so that the fork gets the release tags.
4. Click **Create fork**.

Make sure that the fork has the release tag of your Kit. `<you>` is your GitHub user name. `<version>` is the
[Kit version](../reference/glossary.md#kit-version): the version of `@jr2/orchestrator` in `package.json`, such as
`0.3.0`.

1. Open `https://github.com/<you>/jr2/tags`.
2. Find the tag `v<version>`, such as `v0.3.0`.

If the page shows no tags, delete the fork. Fork again with **Copy the main branch only** cleared.

## Make a token for the fork

The Agent cannot push. You push its branch by hand, so you need a token for your fork. On GitHub, make a fine-grained
personal access token:

1. Click your profile picture, then **Settings**.
2. Click **Developer settings**, then **Personal access tokens**, then **Fine-grained tokens**.
3. Click **Generate new token**.
4. In **Repository access**, select **Only select repositories**.
5. Select `<you>/jr2`.
6. In **Permissions**, set **Contents** to **Read and write**.
7. Click **Generate token**.
8. Copy the token.

Keep the token in a safe place. You use it on this page and on the next page.

## Install @jr2/machines

The Kit ships [Machines](../reference/glossary.md#machine) in the package `@jr2/machines`. Install it at the Kit
version:

```sh
npm install --save-exact @jr2/machines@<version>
```

```text

added 1 package, and audited 15 packages in 266ms

3 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

Your numbers can be different.

## Write the Workflow

The shipped Machine [`task`](../reference/machines.md#task) gives one prompt to a coder Agent in a
[Workspace](../reference/glossary.md#workspace). Then the run waits at a [Gate](../reference/glossary.md#gate) named
`review`, until you approve the work. `task` puts the `review` Gate in its body, so the id of the Gate is `body.review`.

`task` cannot know your Repo, and it cannot pay for your model. Thus it leaves two parts
[Open](../reference/glossary.md#open): its [Repo Slots](../reference/glossary.md#repo-slot) and the model of its coder.
You bind the two with [`customize()`](../reference/authoring-surface.md#customize).

Make the file `workflows/task.ts`. Replace `<you>` and `<version>` in it:

::: tabs key:provider

== Anthropic

<<< @/examples/get-started/an-agent-in-a-sandbox/anthropic/task.ts

== Local

<<< @/examples/get-started/an-agent-in-a-sandbox/local/task.ts

:::

- `target` is the name of the Repo Slot. The coder works in the first Repo Slot.
- `ref` is the release tag. The branch of the Agent starts from it, so each reader of a release starts from the same
  fixture.
- The file name gives the [Workflow](../reference/glossary.md#workflow) its name: `task`.

## Converge the Instance

[`jr2 up`](../reference/cli.md#up) converges the Instance with the new Workflow:

```sh
jr2 up
```

<!-- output: not run -->

```text
…
converged — `jr2 run <workflow>` when ready
```

`task` is the first Workflow of the Instance that has a Workspace. Thus this `jr2 up` also builds the
[Sandbox Image](../reference/glossary.md#sandbox-image) from `images/default/Dockerfile`. If you did not bind an Open
part, `jr2 up` stops and prints the `customize()` line that binds it.

## Start the run

In the first terminal, start a run of `task` with [`jr2 run`](../reference/cli.md#run). The prompt tells the Agent what
to fix and how to check the fix:

```sh
jr2 run task --input '{"prompt":"In docs/site/tutorial/greet, one test fails. Fix the bug in docs/site/tutorial/greet/src/greet.js. To check your fix, run node --test in docs/site/tutorial/greet. Do not change files outside that folder. Do not run the tests of the repo root."}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run <run id> (task) — attached
…
```

The line `run <run id> (task) — attached` gives the run id. Your run id is different. Keep this terminal open. The run
does not end until you approve the work.

## Wait for the review Gate

The Sandbox starts, and the coder works. When the coder finishes, the run waits at the `review` Gate. In the second
terminal, read the status of the run with [`jr2 status`](../reference/cli.md#status). `<run id>` is the run id, or its
first 4 characters or more:

```sh
jr2 status <run id>
```

The status is one line of JSON. While the coder works, `gates` is `[]`. When the run waits at `review`, `gates` holds
the Gate. Its `gate` is `body.review`, and the line ends with its `meta`:

<!-- output: not run -->

```text
…"gate":"body.review",…,"meta":{"summary":"<summary>","branch":"jr2/task-<instance id>","worktree":"/work/target/jr2-task-<instance id>"}}]}
```

Run the command again until `gates` holds the Gate.

- `summary` is what the coder says that it did.
- `branch` is the branch that the coder commits on.
- `worktree` is the folder in the Sandbox that holds the branch. It is
  [the Worktree](../reference/glossary.md#worktree).

Copy `branch` and `worktree` from your output. `<instance id>` is the
[Instance ID](../reference/glossary.md#instance-id) of the run. `jr2 status` prints it as `instanceId`. It is not the
run id. Do not make the branch name from the run id. With the Instance token, the drawer of the
[Console](../reference/glossary.md#console) shows the same `meta`.

If `meta` has a `reason` and no `summary`, the [Turn](../reference/glossary.md#turn) of the coder failed. Send
`request_changes`, as in [Ask for a change](#ask-for-a-change), and the coder tries again.

## Find the Sandbox

The label `jr2.dev/run` on the Sandbox holds the full run id. A prefix does not work here. Copy the full run id from the
line `run <run id> (task) — attached` in the first terminal:

```sh
kubectl -n my-instance get sandboxes -l jr2.dev/run=<run id>
```

<!-- output: not run -->

```text
NAME        PHASE   ENDPOINT     AGE
<sandbox>   Ready   <endpoint>   <age>
```

`<sandbox>` is the name of the Sandbox. It starts with `ws-`. The pod of the Sandbox has the same name.

## Look inside the Sandbox

Go into the `harness` container of the pod. The Agent's tools run in this container:

```sh
kubectl -n my-instance exec -it <sandbox> -c harness -- bash
```

In the Sandbox, go to the fixture in the Worktree. Then run its tests. `<worktree>` is the `worktree` that you copied:

```sh
cd <worktree>/docs/site/tutorial/greet
node --test
```

<!-- output: not run -->

```text
✔ greets the world by default (0.931687ms)
✔ greets a name (0.130595ms)
✔ shouts (0.06902ms)
✔ trims the name (0.052087ms)
✔ prints help (0.222384ms)
✔ refuses an unknown flag (0.18563ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 47.044302
```

Your times are different. Read the commits of the coder. The branch starts at the release tag, so the commits after the
tag are the commits of the coder:

```sh
git log --oneline v<version>..HEAD
```

<!-- output: not run -->

```text
<commit id> <message>
```

Each line is one commit. The commit ids and the messages come from the model. Then leave the Sandbox:

```sh
exit
```

## Ask for a change

In the second terminal, send `request_changes` to the `review` Gate with [`jr2 send`](../reference/cli.md#send).
`--gate` takes the `gate` value from `jr2 status`. Put your notes in the input:

```sh
jr2 send <run id> --gate body.review --event request_changes --input '{"notes":"Also add a test that trims the name when you pass --shout."}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered request_changes to gate "body.review" on <run id>
```

The coder continues the same conversation, with your notes as its next prompt. The Sandbox and the branch stay. Run
`jr2 status <run id>` again until `gates` holds the `review` Gate. The new `summary` tells what the coder changed.

## Push the branch

`task` does not push, and the Agent has no credential to push with. While the run waits at `review`, you push the branch
from the Sandbox. Go into the Sandbox again:

```sh
kubectl -n my-instance exec -it <sandbox> -c harness -- bash
```

In the Sandbox, go to the Worktree. Then push the branch. `<branch>` is the `branch` that you copied:

```sh
cd <worktree>
git push origin <branch>
```

`git push` asks for a user name and a password. Give `<you>` as the user name. Give the token as the password.

<!-- output: not run -->

```text
Username for 'https://github.com': <you>
Password for 'https://<you>@github.com':
…
To https://github.com/<you>/jr2.git
 * [new branch]      jr2/task-<instance id> -> jr2/task-<instance id>
```

`origin` fetches through the Repo cache of the node, and pushes to your fork. Open your fork on GitHub to see the
branch. Then leave the Sandbox:

```sh
exit
```

## Approve the work

::: warning

`approve` ends the run and removes the Sandbox. A commit that you did not push is lost.

:::

In the second terminal, send `approve` to the `review` Gate. `approve` takes no input:

```sh
jr2 send <run id> --gate body.review --event approve
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered approve to gate "body.review" on <run id>
```

In the first terminal, `jr2 run` prints the end of the run, then the final status as one line of JSON, and stops:

<!-- output: not run -->

```text
…
  → done "done"
…
```

## Make sure that the Sandbox is gone

Use the full run id again:

```sh
kubectl -n my-instance get sandboxes -l jr2.dev/run=<run id>
```

<!-- output: not run -->

```text
No resources found in my-instance namespace.
```

## What happened

- `task` is a Machine in a Workspace. The run made a Sandbox for the Workspace and cloned your fork into it. It cut the
  branch from the release tag, in a Worktree in `/work/target/`. See [Workspaces](../concepts/workspaces.md).
- `task` left its Repo Slots and the model of its coder Open. `customize()` bound them where you registered the
  Workflow, and `jr2 up` refuses a Workflow with an Open part. See [Composition](../concepts/composition.md) and
  [ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md).
- The `review` Gate kept the Sandbox while the run waited. `request_changes` sent the coder back to the same
  conversation. `approve` ended the run, and the end of the Workspace removed the Sandbox. See
  [Gates](../concepts/gates.md) and [ADR-0012](../reference/decisions/0012-workspace-wrapper-machine.md).
- You used `kubectl exec` to go into the Sandbox. The guide [Look inside a Sandbox](../guides/look-inside-a-sandbox.md)
  gives the same commands.
- You pushed by hand, because `task` does not push. On the next page, a Machine pushes the branch with an
  [Effect](../reference/glossary.md#effect).

## Next

[Have your Assistant write a Machine](have-your-assistant-write-a-machine.md)
