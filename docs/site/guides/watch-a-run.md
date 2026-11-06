---
title: Watch a run
description: "See where a run is and what its Agents do: in the CLI, in the Console, and in the pod log."
---

See where a run is and what its [Agents](../reference/glossary.md#agent) do, in the CLI, the
[Console](../reference/glossary.md#console) and the pod log of an Agent.

The CLI shows the status of a run: where its [Machine](../reference/glossary.md#machine) is, its context, and its open
[Gates](../reference/glossary.md#gate). The Console shows where the Machine is and, with the credential of a
[Caller](../reference/glossary.md#caller) that has the `answer` scope, the open Gates. `jr2 logs` and the pod log show
the [Conversation](../reference/glossary.md#conversation) of each Agent: its prompts, its text, and its calls.

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
{"runId":"41ca7842-786f-44ca-9083-47109500da5f"}
```

Your run ids, instance ids and `assembly` hash are different from the values on this page.

## List the live runs

Run [`jr2 runs`](../reference/cli.md#runs):

```sh
jr2 runs
```

```text
→ context <context> / namespace <namespace>
[{"runId":"41ca7842-786f-44ca-9083-47109500da5f","workflow":"release","status":"active","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:17:04.653Z","assembly":"19d0bf0cbe10","openGates":1}]
```

`jr2 runs` prints a JSON array of the runs that did not end, the newest start first. Each item is a summary of the run:
its id, its Workflow, its status, who started it and when, its [Assembly](../reference/glossary.md#assembly), and the
number of its open Gates (`openGates`). `--status ended` lists the runs that ended, and `--status all` lists both.
`--workflow` and `--since` (such as `7d`) filter the list. [`jr2 workflows`](../reference/cli.md#workflows) lists the
Workflows that a run can start. To read the state and the context of a run, use `jr2 status <run id>`. A run with a
[Workspace](../reference/glossary.md#workspace) that waits for capacity also has `placing`: the path of each such
Workspace in the run. `jr2 status` tells why it waits. A run that a `dispatch` [Effect](../reference/glossary.md#effect)
started has `dispatchedBy`: the run that started it, the slot of the Effect, the id of the Effect (`effect`), and its
`depth` in the chain. [Start a run from a run](start-a-run-from-a-run.md) shows it.

## List the runs that ended

Give `--status ended` to list the runs that ended. Give `--workflow` and `--since` to make the list shorter. `--since`
takes a duration, such as `2h` or `7d`, or an ISO-8601 time:

```sh
jr2 runs --status ended --workflow release --since 7d
```

```text
→ context <context> / namespace <namespace>
[{"runId":"cad78069-0d8d-4c04-9cf4-3f771693274f","workflow":"release","status":"done","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:16:37.594Z","endedAt":"2026-11-06T19:16:39.762Z","assembly":"19d0bf0cbe10","openGates":0},{"runId":"a4099c00-88a6-4add-8068-dcf39e8c4224","workflow":"release","status":"done","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:16:30.787Z","endedAt":"2026-11-06T19:16:34.593Z","assembly":"19d0bf0cbe10","openGates":0},{"runId":"08b42407-1c4f-4776-9879-7c505bfa6695","workflow":"release","status":"done","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:16:18.276Z","endedAt":"2026-11-06T19:16:22.355Z","assembly":"19d0bf0cbe10","openGates":0},{"runId":"342fef91-53a1-4640-87bf-6fb4395beebf","workflow":"release","status":"done","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:16:00.147Z","endedAt":"2026-11-06T19:16:05.091Z","assembly":"19d0bf0cbe10","openGates":0},{"runId":"0c948d65-fd6f-453a-87fa-71ec00c7fe68","workflow":"release","status":"failed","reason":"The changelog is not ready.","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:15:39.018Z","endedAt":"2026-11-06T19:15:52.902Z","assembly":"19d0bf0cbe10","openGates":0}]
```

An ended run has `endedAt`. `reason` tells why a run is `failed`, `error`, `lost` or `drifted`. `--status` also takes a
comma list of statuses, such as `--status failed,error`. jr2 keeps an ended run for
[`runs.retain`](../reference/config.md#runs), 30 days by default. `jr2 runs` reads every page of the list.
[`GET /runs`](../reference/http-api.md#get-runs) gives the list one page at a time, with a `cursor`.

## Read the status of a run

Run [`jr2 status`](../reference/cli.md#status) with the run id. It reads a run that ended too:

```sh
jr2 status 41ca
```

```text
→ context <context> / namespace <namespace>
{"runId":"41ca7842-786f-44ca-9083-47109500da5f","workflow":"release","instanceId":"a17469b8-b648-44dc-acb9-dcce6fcb81ad","startedAt":"2026-11-06T19:17:04.653Z","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"status":"active","value":"review","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"19d0bf0cbe10","gates":[{"gate":"review","path":["review"],"accepts":[{"name":"approve","description":"Release this version.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}},{"name":"reject","description":"Do not release this version. Say why.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"reason":{"type":"string","minLength":1}},"required":["reason"],"additionalProperties":false}}],"acceptsNow":["approve","reject"],"meta":{"version":"2.0.0"}}]}
started by: token/instance on behalf of kubernetes-admin
```

The status is a [`RunStatus`](../reference/http-api.md#type-runstatus), with the open Gates of the run:

| Field       | What it holds                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`    | `active` while the run continues. `done`, `failed`, `error` or `cancelled` when it ended. `drifted` when jr2 did not continue it.                             |
| `value`     | The state of the root Machine.                                                                                                                                |
| `context`   | The context of the root Machine.                                                                                                                              |
| `children`  | The Machines that the run invokes now, such as its Workspaces, each with its state.                                                                           |
| `waiting`   | Each Workspace that waits for capacity: what it waits for, since when, and the words of the scheduler or the quota.                                           |
| `held`      | Each [outstanding](../reference/glossary.md#outstanding) pick of an Agent: the Agent, the pick, and since when.                                               |
| `fault`     | The error, when the status is `error`.                                                                                                                        |
| `output`    | The output of the Machine, when the run ended. For `failed`, the Failure: `{ reason, detail? }`.                                                              |
| `reason`    | Why jr2 set the status, when the Machine did not set it, such as `drifted`.                                                                                   |
| `assembly`  | The hash of the Assembly that the run started under, and holds.                                                                                               |
| `gates`     | Each open Gate. [Answer a Gate](answer-a-gate.md) explains its fields.                                                                                        |
| `worktrees` | Each [Worktree](../reference/glossary.md#worktree) that the run cut: its `slot`, its `path`, and its `branch`, which is `null` when the Worktree is detached. |

`jr2 status` also prints on stderr who started the run, from `startedBy`: `started by: <via>/<name>`, then the name that
jr2 shows and `on behalf of <party>` when the [Caller](../reference/glossary.md#caller) gave them. For a run that a
`dispatch` started, `jr2 status` reads each run of the chain, up to the first run that a Caller started. Then the line
also names the runs between, as `through run <run id> (<slot>)`. A run that jr2 started says `started by: jr2 (<why>)`.
A cancelled run also prints `cancelled by: <via>/<name>`.

For a run that cut a Worktree, `jr2 status` also prints one line on stderr for each cut:
`worktree: <path> (<slot>), branch <branch>`, or `worktree: <path> (<slot>), detached`. jr2 reads each line from the
record of the cut, so these lines do not change when an Agent changes the branch in the Worktree.

[Durable runs](../concepts/durable-runs.md) tells how long jr2 keeps a run that ended.

`jr2 status` with no run id does not read a run. It prints the current Assembly, each Assembly that a live run holds,
and the [Repos](../reference/glossary.md#repo) of the Instance.

## Follow a run

Run [`jr2 watch`](../reference/cli.md#watch). It prints the state now, then each change, until the run ends. It prints
the lines that `jr2 run` prints while it is attached:

```sh
jr2 watch 41ca
```

While `jr2 watch` runs, send `approve` to the Gate in a second terminal:

```sh
jr2 send 41ca --gate review --event approve
```

The run ends. `jr2 watch` prints the state when it attached, then the last status, and stops:

```text
→ context <context> / namespace <namespace>
run 41ca7842-786f-44ca-9083-47109500da5f (release) — attached
  → active "review"
  → done "released"
```

When the run ended before you attach, `jr2 watch` prints only its last status. With `--json`, it prints each status as
one JSON line:

```sh
jr2 watch 41ca --json
```

```text
→ context <context> / namespace <namespace>
{"runId":"41ca7842-786f-44ca-9083-47109500da5f","workflow":"release","instanceId":"a17469b8-b648-44dc-acb9-dcce6fcb81ad","startedAt":"2026-11-06T19:17:04.653Z","status":"done","value":"released","context":{"version":"2.0.0"},"children":[],"waiting":[],"held":[],"assembly":"19d0bf0cbe10","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"answers":[{"gate":"review","type":"approve","at":"2026-11-06T19:17:14.022Z","answeredBy":{"via":"token","name":"instance","onBehalfOf":"kubernetes-admin"}}]}
```

After the last status of a run that failed, `jr2 watch` prints `failed: <reason>`, as `jr2 run` does. `jr2 watch` exits
with `0` when it reads the run, also when the run ended with the status `error`. Read `status` in the last status.

Without `--json`, `jr2 watch` prints each line on stdout. With `--json`, it prints each status as one JSON line on
stdout, and the other activity of the run on stderr, one line for each item of activity:

| Line                                                                      | What happened                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit <emit>`                                                             | The Machine sent an [Emit](../reference/glossary.md#emit). `<emit>` is its JSON.                                                                                                                                                                                                                              |
| `retry <child> attempt <n> (<reason>)`                                    | jr2 tries a [Turn](../reference/glossary.md#turn) of an Agent again. `<child>` names its Machine. `<reason>` says why. With `runaway reroll`, the Harness ended a [Runaway](../reference/glossary.md#runaway), and jr2 runs the Turn one more time in a new conversation. A second Runaway is an Agent fault. |
| `placing <child>: waits for a node — <message>`                           | The [Sandbox](../reference/glossary.md#sandbox) of a Workspace waits for a node. With a quota, the line says `waits for quota`.                                                                                                                                                                               |
| `placed <child> after <n>s`                                               | The Sandbox got its node after `<n>` seconds.                                                                                                                                                                                                                                                                 |
| ``child-error: `<child>` failed below <agent>'s pick `<pick>` — <error>`` | A child that an Agent's pick started failed. The Agent does not get this error.                                                                                                                                                                                                                               |
| `looked: gate <gate> read its fact, and the run took "<event>"`           | The look of a Gate slot read the fact that the Gate waits for, and the run took the event of its `until`. No Caller answered.                                                                                                                                                                                 |

A line about the root Workspace of the run has no `<child>`. `jr2 run` prints the same lines, with two spaces before
each line. It prints each change of status as `→ <status> <state>`.

## Watch in the Console

[Open the Console](open-the-console.md) tells how to open it. With no token, the Console shows each run and its state:

- The Fleet rail on the left lists each Workflow. Click the name of a Workflow, or click `▸` beside it, to see its runs.
  Each run shows the first 8 characters of its id and its status.
- Click a run. The diagram of its Machine shows the states that the run is in now.
- The `Activity` tab in the drawer lists the Emits of the runs of the Workflow that you selected. Each Emit shows the
  first 8 characters of the run id, and only the type of the Emit.

To see more, type a Caller token, such as the Instance token, in the `Caller token` box in the nav. Push Enter. When the
badge beside the box shows `live`, the nav shows who the Console acts as, such as `as token/instance`. With the `answer`
and `read` scopes for the Workflow ([Open the Console](open-the-console.md) gives what each scope shows):

- In the Fleet rail, `⚑` and a number show the open Gates of each run.
- The `Attention` tab shows the open Gates, and you can answer them. See [Answer a Gate](answer-a-gate.md).
- For the run that you selected, the Console shows each Workspace that waits for capacity, and why. It also shows each
  outstanding pick of an Agent, and since when.
- For a run that you selected that ended `failed`, the Console shows the reason of its
  [Failure](../reference/glossary.md#failure): `failed: <reason>`, as `jr2 status` shows it. With no token, the rail
  shows only the status `failed`, in orange.
- For the run that you selected, the Console shows who started it, such as `started by token/ci`.
- The Fleet rail lists the ended runs of the Workflow under its live runs. The bottom drawer shows the conversation of
  each Agent slot of the run that you selected ([Open the Console](open-the-console.md#read-a-conversation)).

## Watch from a program

The [Orchestrator](../reference/glossary.md#orchestrator) sends the activity of a run as Server-Sent Events. A program
can read them:

| Route                                                                                                      | Token        | What it sends                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| [`GET /runs/:runId/events`](../reference/http-api.md#get-runs-runid-events)                                | `read` scope | The full status of one run, its Emits, and its other activity, until it ends.            |
| [`GET /workflows/:name/runs/:runId/events`](../reference/http-api.md#get-workflows-name-runs-runid-events) | none         | The state of one live run, and the type of each Emit, with no context.                   |
| [`GET /workflows/:name/events`](../reference/http-api.md#get-workflows-name-events)                        | none         | A `runs` event with all the live runs, then the same events for each run. It stays open. |

The run of the steps above ended, and a feed of one run sends only a live run. Start a new run:

```sh
jr2 run release --input '{"version":"2.0.0"}' --detach
```

```text
→ context <context> / namespace <namespace>
{"runId":"0e4a6a62-587e-4550-aee8-58642dde0637"}
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
data: {"runId":"0e4a6a62-587e-4550-aee8-58642dde0637","workflow":"release","status":"active","value":"review","children":[]}

event: status
data: {"runId":"0e4a6a62-587e-4550-aee8-58642dde0637","workflow":"release","status":"done","value":"released","children":[]}
```

The first event is the status when you attach. The feed of one run closes when the run ends. While the run waits, the
feed also sends a comment line, `:`, at intervals, to keep the connection open.

## Read an Agent's conversation

Run [`jr2 logs`](../reference/cli.md#logs) with the run id. It prints the conversation of each Agent of the run, in the
order of the time of each entry. Give an Agent slot or the name of an Agent to print only that Agent. Add `-f` to follow
the conversations while the run continues:

```sh
jr2 logs <run id> coder -f
```

The Orchestrator keeps each conversation for as long as it keeps the run, so `jr2 logs` also reads a run that ended.
[Read a conversation](read-a-conversation.md) tells what each line shows, how long jr2 keeps a conversation, and how the
Console shows it.

## Read the pod log

The [Harness](../reference/glossary.md#harness) that runs an Agent's Turn also prints the conversation to the log of its
container, `harness`. The lines have the form that `jr2 logs` prints. Read them with `kubectl logs`. Add `-f` to follow
them. A cluster that sends its pod logs to a log store keeps them there for as long as that store keeps them.

For a [Menu](../reference/glossary.md#menu)-only Agent, an Agent with `workspace: "none"`, read the log of the
[Instance Harness](../reference/glossary.md#instance-harness):

```sh
kubectl -n <namespace> logs -f statefulset/jr2-instance-harness -c harness
```

The Instance Harness runs the Turns of all the Menu-only Agents of the Instance. Thus its log can hold the lines of more
than one run. Each line of a conversation holds its [Instance ID](../reference/glossary.md#instance-id), which starts
with the run id. To read the lines of one run, keep the lines that hold `[<run id>/`:

```sh
kubectl -n <namespace> logs statefulset/jr2-instance-harness -c harness | grep -F '[<run id>/'
```

For an Agent that works in a Workspace, read the log of its Sandbox. Find the Sandbox with
[`jr2 workspace ls`](../reference/cli.md#workspace-ls), as [Look inside a Sandbox](look-inside-a-sandbox.md) shows. The
pod has the name of the Sandbox, in the `SANDBOX` column:

```sh
jr2 workspace ls <run id>
kubectl -n <namespace> logs -f <sandbox> -c harness
```

The log of a Sandbox also tells the story of its run, in lines that start with `[run]`. `jr2 logs` does not print these
lines:

```text
jr2 harness serving on :8080
[run] [status] running · body: cutting
[run] [status] running · body: working
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [prompt] In docs/intro/repo, run `node bin/greet.js`. Then finish, with what it printed.
…
[coder] [9501dd2f-95ba-479b-b384-307c736a8aad/body/coder] [finish answer] Delivered "finish" to the workflow (delivery 1b61fa16-50b7-4202-b7ed-b46a6ead5930). The workflow consumed it and moved on: your turn is over.
[run] [status] running · body: review
```

`[run] [status] <state>` gives the state of the run, then the state of each Machine that it invokes, separated by `·`,
such as `running · body: working`. When the run ends, the line gives its status. `[run] [emit] <type> <payload>` gives
an Emit. A Turn that runs in a different Harness shows only as `[<agent>] [admitted] <prompt>` and
`[<agent>] [pick] <pick> <input>`. `<input>` is the JSON of the input of the pick, and it is absent for a pick with no
input. The lines of the story of the run have no Instance ID.

The log of a Sandbox goes away with its pod. The Workspace deletes its Sandbox when its body gets to its final state,
and when a [Failure](../reference/glossary.md#failure) goes up through it. `jr2 send <run id> --event CANCEL` without
`--keep` also deletes it. `jr2 logs` still reads the conversations after that.

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
- `GET /runs/:runId/events` refuses a call without a Caller's credential, with the status code `401`: `unauthorized`. It
  refuses a Caller without the `read` scope for the Workflow of the run with the status code `403`.
- `GET /workflows/:name/runs/:runId/events` sends only a live run of that Workflow. For a different run, it refuses with
  the status code `404`: `no live run "<run id>" of "<workflow>"`

## Read next

- [Durable runs](../concepts/durable-runs.md)
- [ADR-0009](../reference/decisions/0009-cli-and-instance-interface.md): `jr2 runs`, `jr2 status`, `jr2 watch`,
  `jr2 logs`, and run id prefixes.
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): what the Console and the feeds show
  without the token.
- [ADR-0022](../reference/decisions/0022-observation-is-a-level-triggered-feed.md): the feeds.
- [ADR-0023](../reference/decisions/0023-the-harness-prints-the-conversation.md): the conversation in the pod log, and
  the copy that the Orchestrator keeps.
- [Architecture](../concepts/architecture.md): the Harness and the Instance Harness.
- [Read a conversation](read-a-conversation.md)
- [Look inside a Sandbox](look-inside-a-sandbox.md)
