---
title: Start a run
description: Start a run of a Workflow from the CLI, from the Console, or with a call to the HTTP API.
---

Start a run of a [Workflow](../reference/glossary.md#workflow) from the CLI, from the
[Console](../reference/glossary.md#console), or with a call to the HTTP API.

A Workflow is a [Machine](../reference/glossary.md#machine) that your [Instance](../reference/glossary.md#instance)
registers. Its name is the name of its file in `workflows/`, without `.ts`. Thus `workflows/ping.ts` is the Workflow
`ping`. A run is one execution of that Machine. The run input is a JSON object, and the Machine reads it when the run
starts.

The examples on this page start `ping`, the Workflow that `jr2 init` writes. In the commands, replace `<namespace>` with
the namespace of your Instance. It is the [`name`](../reference/config.md#name) in `jr2.config.ts`. When `jr2.config.ts`
sets no `name`, it is the name of the Instance folder.

## Start a run from the CLI

Run [`jr2 run`](../reference/cli.md#run) in the Instance folder, with the name of the Workflow. Give the run input in
`--input`:

```sh
jr2 run ping --input '{"message":"hi"}'
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
run 9f2e467b-5b5b-403f-8896-e795ada603bf (ping) — attached
  → done "done"
{"runId":"9f2e467b-5b5b-403f-8896-e795ada603bf","workflow":"ping","instanceId":"7a348d06-7210-4e2e-a2e4-3337302116a0","status":"done","value":"done","context":{"message":"hi","reply":"pong: hi"},"children":[],"waiting":[],"held":[],"assembly":"5e0a91c3d7f2"}
```

Your run id is different.

- `jr2 run` finds the [Orchestrator](../reference/glossary.md#orchestrator) in the current kubectl context, in the
  namespace of the Instance. The first line names the two. To use a different context or namespace, add
  `--context <ctx>` or `-n <ns>`.
- The lines before the last are activity, on stderr. An indented line that starts with `→` is a change of the run's
  status and its state. [Watch a run](watch-a-run.md) gives each kind of activity line.
- The last line is the result, on stdout: the status of the run when it ends, as one JSON object. Thus
  `jr2 run ping … | jq` gets only the result.
- `jr2 run` stays attached until the run ends. A run that waits at a [Gate](../reference/glossary.md#gate) does not end,
  so `jr2 run` waits too. To answer the Gate, use a second terminal. See [Answer a Gate](answer-a-gate.md).
- When you stop `jr2 run`, for example with Ctrl-C, the run continues in the Orchestrator. To attach again, run
  `jr2 logs -f <run id>`.
- `jr2 run` exits with `0` when the run ends with the status `done` or `cancelled`. It exits with `1` when the run ends
  with the status `error`.

### Start a run and return at once

Add `--detach`. `jr2 run` starts the run, prints its run id on stdout, and returns:

```sh
jr2 run ping --input '{"message":"hi"}' --detach
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"da7c7661-63bd-49d3-b7cf-9b39a2eb9498"}
```

Use the run id, or its first 4 characters or more, with `jr2 status`, `jr2 logs` and `jr2 send`.

## Start a run from the Console

You need the Instance token to start a run from the Console. [Open the Console](open-the-console.md) tells how to open
it and how to get the token.

1. Open the Console.
2. Type the Instance token in the `instance token` box in the nav.
3. Push Enter. The badge beside the box shows `…`, then `live`.
4. In the Fleet rail on the left, find the Workflow. Click `start` beside its name.
5. Fill in the form. When the Machine declares its input, the form has one field for each property of the input. A field
   that has `*` after its name is necessary. When the Machine declares no input, the form has a box for the run input as
   JSON. An empty box starts the run with `{}`.
6. Click `start run`.

While the run continues, the number beside the name of the Workflow counts it. To see the run, click the name of the
Workflow, or click `▸` beside it. When the Orchestrator refuses the input, the form shows the refusal text below the
`start run` button, and no run starts.

The form makes a text field for a property that is an object or an array. Thus the Orchestrator refuses the text,
because it is a string. For such an input, start the run from the CLI or with the HTTP API.

The `start` button shows only while the badge shows `live`. Without the token, the Console shows the runs, but you
cannot start one.

## Start a run with the HTTP API

Send [`POST /workflows/:name/runs`](../reference/http-api.md#post-workflows-name-runs) to the Orchestrator, with the
Instance token. The body is the run input. A script, a webhook handler or a CI job can start a run this way.

`jr2 up` makes the Service `jr2-orchestrator` on port 4000, with no address outside the cluster. Thus a caller outside
the cluster uses a port forward, or an address that you make for the Service.

Forward a port to the Orchestrator. Keep this command open:

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

In a second terminal, get the Instance token into a variable:

```sh
TOKEN=$(kubectl -n <namespace> get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d)
```

Start the run:

```sh
curl -s -X POST http://localhost:4000/workflows/ping/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"hi"}'
```

<!-- output: not run -->

```text
{"runId":"f347ed72-275d-4345-a3d7-b4d52b44656d","instanceId":"6a67892d-1942-436c-a97e-7d07dbd658ad"}
```

The status code is `201`. `runId` is the id of the run. `instanceId` is the
[Instance ID](../reference/glossary.md#instance-id) that the run starts with. It is not the run id.

When the Machine declares its input, the run starts with the input as the schema reads it. A `z.object` schema removes a
property that it does not name, and it adds each default that it sets. When the Machine declares no input, the run
starts with the JSON object that you send.

To find the input that a Workflow takes, send [`GET /workflows/:name`](../reference/http-api.md#get-workflows-name) with
`Accept: application/json`. This route needs no token. `input` is the input schema of the Machine, as JSON Schema, or
`null` when the Machine declares no input:

```sh
curl -s http://localhost:4000/workflows/ping -H "Accept: application/json"
```

<!-- output: not run -->

```text
{"name":"ping","machineId":"ping","input":null}
```

[`GET /workflows`](../reference/http-api.md#get-workflows) gives the names of all the Workflows. It also needs no token.

### Use the CLI without the Instance folder

The CLI can also speak to an Orchestrator at a URL. Then it does not look for the Instance folder or for a kubectl
context. Give the URL in `--url`, or in `JR2_URL`. Give the Instance token in `JR2_TOKEN`:

```sh
JR2_URL=http://localhost:4000 JR2_TOKEN=$TOKEN jr2 run ping --input '{"message":"hi"}' --detach
```

<!-- output: not run -->

```text
→ http://localhost:4000
{"runId":"4b0e2c19-7f3a-4d8e-9a61-c25d3e8f0b74"}
```

## Rules

- `jr2 run` with no Workflow name starts no run. It prints its usage and exits with `2`:
  `usage: jr2 run <workflow> [--input <json>] [--detach] [--url <u>] [-n <ns>] [--context <ctx>]`
- The Orchestrator refuses a name that no file in `workflows/` registers, with the status code `404`:
  `no workflow registered as "<workflow>"`. `jr2 run` prints `error: no workflow registered as "<workflow>"` and exits
  with `1`. It also prints the version of the Instance in one more line:
  ``instance: <version> (<hash>) — if it predates this CLI, `jr2 up` converges the cluster to this kit``. `<hash>` is
  the hash of the current [Assembly](../reference/glossary.md#assembly).
- When the Machine declares its input, the Orchestrator checks each run input against it. It refuses an input that does
  not agree, with the status code `400`: `invalid input for workflow "<workflow>": <issues>`. `<issues>` is the list of
  the problems as JSON. The Console shows the same text below its form.
- The Console form starts no run when its box holds text that is not a JSON object. It shows `not valid JSON` or
  `the body must be a JSON object`.
- `jr2 run` starts no run when `--input` is not valid JSON. It prints `error: <message>`, where `<message>` is the
  message of the JSON parser, and exits with `1`.
- The Orchestrator refuses a start without the Instance token, with the status code `401`: `unauthorized`.
- The Orchestrator refuses a start with the token of a [Sandbox](../reference/glossary.md#sandbox), with the status code
  `403`: `run state and control need the Instance token — a Sandbox token has neither`. Thus an
  [Agent](../reference/glossary.md#agent) cannot start a run.
- `jr2 run` outside an Instance folder, with no `--url` and no `JR2_URL`, starts no run:
  `error: not inside a jr2 instance — no jr2.config.ts found walking up from cwd`
- `jr2 run` starts no run when the namespace holds no Instance:
  ``error: not deployed here — right context? (context <context>, namespace <namespace>; `jr2 up` deploys)``
- `jr2 run` starts no run when kubectl has no current context:
  ``error: no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up` ``
- When the connection to the Orchestrator ends before the run ends, for example when the Orchestrator stops, `jr2 run`
  prints `error: <message>` and exits with `1`. The run continues when the Orchestrator starts again. To attach again,
  run `jr2 logs -f <run id>`.
- When the Orchestrator holds the run but did not continue it, `jr2 run` exits with `1`:
  ``run <run id> is parked: stopped before it settled — `jr2 logs -f <run id>` follows it once restored``

## Read next

- [Machines and Workflows](../concepts/machines-and-workflows.md)
- [ADR-0009](../reference/decisions/0009-cli-and-instance-interface.md): `jr2 run`, its output, and its exit codes.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): how the CLI finds the
  Orchestrator.
- [ADR-0033](../reference/decisions/0033-a-machine-declares-the-input-that-starts-it.md): the input that a Machine
  declares.
- [ADR-0058](../reference/decisions/0058-a-harness-answers-the-orchestrator-alone.md): why only the Instance token
  starts a run.
- [Answer a Gate](answer-a-gate.md)
- [Watch a run](watch-a-run.md)
