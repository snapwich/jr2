---
title: Start a run from a run
description: Use a dispatch Effect to start a run of a Workflow from a Machine, in this Instance or in a different one.
---

Start a run of a [Workflow](../reference/glossary.md#workflow) from a [Machine](../reference/glossary.md#machine), with
a `dispatch` [Effect](../reference/glossary.md#effect).

This example is `workflows/intake.ts`. It waits at a [Gate](../reference/glossary.md#gate). For each `report` event, it
starts one run of `triage`, the Workflow of [A model decides](../get-started/a-model-decides.md). Then it waits for the
next report:

<<< @/examples/guides/start-a-run-from-a-run/intake.ts

The Instance must also have `workflows/triage.ts`. The example does not need a model of its own: the runs of `triage`
use the model of `triage`.

## Converge it

Run [`jr2 up`](../reference/cli.md#up). Its `effects:` lines tell where the Effect runs:

```sh
jr2 up
```

```text
…
effects: workflow "intake" — what it runs outside itself (ADR-0067)
  triage: dispatch triage → this Orchestrator — 30s, in the Orchestrator's own process
…
converged — `jr2 run <workflow>` when ready
```

`jr2 up` checks that the [Assembly](../reference/glossary.md#assembly) has a Workflow `triage`. It also compares the
`input` schema of the slot with the input that `triage` declares. When they do not agree, it stops before it changes the
cluster.

## Start the runs

Start the run of `intake` in one terminal. It stays at its Gate, `listening`, until you send `close`:

```sh
jr2 run intake
```

In a second terminal, send a report. `<run id>` is the id that `jr2 run` printed, or its first 4 characters or more:

```sh
jr2 send <run id> --gate listening --event report --input '{"request":"The greeting looks wrong sometimes."}'
```

The Effect starts a run of `triage` with the input `{"request":"The greeting looks wrong sometimes."}`. When the
[Orchestrator](../reference/glossary.md#orchestrator) accepts the run, the Effect ends with `started`, and `intake` goes
back to `listening`.

## See the runs

[`jr2 runs`](../reference/cli.md#runs) lists the two runs. The run of `triage` has `dispatchedBy`:

```sh
jr2 runs
```

```text
…
→ context kind-jr2 / namespace my-instance
[{"runId":"e8a74de7-f3f3-4621-876e-e5f117af5fff","workflow":"triage","status":"active","startedBy":{"kind":"run","run":"f45bed48-9950-4e63-9cda-4df368e9a62f","slot":"triage"},"startedAt":"2026-11-06T19:23:24.220Z","assembly":"19d0bf0cbe10","openGates":0,"dispatchedBy":{"run":"f45bed48-9950-4e63-9cda-4df368e9a62f","slot":"triage","effect":"c63bce4d-e353-4fee-9035-6b13dfac4917","depth":1}},{"runId":"f45bed48-9950-4e63-9cda-4df368e9a62f","workflow":"intake","status":"active","startedBy":{"kind":"caller","via":"token","name":"instance","onBehalfOf":"kubernetes-admin"},"startedAt":"2026-11-06T19:23:21.744Z","assembly":"19d0bf0cbe10","openGates":1}]
```

The first line, `…`, is the line `→ .env:`, with the keys that the CLI took from `.env`. In `dispatchedBy`, `run` is the
run that started it, `slot` is the slot of the Effect, and `effect` is the id of that Effect in the record of the run
that started it. jr2 uses it as the key of the start, so that a start that jr2 sends again starts no second run. `depth`
is the number of runs before it in the chain. The list gives the newest start first, so `triage` comes before `intake`.
`jr2 status` of `intake` shows `dispatched`: each run that it started. Your ids, your time and your hash are different.

[`jr2 status`](../reference/cli.md#status) prints the link in both directions, on stderr. For the run of `intake`:

```text
dispatched: e8a74de7-f3f3-4621-876e-e5f117af5fff (triage)
```

For the run of `triage`:

```text
dispatched by: f45bed48-9950-4e63-9cda-4df368e9a62f (triage), depth 1
```

The two runs are independent. A `CANCEL` of `intake` does not cancel the run of `triage`. Answer the `clarify` Gate of
each run of `triage` as [Answer a Gate](answer-a-gate.md) tells.

## Wait for the run to end

To use the result of the run, add `wait: true` to the definition:
`dispatch("triage", { input: triageInput, wait: true })`.

The Effect then ends when the run of `triage` ends, with `{ outcome: "settled", run, status, output }`. `status` is
`done`, `failed`, `error`, `cancelled`, `lost` or `drifted`. `output` is the output of the Machine of that run, and for
`failed` it is the Failure, `{ reason, detail? }`. The default timeout is then 10 minutes. Set a different one with
`timeout`, such as `timeout: "1h"`. When the timeout comes first, `status` is `live`, and the run continues. On a
different Orchestrator, the Effect reads the run every 5 seconds. When its last read got no answer, the outcome is
`unknown`, not `settled`.

`wait` is fixed in the definition. A Machine that starts the same Workflow in the two ways has two slots.

## Start a run on a different Instance

To start a run on the Orchestrator of a different [Instance](../reference/glossary.md#instance), give a `target` in the
definition: `target: { url: "https://ops.example.com", token: secret("ops-instance") }`.

- `url` is the origin of the other Orchestrator: the scheme, the host and the port. It has no path.
- `token` names a secret that holds the token of a [Caller](../reference/glossary.md#caller) of the other Instance, with
  the `start` scope for the Workflow, and also `read` when `wait` is `true`. A named Caller token of the other Instance
  that has only these scopes is the safest ([Give a Caller a scope](give-a-caller-a-scope.md)). Put the secret in the
  [`secrets`](../reference/config.md#secrets) list of `jr2.config.ts`, as for an `http` Effect. See
  [Run a command or call a URL with an Effect](run-a-command-or-call-a-url.md).
- The Effect runs in the [Instance Effector](../reference/glossary.md#instance-effector), which holds the token.
  `jr2 up` converges the Instance Effector for it.
- `jr2 up` asks the other Orchestrator for `GET /workflows/<name>` with no token, and compares its input. Each problem
  is a warning, not a refusal: the other Instance can be down, or you can converge it later.

A Machine that you publish as a package can leave the target Open with `target: open`. The composer binds the url and
the token together:
`customize(<import>, { effects: { <slot>: { target: { url: "https://<host>", token: secret("<name>") } } } })`. See
[Bind a shipped Machine's Open parts](bind-open-parts.md).

## Rules

- The name of the Workflow is a constant, as `jr2 run` writes it:
  ``dispatch("<name>"): the Workflow is named as `jr2 run` names it — a Machine's filename stem ("review"), or "<wrapper>/<name>" for a named Chart: lowercase letters, digits and "-" (ADR-0071)``
- `wait` is a boolean: `dispatch("<name>", { wait }): wait is true or false — a slot that needs both declares two`
- The `input` option is a `z.object()`:
  `dispatch("<name>", { input }): the input is a z.object(...) — the run's body is a JSON object (ADR-0071)`
- `timeout` is a positive duration:
  `dispatch("<name>"): timeout "<timeout>" is not a positive duration (like "30s", "10m", "1h")`
- A target is an object with a `url` and a `token`, or `open`:
  `dispatch("<name>", { target }): a target is { url: "https://<host>", token: secret("<name>") }, or open (ADR-0071)`
- The `url` of a target is an origin. The refusal starts with
  `dispatch("<name>", { target }): "<url>" is not an origin — write the scheme and the host, with a port if it is not the scheme's, and no path, query or userinfo`.
- The `token` of a target is a secret:
  `dispatch("<name>", { target }): the token is a secret("<name>") holding a Caller token of the target with start for the Workflow (ADR-0071)`
- An Open target is the whole target, not its secret:
  ``dispatch("<name>", { target }): secret(open) in a target — the target is the Open part, not its secret: leave the whole target Open (`target: open`) and let the composer bind its url and token together (ADR-0071)``
- With no target, the Assembly must have the Workflow. `jr2 up` stops:
  `refusing: workflow "<workflow>" dispatches "<name>" which no Workflow in the Assembly has — add workflows/<name>.ts, or name one it registers: <workflows> (ADR-0071)`
- With no target, the `input` schema of the slot must agree with the input that the Workflow declares. `jr2 up` stops,
  with one line for each problem:
  ``refusing: workflow "<workflow>" dispatches "<name>" with input its door does not take: <problem> — align the slot's `input` with the door (derive it from the door's schema, `door.pick({ ... })`) (ADR-0071)``
- For a named Chart that `jr2 up` cannot see, it warns and continues. A runtime Chart is only on the volume of the
  Orchestrator, and the Orchestrator checks it when `jr2 up` publishes. The warning starts with
  `warning: workflow "<workflow>" dispatches "<wrapper>/<name>": the Assembly has no Chart file workflows/<wrapper>/<name>.chart.json`.
- For a target, each problem that `jr2 up` finds is a warning. For example, when the other Orchestrator does not answer:
  `warning: dispatch "<name>" at <url>: no answer from this host (<error>) — the other Instance may be down, or reached only from inside its cluster; while no door answers, the dispatch settles "unreachable" (ADR-0071)`
- When the input does not agree with the `input` schema of the slot, the invoke ends with an error, and no run starts.
  The error starts with `dispatch "<slot>": its input does not match the slot's input schema —`. Before that, jr2 asks
  for a run under the key of the start, with no target and with one. When a run has the key, the Effect gives that run,
  and does not read the input. With a target, jr2 sends the key and no input, so the other Orchestrator starts nothing.
- When the Orchestrator starts no run, the Effect ends with `refused`, not with an error. `report` holds the lines of
  the refusal, and `status` is its status code:
  - `400`: the Workflow does not take the input.
  - `404`: the current Assembly has no Workflow of that name.
  - `409`: the named Chart cannot run now.
  - `413`: the start is larger than the Effector reads.
  - `422`: the door refuses the Chart in the input.
  - `0`: the Effector refused the start before it sent it.

## Read next

- [Effects](../concepts/effects.md)
- [Machines and Workflows](../concepts/machines-and-workflows.md)
- [Durable runs](../concepts/durable-runs.md): `CANCEL`, and how long jr2 keeps a run.
- Reference: [`dispatch`](../reference/authoring-surface/dispatch.md),
  [`DispatchOutput`](../reference/authoring-surface/type-dispatchoutput.md),
  [`POST /workflows/:name/runs`](../reference/http-api.md#post-workflows-name-runs)
- [ADR-0071](../reference/decisions/0071-a-run-starts-a-run-through-a-dispatch-effect.md): a run starts a run through a
  `dispatch` Effect.
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine inside a run
  is composed by invoke.
