---
title: Run a Chart by name
description: Keep a Chart under a name, as a Chart file or a runtime Chart, and run it with jr2 run.
---

Keep a [Chart](../reference/glossary.md#chart) under a name, and run it as a
[Workflow](../reference/glossary.md#workflow).

This example is `workflows/notes.ts`, a [Chart wrapper](../reference/glossary.md#chart-wrapper). Its run input has a
field `chart` that is [`chartSchema`](../reference/authoring-surface.md#chartschema). Thus it takes a Chart in its run
input, and it keeps Charts under names:

<<< @/examples/guides/run-a-chart-by-name/anthropic/notes.ts#imports

The model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/run-a-chart-by-name/anthropic/notes.ts#model

== Local

<<< @/examples/guides/run-a-chart-by-name/local/notes.ts#model

:::

The run input and the Machine:

<<< @/examples/guides/run-a-chart-by-name/anthropic/notes.ts#door

<<< @/examples/guides/run-a-chart-by-name/anthropic/notes.ts#machine

This Chart is `workflows/notes/summary.chart.json`. Its Workflow name is `notes/summary`:

<<< @/examples/guides/run-a-chart-by-name/summary.chart.json

The Chart invokes the lent Agent `writer` with a prompt that reads `{{input.topic}}`. When `writer` picks `finished`,
the Chart keeps the summary in its context, and ends with it as its output.

## Keep a Chart in a file

Put the Chart file in a folder that has the name of its wrapper: `workflows/<wrapper>/<name>.chart.json`. `<name>` has
lower-case letters, digits and `-`. Then run [`jr2 up`](../reference/cli.md#up). It checks each Chart file at the door
before it changes the cluster, and publishes it in the [Assembly](../reference/glossary.md#assembly).

[`jr2 runs`](../reference/cli.md#runs) lists the Chart under its wrapper, on stderr:

```sh
jr2 runs
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
workflows:
  notes (machine, Chart wrapper: body "body", one-shot)
    notes/summary (chart file)
…
[]
```

`one-shot` means that the wrapper also takes a Chart in its run input. `jr2 runs --workflows` prints the same list as
JSON on stdout.

## Run the Chart

A named Chart supplies the `chart` field. Give the other fields of the run input:

```sh
jr2 run notes/summary --input '{"topic":"the greet CLI"}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run 5b7e2c90-1d4f-4a83-9e6b-0f2c8d7a3e15 (notes/summary) — attached
  → done "done"
…
```

The last line is the status of the run as JSON. Its `context.result` is the output of the
[Open body](../reference/glossary.md#open-body): `{"outcome":"done","output":{"summary":"<summary>"}}`. Your run id is
different, and `<summary>` is the text of the model.

## Keep a Chart at run time

A runtime Chart needs no `jr2 up`. Send it to the [Orchestrator](../reference/glossary.md#orchestrator) with
`PUT /workflows/<wrapper>/charts/<name>`, and the Instance token. No `jr2` command does this, so use `curl`, or a tool
of your own. Start the port forward of [Open the Console](open-the-console.md). Then, in a second terminal, put the
token in a variable:

```sh
TOKEN=$(kubectl -n my-instance get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d)
```

Then send the text of the Chart file under a second name, `brief`:

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data @workflows/notes/summary.chart.json http://localhost:4000/workflows/notes/charts/brief
```

<!-- output: not run -->

```text
{"name":"notes/brief","origin":"runtime","hash":"<hash>"}
```

The status code is `201` for a new name, and `200` when the Chart replaced a runtime Chart with the same name.
`jr2 runs` then lists `notes/brief (chart)`, and `jr2 run notes/brief` starts it. A run of the old text keeps its own
text.

To remove the Chart:

```sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:4000/workflows/notes/charts/brief
```

The Orchestrator keeps a runtime Chart on its volume, so it stays after a restart. When a publish removes a part that it
uses, it stays, and `jr2 runs` marks it `unrunnable` with the reason.

## Run a Chart one time

To run a Chart with no name, put it in the `chart` field of the run input of the wrapper:

```sh
jr2 run notes --input "{\"topic\":\"the greet CLI\",\"chart\":$(cat workflows/notes/summary.chart.json)}"
```

The run has the Workflow name `notes`. `GET /workflows/notes/chart-schema` gives the Chart grammar with the names that
this wrapper lends. Give it to your editor as the JSON Schema of your Chart files, so that it checks them while you
write.

## Rules

- `jr2 up` refuses a Chart file that the door refuses, and changes nothing in the cluster. It prints one line for each
  problem: `refusing: workflows/<wrapper>/<name>.chart.json: Chart refused: <problem>`. See
  [Let an Agent write a Chart](let-an-agent-write-a-chart.md#rules) for the problems.
- A Chart file is under a Chart wrapper that the Assembly has:
  `refusing: workflows/<wrapper>/<name>.chart.json: no workflows/<wrapper>.ts registers the Chart wrapper "<wrapper>" this Chart file is under`
- A Chart name has lower-case letters, digits and `-`:
  `"<name>" is not a Chart name: lower-case letters, digits and "-", starting with a letter or a digit, at most 63 characters`
- `jr2 up` ignores a Chart file in `workflows/`, and warns:
  `warning: workflows/<file>: ignored — a Chart file sits in workflows/<wrapper>/<name>.chart.json, below the Chart wrapper it runs under (ADR-0070)`
- The folder of a wrapper holds only Chart files. `jr2 up` warns about each other file:
  `warning: workflows/<wrapper>/<file>: ignored — a wrapper's directory holds Chart files (<name>.chart.json) and nothing else jr2 reads (ADR-0070)`
- A Chart runs only under a Chart wrapper. The `PUT` refuses, with the status `409`:
  `workflow "<wrapper>" is no Chart wrapper: it declares no Open body (openBody() in its actors), so no Chart runs under it (ADR-0070)`
- Only a wrapper with a `chartSchema` field keeps a Chart under a name. The `PUT` refuses, with the status `409`:
  `workflow "<wrapper>" has no Chart door: no field of its input is chartSchema, so its Open body binds only Charts its own states supply (ADR-0070)`
- The `PUT` refuses a wrapper that the Assembly does not have, with the status `404`: `no workflow "<wrapper>"`
- The `PUT` refuses the name of a Chart file, with the status `409`:
  ``"<wrapper>/<name>" is a Chart file of the Assembly (workflows/<wrapper>/<name>.chart.json): change it there and `jr2 up` (ADR-0070)``
- The `PUT` refuses a Chart that the door refuses, with the status `422`: `{"error":"refused","report":[<problems>]}`
- The `DELETE` refuses a Chart file, with the status `409`:
  ``a Chart file is the Instance's own: remove workflows/<wrapper>/<name>.chart.json and `jr2 up` (ADR-0070)``
- `PUT` and `DELETE` need the Instance token. Without it, the status is `401`.
- An unrunnable named Chart does not start. The status is `409`: `named Chart "<wrapper>/<name>" cannot run: <reason>`
- `jr2 run` prints the report of a Chart that the door refuses in the run input, and exits with `1`:
  `error: the door refused the Chart for "<workflow>"`, then one line for each problem.

## Read next

- [Charts](../concepts/charts.md)
- [Start a run](start-a-run.md)
- [Let an Agent write a Chart](let-an-agent-write-a-chart.md)
- Reference: [`chartSchema`](../reference/authoring-surface.md#chartschema), [`jr2 runs`](../reference/cli.md#runs),
  [`PUT /workflows/:wrapper/charts/:name`](../reference/http-api.md#put-workflows-wrapper-charts-name),
  [`GET /workflows/:wrapper/chart-schema`](../reference/http-api.md#get-workflows-wrapper-chart-schema)
- [ADR-0070](../reference/decisions/0070-a-machine-lends-its-parts-to-a-chart.md): a Machine lends its parts to a Chart.
