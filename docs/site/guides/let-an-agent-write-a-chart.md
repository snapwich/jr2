---
title: Let an Agent write a Chart
description: Write a Chart wrapper whose planner Agent writes a Chart, runs it, and corrects it.
---

Write a [Chart wrapper](../reference/glossary.md#chart-wrapper) whose planner [Agent](../reference/glossary.md#agent)
writes a [Chart](../reference/glossary.md#chart) and runs it.

This example is `workflows/plan.ts`. The planner reads the task, and it picks `run_chart` with a Chart. The Chart runs
in the [Open body](../reference/glossary.md#open-body) `body`. It can use the Agent `writer` and the
[Gate](../reference/glossary.md#gate), and it can add its own Agents with the model of the tab. When the door refuses
the Chart, the planner gets the report as the answer to its pick, and it can pick again:

<<< @/examples/guides/let-an-agent-write-a-chart/anthropic/plan.ts#imports

The model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/let-an-agent-write-a-chart/anthropic/plan.ts#model

== Local

<<< @/examples/guides/let-an-agent-write-a-chart/local/plan.ts#model

:::

The Open body and the pick:

<<< @/examples/guides/let-an-agent-write-a-chart/anthropic/plan.ts#body

<<< @/examples/guides/let-an-agent-write-a-chart/anthropic/plan.ts#pick

The Machine:

<<< @/examples/guides/let-an-agent-write-a-chart/anthropic/plan.ts#machine

## Read the example

- [`openBody(declaration)`](../reference/authoring-surface/openbody.md) is the slot that the Chart binds. Its
  declaration lends the Agent `writer` and the Gate, lets a Chart add Agents with `model` and no Sandbox, and sets the
  ceilings. [Charts](../concepts/charts.md#the-open-body) tells what each part does.
- The pick `run_chart` has one parameter, `chart`. Its schema is
  [`chartSchemaFor(declaration)`](../reference/authoring-surface/chartschemafor.md): the Chart grammar with the names of
  this Open body. The model gets it as the parameters of its tool.
- The state `running` is below the state of the planner. Thus the pick is
  [outstanding](../reference/glossary.md#outstanding) while the Chart runs, and the Turn of the planner stays open.
- [`fromPick`](../reference/authoring-surface/frompick.md) gives the Chart of the pick to the Open body, and adds
  `task`. The Chart reads it as `{{input.task}}`.
- The Open body ends with an [`OpenBodyOutput`](../reference/authoring-surface/type-openbodyoutput.md). `done` goes to
  the final state. `refused` and `ceiling` go back to `ready`, where jr2 answers the pick with the output. The planner
  reads the report, and it can pick `run_chart` again.

## Run it

Run [`jr2 up`](../reference/cli.md#up). The planner and `writer` are Menu-only Agents, so `jr2 up` converges the
[Instance Harness](../reference/glossary.md#instance-harness). It also puts the key of each model in `allows.models` on
the Instance Harness, because a Chart can add an Agent with that model. Then start a run:

```sh
jr2 run plan --input '{"task":"Write the release notes for the greet CLI, and ask a person to approve them."}'
```

Open the run in the [Console](../reference/glossary.md#console). After the planner picks `run_chart`, the Console draws
the Chart inside `running`. The Chart of each run is different, because the planner writes it.

When the door refuses a Chart, the answer to the pick holds the report. The log of the
[Instance Harness](../reference/glossary.md#instance-harness) shows each answer. Replace `<namespace>` with the
namespace of your Instance, and `<run id>` with the full run id. The log holds the lines of each run of a Menu-only
Agent, and the first `grep` keeps the lines of your run:

```sh
kubectl -n <namespace> logs statefulset/jr2-instance-harness -c harness | grep -F '[<run id>/' | grep -F '[run_chart answer]'
```

For example, in one run with the model of each tab, the first Chart of the planner gave a prompt to the Gate. The door
refused it:

```text
[planner] [<run id>/root/planner] [run_chart answer] Delivered "run_chart" to the workflow (delivery ede62e99-7596-41fe-bda3-c6dcc194517f). The workflow took it and is back in the state that asked for this turn. Its answer: the output of `body`: {"outcome":"refused","report":["states.approve.invoke.input.prompt: a Gate's input takes gate and meta only; `gate` is the kit's Gate, which waits for an outside answer (a human, a webhook), not an Agent's Turn"]}. Your turn is not over. Allowed now: `mcp__jr2__run_chart`.
```

The planner writes a different Chart in each run. Thus your report can be different, and the door can accept the first
Chart. Your delivery id is different. After a refusal, the planner can pick `run_chart` again with a corrected Chart.

When the Chart gets to its Gate, the run waits. `jr2 status <run id>` gives the id of the Gate, such as
`0.plan.planning.running.approve`, and the events that it takes. [Answer a Gate](answer-a-gate.md) tells how to answer
it. Then the Chart ends, and the run ends with the status `done`.

## Rules

- [`openBody()`](../reference/authoring-surface/openbody.md) refuses a declaration that is not correct, with one line
  for each problem. The refusal starts with `openBody: `, then each problem, separated by `; `. For example:
  - `lends.<kind>: an Open body lends agents, effects, machines, guards, actions, delays, gate and fail only`
  - `allows.workspace: "<value>" is not a Workspace access (write, read, none)`
  - `ceilings.<ceiling>: missing; an Open body states every ceiling`
  - `ceilings.<ceiling>: <value> is not a positive integer`
  - `ceilings.wallClock: <value> is not a positive duration (like "90s", "10m", "2h")`
  - `ceilings.size: <value> is more than 1048576 bytes (1 MiB)`
- `createMachine` refuses a lent name that the Machine does not have. The refusal starts with
  `machine "<id>": Open body "<slot>": `, then each problem:
  - `lends.<kind>: "<name>" is no actor slot of this Machine; its actors: <slots>`
  - `lends.<kind>: "<name>" is not an Agent slot (agent(...))`, or `is not an Effect slot`, or `is not a Machine`
  - `lends.<kind>: "<name>" is no <guard, action or delay> of this Machine; its <kind>: <names>`
  - `lends.<kind>: "<name>" is the Open body itself`
- The door refuses a Chart, and gives one line for each problem. Each line starts with the path in the Chart. For
  example:
  - `<path>: "<name>" is not a lent actor or an Agent of this Chart; lent: <names>; kit: <gate, fail or none>; minted: <names>`
  - `<path>: "<name>" is not a lent guard; lent guards: <names> (and jr2.sentBy with params { id }, and jr2.failure)`
  - `<path>.type: "<name>" is not a generic or a lent action; generic: set, append, increment, clear; lent: <names>`
  - ``<path>: <reference> is supplied by nothing: it is not in the initial `context`, and no `set`, `append` or `increment` writes it``,
    then what a write supplies
  - `<path>: "<reference>" is not a reference: it starts at context, event or input (a reference is a path, never an expression)`
- The door then compiles the Chart as the Open body does. A line of this last check starts with `(chart):`, and names a
  state by its [xstate](https://xstate.js.org) id (for example `body.writing`), not by its path in the Chart.
- A refusal is output, not an error: the Open body ends with `{ outcome: "refused", report }`. A Chart wrapper that
  routes `onDone` back to the state of the pick gives the report to the planner.
- When the Turn of an Agent of the Chart cannot go on, and no transition of the Chart takes
  [`agent.fault`](../reference/mechanism-events.md#agent-fault), the Open body sends the event, unchanged, to this
  wrapper. The wrapper's root route takes it, as it takes the fault of `planner`, so the run ends `failed`.
- A Chart that gets to a ceiling stops, and the Open body ends with `{ outcome: "ceiling", ceiling, detail }`.

## Read next

- [Charts](../concepts/charts.md)
- [The Menu](../concepts/the-menu.md): how a pick waits for its answer.
- [Run a Chart by name](run-a-chart-by-name.md)
- Reference: [`openBody`](../reference/authoring-surface/openbody.md),
  [`OpenBodyDeclaration`](../reference/authoring-surface/type-openbodydeclaration.md),
  [`chartSchemaFor`](../reference/authoring-surface/chartschemafor.md),
  [`fromPick`](../reference/authoring-surface/frompick.md)
- [ADR-0070](../reference/decisions/0070-a-machine-lends-its-parts-to-a-chart.md): a Machine lends its parts to a Chart.
