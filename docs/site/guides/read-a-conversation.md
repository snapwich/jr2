---
title: Read a conversation
description: Read what an Agent said and did in a run, live or after the run ended, with jr2 logs or the Console.
---

Read the [Conversation](../reference/glossary.md#conversation) of each [Agent](../reference/glossary.md#agent) of a run,
while the run continues or after it ended.

The [Harness](../reference/glossary.md#harness) of each Agent sends the entries of its conversation to the
[Orchestrator](../reference/glossary.md#orchestrator) during the [Turn](../reference/glossary.md#turn). The Orchestrator
keeps them for as long as it keeps the run. Thus you can read a conversation after its
[Sandbox](../reference/glossary.md#sandbox) is gone. A [Menu](../reference/glossary.md#menu)-only Agent sends its
conversation in the same way.

The examples on this page use a run of the `task` [Workflow](../reference/glossary.md#workflow) of
[An Agent in a Sandbox](../get-started/an-agent-in-a-sandbox.md), with the prompt
``In docs/intro/repo, run `node bin/greet.js`. Then finish, with what it printed.``. In the commands, replace `<run id>`
with the run id, or its first 4 characters or more. `jr2 run` prints the run id in the line
`run <run id> (<workflow>) — attached`.

Give each `jr2` command in the [Instance](../reference/glossary.md#instance) folder.

## Print the conversations of a run

Run [`jr2 logs`](../reference/cli.md#logs) with the run id. It prints the conversation of each Agent of the run, in the
order of the time of each entry:

```sh
jr2 logs <run id>
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [prompt] In docs/intro/repo, run `node bin/greet.js`. Then finish, with what it printed.
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] Work in /work/target/task, on branch jr2/task-84f810c8-dda7-4577-a57e-4a09a4e7f507 — your tools are rooted there, so a relative path lands inside it. Commit what you do there, then call finish.
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] <jr2-turn>
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] Working directory: /work/target/task
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] Allowed now: `mcp__jr2__finish`.
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] </jr2-turn>
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [thinking] The user wants me to:
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] 1. Run `node bin/greet.js` from the `docs/intro/repo` directory within the worktree
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] 2. Report what it printed
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] 3. Commit my work and call finish
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] Let me first run the command.
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [text]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [bash] cd /work/target/task && node docs/intro/repo/bin/greet.js
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [thinking] The command printed "hello, world". Now I need to finish with that information.
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [text]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder]
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [finish] {"summary":"Ran `node bin/greet.js` from docs/intro/repo. It printed: hello, world"}
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [finish answer] Delivered "finish" to the workflow (delivery 1b61fa16-50b7-4202-b7ed-b46a6ead5930). The workflow consumed it and moved on: your turn is over.
```

The thinking, the calls and the text are the words of the model, so your conversation is different. Your ids are
different too.

`jr2 logs` prints the conversation lines of the pod log of the Harness. It does not print the lines of the story of the
run: `[run] …`, and `[<agent>] [admitted] …` and `[<agent>] [pick] …`, which have no Instance ID.
[Watch a run](watch-a-run.md#read-the-pod-log) tells how to read the pod log.

## Print the conversation of one Agent

Give an Agent slot, or the name of an Agent, after the run id. An Agent slot is the path of the
[Machine](../reference/glossary.md#machine) of the Agent, then its name, such as `body/coder`.
[`jr2 steer`](../reference/cli.md#steer) `<run id>` lists the Agent slots of a live run. A name, such as `coder`, prints
each conversation of the Agents of that name:

```sh
jr2 logs <run id> coder
```

When the run keeps no conversation of that Agent, `jr2 logs` lists the Agents that it keeps. Without `-f`, it then exits
with `1`. With `-f`, it waits for the conversation of that Agent.

## Follow a conversation

Add `-f` to print each new entry when the Orchestrator keeps it:

```sh
jr2 logs <run id> -f
```

`jr2 logs -f` first prints what the Orchestrator keeps. Then it follows each conversation that has an open Turn, and it
finds each new conversation of the run. It stops when the run ended and no Turn is open. The Harness sends its entries
when the model's answer ends, at the end of the Turn, and about one time each second. Thus a line comes a short time
after the model wrote it.

## Read the lines

Each line starts with the name of the Agent in brackets, then the [Instance ID](../reference/glossary.md#instance-id) of
the conversation in brackets. The Instance ID starts with the run id. The first line of each entry then has a label in
brackets. The next lines of the same entry have no label:

| Line                                          | What it shows                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[<agent>] [<iid>] [prompt] <text>`           | A message that the model reads: the prompt of the Turn, or a message that jr2 adds to the Turn, such as a [Steering message](../reference/glossary.md#steering-message) or a notice. |
| `[<agent>] [<iid>] [thinking] <text>`         | The thinking of the model.                                                                                                                                                           |
| `[<agent>] [<iid>] [text] <text>`             | The text of the model.                                                                                                                                                               |
| `[<agent>] [<iid>] [<call>] <input>`          | A call of a [Working tool](../reference/glossary.md#working-tools), or a pick from the Menu. `<input>` is a path for read, write and edit, the command for `bash`, or else JSON.     |
| `[<agent>] [<iid>] [<server>/<tool>] <input>` | A call of an [MCP tool](../reference/glossary.md#mcp-tools): the server's name in `jr2.config.ts`, then the tool. `<input>` is JSON. A pick never prints with a `/`.                 |
| `[<agent>] [<iid>] [<pick> answer] <text>`    | The answer that the model got for a pick from its Menu.                                                                                                                              |
| `[<agent>] [<iid>] [<pick> error] <text>`     | An answer to a pick that the model reads as an error, such as a refusal.                                                                                                             |
| `[<agent>] [<iid>] [compacted] <text>`        | The Harness made the context of the conversation smaller: `context <before> → ~<after> tokens (window <window>)`.                                                                    |
| `[<agent>] [<iid>] [thinking level] <text>`   | The model has no thinking level of the name that the Turn asked for, and the line names the level that the model ran at. The Harness prints it one time for each Turn.               |
| `[<agent>] [<iid>] [cut] <text>`              | The Orchestrator keeps no more entries of this conversation. See [Rules](#rules).                                                                                                    |

The conversation does not hold the result of a Working tool or of an MCP tool. For example, it does not hold the text of
a file that the Agent read, or the output of a command that the Agent ran. The Harness cuts an input that is longer than
2000 characters at its end, and marks the cut with `…`. It cuts a long answer to a pick in its middle, and marks the cut
with `… [<n> characters cut] …`. The model reads the full text.

## Read a conversation in the Console

With a [Caller](../reference/glossary.md#caller) token that has the `read` scope for the Workflow, the
[Console](../reference/glossary.md#console) shows the conversations of the run that you select:

- The bottom drawer has one tab for each Agent slot of the run. A dot on a tab shows a slot whose Turn is open.
- Click a tab. The drawer opens on the conversation of that slot. While the Turn is open, the drawer adds each new
  entry.
- The drawer folds each pick with its answer. A Working tool's call shows no result. It shows the Steering messages, the
  notices and each [Compaction](../reference/glossary.md#compaction).
- The Fleet rail lists the ended runs of the Workflow under its live runs. Click an ended run to read its conversations.

[Open the Console](open-the-console.md#read-a-conversation) tells more.

## Keep conversations for a different time

The Orchestrator keeps an ended run, with its conversations, for 30 days. To change the time, set
[`runs.retain`](../reference/config.md#runs) in `jr2.config.ts`. The conversations are on the state volume of the
Orchestrator. A new volume claim is `5Gi` by default. To make it larger, set `runs.volume`:

<<< @/examples/guides/read-a-conversation/jr2.config.ts

Then run [`jr2 up`](../reference/cli.md#up). The Orchestrator uses the new `retain` at its next sweep, one time each
hour. When `runs.volume` is larger than the volume claim, `jr2 up` makes the claim larger, but only when its
StorageClass allows expansion. The `standard` class of kind does not. Thus on kind, with the claim of `5Gi` that the
first `jr2 up` made, `jr2 up` refuses, and applies nothing:

<!-- output: not run -->

```text
…
refusing: runs.volume is 20Gi, larger than the state volume claim jr2-state (5Gi), and its StorageClass "standard" does not allow expansion (allowVolumeExpansion is not true). Keep runs.volume at 5Gi, or use a StorageClass that allows expansion (ADR-0065). Nothing was applied.
```

On kind, set `runs.volume` before the first `jr2 up` of the Instance. A new claim takes that size, and `jr2 up` prints
no line about it. A live run and its conversations stay, whatever their age.

## Rules

- The Orchestrator keeps at most 8 MiB of one conversation. It keeps the start of the conversation. In place of the
  entry that goes above the limit, it keeps one entry `[cut]`, and it keeps no entry after it:
  `the Orchestrator keeps no more of this conversation: it is at its cap of 8 MiB (ADR-0023)`
- When the state volume is more than 80% full, the Orchestrator deletes the conversations of the runs that ended, the
  oldest run first, until the volume is less than 80% full. It does not delete the row of the run. It never deletes a
  conversation of a live run for space. `jr2 logs` prints `<agent slot> [<iid>]: no space` in place of a conversation
  that it deleted, and `jr2 status` and `jr2 runs` give the run `swept: "conversation swept: no space"`.
- When the volume is more than 95% full and no ended run has a conversation to delete, the Orchestrator keeps no more
  entries of each open conversation:
  `the Orchestrator keeps no more of this conversation: its state volume is full (ADR-0065)`
- `jr2 logs` with an Agent that the run keeps no conversation of prints a line on stderr. Without `-f`, it then exits
  with `1`; with `-f`, it waits: `run <run id> keeps no conversation of "<agent>" — its Agents: <slots>`
- When the run keeps no conversation at all, the line ends differently:
  `run <run id> keeps no conversation of "<agent>" — it keeps no conversation yet`
- The routes of the conversations refuse a Caller without the `read` scope for the Workflow of the run, with the status
  code `403`: `the Caller <via>/<name> needs the "read" scope for Workflow "<workflow>" (ADR-0078)`. A Caller with the
  `read` scope for no Workflow gets this refusal first:
  `the Caller <via>/<name> has no "read" scope for any Workflow (ADR-0078)`
- `GET /runs/:runId/conversations/:instanceId` refuses an Instance ID that the run does not keep, with the status code
  `404`: `run "<run id>" keeps no conversation "<iid>"`
- `runs.retain` is a number and `m`, `h`, `d` or `w`. The config load refuses another value:
  `<file> at runs.retain: "<value>" is not a duration — a number and m, h, d or w, such as "30d" (ADR-0065)`
- The config load refuses a `runs.retain` that is shorter than one hour:
  `<file> at runs.retain: "<value>" is shorter than 1h — jr2 keeps an ended run for at least 1h (ADR-0065)`
- The config load refuses a `runs.volume` with no unit:
  `<file> at runs.volume: "<value>" is not a storage quantity — a number and a unit, such as "5Gi" or "500Mi" (ADR-0065)`
- `jr2 up` grows the claim when `runs.volume` is larger and the StorageClass allows expansion:
  `state volume: growing the claim jr2-state from <claim size> to <size>`
- `jr2 up` keeps the size of a claim that exists when `runs.volume` is not set, and the claim is not `5Gi`:
  `state volume: keeping the claim jr2-state at <claim size> — runs.volume is not set, and the default 5Gi is for a new claim`
- `jr2 up` refuses, and applies nothing, when it cannot read the claim:
  `refusing: cannot read the state volume claim jr2-state in namespace "<namespace>" (<error>). Nothing was applied.`
- `jr2 up` refuses, and applies nothing, when `runs.volume` is larger and it cannot read the StorageClass:
  `refusing: runs.volume is <size>, larger than the state volume claim jr2-state (<claim size>), and jr2 cannot read StorageClass "<class>" to see if it allows expansion (<error>). Nothing was applied.`
- `jr2 up` refuses a `runs.volume` that is smaller than the claim, and applies nothing:
  `refusing: runs.volume is <size>, smaller than the state volume claim jr2-state (<claim size>) — Kubernetes never makes a claim smaller. Set runs.volume to <claim size> or more (ADR-0065). Nothing was applied.`
- `jr2 up` refuses a larger `runs.volume` on a StorageClass that does not allow expansion, and applies nothing:
  `refusing: runs.volume is <size>, larger than the state volume claim jr2-state (<claim size>), and its StorageClass "<class>" does not allow expansion (allowVolumeExpansion is not true). Keep runs.volume at <claim size>, or use a StorageClass that allows expansion (ADR-0065). Nothing was applied.`

::: warning

A Caller with `read` can read each conversation of the Workflow, and the answers that jr2 gives to the picks. An answer
can hold the output of a [`command`](../reference/authoring-surface/command.md)
[Effect](../reference/glossary.md#effect). Give `read` only to the Callers that can see that output.
[Secrets and trust](../concepts/secrets-and-trust.md) tells what a conversation can hold.

:::

## Read next

- [Agents and Turns](../concepts/agents-and-turns.md)
- [Durable runs](../concepts/durable-runs.md): how long jr2 keeps a run.
- [ADR-0023](../reference/decisions/0023-the-harness-prints-the-conversation.md): the Harness prints the conversation,
  and the Orchestrator keeps it.
- [ADR-0065](../reference/decisions/0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md):
  `runs.retain`, `runs.volume` and the space guard.
- Reference: [`jr2 logs`](../reference/cli.md#logs), [`runs`](../reference/config.md#runs),
  [`GET /runs/:runId/conversations`](../reference/http-api.md#get-runs-runid-conversations)
- [Watch a run](watch-a-run.md)
