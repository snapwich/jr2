---
title: Machines and Workflows
description: What a Machine and a Workflow are, the door of a run, the Vocabulary, and Emits.
---

A [Machine](../reference/glossary.md#machine) is an xstate state machine that you write. It holds the control flow of
your work. The control flow is the states, the events that move a run between them, and what each state does. A
[Workflow](../reference/glossary.md#workflow) is a Machine that your [Instance](../reference/glossary.md#instance)
registers under a name. You start a run of a Workflow with `jr2 run <name>`. This page tells how a Machine gets the
input of a run, which events it takes, and how it tells you what it does.

## Why the control flow is a Machine

A model does not always do the same thing for the same prompt. If a model decides the order of the work, you cannot know
before a run what the run will do. In jr2, the Machine decides the order. An [Agent](../reference/glossary.md#agent)
does the work of one state, then picks an event from its [Menu](../reference/glossary.md#menu). The Machine decides what
that event does.

A Machine is code that you can read before a run starts. The [Console](../reference/glossary.md#console) draws its
states, and it shows the states of each run while the run continues. Thus you review how the work happens, and not only
the code that comes out of it. The [Orchestrator](../reference/glossary.md#orchestrator) keeps the state of each run, so
a run continues after a restart. [Durable runs](durable-runs.md) tells how.

## A Workflow is a file

Each `.ts` file in the `workflows/` folder of the Instance is a Workflow. The name of the file, without `.ts`, is the
name of the Workflow. Thus `workflows/refund.ts` is the Workflow `refund`, and you start it with `jr2 run refund`. The
name has only lower-case letters, digits and `-`, so `jr2 run` and a `dispatch` Effect write it the same way. The file
exports its Machine as `machine`. jr2 reads no other export.

A Workflow is only a name. The Machine holds all that it needs: its events, its Agents, its
[Effects](../reference/glossary.md#effect) and its [Sandbox Image](../reference/glossary.md#sandbox-image). Thus one
Machine can be a Workflow of your Instance, a child of a different Machine, or a part of an npm package.
[Composition](composition.md) tells how one Machine invokes a different Machine.

A Workflow can also be a named [Chart](../reference/glossary.md#chart): a Machine written as data, which runs under a
Machine of the Instance. Its name is `<wrapper>/<name>`, such as `notes/summary`. It comes from a Chart file,
`workflows/<wrapper>/<name>.chart.json`, or from a runtime Chart that the Orchestrator keeps. [Charts](charts.md) tells
how.

`jr2 up` loads each Workflow before it changes the cluster. It runs the typecheck of the Instance, then it loads each
Machine and examines its parts. An error that the typecheck or the load finds stops `jr2 up`, so a run never starts with
that error. The Orchestrator runs the Machines that the last `jr2 up` gave it. After you change a Machine, run `jr2 up`
again.

## An example

This Workflow takes a refund request, and it waits for a person to approve or reject it. It has no Agent:

<<< @/examples/concepts/machines-and-workflows/refund.ts

The parts of this file are the subjects of the sections below: the door (`runInput`), the
[Vocabulary](../reference/glossary.md#vocabulary) (`approve` and `reject`), and the
[Emit](../reference/glossary.md#emit) (`decided`). The `review` state invokes a [Gate](../reference/glossary.md#gate),
which waits for an event from outside the run. [Gates](gates.md) tells how.

## The door

The door of a Machine is the input that starts a run. A Machine declares its door as a zod object in the `input` of
`createMachine`. [`jr2Setup`](../reference/authoring-surface.md#jr2setup) adds this option to `createMachine`. The same
schema, through `z.infer`, gives `types.input`, so TypeScript and jr2 agree about one shape.

With a door, jr2 does these things:

- It examines each start against the schema. When the input does not agree with the schema, the Orchestrator refuses the
  start, and no run starts. Thus a wrong input stops at the start, and not in the middle of a run.
- It starts the run with the input that zod parsed. Thus the defaults of the schema apply, and a plain `z.object`
  removes the keys that it does not declare.
- It serves the schema as JSON Schema, at [`GET /workflows/:name`](../reference/http-api.md#get-workflows-name). This
  route needs no token. The Console makes its start form from the schema.

Without a door, a run starts with any input, and the start form of the Console is a field for JSON.

The root Machine of a run also gets `instanceId`, an id that jr2 makes for the run. It is not the run id. It is not a
part of the door, because no caller sends it.
[`HostInjectedInput`](../reference/authoring-surface.md#type-hostinjectedinput) is its type.

A [`workspace()`](../reference/authoring-surface.md#workspace) or a [`pool()`](../reference/authoring-surface.md#pool)
has a door of its own. It does not use the door of the Machine inside it, because that Machine gets other input. A
`workspace()` body gets the run input and the Workspace handles. A [Pool](../reference/glossary.md#pool) worker gets its
item. Thus the wrapper declares the door, with its `input` option. `workspace()` refuses a body that declares a door.

## The Vocabulary

The Vocabulary of a Machine is the list of the workflow events that it takes. Each event comes from
[`defineEvent`](../reference/authoring-surface.md#defineevent): a name, a zod schema for its payload and, if you want, a
description. `jr2Setup` lists the events. Each name is an `on` key of the states that take it.

jr2 makes three things from the Vocabulary:

- **The Menu of each Agent.** Each event that an Agent can send is a tool for its model. The description of the event is
  the description of the tool. [The Menu](the-menu.md) tells how.
- **The events that a Gate accepts.** `jr2 send`, the Console and a webhook can send only those events.
- **The check of each delivery.** jr2 parses the payload of each event with its schema before the Machine gets the
  event.

The position of an `on` key tells which party can send the event. The key belongs to the party that its state invokes,
or to the party that the nearest state above it invokes. A party is an Agent or a Gate. The `audience` of an event can
change this. [The Menu](the-menu.md) gives the rule. Each event that a party sends carries its
[Sender](../reference/glossary.md#sender).

A Vocabulary belongs to one Machine. A child Machine keeps its own Vocabulary. The Machine that invokes it does not see
the events of the child, and does not declare them again. Thus two Machines in one run can each have an `approve` event,
with different payloads.

jr2 also sends its own events into each Machine that `jr2Setup` makes: `agent.fault` and `workspace.lost`. They are not
in the Vocabulary. Their names have a dot, and the name of a workflow event cannot have a dot.
[Mechanism events](../reference/mechanism-events.md) gives them.

## Emits

An Emit is a message that a Machine sends to the people and the tools that watch a run, such as "the review is done". A
Machine sends it with xstate's `emit()` action. jr2 has no function of its own for it. jr2 gives the Emits of each actor
in the run to the feeds, also those of each child Machine.

You see an Emit in these places:

- `jr2 run`, and `jr2 logs -f`, write each Emit on stderr while they are attached to the run. The line holds `emit`,
  then the Emit as JSON. `jr2 logs` without `-f` writes no Emit.
- The Activity tab of the Console shows the type of each Emit that comes while the page is open.
- The [Harness](../reference/glossary.md#harness) of each [Workspace](../reference/glossary.md#workspace) writes the
  Emits of its run in its log, beside the conversation of its Agents.
- The feed of a run, [`GET /runs/:runId/events`](../reference/http-api.md#get-runs-runid-events), carries each Emit with
  its payload. This feed needs the Instance token.

The feeds that need no token carry the type of an Emit, but not its payload. The payload is your data, as the context of
a run is.

An Emit does not control the run. No part of the run acts on an Emit, and an Emit does not move a Machine. Only an event
moves a Machine.

## Rules

- A Workflow is a `.ts` file in `workflows/`, and its name is the name of the file without `.ts`. The name has only
  lower-case letters, digits and `-`. A named Chart is a Workflow too, with the name `<wrapper>/<name>`.
- jr2 does not register a file whose name starts with `_`, or a `.d.ts` file. Put a Machine that only other Machines
  import in such a file. A file in `workflows/` that a different Workflow imports is also a Workflow of its own.
- A Workflow file must export `machine`. jr2 refuses a file without it.
- The name of an event has only letters, digits, `_` and `-`.
- Each `on` key of a `jr2Setup` Machine is an event of its Vocabulary, a jr2 or xstate event, which has a dot, or the
  wildcard `*`. `createMachine` refuses an `on` key that no event declares.
- Each event in the Vocabulary is an `on` key of a state. `createMachine` refuses an event that no state takes.
- A payload schema is a flat `z.object`, and it has no `sender` field. jr2 writes `sender` on each event that a party
  sends.
- When a Machine declares a door, the Orchestrator refuses a start whose input does not agree with it.
- The body of a `workspace()` declares no door. `workspace()` refuses a body that declares one.
- An Emit never moves a Machine.

[Write a Workflow](../guides/write-a-workflow.md) gives the exact text of each refusal.

## Read next

- [Write a Workflow](../guides/write-a-workflow.md)
- [Start a run](../guides/start-a-run.md)
- [Agents and Turns](agents-and-turns.md), [The Menu](the-menu.md), [Gates](gates.md) and [Charts](charts.md)
- Reference: [`jr2Setup`](../reference/authoring-surface.md#jr2setup),
  [`defineEvent`](../reference/authoring-surface.md#defineevent),
  [`HostInjectedInput`](../reference/authoring-surface.md#type-hostinjectedinput), [`jr2 run`](../reference/cli.md#run),
  [`POST /workflows/:name/runs`](../reference/http-api.md#post-workflows-name-runs) and
  [Mechanism events](../reference/mechanism-events.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): the events are the Workflow's, and jr2 delivers
  them
- [ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md): the Vocabulary and the Menus come
  from the Machine
- [ADR-0033](../reference/decisions/0033-a-machine-declares-the-input-that-starts-it.md): a Machine declares the input
  that starts it
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine carries its
  parts
- [ADR-0050](../reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md): what
  only the CLI names, jr2 finds by its file name
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): observation is open, and the state of
  a run is not
