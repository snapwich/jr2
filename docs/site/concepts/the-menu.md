---
title: The Menu
description: How an Agent picks from the events that its Machine takes, and how the Machine decides what each pick does.
---

The [Menu](../reference/glossary.md#menu) of an [Agent](../reference/glossary.md#agent) is the set of tools that the
Agent uses to speak to its [Machine](../reference/glossary.md#machine). Each tool is one workflow event of the Machine.
The Agent calls one tool, with its input. This call is a pick. The Machine decides what the pick does.

## Why the Menu exists

When a model decides the next step itself, you cannot read the control flow before a run starts. In jr2, the Machine
holds the control flow. The model chooses only from the transitions that the Machine has. A pick that the Machine does
not take moves nothing. Thus the graph that you read in the [Console](../reference/glossary.md#console) is the full set
of paths that a run can take.

The Menu does not change during a conversation. A model provider keeps the start of a conversation in a prompt cache,
and the tools block is first in it. A change to the tools block makes the provider read the full conversation again.
Thus jr2 keeps the Menu the same, and tells each [Turn](../reference/glossary.md#turn) which part of it the Turn can
pick now.

## Where the Menu comes from

You do not write the Menu. `jr2Setup` makes the Menu from the Machine when you call `createMachine`:

- A state that invokes an Agent gives the Agent the events of its own `on` keys and of the `on` keys of its parent
  states.
- It also gives the events of the `on` keys of its child states. A child state that invokes nothing is a
  [mode](../reference/glossary.md#mode). A child state that runs an [Effect](../reference/glossary.md#effect) or a child
  Machine also gives its events.
- A child state that invokes a different Agent, or a [Gate](../reference/glossary.md#gate), does not give its events.
  Those events belong to that Agent or to that Gate.
- When two or more states invoke the same Agent slot, its Menu has the events of all of them.
- The `description` of each [`defineEvent`](../reference/authoring-surface.md#defineevent) is the description of its
  tool. Make it true at each state that takes the event.

The position of an `on` key decides who can send its event. The event belongs to the party (an Agent or a Gate) that its
state, or the nearest state above it, invokes. An `on` key with no such state above it belongs to both parties. Set
[`audience`](../reference/authoring-surface.md#type-eventaudience) on an event only to give it to the other party too,
or to keep an event at the root from one party.

## A worked example

In this [Workflow](../reference/glossary.md#workflow), a writer drafts release notes. It can ask an editor a question,
and it finishes with `done`:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/the-menu/anthropic/notes.ts

== Local

<<< @/examples/concepts/the-menu/local/notes.ts

:::

The writer's Menu is `ask` and `done`. The `reply` event belongs to the Gate in `asking`, so it is not on the Menu.
`jr2 up` prints who can send what at each state. The Console shows the same seats in the "who may send what" panel of
the graph:

<!-- output: not run -->

```text
…
seats: workflow "notes" — who may send what, per state (ADR-0015)
  notes.writing agent:writer: [ask, done]
  notes.writing.asking gate: [reply]
…
```

## Allowed picks

The [Allowed picks](../reference/glossary.md#allowed-picks) are the part of the Menu that one Turn can pick now. jr2
reads them from the live Machine. They change with the active mode and with the guards. The Menu does not change.

In the example, one Turn can have three sets of Allowed picks:

| The writer is in            | Allowed picks | Why                                                                                            |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `drafting`, before a reply  | `ask`         | The guard on `done` is false.                                                                  |
| `asking`                    | none          | The `ask` pick is [outstanding](../reference/glossary.md#outstanding). The Gate is still open. |
| `drafting`, after one reply | `ask`, `done` | The guard on `done` is now true.                                                               |

The Agent reads its Allowed picks after the prompt of each Turn. It reads them again in the answer to each pick that
does not end the Turn. When the Allowed picks change while the Agent works, it reads them again before its next step.
[Agents and Turns](agents-and-turns.md) tells how jr2 gives this text to the model.

A guard that reads only the context decides the Allowed picks exactly. A guard that reads the input of the pick cannot
decide before the pick. jr2 keeps that pick in the Allowed picks, and the guard decides when the pick comes.

## One pick at a time

A pick that leaves the state that invokes the Agent ends the Turn. In the example, `done` goes to `published` and ends
the Turn. A pick whose target is inside that state keeps the Turn open. A pick with no target also keeps the Turn open.
Thus one Turn can hold many picks, and the last one leaves the state.

A pick that starts work inside the Agent's state is outstanding until that work is done. In the example, `ask` starts a
Gate in `asking`, and it is outstanding until the editor replies. While a pick is outstanding, jr2 refuses each other
pick of the Agent, and delivers nothing.

jr2 answers an outstanding pick when the Agent's state is at [Rest](../reference/glossary.md#rest). At Rest, no state
below the Agent's state runs something: an Effect, a Gate, a different Agent or a child Machine. Also, no timer is set
that moves the Machine to a different state inside the Agent's state. Rest is a condition that jr2 reads from the
Machine. A state with the name `rest` has no special meaning.

When something else leaves the Agent's state while the work of a pick runs, the work stops and the Turn ends. A timer, a
Gate or an outside event can do this. The answer tells the Agent that its pick did not finish.

## The answer to a pick

The answer comes in this order. The work of the pick finishes, then the Machine runs its route (the guards and the
actions), then jr2 answers the Agent. The answer has the Allowed picks that jr2 reads after the route.

By default, the answer is the last reply since the pick. A reply is the output of a child that ran below the Agent's
state. An event from a party below it is also a reply: a Gate's event, or the pick of a nested Agent. Every reply since
the pick, oldest first, is the [Chain](../reference/glossary.md#chain).

To give the Agent a different answer, write [`answer`](../reference/authoring-surface.md#answer) on the route. It is an
xstate action. It reads the context, the event and the Chain, and its value is the answer. In the example, the writer
reads `The editor replied: <text>` and not the raw `reply` event. Where you write `answer` decides which pick it
answers. The Reference entry gives the rule.

The error of a child is not a reply, and the Agent does not see it. To tell the Agent about an error, write `answer` on
the `onError` route.

When the route leaves the Agent's state, the Turn ends, and jr2 keeps the answer as a notice. If the Turn that made the
pick continues a conversation (`continue: true`), the next Turn on that conversation reads the notice. If it does not,
no Agent reads the answer.

## The Sender

Each event that a party sends carries its [Sender](../reference/glossary.md#sender), as `event.sender`. The Sender is
`{ party, id }`: an Agent by its slot, or a Gate by its invoke id (see
[`Sender`](../reference/authoring-surface.md#type-sender)). The [Orchestrator](../reference/glossary.md#orchestrator)
writes it on each event that a party delivers. An event that the Machine sends to itself has no Sender.

Use the Sender when two parties can send the same event to one state. The guard
[`sentBy(id)`](../reference/authoring-surface.md#sentby) is true for an event from that party, and for an event with no
Sender. It is false for an event from a different party, so xstate tries the next transition. `sentBy` can only make a
transition refuse other senders. It never gives an event to a party. The position of the `on` key does that.

## Rules

- jr2 refuses a pick that is not on the Menu.
- A pick that is on the Menu but not in the Allowed picks moves nothing. Its answer gives the Allowed picks.
- While a pick is outstanding, or while the Agent's state is not at Rest, jr2 refuses each pick and delivers nothing.
  This includes a pick that would end the Turn.
- An Agent cannot send an event to a Gate. Only the Gate's caller can.
- No party can write the Sender. `defineEvent` refuses an input with a `sender` field, and the Orchestrator refuses a
  body that has one.
- `createMachine` refuses an `on` key that no listed event has, and a listed event that no state takes.
- `createMachine` refuses a parallel state at or below a state that invokes an Agent.
- `createMachine` refuses a `sentBy` that names no Agent slot and no Gate invoke id of the Machine.
- `jr2 up` warns about a mode that no transition enters. Its picks are on the Menu, but never in the Allowed picks.
- `jr2 up` warns about a Gate below an Agent's state whose event has no target. The Gate stays open after that event, so
  the Agent's state does not come to Rest. jr2 refuses each pick of the Agent until the Gate's state exits.

## Read next

- [Write a Workflow](../guides/write-a-workflow.md)
- [Set an Agent's access and Dials](../guides/set-an-agents-access-and-dials.md)
- [Run a command or call a URL with an Effect](../guides/run-a-command-or-call-a-url.md)
- [Agents and Turns](agents-and-turns.md), [Gates](gates.md) and [Effects](effects.md)
- Reference: [`jr2Setup`](../reference/authoring-surface.md#jr2setup),
  [`defineEvent`](../reference/authoring-surface.md#defineevent), [`answer`](../reference/authoring-surface.md#answer),
  [`sentBy`](../reference/authoring-surface.md#sentby) and
  [`EventAudience`](../reference/authoring-surface.md#type-eventaudience)
- [ADR-0006](../reference/decisions/0006-agent-control-surface.md): the Agent picks from a Menu that the Machine defines
- [ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md): the Menu comes from the Machine,
  and the position of an `on` key gives it to a party
- [ADR-0024](../reference/decisions/0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md): a Turn ends with its
  state, and an outstanding pick is answered at Rest
- [ADR-0029](../reference/decisions/0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md):
  the Menu does not change, and a Turn reads its Allowed picks
- [ADR-0067](../reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md):
  `answer`, and the Chain
