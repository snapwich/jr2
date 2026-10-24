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

[`jr2 runs`](../reference/cli.md#runs) lists the two runs. The run of `triage` has `dispatchedBy` after its id:

```sh
jr2 runs
```

```text
…
→ context kind-jr2 / namespace my-instance
workflows:
  intake (machine)
  ping (machine)
  triage (machine)
[{"runId":"91ca85e1-5092-4e10-9ec6-d14e37811ca1","workflow":"intake","instanceId":"e51d124b-88e5-461c-b464-6a3660ee13dc","status":"active","value":"listening","context":{"started":["45b52048-0848-4015-ad56-6ff8ae33d817"],"request":"The greeting looks wrong sometimes.","last":{"outcome":"started","run":"45b52048-0848-4015-ad56-6ff8ae33d817"}},"children":[],"waiting":[],"held":[],"assembly":"3229103a2952","dispatched":[{"slot":"triage","run":"45b52048-0848-4015-ad56-6ff8ae33d817","at":"2026-10-24T06:20:43.465Z"}]},{"runId":"45b52048-0848-4015-ad56-6ff8ae33d817","dispatchedBy":{"run":"91ca85e1-5092-4e10-9ec6-d14e37811ca1","slot":"triage","effect":"08423831-751f-41e5-9d93-1fa063faaf61","depth":1},"workflow":"triage","instanceId":"a2ad6e54-6a52-45c2-81f4-89f408a27d1f","status":"active","value":"triaging","context":{"request":"The greeting looks wrong sometimes.","exchange":[]},"children":[],"waiting":[],"held":[],"assembly":"3229103a2952"}]
```

The first line, `…`, is the line `→ .env:`, with the keys that the CLI took from `.env`. The lines on stderr list the
Workflows of the Instance. In `dispatchedBy`, `run` is the run that started it, `slot` is the slot of the Effect, and
`effect` is the id of that Effect in the record of the run that started it. jr2 uses it as the key of the start, so that
a start that jr2 sends again starts no second run. `depth` is the number of runs before it in the chain. `dispatched` of
`intake` lists each run that it started. Your ids, your time and your hash are different.

[`jr2 status`](../reference/cli.md#status) prints the link in both directions, on stderr. For the run of `intake`:

```text
dispatched: 45b52048-0848-4015-ad56-6ff8ae33d817 (triage)
```

For the run of `triage`:

```text
dispatched by: 91ca85e1-5092-4e10-9ec6-d14e37811ca1 (triage), depth 1
```

The two runs are independent. A `CANCEL` of `intake` does not cancel the run of `triage`. Answer the `clarify` Gate of
each run of `triage` as [Answer a Gate](answer-a-gate.md) tells.

## Wait for the run to end

To use the result of the run, add `wait: true` to the definition:
`dispatch("triage", { input: triageInput, wait: true })`.

The Effect then ends when the run of `triage` ends, with `{ outcome: "settled", run, status, output }`. `status` is
`done`, `error`, `cancelled`, `lost` or `drifted`. `output` is the output of the Machine of that run. The default
timeout is then 10 minutes. Set a different one with `timeout`, such as `timeout: "1h"`. When the timeout comes first,
`status` is `live`, and the run continues. On a different Orchestrator, the Effect reads the run every 5 seconds. When
its last read got no answer, the outcome is `unknown`, not `settled`.

`wait` is fixed in the definition. A Machine that starts the same Workflow in the two ways has two slots.

## Start a run on a different Instance

To start a run on the Orchestrator of a different [Instance](../reference/glossary.md#instance), give a `target` in the
definition: `target: { url: "https://ops.example.com", token: secret("ops-instance") }`.

- `url` is the origin of the other Orchestrator: the scheme, the host and the port. It has no path.
- `token` names a secret that holds the Instance token of the other Instance. Put the secret in the
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
  `dispatch("<name>", { target }): the token is a secret("<name>") holding the target's Instance token (ADR-0071)`
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
- When the Orchestrator starts no run, the Effect ends with `refused`, not with an error. `report` holds the lines of
  the refusal, and `status` is its status code:
  - `400`: the Workflow does not take the input.
  - `404`: the current Assembly has no Workflow of that name.
  - `409`: the named Chart cannot run now, or a run of a different Workflow has the key of this start.
  - `413`: the start is larger than the Effector reads.
  - `422`: the door refuses the Chart in the input.
  - `0`: the Effector refused the start before it sent it.

## Read next

- [Effects](../concepts/effects.md)
- [Machines and Workflows](../concepts/machines-and-workflows.md)
- [Durable runs](../concepts/durable-runs.md): `CANCEL`, and how long jr2 keeps a run.
- Reference: [`dispatch`](../reference/authoring-surface.md#dispatch),
  [`DispatchOutput`](../reference/authoring-surface.md#type-dispatchoutput),
  [`POST /workflows/:name/runs`](../reference/http-api.md#post-workflows-name-runs)
- [ADR-0071](../reference/decisions/0071-a-run-starts-a-run-through-a-dispatch-effect.md): a run starts a run through a
  `dispatch` Effect.
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine inside a run
  is composed by invoke.
