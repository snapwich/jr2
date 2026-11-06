---
title: Steer an Agent
description: Send free text to one Agent of a live run, from the CLI, from HTTP, or from the Machine itself.
---

Send free text to one [Agent](../reference/glossary.md#agent) of a live run, from the CLI, from HTTP, or from the
[Machine](../reference/glossary.md#machine) itself.

A [Steering message](../reference/glossary.md#steering-message) is not a pick and not an event. No guard reads it, and
no [Gate](../reference/glossary.md#gate) takes it. The Agent hears it one time, and nothing interrupts the Agent. Then
the Agent decides what to do, and it acts on the run only with its picks. To move the run, answer a Gate:
[Answer a Gate](answer-a-gate.md).

The examples on this page use the [Workflow](../reference/glossary.md#workflow) `notes`. A writer writes release notes,
and a reviewer reads them. When the reviewer sends a note, the Machine relays it to the writer as a Steering message.
Save the file as `workflows/notes.ts` in your [Instance](../reference/glossary.md#instance). Then run `jr2 up`:

<<< @/examples/guides/steer-an-agent/notes.ts

In the commands, replace these values:

- `<namespace>`: the namespace of your Instance. It is the [`name`](../reference/config.md#name) in `jr2.config.ts`.
  When `jr2.config.ts` sets no `name`, it is the name of the Instance folder.
- `<run id>`: the run id, or its first 4 characters or more. `jr2 run` prints the run id in the line
  `run <run id> (<workflow>) — attached`.

Give each `jr2` command in the Instance folder.

## Start a run

```sh
jr2 run notes --input '{"version":"1.4.0"}'
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
run 5c1f0b8e-6d4a-4f0e-9a51-2a8d7c3e9b10 (notes) — attached
  → active "writing"
```

Your run id is different. Give the commands in the next steps in a second terminal.

## Find the Agent slot

A message goes to an Agent slot: the path of the Machine and the name of the Agent. The Agents of the root Machine have
the path `root`. An Agent in a child Machine has the path of that Machine, such as `review/reviewer`. Give
[`jr2 steer`](../reference/cli.md#steer) the run id alone to list the slots:

```sh
jr2 steer 5c1f
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
[{"agent":"root/writer","open":true,"steerable":true},{"agent":"root/reviewer","open":false,"steerable":false}]
```

- `open` is `true` when a [Turn](../reference/glossary.md#turn) of the slot is open now.
- `steerable` is `false` when the definition of the Agent says `steerable: false`. A Caller cannot steer it.

The list has each Agent of each Machine instance that is live now, also an Agent with no open Turn.

## Send the message

```sh
jr2 steer 5c1f root/writer "Put the breaking change first."
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
sent a Steering message to root/writer on 5c1f0b8e-6d4a-4f0e-9a51-2a8d7c3e9b10: its open Turn hears it at its next step boundary
```

Then one of these things occurs:

- When a Turn of the slot is open, the Harness adds the message to the Turn before the next model request.
- When no Turn of the slot is open, the message waits. The next Turn of the slot in the same Machine instance hears it,
  and `jr2 steer` prints `its next Turn hears it`.
- When that Machine instance ends first, the message is not delivered.

## Read what became of the message

[`jr2 status`](../reference/cli.md#status) prints the record of the messages of the run in its `steering` field. Each
entry has the slot, the author, the text, the time, and the `outcome`: `held` while it waits, `heard` when a Turn heard
it, or `not-delivered` when its Machine instance ended first.

```sh
jr2 status 5c1f
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"5c1f0b8e-6d4a-4f0e-9a51-2a8d7c3e9b10","workflow":"notes",…,"steering":[{"id":"9d2e4c1a-0b7f-4e3d-8c6a-5f1e2d3c4b5a","agent":"root/writer","author":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"text":"Put the breaking change first.","at":"2026-11-03T15:02:11.204Z","outcome":"heard"}],…}
```

The model reads the message after the notices of the Turn and before its Allowed picks. The Harness tells the model that
the message is an instruction from outside the run, and gives your name as a [Caller](../reference/glossary.md#caller).

## Send the message from the Console

With a credential that has the `steer` scope for the Workflow, the [Console](../reference/glossary.md#console) shows a
box beside the conversation in the bottom drawer. Select the run, and click the tab of the Agent slot. Type the message
in the box under `steer <slot>`, and click `send`. The box shows `<slot> cannot be steered now` when the definition of
the Agent says `steerable: false`, or when the Machine instance of the slot ended. The conversation shows the message
where the model read it. [Open the Console](open-the-console.md#read-a-conversation) tells how to open the drawer.

## Send the message from HTTP

A client that is not the CLI sends the message to
[`POST /runs/:runId/steering`](../reference/http-api.md#post-runs-runid-steering), with the credential of a Caller that
has the `steer` scope for the Workflow of the run. [Give a Caller a scope](give-a-caller-a-scope.md) makes such a token.
The path takes the full run id, not a prefix.
[`GET /runs/:runId/agents`](../reference/http-api.md#get-runs-runid-agents) lists the slots. This example reaches the
Orchestrator through the port forward in [Open the Console](open-the-console.md):

```sh
curl -X POST http://localhost:4000/runs/<run id>/steering \
  -H "authorization: Bearer <token>" \
  -d '{"agent":"root/writer","text":"Put the breaking change first."}'
```

<!-- output: not run -->

```text
{"id":"9d2e4c1a-0b7f-4e3d-8c6a-5f1e2d3c4b5a","agent":"root/writer","open":true}
```

The status is 202.

## Steer from the Machine

The Machine sends a Steering message with the [`steer`](../reference/authoring-surface/steer.md) action, in a
transition. In `notes.ts`, the `note` pick of the reviewer sends the writer back to `writing`, and `steer` gives the
reviewer's text to the writer's next Turn.

`from` names the [Sender](../reference/glossary.md#sender) of the event: here, the reviewer. Then the writer reads the
text as information from a peer, not as an instruction. When `from` is a Gate, the writer reads the text as what the
Gate received, not as an order: the workflow did not write it. A `steer` with no `from` is the text of the workflow
itself. Agents tell each other things only in this way: jr2 gives an Agent no tool to message another Agent.

The Machine can steer an Agent whose definition says `steerable: false`. That refuses Callers only.

## Rules

- A message is at most 16 KiB of UTF-8. `POST /runs/:runId/steering` refuses a longer text with the status 413:
  `the text is longer than 16384 bytes (16 KiB)`. The `steer` action cuts a longer text and adds
  `[jr2 cut this message at 16 KiB]`.
- A body with no `agent`, or no `text`, gets the status 400.
- A slot that no live Machine instance of the run holds gets the status 409, with the slots of the run in `agents`:
  `no live Machine instance of run "<run id>" holds the Agent slot "<agent>" (its slots: <slots>)`. A run that has ended
  gets 409 too: `run "<run id>" is not live: no Agent of it can hear a message`.
- A slot whose Agent says `steerable: false` gets the status 403:
  `the Agent slot "<agent>" is not steerable: its definition says steerable: false`.
- A Caller with no `steer` scope for the Workflow of the run gets the status 403:
  `the Caller <via>/<name> needs the "steer" scope for Workflow "<workflow>" (ADR-0078)`.
- An unknown run gets the status 404: `no run "<run id>"`.
- The record keeps the newest 100 messages of a run, and each message that waits.

## Read next

- [Agents and Turns](../concepts/agents-and-turns.md#steering-messages)
- [`jr2 steer`](../reference/cli.md#steer) and [`steer`](../reference/authoring-surface/steer.md)
- [ADR-0002](../reference/decisions/0002-duplex-streaming-actor.md#steering-messages): Steering messages
- [ADR-0062](../reference/decisions/0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md): one ledger for notices
  and Steering messages
