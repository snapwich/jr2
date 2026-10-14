---
title: Run one worker per item
description: Make a Pool that runs one worker Machine for each item that a Source gives, and run it.
---

Make a [Workflow](../reference/glossary.md#workflow) that runs one worker [Machine](../reference/glossary.md#machine)
for each item of work, with [`pool()`](../reference/authoring-surface.md#pool) and
[`source()`](../reference/authoring-surface.md#source).

In this example, the items are the open issues of a GitHub [Repo](../reference/glossary.md#repo) that have the label
`jr2`. The worker is the shipped Machine [`task`](../reference/machines.md#task). Each worker works on one issue in its
own [Sandbox](../reference/glossary.md#sandbox). Then it waits at a [Gate](../reference/glossary.md#gate) until a person
approves its work.

## The Workflow

The example uses `@jr2/machines`. Add it to the [Instance](../reference/glossary.md#instance) at the
[Kit version](../reference/glossary.md#kit-version). `<version>` is the version of `@jr2/orchestrator` in your
`package.json`:

```sh
npm install --save-exact @jr2/machines@<version>
```

Save this file as `workflows/issues.ts`. Replace `you/app` with your Repo, in the two places where it occurs.

The imports:

<<< @/examples/guides/run-one-worker-per-item/anthropic/issues.ts#imports

The model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/run-one-worker-per-item/anthropic/issues.ts#model

== Local

<<< @/examples/guides/run-one-worker-per-item/local/issues.ts#model

:::

The [Source](../reference/glossary.md#source), the worker and the [Pool](../reference/glossary.md#pool):

<<< @/examples/guides/run-one-worker-per-item/anthropic/issues.ts#pool

The file has five parts:

- **The Source.** `next` gets the open issues from the GitHub REST API. It gives the first issue that no worker has had.
  When no issue is ready, it gives `null`. The request has no token, so the Repo must be public. Without a token, GitHub
  allows 60 requests in each hour. The example reads only the first page of issues: at most 100. When the request fails
  while workers run, `next` gives `null` in place of the error, so that the failure does not stop the run.
- **The record of the Source.** `next` keeps each issue that it gives in the `Set` `claimed`, and skips the issues in
  `active`. The `Set` is in the memory of the [Orchestrator](../reference/glossary.md#orchestrator), and each run of the
  Workflow uses the same `Set`. A restart of the Orchestrator empties it. Then `next` can give a finished issue again,
  but never an issue that a worker of this run has now.
- **The worker.** `fixer` is `task` with its two [Open](../reference/glossary.md#open) parts bound: the Repo and the
  model of the coder. [Bind a shipped Machine's Open parts](bind-open-parts.md) tells more.
- **The run input.** `door` is the run input of the Pool. `cap` reads `workers` from it. A worker never gets it.
- **The Pool.** `itemId` gives the id of each item. `itemInput` makes the input of the worker from the item: the prompt
  and the branch.

Run [`jr2 up`](../reference/cli.md#up) to converge the Instance with the new Workflow:

```sh
jr2 up
```

<!-- output: not run -->

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
…
```

## Start the run

Give the label `jr2` to one open issue or more of your Repo. With no such issue, the run ends at once, as `drained`.

Start a run in one terminal. `workers` is the largest number of issues that the run works on at the same time:

```sh
jr2 run issues --input '{"workers":2}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run 3f9a1c2e-7b4d-4e8a-9c1f-5d2b6a8e0f13 (issues) — attached
…
```

The examples on this page use the Instance `my-instance` in the kubectl context `kind-jr2`. Your run id is different.
Give each `jr2` command in the Instance folder. Give the commands in the next steps in a second terminal. In them,
`<run id>` is the run id, or a unique prefix of it, 4 characters or more.

[`jr2 run`](../reference/cli.md#run) stays attached until the run ends. The run ends when no issue is ready and no
worker runs.

## Find the Gates of the workers

Run [`jr2 status`](../reference/cli.md#status):

```sh
jr2 status <run id>
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
{"runId":"3f9a1c2e-…","workflow":"issues",…,"gates":[{"gate":"source",…},{"gate":"issue-12.body.review",…},…]}
```

In the JSON that it prints, `gates` holds each open Gate of the run:

- `source`: the Gate of the `wake` event of the Source. It is open for the whole run.
- `issue-<number>.body.review`: the `review` Gate of the worker for that issue. It opens when the coder finishes, or
  when its [Turn](../reference/glossary.md#turn) fails. The id starts with the item id. `body` is the slot of the
  Machine that `task` wraps.

The `meta` of a `review` Gate gives the `branch` and the `worktree` of the worker. The name of the Sandbox of a worker
holds its item id: `ws-<first 8 characters of the run id>-<item id>-<hash>`.
[Look inside a Sandbox](look-inside-a-sandbox.md) tells how to read the work before you approve it.

## Approve the work of one worker

Push the branch before you approve. `approve` ends that worker and removes its Sandbox, and the commits that you did not
push are lost. [Look inside a Sandbox](look-inside-a-sandbox.md#push-the-branch) tells how to push.

Then send `approve` to the Gate of the worker. This example approves issue 12:

```sh
jr2 send <run id> --gate issue-12.body.review --event approve
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered approve to gate "issue-12.body.review" on 3f9a1c2e-7b4d-4e8a-9c1f-5d2b6a8e0f13
```

The Pool then calls `next` again, and starts a worker for the next issue.

The `review` Gate also takes `request_changes`, with `--input '{"notes":"<text>"}'`. Then the coder continues with the
notes, and the Gate opens again when it finishes. [Answer a Gate](answer-a-gate.md) gives the other ways to answer a
Gate.

## Tell the Pool about new work

While workers run and no issue is ready, the Pool waits. When you add the label to an issue, send the `wake` event to
the `source` Gate. The Pool then calls `next` at once:

```sh
jr2 send <run id> --gate source --event issues_changed
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered issues_changed to gate "source" on 3f9a1c2e-7b4d-4e8a-9c1f-5d2b6a8e0f13
```

Without the event, the Pool calls `next` again when a worker finishes, or after `pollEvery`. A webhook can send the same
event with [`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events).

## The end of the run

When the last worker finishes and no issue is ready, the run ends. In the first terminal, `jr2 run` prints the last
state of the Pool, then the status of the run as JSON:

<!-- output: not run -->

```text
…
  → done "drained"
…
```

In the JSON, `context.items` holds the output of each worker, by item id. For this Source, `context.status` is always
`drained`, because `next` never gives `open`. [Pools and Sources](../concepts/pools-and-sources.md#how-the-run-ends)
tells what each status means.

## Rules

- `itemId` must give each item an id of its own, and the same id each time. It is the id of the worker, the key in
  `items`, and the start of the id of each Gate of the worker.
- `next` must not give an item that a worker has now. jr2 does not refuse the item when `next` gives it. A second worker
  starts in the same Sandbox and the same [Worktree](../reference/glossary.md#worktree) as the first. When the two
  workers register the same Gate or [Agent](../reference/glossary.md#agent), the run stops with the status `error`, and
  its `fault` is `registration address "<address>" is already live (two concurrent registrations share an id)`. For
  `task`, `<address>` is `gate/<run id>/<item id>.body.review` or `agent/<run id>/<item id>.body/coder`.
- `next` gets only `active`: the ids of the items that workers have now. To not give a finished item again, the Source
  must keep the items that it gave.
- When `next` rejects, the run stops. Its status is `error`, and its `fault` is the message of the error.
- `pool()` does not carry the item type of the Source to `itemId` and `itemInput`. Write the type on their parameter, as
  in `(issue: Issue)`.
- A worker gets its item, or what `itemInput` makes of it. It never gets the run input. `cap` and `itemInput` get the
  run input as `{ input }`, typed by the `input` schema of the Pool.
- The Orchestrator refuses a run input that does not match the `input` schema of the Pool. `jr2 run` prints
  `error: invalid input for workflow "<workflow>": <reason>`.
- A `task` inside a Pool needs `branch` in its input. Without it, the run stops with the status `error`, and its `fault`
  starts with ``task: no `branch` on the door and no Instance ID to derive one from``.
- Without `cap`, one worker runs at a time. Each `task` worker has its own
  [Workspace](../reference/glossary.md#workspace). Thus the run has `cap` Sandboxes or fewer at one time.
- The Pool takes the `wake` event only while it waits: workers run, and no item is ready. At other times,
  [`jr2 send`](../reference/cli.md#send) refuses it:
  `error: gate "source" is open, and the run does not take "<event>" now: no writing of it would move the run with this payload — not delivered (takes now: nothing)`.
- `onDrained` takes only `"final"`: the run ends.

## Read next

- [Pools and Sources](../concepts/pools-and-sources.md)
- [Composition](../concepts/composition.md)
- [Gates](../concepts/gates.md)
- Reference: [`pool()`](../reference/authoring-surface.md#pool), [`source()`](../reference/authoring-surface.md#source),
  [`PoolSpec`](../reference/authoring-surface.md#type-poolspec),
  [`SourceSpec`](../reference/authoring-surface.md#type-sourcespec), [`task`](../reference/machines.md#task)
- [ADR-0017](../reference/decisions/0017-pool-over-a-source-port.md): the run loop is a Pool over a Source
