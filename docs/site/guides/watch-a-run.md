---
title: Watch a run
description: "See where a run is and what its Agents do: in the CLI, in the Console, and in the pod log."
---

See where a run is and what its [Agents](../reference/glossary.md#agent) do, in the CLI, the
[Console](../reference/glossary.md#console) and the pod log of an Agent.

The CLI shows the status of a run: where its [Machine](../reference/glossary.md#machine) is, its context, and its open
[Gates](../reference/glossary.md#gate). The Console shows where the Machine is and, with the Instance token, the open
Gates. The pod log shows the conversation of each Agent: its prompts, its text, and its calls.

The examples on this page use a run of the [Workflow](../reference/glossary.md#workflow) `release`. Its Gate `review`
waits for `approve` or `reject`. [Answer a Gate](answer-a-gate.md) gives the file `workflows/release.ts`. In the
commands, replace these values:

- `<namespace>`: the namespace of your [Instance](../reference/glossary.md#instance). It is the
  [`name`](../reference/config.md#name) in `jr2.config.ts`. When `jr2.config.ts` sets no `name`, it is the name of the
  Instance folder.
- `<run id>`: the run id, or its first 4 characters or more. `jr2 run` prints the run id in the line
  `run <run id> (<workflow>) — attached`. `kubectl` and the HTTP routes need the full run id.

Give each `jr2` command in the Instance folder.

## Start a run to watch

Start a run of `release` with `--detach`. `jr2 run` prints the run id and returns, and the run waits at the Gate:

```sh
jr2 run release --input '{"version":"2.0.0"}' --detach
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"3651bde0-63b6-4d05-aae2-7c3fc4bb1e2b"}
```

Your run ids are different from the run ids on this page.

## List the live runs

Run [`jr2 runs`](../reference/cli.md#runs):

```sh
jr2 runs
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
[{"runId":"3651bde0-63b6-4d05-aae2-7c3fc4bb1e2b","workflow":"release","instanceId":"3ac6d046-8398-4fa9-9008-caef68f35d40","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[]}]
```

`jr2 runs` prints a JSON array of the runs that did not end. To read a run that ended, use `jr2 status <run id>`. A run
with a [Workspace](../reference/glossary.md#workspace) that waits for capacity also has `placing`: the path of each such
Workspace in the run. `jr2 status` tells why it waits.

## Read the status of a run

Run [`jr2 status`](../reference/cli.md#status) with the run id. It reads a run that ended too:

```sh
jr2 status 3651
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"3651bde0-63b6-4d05-aae2-7c3fc4bb1e2b","workflow":"release","instanceId":"3ac6d046-8398-4fa9-9008-caef68f35d40","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"gates":[{"gate":"review","path":["review"],"accepts":[{"name":"approve","description":"Release this version.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}},{"name":"reject","description":"Do not release this version. Say why.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"reason":{"type":"string"}},"required":["reason"],"additionalProperties":false}}],"acceptsNow":["approve","reject"],"meta":{"version":"2.0.0"}}]}
```

The status is a [`RunStatus`](../reference/http-api.md#type-runstatus), with the open Gates of the run:

| Field      | What it holds                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `status`   | `active` while the run continues. `done`, `error` or `cancelled` when it ended. `drifted` when jr2 did not continue it. |
| `value`    | The state of the root Machine.                                                                                          |
| `context`  | The context of the root Machine.                                                                                        |
| `children` | The Machines that the run invokes now, such as its Workspaces, each with its state.                                     |
| `waiting`  | Each Workspace that waits for capacity: what it waits for, since when, and the words of the scheduler or the quota.     |
| `held`     | Each [outstanding](../reference/glossary.md#outstanding) pick of an Agent: the Agent, the pick, and since when.         |
| `fault`    | The error, when the status is `error`.                                                                                  |
| `reason`   | Why jr2 set the status, when the Machine did not set it, such as `drifted`.                                             |
| `gates`    | Each open Gate. [Answer a Gate](answer-a-gate.md) explains its fields.                                                  |

[Durable runs](../concepts/durable-runs.md) tells how long jr2 keeps a run that ended.

`jr2 status` with no run id does not read a run. It prints the [Repos](../reference/glossary.md#repo) of the Instance.

## Follow a run

Run [`jr2 logs`](../reference/cli.md#logs) with `-f`. It prints the status now, then each change, until the run ends:

```sh
jr2 logs -f 3651
```

While `jr2 logs -f` runs, send `approve` to the Gate in a second terminal:

```sh
jr2 send 3651 --gate review --event approve
```

The run ends. `jr2 logs -f` prints the status when it attached, then the last status, and stops:

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"3651bde0-63b6-4d05-aae2-7c3fc4bb1e2b","workflow":"release","instanceId":"3ac6d046-8398-4fa9-9008-caef68f35d40","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[]}
{"runId":"3651bde0-63b6-4d05-aae2-7c3fc4bb1e2b","workflow":"release","instanceId":"3ac6d046-8398-4fa9-9008-caef68f35d40","status":"done","value":"released","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[]}
```

When the run ended before you attach, `jr2 logs -f` prints only its last status. Without `-f`, `jr2 logs` prints the
status now, and stops. `jr2 logs` exits with `0` when it reads the run, also when the run ended with the status `error`.
Read `status` in the last line.

`jr2 logs` prints each status as one JSON line on stdout. It prints the other activity of the run on stderr, one line
for each item of activity:

| Line                                                                      | What happened                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `emit <emit>`                                                             | The Machine sent an [Emit](../reference/glossary.md#emit). `<emit>` is its JSON.                                                |
| `retry <child> attempt <n> (<reason>)`                                    | jr2 tries a [Turn](../reference/glossary.md#turn) of an Agent again. `<child>` names its Machine. `<reason>` says why.          |
| `placing <child>: waits for a node — <message>`                           | The [Sandbox](../reference/glossary.md#sandbox) of a Workspace waits for a node. With a quota, the line says `waits for quota`. |
| `placed <child> after <n>s`                                               | The Sandbox got its node after `<n>` seconds.                                                                                   |
| ``child-error: `<child>` failed below <agent>'s pick `<pick>` — <error>`` | A child that an Agent's pick started failed. The Agent does not get this error.                                                 |

A line about the root Workspace of the run has no `<child>`. `jr2 run` prints the same lines, with two spaces before
each line. It prints each change of status as `→ <status> <state>`.

## Watch in the Console

[Open the Console](open-the-console.md) tells how to open it. With no token, the Console shows each run and its state:

- The Fleet rail on the left lists each Workflow. Click the name of a Workflow, or click `▸` beside it, to see its runs.
  Each run shows the first 8 characters of its id and its status.
- Click a run. The diagram of its Machine shows the states that the run is in now.
- The `Activity` tab in the drawer lists the Emits of the runs of the Workflow that you selected. Each Emit shows the
  first 8 characters of the run id, and only the type of the Emit.

To see more, type the Instance token in the `instance token` box in the nav. Push Enter. When the badge beside the box
shows `live`:

- In the Fleet rail, `⚑` and a number show the open Gates of each run.
- The `Attention` tab shows the open Gates, and you can answer them. See [Answer a Gate](answer-a-gate.md).
- For the run that you selected, the Console shows each Workspace that waits for capacity, and why. It also shows each
  outstanding pick of an Agent, and since when.

## Watch from a program

The [Orchestrator](../reference/glossary.md#orchestrator) sends the activity of a run as Server-Sent Events. A program
can read them:

| Route                                                                                                      | Token          | What it sends                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| [`GET /runs/:runId/events`](../reference/http-api.md#get-runs-runid-events)                                | Instance token | The full status of one run, its Emits, and its other activity, until it ends.            |
| [`GET /workflows/:name/runs/:runId/events`](../reference/http-api.md#get-workflows-name-runs-runid-events) | none           | The state of one live run, and the type of each Emit, with no context.                   |
| [`GET /workflows/:name/events`](../reference/http-api.md#get-workflows-name-events)                        | none           | A `runs` event with all the live runs, then the same events for each run. It stays open. |

The run of the steps above ended, and a feed of one run sends only a live run. Start a new run:

```sh
jr2 run release --input '{"version":"2.0.0"}' --detach
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"a9f3ab44-bd2a-41fb-966f-2f020eebbed9"}
```

To read its feed, forward a port to the Orchestrator, as [Start a run](start-a-run.md#start-a-run-with-the-http-api)
shows. Then use the full run id of the new run:

```sh
curl -s -N http://localhost:4000/workflows/release/runs/<run id>/events
```

While `curl` runs, send `approve` to the Gate in a second terminal:

```sh
jr2 send <run id> --gate review --event approve
```

The feed sends the status when you attached, then the last status, and closes:

<!-- output: not run -->

```text
event: status
data: {"runId":"a9f3ab44-bd2a-41fb-966f-2f020eebbed9","workflow":"release","status":"active","value":"review","children":[]}

event: status
data: {"runId":"a9f3ab44-bd2a-41fb-966f-2f020eebbed9","workflow":"release","status":"done","value":"released","children":[]}
```

The first event is the status when you attach. The feed of one run closes when the run ends. While the run waits, the
feed also sends a comment line, `:`, at intervals, to keep the connection open.

## Read an Agent's conversation

The [Harness](../reference/glossary.md#harness) that runs an Agent's Turn prints the conversation to the log of its
container, `harness`. Read it with `kubectl logs`. Add `-f` to follow it.

For a [Menu](../reference/glossary.md#menu)-only Agent, an Agent with `workspace: "none"`, read the log of the
[Instance Harness](../reference/glossary.md#instance-harness):

```sh
kubectl -n <namespace> logs -f statefulset/jr2-instance-harness -c harness
```

The Instance Harness runs the Turns of all the Menu-only Agents of the Instance. Thus its log can hold the lines of more
than one run.

For an Agent that works in a Workspace, read the log of its Sandbox. Find the Sandbox with the full run id, as
[Look inside a Sandbox](look-inside-a-sandbox.md) shows. The pod has the name of the Sandbox:

```sh
kubectl -n <namespace> get sandboxes -l jr2.dev/run=<run id>
kubectl -n <namespace> logs -f <sandbox> -c harness
```

<!-- output: not run -->

```text
[<agent>] [prompt] <the prompt of the Turn>
…
[<agent>] [bash] node --test
…
[<agent>] [<pick>] <input>
[<agent>] [<pick> answer] <the answer to the pick>
…
```

Each line starts with the name of the Agent in brackets. The first line of each message then has a label in brackets.
The next lines of the same message have no label:

| Line                               | What it shows                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[<agent>] [prompt] <text>`        | A message that the model reads: the prompt of the Turn, or a message that jr2 adds to the Turn.                                                                                  |
| `[<agent>] [thinking] <text>`      | The thinking of the model.                                                                                                                                                       |
| `[<agent>] [text] <text>`          | The text of the model.                                                                                                                                                           |
| `[<agent>] [<call>] <input>`       | A call of a [Working tool](../reference/glossary.md#working-tools), or a pick from the Menu. `<input>` is a path for read, write and edit, the command for `bash`, or else JSON. |
| `[<agent>] [<pick> answer] <text>` | The answer that the model got for a pick from its Menu.                                                                                                                          |
| `[<agent>] [<pick> error] <text>`  | An answer to a pick that the model reads as an error, such as a refusal.                                                                                                         |
| `[<agent>] [compacted] <text>`     | The Harness made the context of the conversation smaller.                                                                                                                        |

The log of a Sandbox also tells the story of its run, in lines that start with `[run]`. `[run] [status] <state>` gives
the state of the run, or its status when it ends. `[run] [emit] <type> <payload>` gives an Emit. A Turn that runs in a
different Harness shows only as `[<agent>] [admitted] <prompt>` and `[<agent>] [pick] <pick> <input>`. `<input>` is the
JSON of the input of the pick, and it is absent for a pick with no input.

The Harness does not print the result of a Working tool. For example, it does not print the text of a file that the
Agent read, or the output of a command that the Agent ran.

The Harness cuts an input that is longer than 2000 characters at its end, and marks the cut with `…`. It cuts a long
answer to a pick in its middle, and marks the cut with `… [<n> characters cut] …`. The model reads the full text. The
Harness cuts only the log.

The log of a Sandbox goes away with its pod. The Workspace deletes its Sandbox when its body gets to its final state.
`jr2 send <run id> --event CANCEL` without `--keep` also deletes it. To keep the log, save it before then:

```sh
kubectl -n <namespace> logs <sandbox> -c harness > <file>
```

::: warning

A person who can read the pod logs of the namespace can read each conversation, and the answers that jr2 gives to the
picks. An answer can hold the output of a [`command`](../reference/authoring-surface.md#command)
[Effect](../reference/glossary.md#effect). On a shared cluster, decide who can read the pod logs.

:::

## Rules

- A run id prefix of fewer than 4 characters is a usage error. The command exits with `2`:
  `jr2: run id "<prefix>" is too short (need 4+ characters)`
- A prefix that no run id starts with is an error. The command exits with `1`: `no run "<prefix>"`
- A prefix that more than one run id starts with is an error. The command lists the run ids, and exits with `1`:
  `error: run id "<prefix>" is ambiguous`
- `GET /runs/:runId/events` refuses a call without the Instance token, with the status code `401`: `unauthorized`.
- `GET /workflows/:name/runs/:runId/events` sends only a live run of that Workflow. For a different run, it refuses with
  the status code `404`: `no live run "<run id>" of "<workflow>"`

## Read next

- [Durable runs](../concepts/durable-runs.md)
- [ADR-0009](../reference/decisions/0009-cli-and-instance-interface.md): `jr2 runs`, `jr2 status`, `jr2 logs`, and run
  id prefixes.
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): what the Console and the feeds show
  without the token.
- [ADR-0022](../reference/decisions/0022-observation-is-a-level-triggered-feed.md): the feeds.
- [ADR-0023](../reference/decisions/0023-the-harness-prints-the-conversation.md): the conversation in the pod log.
- [Architecture](../concepts/architecture.md): the Harness and the Instance Harness.
- [Look inside a Sandbox](look-inside-a-sandbox.md)
