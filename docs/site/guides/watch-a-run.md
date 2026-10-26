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

```text
→ context <context> / namespace <namespace>
{"runId":"a2d8b5b5-645c-44d2-8175-a949493e2320"}
```

Your run ids, instance ids and `assembly` hash are different from the values on this page.

## List the live runs

Run [`jr2 runs`](../reference/cli.md#runs):

```sh
jr2 runs
```

```text
→ context <context> / namespace <namespace>
workflows:
  ping (machine)
  release (machine)
[{"runId":"a2d8b5b5-645c-44d2-8175-a949493e2320","workflow":"release","instanceId":"6242963e-76d0-4acd-ac86-09359a29912f","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"28c844453c20"}]
```

`jr2 runs` prints a JSON array of the runs that did not end. On stderr, it first lists the Workflows that a run can
start, each with where it comes from: `machine`, `chart file` or `chart`. A Chart wrapper lists its named Charts under
it. `jr2 runs --workflows` prints that list as the JSON result. To read a run that ended, use `jr2 status <run id>`. A
run with a [Workspace](../reference/glossary.md#workspace) that waits for capacity also has `placing`: the path of each
such Workspace in the run. `jr2 status` tells why it waits. A run that a `dispatch`
[Effect](../reference/glossary.md#effect) started has `dispatchedBy` after its id: the run that started it, the slot of
the Effect, the id of the Effect (`effect`), and its `depth` in the chain.
[Start a run from a run](start-a-run-from-a-run.md) shows it.

## Read the status of a run

Run [`jr2 status`](../reference/cli.md#status) with the run id. It reads a run that ended too:

```sh
jr2 status a2d8
```

```text
→ context <context> / namespace <namespace>
{"runId":"a2d8b5b5-645c-44d2-8175-a949493e2320","workflow":"release","instanceId":"6242963e-76d0-4acd-ac86-09359a29912f","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"28c844453c20","gates":[{"gate":"review","path":["review"],"accepts":[{"name":"approve","description":"Release this version.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}},{"name":"reject","description":"Do not release this version. Say why.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"reason":{"type":"string"}},"required":["reason"],"additionalProperties":false}}],"acceptsNow":["approve","reject"],"meta":{"version":"2.0.0"}}]}
```

The status is a [`RunStatus`](../reference/http-api.md#type-runstatus), with the open Gates of the run:

| Field      | What it holds                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | `active` while the run continues. `done`, `failed`, `error` or `cancelled` when it ended. `drifted` when jr2 did not continue it. |
| `value`    | The state of the root Machine.                                                                                                    |
| `context`  | The context of the root Machine.                                                                                                  |
| `children` | The Machines that the run invokes now, such as its Workspaces, each with its state.                                               |
| `waiting`  | Each Workspace that waits for capacity: what it waits for, since when, and the words of the scheduler or the quota.               |
| `held`     | Each [outstanding](../reference/glossary.md#outstanding) pick of an Agent: the Agent, the pick, and since when.                   |
| `fault`    | The error, when the status is `error`.                                                                                            |
| `output`   | The output of the Machine, when the run ended. For `failed`, the Failure: `{ reason, detail? }`.                                  |
| `reason`   | Why jr2 set the status, when the Machine did not set it, such as `drifted`.                                                       |
| `assembly` | The hash of the [Assembly](../reference/glossary.md#assembly) that the run started under, and holds.                              |
| `gates`    | Each open Gate. [Answer a Gate](answer-a-gate.md) explains its fields.                                                            |

[Durable runs](../concepts/durable-runs.md) tells how long jr2 keeps a run that ended.

`jr2 status` with no run id does not read a run. It prints the current Assembly, each Assembly that a live run holds,
and the [Repos](../reference/glossary.md#repo) of the Instance.

## Follow a run

Run [`jr2 logs`](../reference/cli.md#logs) with `-f`. It prints the status now, then each change, until the run ends:

```sh
jr2 logs -f a2d8
```

While `jr2 logs -f` runs, send `approve` to the Gate in a second terminal:

```sh
jr2 send a2d8 --gate review --event approve
```

The run ends. `jr2 logs -f` prints the status when it attached, then the last status, and stops:

```text
→ context <context> / namespace <namespace>
{"runId":"a2d8b5b5-645c-44d2-8175-a949493e2320","workflow":"release","instanceId":"6242963e-76d0-4acd-ac86-09359a29912f","status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"28c844453c20"}
{"runId":"a2d8b5b5-645c-44d2-8175-a949493e2320","workflow":"release","instanceId":"6242963e-76d0-4acd-ac86-09359a29912f","status":"done","value":"released","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"28c844453c20"}
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
- For a run that you selected that ended `failed`, the Console shows the reason of its
  [Failure](../reference/glossary.md#failure): `failed: <reason>`, as `jr2 status` shows it. With no token, the rail
  shows only the status `failed`, in orange.

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

```text
→ context <context> / namespace <namespace>
{"runId":"2a009f09-13d4-44ba-9e17-fd665acc7aa8"}
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

```text
event: status
data: {"runId":"2a009f09-13d4-44ba-9e17-fd665acc7aa8","workflow":"release","status":"active","value":"review","children":[]}

event: status
data: {"runId":"2a009f09-13d4-44ba-9e17-fd665acc7aa8","workflow":"release","status":"done","value":"released","children":[]}
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
than one run. Each line of a conversation holds its Instance ID, which starts with the run id. To read the lines of one
run, keep the lines that hold `[<run id>/`:

```sh
kubectl -n <namespace> logs statefulset/jr2-instance-harness -c harness | grep -F '[<run id>/'
```

For an Agent that works in a Workspace, read the log of its Sandbox. Find the Sandbox with the full run id, as
[Look inside a Sandbox](look-inside-a-sandbox.md) shows. The pod has the name of the Sandbox:

```sh
kubectl -n <namespace> get sandboxes -l jr2.dev/run=<run id>
kubectl -n <namespace> logs -f <sandbox> -c harness
```

For example, this is the log of a run of the `task` Workflow of
[An Agent in a Sandbox](../get-started/an-agent-in-a-sandbox.md), with the prompt
``In docs/intro/repo, run `node bin/greet.js`. Then finish, with what it printed.``:

```text
jr2 harness serving on :8080
[run] [status] running · body: working
[run] [status] running · body: working
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [prompt] In docs/intro/repo, run `node bin/greet.js`. Then finish, with what it printed.
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder]
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] Work in /work/target/jr2-task-19b49b58-2ea4-4d79-b100-49aad6e12013, on branch jr2/task-19b49b58-2ea4-4d79-b100-49aad6e12013 — your tools are rooted there, so a relative path lands inside it. Commit what you do there, then call finish.
…
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [thinking] The user wants me to run `node bin/greet.js` inside `docs/intro/repo` directory. Let me navigate there and run it.
…
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [bash] cd docs/intro/repo && node bin/greet.js
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [thinking] The script printed "hello, world". I should now finish with this summary.
…
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [finish] {"summary":"Ran `node bin/greet.js` in docs/intro/repo, which printed: hello, world"}
[coder] [19b49b58-2ea4-4d79-b100-49aad6e12013/body/coder] [finish answer] Delivered "finish" to the workflow (delivery afe6340b-fe10-4819-b545-8ebd1b9a3964). The workflow consumed it and moved on: your turn is over.
[run] [status] running · body: review
```

The thinking, the calls and the text are the words of the model, so your log is different. Your ids are different too.

Each line of a conversation starts with the name of the Agent in brackets, then the
[Instance ID](../reference/glossary.md#instance-id) of the conversation in brackets. The Instance ID starts with the run
id. The first line of each message then has a label in brackets. The next lines of the same message have no label:

| Line                                        | What it shows                                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[<agent>] [<iid>] [prompt] <text>`         | A message that the model reads: the prompt of the Turn, or a message that jr2 adds to the Turn.                                                                                  |
| `[<agent>] [<iid>] [thinking] <text>`       | The thinking of the model.                                                                                                                                                       |
| `[<agent>] [<iid>] [text] <text>`           | The text of the model.                                                                                                                                                           |
| `[<agent>] [<iid>] [<call>] <input>`        | A call of a [Working tool](../reference/glossary.md#working-tools), or a pick from the Menu. `<input>` is a path for read, write and edit, the command for `bash`, or else JSON. |
| `[<agent>] [<iid>] [<pick> answer] <text>`  | The answer that the model got for a pick from its Menu.                                                                                                                          |
| `[<agent>] [<iid>] [<pick> error] <text>`   | An answer to a pick that the model reads as an error, such as a refusal.                                                                                                         |
| `[<agent>] [<iid>] [compacted] <text>`      | The Harness made the context of the conversation smaller: `context <before> → ~<after> tokens (window <window>)`.                                                                |
| `[<agent>] [<iid>] [thinking level] <text>` | The model has no thinking level of the name that the Turn asked for, and the line names the level that the model ran at. The Harness prints it one time for each Turn.           |

The log of a Sandbox also tells the story of its run, in lines that start with `[run]`. `[run] [status] <state>` gives
the state of the run, then the state of each Machine that it invokes, separated by `·`, such as
`running · body: working`. When the run ends, the line gives its status. `[run] [emit] <type> <payload>` gives an Emit.
A Turn that runs in a different Harness shows only as `[<agent>] [admitted] <prompt>` and
`[<agent>] [pick] <pick> <input>`. `<input>` is the JSON of the input of the pick, and it is absent for a pick with no
input. The lines of the story of the run have no Instance ID.

The Harness does not print the result of a Working tool. For example, it does not print the text of a file that the
Agent read, or the output of a command that the Agent ran.

The Harness cuts an input that is longer than 2000 characters at its end, and marks the cut with `…`. It cuts a long
answer to a pick in its middle, and marks the cut with `… [<n> characters cut] …`. The model reads the full text. The
Harness cuts only the log.

The log of a Sandbox goes away with its pod. The Workspace deletes its Sandbox when its body gets to its final state,
and when a [Failure](../reference/glossary.md#failure) goes up through it. `jr2 send <run id> --event CANCEL` without
`--keep` also deletes it. To keep the log, save it before then:

```sh
kubectl -n <namespace> logs <sandbox> -c harness > <file>
```

::: warning

A person who can read the pod logs of the namespace can read each conversation, and the answers that jr2 gives to the
picks. An answer can hold the output of a [`command`](../reference/authoring-surface/command.md) Effect. On a shared
cluster, decide who can read the pod logs.

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
