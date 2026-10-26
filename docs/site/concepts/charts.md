---
title: Charts
description: How an Agent writes a Machine as data at run time, which cannot reach the process of the Orchestrator.
---

A [Chart](../reference/glossary.md#chart) is a [Machine](../reference/glossary.md#machine) that is written as data, in
JSON, with no code. An [Agent](../reference/glossary.md#agent) writes it while a run runs, or you keep it in a file. A
Chart runs only under a [Chart wrapper](../reference/glossary.md#chart-wrapper): a Machine that declares an
[Open body](../reference/glossary.md#open-body). The Open body names the parts that a Chart can use.

## Why Charts exist

Some work has a shape that nobody knows before the run. A planner Agent reads the task and decides the steps: first a
coder, then a reviewer, then a person. You cannot write that Machine before the run.

An Agent cannot write code for the [Orchestrator](../reference/glossary.md#orchestrator). Only
[`jr2 up`](../reference/cli.md#up) publishes code, because the Orchestrator holds the credentials of the
[Instance](../reference/glossary.md#instance). Code that an Agent wrote could reach them. A Chart is data: the
Orchestrator reads it, but it cannot reach the process of the Orchestrator or its credentials. It can only name parts
that your code gives it, and jr2 checks each name before the Chart runs. Thus an Agent can make a Machine while a run
runs, and it can do only what the Open body lets it do. A Chart becomes a Workflow only when it is kept under a name
(see [Four ways to run a Chart](#four-ways-to-run-a-chart)). This is true also when the model is wrong or someone gives
it bad text.

## The Open body

[`openBody()`](../reference/authoring-surface/openbody.md) makes the actor slot that a Chart binds. It is the one
[Open](../reference/glossary.md#open) part that a run binds, not a composer. Its declaration has three parts:

- **`lends`**: the parts of the Chart wrapper that a Chart can use, by their slot keys. These are Agents, Effects,
  Machines, guards, actions and delays. `gate: true` lends the [Gate](../reference/glossary.md#gate), so that a Chart
  can wait for a person. `fail: true` lends [`fail()`](../reference/authoring-surface/fail.md), so that a Chart can end
  its run as a [Failure](../reference/glossary.md#failure) with `invoke: { src: "fail", input: { reason } }`.
- **`allows`**: what the Agents that a Chart adds can have. `models` lists the models, and `workspace` lists the
  Workspace accesses. With no model, a Chart cannot add an Agent.
- **`ceilings`**: the limits of one Chart: the Agent Turns, the wall clock, the transitions, the children at one time,
  and the size of the Chart in bytes.

A Chart gets nothing else. A lent Effect keeps its url, its argv and its secrets, so a Chart fills only its input. A
Chart has no url, no secret, no image and no Repo of its own. The Open body also decides where each Turn of the Chart
runs: in the Sandbox of its `workspace()`, or on the [Instance Harness](../reference/glossary.md#instance-harness).

## What a Chart holds

A Chart is xstate's own JSON config, with these limits:

- States, transitions, `after` delays, and nested and parallel states. A Chart has 200 states at most, 8 levels deep.
- Each `invoke.src` is a lent slot key or an Agent of the Chart. Each guard, action and delay is a lent name. Each Chart
  also has the guard `jr2.failure`, which is true on an `onError` when the error is a Failure.
- A state that invokes an Agent can route [`agent.fault`](../reference/mechanism-events.md#agent-fault) in its `on`, but
  it does not have to. When no transition of the Chart takes `agent.fault`, the Open body ends as an error. An `onError`
  on the Open body's state in the Chart wrapper catches it. With no `onError` there, the run ends `error`.
- Its events, with a JSON Schema for the input of each. An Agent of the Chart picks these events.
- Its own Agents, under `agents`, each with a model that the Open body allows.
- Its `context`, and the `output` of its final state. A Chart reads that `output`. A Machine that you write in
  TypeScript does not: it needs a root `output`. `createMachine` refuses an `output` on a final state directly below the
  root when the root has none (see [Write a Workflow](../guides/write-a-workflow.md#give-the-run-an-output)).

A Chart moves data with a [Reference](../reference/glossary.md#reference): a path that jr2 reads when the state starts.
`{{input.topic}}` reads the input of the Chart, `{{context.notes}}` reads its context, and `{{event.summary}}` reads the
pick that a transition handles. `{ "$ref": "event.summary" }` is the same. A Reference is a path, not an expression:
`{{context.round + 1}}` is refused. Four actions write the context: `set`, `append`, `increment` and `clear`.

A placeholder in data stays text. When a ticket holds `{{context.notes}}`, the prompt gets those characters, not the
notes.

## The door

jr2 checks each Chart before it runs. The door reads the whole Chart, and gives one line for each problem:

- each name that is not lent, or not declared by the Chart
- each event that no state handles, and each payload schema that uses a part that jr2 does not check
- each model that the Open body does not allow
- each loop with no guard, and each Agent state that nothing can end
- each Reference that nothing supplies, such as `{{context.summary}}` when no `set` writes `summary`

A refusal is the output of the Open body: `{ outcome: "refused", report }`. The Chart wrapper routes it. Usually it goes
back to the planner as the answer to its pick, and the planner sends a corrected Chart. The other outputs are
`{ outcome: "done", output }` when the Chart ends, and `{ outcome: "ceiling", ceiling }` when it gets to a ceiling.

The pick of a planner carries the Chart as its parameter. Its schema is
[`chartSchemaFor(declaration)`](../reference/authoring-surface/chartschemafor.md): the Chart grammar with the lent names
of this Open body. Thus the model gets the grammar as the parameters of its tool. On each Turn where the pick is an
[Allowed pick](../reference/glossary.md#allowed-picks), the [Briefing](../reference/glossary.md#briefing) also tells the
Agent how a Chart runs.

## Four ways to run a Chart

| Who                  | One time                                                      | By name                                                             |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| You, a tool or a CLI | The Chart in the run input of the Chart wrapper               | A Chart file, or a runtime Chart, run as `jr2 run <wrapper>/<name>` |
| An Agent             | Its pick carries the Chart, and a state invokes the Open body | The Open body gets `{ chart: { name } }`                            |

A Chart wrapper takes a Chart in its run input when a field of its input is
[`chartSchema`](../reference/authoring-surface/chartschema.md). Only such a wrapper keeps Charts under a name. A named
Chart is a [Workflow](../reference/glossary.md#workflow), with the name `<wrapper>/<name>`, and it runs under that
wrapper only. It comes from one of two places:

- A **Chart file** in the Assembly: `workflows/<wrapper>/<name>.chart.json`. `jr2 up` checks it at the door before it
  converges, and refuses a Chart file that the door refuses.
- A **runtime Chart**: `PUT /workflows/<wrapper>/charts/<name>`, with the Instance token. The Orchestrator keeps it on
  its volume. `DELETE` on the same path removes it.

[`jr2 runs`](../reference/cli.md#runs) lists each named Chart under its wrapper. When a publish removes a part that a
runtime Chart uses, the Chart stays, and it is unrunnable until a publish gives the part back.

## A run keeps its Chart

The run keeps the text of its Chart in its snapshot. Thus a run continues when its named Chart changes or goes. After a
restart, jr2 checks the text at the door again. A Chart that the door refuses then makes the run `drifted`.

The [Console](../reference/glossary.md#console) draws the Machine that the run binds, with its Chart in it. Thus you see
the states of the Chart while it runs.

## Rules

- A Chart runs only under a Chart wrapper.
- A Chart names only the parts that the Open body lends, its own Agents, and the four generic actions.
- An Agent of a Chart has a model that the Open body allows, and a Workspace access that it allows.
- A Reference starts at `context`, `event` or `input`, and something must supply it.
- The door refuses the whole Chart when it finds one problem, and it lists each problem.
- A Chart cannot go past a ceiling. The Open body then stops it.
- Only a wrapper with a `chartSchema` field in its input takes a Chart in the run input, and keeps named Charts.
- A Chart file and a runtime Chart with the same name: the Chart file wins, and the runtime Chart is unrunnable.

[Let an Agent write a Chart](../guides/let-an-agent-write-a-chart.md) and
[Run a Chart by name](../guides/run-a-chart-by-name.md) give the refusal text of each rule.

## Read next

- [Let an Agent write a Chart](../guides/let-an-agent-write-a-chart.md)
- [Run a Chart by name](../guides/run-a-chart-by-name.md)
- [Composition](composition.md), [The Menu](the-menu.md), [Agents and Turns](agents-and-turns.md)
- Reference: [`openBody`](../reference/authoring-surface/openbody.md),
  [`OpenBodyDeclaration`](../reference/authoring-surface/type-openbodydeclaration.md),
  [`OpenBodyOutput`](../reference/authoring-surface/type-openbodyoutput.md),
  [`chartSchema`](../reference/authoring-surface/chartschema.md),
  [`chartSchemaFor`](../reference/authoring-surface/chartschemafor.md),
  [`PUT /workflows/:wrapper/charts/:name`](../reference/http-api.md#put-workflows-wrapper-charts-name)
- [ADR-0070](../reference/decisions/0070-a-machine-lends-its-parts-to-a-chart.md): a Machine lends its parts to a Chart
