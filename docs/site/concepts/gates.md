---
title: Gates
description: How a run waits for an event from a person, the CLI, the Console, a Hook or a CI job.
---

A [Gate](../reference/glossary.md#gate) is an input that a run waits for from outside the run. A person, a CI job or a
[Hook](../reference/glossary.md#hook) can send it. A state of a [Machine](../reference/glossary.md#machine) opens a Gate
when it invokes the `gate` actor, and the Gate closes when the state exits. While the Gate is open, a caller can send
one of its events.

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

::: graph @/examples/concepts/gates/ci-release.ts

:::

You do not import the `gate` actor. `jr2Setup` adds it, and a state invokes it as `invoke: { src: "gate" }`. Its input
is optional. It can hold `meta`, and an authored `gate` id. A Gate that hears a Hook is a Gate slot, which you declare
with `gate({ … })` (see [A Gate that hears a Hook](#a-gate-that-hears-a-hook)).

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

`meta` is data for the caller. It tells a person what to decide, and it lets the handler of a Gate slot find the correct
Gate. In the example, the `review` Gate shows the version and the URL of the CI job. jr2 does not read the `meta` of a
plain Gate. A Gate slot checks its `meta` against its schema when it opens.

### The callers

A caller finds the open Gates of all the live runs that it can answer with
[`GET /gates`](../reference/http-api.md#get-gates), the oldest first, and the open Gates of one run with
[`GET /runs/:runId`](../reference/http-api.md#get-runs-runid). Each Gate gives its id, its events with their input
schemas, `acceptsNow` and `meta` (see [`GateView`](../reference/http-api.md#type-gateview)). Then the caller sends one
event, with its input. These callers use the same route,
[`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events), with the
[Instance](../reference/glossary.md#instance) token:

- **The [jr2 CLI](../reference/glossary.md#jr2-cli).** [`jr2 gates`](../reference/cli.md#gates) prints the open Gates of
  all the live runs that you can answer, the oldest first, each with the time when it opened.
  [`jr2 status`](../reference/cli.md#status) prints the open Gates of one run under `gates`.
  [`jr2 send`](../reference/cli.md#send) with `--gate` sends an event to one of them.
- **The [Console](../reference/glossary.md#console).** When you type a token with the `answer` scope, or log in, the
  Attention tab shows a card for each open Gate of the Workflows of that scope. The card has a form for each event.
- **A CI job.** Any client that can reach the [Orchestrator](../reference/glossary.md#orchestrator), and that holds a
  credential with the `answer` scope, can send to a Gate. It can call the route, or run `jr2 send` with `--url` and
  `JR2_TOKEN`.
- **A Hook.** A Gate slot's handlers turn a delivery of an outside service into one of the Gate's events (see below).

The [Sender](../reference/glossary.md#sender) of the event is the Gate, by its invoke id. The invoke id is not always
the id that a caller uses. The Sender also carries the [Caller](../reference/glossary.md#caller) that answered: `via`,
`name`, `onBehalfOf` when the Caller gives it, and `checked`, the fields that jr2 verified.
[The Sender](the-menu.md#the-sender) tells how to use the Sender, and why you must not trust an `onBehalfOf` that
`checked` does not name.

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

A Pool that has a `wake` event, or a Source that hears a Hook, serves a Gate with the id `source`. A Hook's delivery
reaches the Source's handlers through it (see [Pools and Sources](pools-and-sources.md#a-hook-reaches-a-source)).

## A Gate that hears a Hook

A [Hook](../reference/glossary.md#hook) checks that a delivery comes from its service, and decides nothing
([Callers and Hooks](callers-and-hooks.md) tells what the door of a Hook does). A Gate decides what the delivery means
for its run. Thus a Gate that hears a Hook is an extension of the Gate, and not a second concept. You declare it as a
Gate slot in `actors`, as `actors: { review: gate({ meta, delivers, hooks, look, reply }) }`, and a state invokes it by
its key, as `invoke: { src: "review" }`.

- **`meta`** is a zod object. The Gate checks the state's `meta` against it when it opens, and its handlers and its look
  read the `meta` typed.
- **`delivers`** lists the events that the handlers and the look can give. An event whose def does not set `audience` is
  `"external"` here, so an Agent below the Gate does not have it on its Menu. `createMachine` refuses an event of
  `delivers` that the Gate does not take at the state that invokes it.
- **`hooks`** has a handler for each [Hook kind](../reference/glossary.md#hook-kind) and event key, such as
  `github: { "pull_request_review.submitted": handler }`. A delivery goes to each open Gate whose handlers hear its kind
  and key. The handler compares the payload with the `meta`, and gives one event of `delivers`, or `undefined`. It is
  pure and synchronous.
- **`look`** reads the fact that the Gate waits for. It reads once after the Gate opens, again after each restart of the
  Orchestrator, and every `every` (default `"10m"`) while the Gate is open, until the run takes the event that `until`
  gives. So a delivery that came before the Gate opened, or that was lost in an outage, does not stop the run. The read
  is an `http` Effect marked `idempotent: true`, or a promise. A looked event has the Gate as its Sender and no Caller,
  and the run's feed shows `looked`. `look: "none"` is for a Gate that hears a command, such as `/retry`, which no read
  can find. A packaged Machine leaves its look `open`, and the composer binds it with
  `customize(machine, { gates: { <slot>: { look } } })`.
- **`reply`** gives the text that the person who acted reads, for a kind whose answer a person reads: a Slack command or
  click, or a Discord interaction. `reply(outcome, { meta, caller })` is pure and synchronous. `outcome.state` is
  `delivered`, with the event, or `refused`, with the reason. It runs after the run answers. It does not run for a Gate
  whose handler gave `undefined`, because that Gate was not a target. It runs for every other target, and a handler that
  threw is one of them: its `outcome` is `refused`, with the reason. It gives plain text or `undefined`. The Hook kind
  escapes the text and shows it only to the person who acted.

### The answer that a person reads

For a chat command or click, the Hook's door answers 200 with one text in the kind's envelope, not the outcome JSON:

- The door joins the `reply` text of each target. A Source's text comes first, then a Gate's. In each, the order is by
  Workflow name and then by run id. The door drops an empty text and a text that is the same as one before it. The text
  of a Source's `skipped` verdict shows only when no other target gave a text.
- When no target gives a text, the door writes one: for example `Nothing in jr2 waits for this now.`, or that jr2 got
  the delivery before.
- Where the door's rules give 429 or 503, the person gets 200, and a line of the text says why. The hook log keeps the
  status of the rules.
- The door cuts the text to the limit of the kind (Discord: 2000 characters; Slack: 4000).
- Slack shows no text in the answer to a click. Thus the door answers the click with an empty 200, and then posts the
  text to the click's `response_url` through the Instance Effector. A post that fails is a `follow-up` line in
  [`jr2 hooks <name>`](../reference/cli.md#hooks).

A message that everyone in the channel sees is a change of shared state. Write it as an `http` Effect of the Machine.

A Chart can invoke a Gate slot that its Open body lends in `lends.gates` (see [Charts](charts.md)). The Chart must
declare each event of the slot's `delivers` in its `events`.

[Answer a Gate from a forge](../guides/answer-a-gate-from-a-forge.md) shows a full example.

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
- `jr2 up` warns about a Gate slot that hears a Hook and has no look and no `after` on its state, and about a look that
  a package left `open` and that nobody bound. A person can still answer that Gate with `jr2 send`.
- A Gate slot's handler that throws, or that gives an event that the run does not take now, never faults the run. The
  Hook's answer names the Gate in `refused`, and the run's feed shows `hook-refused`.

## Read next

- [Answer a Gate](../guides/answer-a-gate.md) and [Answer a Gate from a forge](../guides/answer-a-gate-from-a-forge.md)
- [Open the Console](../guides/open-the-console.md)
- [The Menu](the-menu.md), [Callers and Hooks](callers-and-hooks.md), [Pools and Sources](pools-and-sources.md) and
  [Durable runs](durable-runs.md)
- Reference: [`jr2 send`](../reference/cli.md#send), [`jr2 status`](../reference/cli.md#status),
  [`GET /runs/:runId`](../reference/http-api.md#get-runs-runid),
  [`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events),
  [`GateView`](../reference/http-api.md#type-gateview) and [`sentBy`](../reference/authoring-surface/sentby.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): a Gate is an addressable resource on a run, and a
  Gate slot hears a Hook and looks before it waits
- [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md): an Agent
  cannot send to a Gate, and a send that the run does not take is refused
- [ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md): the position of an `on` key gives
  its event to a Gate or to an Agent
- [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-a-callers-credential.md): the Console sends to a Gate
  with a Caller's credential
