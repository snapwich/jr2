---
title: Durable runs
description: How a run survives a restart of the Orchestrator, what ends it, and how long jr2 keeps a run that ended.
---

A run is durable. The [Orchestrator](../reference/glossary.md#orchestrator) saves each run after each transition of its
[Machine](../reference/glossary.md#machine). When the Orchestrator starts again, it continues each run that did not end,
from the state that it saved. A run that ended stays readable for [`runs.retain`](../reference/config.md#runs), 30 days
by default.

## Why runs are durable

A run can take a long time. An [Agent](../reference/glossary.md#agent) can work for an hour, and a run can wait at a
[Gate](../reference/glossary.md#gate) for days, until a person answers. In that time, the Orchestrator can stop:

- Each [`jr2 up`](../reference/cli.md#up) that changes the [Kit version](../reference/glossary.md#kit-version) starts
  the Orchestrator again on the image of the new version.
- The node of the Orchestrator can fail.
- The process can stop because of an error.

If a run ended each time that its process stopped, a long run would not finish. Thus the run is not in the process. The
process holds the run only while it runs it, and the store holds the run between two processes.

## Snapshots

After each transition, the Orchestrator writes the snapshot of the run to its store. The store is a sqlite file on the
volume of the [Instance](../reference/glossary.md#instance), in the namespace of the Instance. One row holds the whole
run. With the snapshot, the row holds the facts that a new process needs to continue the run:

- the [Admission](../reference/glossary.md#admission) of each Agent's [Turn](../reference/glossary.md#turn): where the
  Turn's stream is, and how much of it the run read
- each timer that waits, with the time at which it fires
- each [Effect](../reference/glossary.md#effect) that started, and its result when it has one
- each pick that waits for its answer

The write is complete before the Machine does its next action. A write survives a crash of the process. A power loss of
the node can lose the last transitions. The Orchestrator then continues from the snapshot before them, as it does after
each restart.

Only one Orchestrator writes to the store. The Orchestrator has one replica, and a new pod starts only after the old pod
stopped.

## Restart and re-attach

When the Orchestrator starts, it reads each run that did not end, one at a time. For each run, it:

1. Finds the [Assembly](../reference/glossary.md#assembly) that the run holds: the Assembly that was current when the
   run started. Then it finds the [Workflow](../reference/glossary.md#workflow) in that Assembly, by the name of its
   file in `workflows/`.
2. Compares the shape of the Machine with the shape that the snapshot records. See
   [Machine shape and drift](#machine-shape-and-drift).
3. Starts the Machine again from the snapshot.

Thus a run continues on the Machine that it started on, also when `jr2 up` published a newer Assembly after it started.
When the Orchestrator has no current Assembly, it continues no run. This occurs after its volume lost the Assembly, and
after `jr2 up` started a new Kit image and before it published. The Orchestrator keeps the live runs, and the next
publish continues them.

The parts of the run then continue:

- **Agents.** A Turn does not stop when the Orchestrator stops. It continues in its
  [Harness](../reference/glossary.md#harness). The new Orchestrator re-attaches to the stream of the Turn, from the
  point that the snapshot records. It does not send the prompt again. The one exception is a Turn whose Admission the
  Orchestrator did not save before it stopped. That Turn can start again.
- **Workspaces.** The Orchestrator watches each [Sandbox](../reference/glossary.md#sandbox) of the Instance. When the
  Sandbox of a [Workspace](../reference/glossary.md#workspace) is still there, the Workspace continues. When the Sandbox
  is gone or its pod ended, its [Worktrees](../reference/glossary.md#worktree) and the commits that nobody pushed are
  gone too. The Workspace then sends [`workspace.lost`](../reference/mechanism-events.md#workspace-lost) to its body,
  and the Machine decides what to do. jr2 never makes the Sandbox again for that Workspace.
  [Workspaces](workspaces.md#lease-and-continuity) explains how the operator decides to remove a Sandbox.
- **Timers.** A timer, such as an [xstate](https://xstate.js.org) `after`, fires after the time that remained. A timer
  whose time passed while the Orchestrator was stopped fires at once.
- **Effects.** jr2 runs an Effect a second time only when that is safe. When the Orchestrator cannot find out if an
  Effect finished, the result of the Effect is `unknown`. [Effects](effects.md) gives the rules.

A run that the Orchestrator does not continue gets one of these results:

| Result    | When                                                                                                        | What stays                                         |
| --------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `lost`    | No Workflow has the name of the run's file, or the row holds no snapshot.                                   | The row and the reason, for `runs.retain`.         |
| `drifted` | The Orchestrator cannot read the Assembly of the run, or the Machine of the Workflow has a different shape. | The row and the snapshot.                          |
| `failed`  | The restore of the run stopped with an error.                                                               | The run stays live. The next start tries it again. |

The Orchestrator prints the ids of these runs on the line that it writes when it starts. A run that it continued is
normal, and it does not print it.

## Machine shape and drift

The [Machine shape](../reference/glossary.md#machine-shape) is the part of a Machine that a snapshot must agree with:

- the states, their ids, their nesting, and the initial state of each level
- the type of each state
- the invokes of each state, by their `id` and their `src`
- the shape of each Machine that a state invokes or spawns
- each transition: its source state, its event and its targets

Each save records a digest of the shape. Each restore calculates the digest of the Machine that it loaded, and compares
the two. When they are different, the run has drift. The Orchestrator does not continue it.

The digest does not include the bodies of the guards and the actions (other than what an action spawns), the `assign`
calls, the prompts and the descriptions. A change to these parts does not cause drift. A run that continues after such a
change uses the new code from its next transition.

A run holds its Assembly, so a change that you publish does not change the Machine of a live run. Drift occurs when the
Orchestrator cannot read the Assembly that the run holds:

- The Assembly is for a different Kit version. After you upgrade the Kit version, the first publish marks each run of an
  older Assembly `drifted`.
- The volume of the Orchestrator lost the Assembly.
- The Assembly does not load.

The Orchestrator keeps a drifted run, and you can read it. [`jr2 status`](../reference/cli.md#status) shows its status,
`drifted`, with the reason. The reason names the Workflow and the two digests, or the Assembly and why it cannot load.
By default, [`jr2 runs`](../reference/cli.md#runs) shows only the live runs, so it does not show a drifted run.
`jr2 runs --status drifted`, `--status ended` or `--status all` shows it with its reason. jr2 cannot move a drifted run
to a new Machine. Thus, before you change the Kit version, let the runs end, or cancel them.

## CANCEL and stop

A run ends when its Machine gets to a final state, when it has a fault, or when you cancel it. A restart of the
Orchestrator does not end a run. It only stops the process that held the run, and the run stays live in the store.

To end a run yourself, send it the `CANCEL` event with [`jr2 send`](../reference/cli.md#send). `CANCEL` does three
things:

1. It stops the Machine. The Turn of each Agent of the run ends too.
2. It saves the run as `cancelled`. The Orchestrator does not continue a cancelled run after a restart.
3. It deletes the Sandbox of each Workspace of the run, because nothing can use it now.

With `--keep`, `CANCEL` does not delete the Sandboxes, so that you can look inside them. Nothing renews their
[Lease](../reference/glossary.md#lease), so the operator removes each one after its idle timeout of 30 minutes.

A run that has a fault ends with the status `error`. It keeps its Sandboxes, because they are the evidence of the fault.
The operator removes them after the same idle timeout. A run that a Machine fails, with `fail()`, ends with the status
`failed`, and the Orchestrator deletes its Sandboxes as `CANCEL` does: the Machine chose that end
([ADR-0073](../reference/decisions/0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)).

`jr2 status` shows a cancelled run with the status `cancelled` and the state that it was in.

## History

jr2 keeps the row of a run that ended for 30 days after its last write. `runs.retain` in `jr2.config.ts` changes this
time, for example `runs: { retain: "90d" }`. It is a number and `m`, `h`, `d` or `w`, and it is at least `1h`. This is
true for each status that is not live: `done`, `failed`, `error`, `cancelled`, `lost` and `drifted`. The Orchestrator
deletes the older rows when it starts, and one time each hour after that. A live run stays, whatever its age. A run that
waits at a Gate for a month is still there.

`jr2 runs --status ended` lists the runs that ended, newest first. `--workflow` and `--since` make the list shorter. jr2
is not the record of the results of a run. A Machine sends its results where they belong, such as a pull request.
`jr2 status` on a run that ended is for debugging. After `runs.retain`, `jr2 status` says that the run does not exist,
and a prefix of its id no longer finds it.

The time of a drifted run starts at the restart or the publish that refused it, not at its last transition.

The same time applies to the [Conversations](../reference/glossary.md#conversation) of a run and to the log of each
[Hook](../reference/glossary.md#hook). The Orchestrator keeps each conversation of an Agent while the run is kept, and
deletes it with the row of the run. Thus `jr2 logs` reads the conversations of a run that ended, also after its
[Sandbox](../reference/glossary.md#sandbox) is gone. [Read a conversation](../guides/read-a-conversation.md) gives the
commands.

### The state volume

The Orchestrator keeps the rows of the runs, the conversations, the Assemblies and the
[Charts](../reference/glossary.md#chart) on its state volume. A new volume claim is `5Gi` by default, and `jr2 up` keeps
the size of a claim that exists. `runs.volume` in `jr2.config.ts` sets its size, such as `runs: { volume: "20Gi" }`.
`jr2 up` makes the claim larger when its StorageClass allows expansion, and refuses otherwise. It never makes a claim
smaller, because Kubernetes cannot.

A space guard keeps the volume from becoming full. When the volume is more than 80% full, the Orchestrator deletes the
conversations of the runs that ended, the oldest run first, until the volume is less than 80% full. The rows of the runs
stay, and each one shows that its conversations went for space. The guard never deletes a conversation of a live run.
When the volume is more than 95% full and no ended run has a conversation left, the Orchestrator keeps no more entries
of the open conversations. One conversation also has a limit of 8 MiB, after which the Orchestrator keeps no more of it.

[`jr2 down`](../reference/cli.md#down) deletes the namespace of the Instance, and the store with it. The live runs go
too.

## Rules

- The context of a Machine and the input of each actor hold only plain data, such as ids, counts and strings. A live
  object, such as a server or a client, does not survive a restart.
- The Orchestrator continues a run only under the Assembly that it started under, and only when its Machine has the same
  shape.
- The Orchestrator never continues a drifted run, and never moves it to a new Machine.
- The Orchestrator never continues a cancelled run.
- `CANCEL` is the only run event that `jr2 send` sends without `--gate`. `--keep` goes only with `CANCEL`.
- jr2 keeps a run that ended for `runs.retain`, 30 days by default. The hourly sweep never deletes a live run.
- jr2 keeps the conversations of a run for as long as it keeps the run, unless the space guard deletes them first. The
  space guard never deletes a conversation of a live run.

[Cancel a run](../guides/cancel-a-run.md) and [Watch a run](../guides/watch-a-run.md) give the commands and their
output.

## Read next

- [Watch a run](../guides/watch-a-run.md)
- [Read a conversation](../guides/read-a-conversation.md)
- [Cancel a run](../guides/cancel-a-run.md)
- [Iterate on a Machine on kind](../guides/iterate-on-a-machine-on-kind.md)
- [Effects](effects.md), [Workspaces](workspaces.md) and [Converge](converge.md)
- Reference: [`jr2 send`](../reference/cli.md#send), [`jr2 status`](../reference/cli.md#status),
  [`jr2 runs`](../reference/cli.md#runs), [`POST /runs/:runId/events`](../reference/http-api.md#post-runs-runid-events),
  [`GET /runs/:runId`](../reference/http-api.md#get-runs-runid) and
  [`RunStatus`](../reference/http-api.md#type-runstatus)
- [ADR-0007](../reference/decisions/0007-durable-machine-state.md): the state of a Machine is durable
- [ADR-0021](../reference/decisions/0021-workspace-continuity-is-a-lease-that-answers-back.md): the Lease and Continuity
  of a Workspace
- [ADR-0025](../reference/decisions/0025-cancel-ends-a-run-stop-parks-it.md): `CANCEL` ends a run, and a stop parks it
- [ADR-0030](../reference/decisions/0030-a-snapshot-names-the-machine-it-was-written-under.md): a snapshot names the
  Machine that wrote it
- [ADR-0065](../reference/decisions/0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md): a save
  survives a crash, and jr2 keeps history for `runs.retain`
- [ADR-0069](../reference/decisions/0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md): a
  run holds the Assembly that it started under
