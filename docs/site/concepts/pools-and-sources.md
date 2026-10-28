---
title: Pools and Sources
description: How a Pool runs one worker Machine for each work item that a Source gives, and how its run ends.
---

A [Pool](../reference/glossary.md#pool) is a [Machine](../reference/glossary.md#machine) that runs one worker Machine
for each item of work. It gets the items from a [Source](../reference/glossary.md#source), one at a time, and it runs a
limited number of workers at once. You make a Pool with [`pool()`](../reference/authoring-surface/pool.md) and a Source
with [`source()`](../reference/authoring-surface/source.md). A Pool is usually the root of a
[Workflow](../reference/glossary.md#workflow). For example, a Pool can run one [`task`](../reference/machines.md#task)
for each ticket that is ready.

## Why it exists

A Machine that works through a list of items does the same work each time. It claims an item and starts a worker for it.
It runs no more workers than a limit. It collects each result, looks for more work, and decides when the run is done. A
Pool does all of this. The Machine gives only the Source, the worker and the limit.

The Pool holds both the Source and the workers. Thus it can tell three conditions apart. All the work is done, the work
that remains can never start, or the workers wait for a person.

## How a Pool behaves

The example is a Pool over a Source of four tickets. T-3 needs T-1 and T-2, and T-4 needs a ticket that does not exist.
Each worker waits at a [Gate](../reference/glossary.md#gate) until a person approves or rejects its ticket. Thus the
example runs with no model. A worker is usually a Machine with an [Agent](../reference/glossary.md#agent), such as
`task`.

<<< @/examples/concepts/pools-and-sources/tickets.ts

::: graph @/examples/concepts/pools-and-sources/tickets.ts

:::

The Pool asks for work, starts workers, and waits:

- The Pool calls the `next` of its Source when the run starts. It gives `next` the ids of the items that its workers
  have now.
- When `next` gives an item, the Pool starts a worker for it, and calls `next` again. The id of the worker is
  `itemId(item)`.
- When `cap` workers run, the Pool does not call `next`. It calls `next` again when a worker finishes.
- When no item is ready and workers run, the Pool waits. It calls `next` again when a worker finishes, when the `wake`
  event comes, or after `pollEvery` milliseconds.
- When no worker runs and `next` gives no item, the run ends.

In the example, T-1 and T-2 start at once, because `cap` is 2. The run then has three Gates: `T-1.review`, `T-2.review`
and `source`. When a person answers both tickets, T-3 starts. When T-3 finishes, only T-4 remains, and it can never
start. Thus the run ends in the state `deadlocked`, and the `status` of its output is `deadlocked`.

### How the run ends

The output of a Pool is `{ status, items, failures }`. `items` holds the output of each worker that got to a final
state, by item id. `failures` holds the [Failure](../reference/glossary.md#failure) of each worker that failed, by item
id. The Pool catches a worker's Failure: that worker stops, its Sandbox is deleted, and the other workers go on. A
defect in a worker is not caught, and ends the run `error`.

When the Pool ends and one or more workers failed, the run ends `failed` by default. This is true for `drained` and for
`deadlocked`. Its output is then the Failure of the Pool: the reason is `"<n> of <m> items failed"`, and the detail is
`{ status, items, failures }`. `jr2 run` exits 1. To end `done` with the failures in the output, give `pool()` the
option `failures: "report"`. Use it when a failed item is a correct answer of the run, for example in a run that tries
each item and reports which ones did not succeed.

`status` comes from the last answer of `next`:

| The last answer of `next`                       | `status`     | What it means                            |
| ----------------------------------------------- | ------------ | ---------------------------------------- |
| `null`, or `{ item: null, open: 0 }`            | `drained`    | No item is left.                         |
| `{ item: null, open: <n> }`, with `<n>` above 0 | `deadlocked` | Items exist, but none of them can start. |

While workers wait at Gates, the run does not end. It stays open, and the Gates of the run show what needs you. This is
not a status in the output: a run that waits has no output yet.

### Inputs, Gates and the wake event

- A worker gets its item as its input, or what `itemInput(item, { input })` makes of it. The Pool does not give the run
  input to a worker. `itemInput` can copy a part of it into the worker's input.
- The run input of a Pool is its own `input` schema, not the input of its worker. `cap` and `itemInput` read it.
- The Gates of a worker show in the run. The id of each one starts with the id of its item, such as `T-1.review`.
- The Pool takes the `wake` event of the Source at a Gate named `source`, for the whole run. A webhook or
  [`jr2 send`](../reference/cli.md#send) sends it. When the Pool is inside a different Machine, the Gate is
  `<path>.source`.
- The [Vocabulary](../reference/glossary.md#vocabulary) of a Pool is only its `wake` event. Each worker keeps its own.

A Pool is a Machine. It can be the root of a Workflow, or a different Machine can compose it.
[`customize()`](../reference/authoring-surface/customize.md) goes through a Pool to its worker, as
[Composition](composition.md) tells.

## Sources

[`source(spec)`](../reference/authoring-surface/source.md) declares where a Pool gets its items. A Source has three
parts ([`SourceSpec`](../reference/authoring-surface/type-sourcespec.md)):

- `next`: an [xstate](https://xstate.js.org) promise actor that claims the next ready item. Its input is `{ active }`,
  the ids of the items that workers have now.
- `wake`: an optional event, made with [`defineEvent`](../reference/authoring-surface/defineevent.md), that tells the
  Pool that new work is ready.
- `pollEvery`: an optional time in milliseconds. While the Pool waits, it calls `next` again at this interval.

`next` resolves to one of three answers ([`SourceNextResult`](../reference/authoring-surface/type-sourcenextresult.md)):
an item, `null` when no item is ready now, or `{ item, open }`. `open` is the number of items that exist but are not
ready. Without `open`, the Pool cannot tell a finished run from a blocked one. Thus, when no worker runs, `null` means
`drained`.

A Source can be a queue, a generator, or a set that `next` queries again each time.

## Work Source and the Ready-set

A [Work Source](../reference/glossary.md#work-source) is a Source over an issue tracker, such as GitHub issues or Jira.
The Work Source reads the dependencies between the items from the issue tracker. The
[Ready-set](../reference/glossary.md#ready-set) is the set of items that nothing blocks now. The `next` of a Work Source
gives the next item of the Ready-set.

The Machine does not hold the dependencies, and it does not copy the Ready-set into its context. It asks the Work Source
again each time. The Ready-set changes during a run. A person can add a ticket, or open a closed ticket again. Use
`wake` or `pollEvery`, so that the Pool sees the change while it waits.

jr2 does not include a Work Source. You write its `next` for your issue tracker. In the example, the list in memory is
the issue tracker.

## Rules

- `itemId` gives each item an id of its own, and the same id each time. The Pool uses it as the id of the worker and as
  the key in `items`.
- `next` must not give an item that a worker has now, or an item that a worker finished. The Pool gives `next` the
  active ids only. Your Source keeps the finished items.
- `cap` is a number, or a function of the run input. Without `cap`, one worker runs at a time.
- `onDrained` takes only `"final"`: the run ends.
- The Pool calls `next` again on `wake` or after `pollEvery` only while it waits: workers run and no item is ready.
- A `task` in a Pool needs a `branch` in its input. Make it in `itemInput`, for example from the item id.

## Read next

- [Run one worker per item](../guides/run-one-worker-per-item.md)
- [Composition](composition.md)
- [Gates](gates.md)
- Reference: [`pool()`](../reference/authoring-surface/pool.md), [`source()`](../reference/authoring-surface/source.md),
  [`PoolSpec`](../reference/authoring-surface/type-poolspec.md),
  [`SourceSpec`](../reference/authoring-surface/type-sourcespec.md),
  [`SourceNextResult`](../reference/authoring-surface/type-sourcenextresult.md)
- [ADR-0017](../reference/decisions/0017-pool-over-a-source-port.md): the run loop is a Pool over a Source
