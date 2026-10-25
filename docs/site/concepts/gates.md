---
title: Gates
description: How a run waits for an event from a person, the CLI, the Console, a webhook or a CI job.
---

A [Gate](../reference/glossary.md#gate) is an input that a run waits for from outside the run. A person, a CI job or a
webhook can send it. A state of a [Machine](../reference/glossary.md#machine) opens a Gate when it invokes the `gate`
actor, and the Gate closes when the state exits. While the Gate is open, a caller can send one of its events.

## Why Gates exist

Some decisions do not belong to a model. A person approves a release. A CI job reports that the tests pass. An
[Agent](../reference/glossary.md#agent) must not approve its own work. A Gate is the place in the Machine where such a
decision comes in. You see it as a state in the graph of the Machine before a run starts.

A Gate has an address, because more than one Gate can be open at the same time. For example, a
[Pool](../reference/glossary.md#pool) can run three workers that each wait at a review Gate. A caller sends an event to
one Gate by its id, and not to the run.

## How a Gate behaves

In this [Workflow](../reference/glossary.md#workflow), `ci-release`, a CI job answers the first Gate, and a person
answers the second one:

<<< @/examples/concepts/gates/ci-release.ts

You do not import the `gate` actor. `jr2Setup` adds it, and a state invokes it as `invoke: { src: "gate" }`. Its input
is optional. It can hold `meta`, and an authored `gate` id.

### The id

By default, jr2 makes the id of a Gate from the keys of the states. It joins the keys from the root of its Machine down
to the state that invokes it, with a `.` between them. In the example, the ids are `checks` and `review`. When the
Machine runs inside a different Machine, the id starts with the invoke ids above it. For example, the `review` Gate of a
Machine that [`workspace()`](../reference/authoring-surface/workspace.md) wraps has the id `body.review`. In a Pool, the
id of each worker's Gate includes the id of its item. Thus two workers that wait at the same state have different Gate
ids.

To give a Gate a name of your own, set `gate` in its input, for example `{ gate: "F-12" }`. Then you must make sure that
no two open Gates of the run have that id. jr2 refuses the second one when it opens. jr2 keeps the Gate ids of each run
apart, so two runs can use the same id.

### The events that a Gate takes

A Gate takes the events of the `on` keys of its own state, and of its child states that invoke no party. It also takes
the events of its parent states that belong to no other party. The position of the `on` key decides this, as it does for
the [Menu](../reference/glossary.md#menu) of an Agent. [The Menu](the-menu.md) gives the full rule. Set
[`audience`](../reference/authoring-surface/type-eventaudience.md) on an event only to give it to the other party too.

A Gate takes some of its events now and other events later, because of the guards. `acceptsNow` is the list of events
that the run takes from the Gate now. jr2 refuses an event that is not in `acceptsNow`, and the run does not move. When
`acceptsNow` is empty, the Gate waits.

### The meta

`meta` is data for the caller. It tells a person what to decide, and it lets a webhook find the correct Gate. In the
example, the `review` Gate shows the version and the URL of the CI job. jr2 does not read `meta`.

### The callers

A caller finds the open Gates of a run with [`GET /runs/:runId`](../reference/http-api.md#get-runs-runid). Each Gate
gives its id, its events with their input schemas, `acceptsNow` and `meta` (see
[`GateView`](../reference/http-api.md#type-gateview)). Then the caller sends one event, with its input. These callers
use the same route,
[`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events), with the
[Instance](../reference/glossary.md#instance) token:

- **The [jr2 CLI](../reference/glossary.md#jr2-cli).** [`jr2 status`](../reference/cli.md#status) prints the open Gates
  of a run under `gates`. [`jr2 send`](../reference/cli.md#send) with `--gate` sends an event to one of them.
- **The [Console](../reference/glossary.md#console).** When you type the Instance token, the Attention tab shows a card
  for each open Gate. The card has a form for each event.
- **A webhook or a CI job.** Any client that can reach the [Orchestrator](../reference/glossary.md#orchestrator), and
  that holds the Instance token, can send to a Gate. It can call the route, or run `jr2 send` with `--url` and
  `JR2_TOKEN`.

The [Sender](../reference/glossary.md#sender) of the event is the Gate, by its invoke id, and not the person or the
system behind it. The invoke id is not always the id that a caller uses. [The Menu](the-menu.md) tells how to use the
Sender.

### A run that waits

A run that waits at a Gate does not end. `jr2 run` stays attached until the run ends. The run also waits through a
restart of the Orchestrator (see [Durable runs](durable-runs.md)). A [Workspace](../reference/glossary.md#workspace)
whose Machine waits at a Gate keeps its [Sandbox](../reference/glossary.md#sandbox), so that you can look at the work
(see [Workspaces](workspaces.md)).

A Gate can be inside the state of an Agent. Then the Agent's pick that opened the Gate stays
[outstanding](../reference/glossary.md#outstanding) until the Gate's event moves the Machine out of the Gate's state. By
default, the Gate's event is the answer to the pick. The Gate takes its own events. It does not take the picks of the
Agent, unless an event's `audience` is `"any"`. [The Menu](the-menu.md) tells how jr2 answers the pick.

After each answer, the Agent can pick again, so it can ask and get answers with no end. To stop this loop, put a guard
on the pick. For example, `guard: ({ context }) => context.replies < 1` allows one question only. A guard that reads
only the context removes the pick from the [Allowed picks](the-menu.md#allowed-picks).

A Pool that has a `wake` event serves it as a Gate with the id `source` (see [Pools and Sources](pools-and-sources.md)).

## Rules

- jr2 refuses an event from an Agent to a Gate, because a Sandbox token cannot send to the Gates route. Thus an Agent
  cannot approve its own work.
- jr2 refuses these events to a Gate, and nothing moves:
  - an event that the Gate does not take
  - an input that does not agree with the event's schema
  - an event that is not in `acceptsNow`
- jr2 refuses an event to a Gate that is not open: its state has exited, or the run has ended.
- jr2 refuses an event body that has a `sender` field. Only the Orchestrator writes the Sender.
- A Gate that takes no events does not open. Its invoke fails with an error that names the Gate.
- jr2 refuses a second open Gate with the same id in one run.
- `jr2 up` warns about a Gate above an Agent's state that takes an event that the Agent can also reach. The Gate's
  caller can send the event, and the Agent cannot.

## Read next

- [Answer a Gate](../guides/answer-a-gate.md)
- [Open the Console](../guides/open-the-console.md)
- [The Menu](the-menu.md), [Pools and Sources](pools-and-sources.md) and [Durable runs](durable-runs.md)
- Reference: [`jr2 send`](../reference/cli.md#send), [`jr2 status`](../reference/cli.md#status),
  [`GET /runs/:runId`](../reference/http-api.md#get-runs-runid),
  [`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events),
  [`GateView`](../reference/http-api.md#type-gateview) and [`sentBy`](../reference/authoring-surface/sentby.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): a Gate is an addressable resource on a run
- [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md): an Agent
  cannot send to a Gate, and a send that the run does not take is refused
- [ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md): the position of an `on` key gives
  its event to a Gate or to an Agent
- [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-the-instance-token.md): the Console sends to a Gate
  with the Instance token
