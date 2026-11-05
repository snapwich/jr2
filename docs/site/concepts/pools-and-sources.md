---
title: Pools and Sources
description: How a Pool runs one worker for each item of a Source, how a Hook brings items, and how its run ends.
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
- The Pool takes the `wake` event of the Source at a Gate named `source`, for the whole run.
  [`jr2 send`](../reference/cli.md#send) sends it. A Hook reaches the Source's handlers through the same Gate. When the
  Pool is inside a different Machine, the Gate is `<path>.source`.
- The [Vocabulary](../reference/glossary.md#vocabulary) of a Pool is only its `wake` event. Each worker keeps its own.

A Pool is a Machine. It can be the root of a Workflow, or a different Machine can compose it.
[`customize()`](../reference/authoring-surface/customize.md) goes through a Pool to its worker, as
[Composition](composition.md) tells.

## Sources

[`source(spec)`](../reference/authoring-surface/source.md) declares where a Pool gets its items. A Source has one of
three forms:

| Form | What it has                    | How the Pool gets items                                                                  |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Pull | `next`                         | The Pool calls `next`, and `next` gives one item at a time.                              |
| Read | `read` and `items`             | The Pool reads the whole set, and starts the items that are new, one for each slot.      |
| Push | `item` (a zod schema), `hooks` | Each [Hook](../reference/glossary.md#hook) delivery carries one item. The Pool holds it. |

### Pull

A pull Source has three parts ([`SourceSpec`](../reference/authoring-surface/type-sourcespec.md)):

- `next`: an [xstate](https://xstate.js.org) promise actor that claims the next ready item. Its input is
  `{ active, settled, input }`: the ids of the items that workers have now, the ids of the finished and failed items,
  and the input of the Pool. Thus a Source can fan out over a plan with no state of its own.
- `wake`: an optional event, made with [`defineEvent`](../reference/authoring-surface/defineevent.md), that tells the
  Pool that new work is ready.
- `pollEvery`: an optional time in milliseconds. While the Pool waits, it calls `next` again at this interval.

`next` resolves to one of three answers ([`SourceNextResult`](../reference/authoring-surface/type-sourcenextresult.md)):
an item, `null` when no item is ready now, or `{ item, open }`. `open` is the number of items that exist but are not
ready. Without `open`, the Pool cannot tell a finished run from a blocked one. Thus, when no worker runs, `null` means
`drained`.

A Source can be a queue, a generator, or a set that `next` queries again each time.

### Read

A read Source reads the whole set each time. `read` is an `http` Effect marked `idempotent: true`, so that the read can
use a secret that the Instance Effector holds, or a promise. Its input is the input of the Pool. `items(output)` gives
the items in its answer, in order. Without `items`, the answer must be the list of items.

- The Pool reads when the run starts, when a worker finishes, on `wake`, when a Hook's handler gives `reread()`, and
  after `pollEvery` milliseconds while it waits.
- One read fills each free slot. The Pool does not start an item whose id a worker has, or that finished in this run.
  The items that do not get a slot stay in the Source: the next read finds them again.
- When a `reread()`, a `wake` or a finished worker comes during a read, the Pool reads one more time after that read.
  Thus no change is lost.
- A read that fails gives no items. The next read tries again.
- An item whose `itemId` throws or gives no id is skipped, and the read starts the other items. The run's feed has a
  `pool` line `skipped` that says which item and why, one time in the run's life.

The read is the truth. A Hook delivery only says "read again". An item that changed while it waited is read as it is
now.

### Push

A push Source has no read. Each item comes in a Hook delivery, and the handler gives `carry(item)`. The Pool parses the
item with the `item` schema and holds it in its run, in the order of arrival. When a slot is free, the Pool starts the
oldest held item. Only a standing Pool of runs takes a push Source (see [A Pool of runs](#a-pool-of-runs)), because a
Pool that ends when no item is ready would end at once.

`hold` is the most items that the Pool holds, 1000 by default. A held item is in the run's saved state before the Hook
gets its answer, so a restart does not lose it.

### A Hook reaches a Source

The `hooks` of a Source have the shape of a [Gate's](gates.md) handlers: a handler for each Hook kind and event key. A
handler reads `{ payload, caller, delivery, input }`. It is pure and synchronous, and it gives one of three answers:

- [`reread()`](../reference/authoring-surface/reread.md): read the Source again now. A pull or a read Source gives it.
- [`carry(item)`](../reference/authoring-surface/carry.md): here is the item. A push Source gives it.
- [`skip(reason)`](../reference/authoring-surface/skip.md): this delivery brings nothing, because of `reason`.

A handler never gives `undefined`. A handler that throws is a skip, with the error as its reason. The Hook reaches the
Source through the Pool's `source` Gate, so the Hook's `may.answer` must name the Pool's Workflow.

The answer of the Hook's door has a line in `sources` for each Source that heard the delivery. Its `verdict` is one of
these:

| `verdict`   | What it means                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `held`      | The Pool holds the carried item. `key` is its id.                                                |
| `existing`  | The Pool holds the key already, a worker has it, or a run of the callee has it (`run` names it). |
| `hold-full` | The Pool holds `hold` items. When each Source says `hold-full`, the answer is 429.               |
| `reread`    | The Source reads again.                                                                          |
| `skipped`   | The handler gave `skip(reason)`, or threw. `reason` says why.                                    |
| `paused`    | The standing Pool is paused, and it holds nothing. `jr2 run <workflow>` resumes it.              |

A 429 does not mark the delivery as seen, so the service can send it again. For a chat command or a click, the person
gets 200 and a text that says why ([The answer that a person reads](gates.md#the-answer-that-a-person-reads)).

A Source can also give `reply(verdict, { caller })`: the text that the person who acted on a chat service reads, from
its verdict. `verdict.verdict` is one of the names above, except `paused`. `held`, `existing` and `hold-full` also carry
the `item` and its `key`. The text of a `skipped` verdict shows only when no Gate or other Source gave a text, because a
skip says "not for me". See [The answer that a person reads](gates.md#the-answer-that-a-person-reads).

## A Pool of runs

The worker of a Pool can be a [`dispatch(...)`](../reference/authoring-surface/dispatch.md) slot in place of a Machine.
Then each item is a run of its own of the slot's Workflow: it has its own row in `jr2 runs`, its own cancel and its own
Workspaces. The example starts one `triage` run for each alert that an alert service sends:

<<< @/examples/shared/alerts/workflows/alerts.ts

jr2 ships no kind for this alert service. Thus the Instance makes the `sentry` kind with `webhook()` from
`@jr2/hooks/webhook`, in a module of its own: `hooks/sentry.ts`. `jr2.config.ts` imports it for the Hook, and the
Workflow imports it for the types of its handlers.

A Pool of runs is different from a Pool of child Machines:

- **The key.** `itemId(item)` is the key of the item's run in the callee Workflow. Each start with the same key gets the
  same run while the run's row lives: while the run is live, and a week after it ends. Thus an item never starts two
  runs, also after a restart. `jr2 status` of the run prints the key, and the Hook delivery that carried the item.
- **It stands.** A Pool of runs needs `standing: true`. It never ends by itself, and it has no output. When it has no
  work, it waits for a Hook delivery, a `reread()`, a `wake` or its `pollEvery`.
- **`cap` counts live runs.** The `dispatch` slot must say `wait: true`, so that the Pool knows when a run ends. A run
  that ends in any way frees its slot. A run that ends `failed`, or a start that the callee's door refuses, ends only
  its item: the run is not the Pool's child. The run's feed has a `pool` line for each start and each end.
- **Independent runs.** A cancel of the Pool does not cancel its runs. `customize()` does not reach into them.

### jr2 keeps the standing run

Nobody starts the run of a standing Pool. jr2 starts it at the publish that adds the Workflow, and keeps one live run of
it after that:

- **A restart keeps it.** The restored run keeps its held items and its live runs. jr2 starts no second one.
- **A publish hands it over.** At each publish, jr2 starts a new run under the new Assembly and ends the old run `done`.
  `jr2 status <old run>` prints `handed over to: <new run>`. The new run takes the held items, parsed again by the new
  `item` schema (an item that does not parse is dropped, with a `carry-refused` line on the feed), and it sends each
  active key again: the key finds its run, so no item starts a second run. jr2 also hands the run over when it has taken
  500 items or is one day old, and when its Assembly can no longer be read (drift).
- **An `error` is handed over after a back-off** of 1 s, then 4 s, then 16 s. A run that ends `failed` is handed over as
  a run that ends `error` is. While the Pool waits, it has no live run, and the Hook's door answers 503 to a delivery
  for it, so the service sends it again. For a chat command or a click, the person gets 200 and a text that says why
  ([The answer that a person reads](gates.md#the-answer-that-a-person-reads)).
- **A bound with no run started is handed over after the back-off too.** When a run takes its 500 items and none of them
  starts a run (the callee's door refuses each one, for example), jr2 ends the run and waits before the next run. The
  Pool knows an item that ends with no run only during the run that took it. Without the wait, each new run would take
  the same items again at once, with no end.
- **jr2 pauses a Pool whose items start no run.** One rule counts a run that ends `error`, ends `failed`, or takes its
  bound: when no item that the run took itself starts a run, the run counts. An active key that a hand-over carried to
  the run does not count, because its run started before. A run in which an item that it took starts a run starts the
  count again. After 3 hand-overs from counted runs in a row, jr2 pauses the Pool when the next counted run ends.
  `jr2 status` and the Orchestrator's log say which end paused the Pool.
- **A cancel is a pause.** `jr2 send <run> --event CANCEL` ends the run `cancelled`, and jr2 starts no run of the
  Workflow at a restart or a publish. A delivery gets the verdict `paused`, and the Pool holds nothing. `jr2 status`
  prints the Pool as paused, with the number of items it holds.
- **`jr2 run <workflow>` resumes it.** It is the one start of a standing Workflow that jr2 accepts: the new run takes
  the held items and the active keys of the paused run, and `jr2 status` prints `resumed by:` with the Caller.
  `jr2 run <workflow> --drop-held` resumes it with no held item. While the Pool is live, `jr2 run` of it is refused.

`jr2 up` prints the chain from each Hook to each standing Pool and its callee (`standing: sentry → alerts → triage`),
and the state of each standing Pool after the publish. It warns when two standing Pools dispatch to one Workflow: `cap`
is for each Pool, so the caps add.

`pool()` and the load walk refuse a Pool that cannot run, and the message tells the fix:

- A worker that is a Workflow name. Write `dispatch("<name>", { input, wait: true })`.
- A Pool of runs without `standing: true`, a `dispatch` slot without `wait: true` or with a `target`, and a Pool of runs
  without `cap`.
- `standing: true` on a Pool of child Machines, and a push Source on a Pool that does not stand.
- A standing Pool that is not the top Machine of its Workflow. Put it in a file of its own in `workflows/`.

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
  the key in `items`. An item whose `itemId` throws or gives no id is skipped: a push Source's verdict is `skipped`, and
  a read Source puts a `skipped` line on the feed. In a pull Source, the run ends `error`.
- `next` must not give an item in `active` or in `settled`.
- `cap` is a number, or a function of the run input. Without `cap`, one worker runs at a time. A Pool of runs must state
  `cap`.
- `onDrained` takes only `"final"`: the run ends.
- The Pool calls `next` again on `wake`, on `reread()` or after `pollEvery` only while it waits: workers run and no item
  is ready. A `wake` or a `reread()` that comes while `next` runs makes the Pool call `next` once more.
- A `task` in a Pool needs a `branch` in its input. Make it in `itemInput`, for example from the item id.

## Read next

- [Run one worker per item](../guides/run-one-worker-per-item.md) and
  [Start a run for each alert](../guides/start-a-run-for-each-alert.md)
- [Callers and Hooks](callers-and-hooks.md)
- [Composition](composition.md)
- [Gates](gates.md)
- Reference: [`pool()`](../reference/authoring-surface/pool.md), [`source()`](../reference/authoring-surface/source.md),
  [`carry()`](../reference/authoring-surface/carry.md), [`reread()`](../reference/authoring-surface/reread.md),
  [`skip()`](../reference/authoring-surface/skip.md), [`PoolSpec`](../reference/authoring-surface/type-poolspec.md),
  [`SourceSpec`](../reference/authoring-surface/type-sourcespec.md),
  [`SourceNextResult`](../reference/authoring-surface/type-sourcenextresult.md)
- [ADR-0017](../reference/decisions/0017-pool-over-a-source-port.md): the run loop is a Pool over a Source
