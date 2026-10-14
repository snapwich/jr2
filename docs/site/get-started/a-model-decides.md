---
title: A model decides
description: Write a Workflow in which a model chooses the next state, and answer its question at a Gate.
---

At the end of this page, you have a [Workflow](../reference/glossary.md#workflow), `triage`, in which a model makes a
decision. An [Agent](../reference/glossary.md#agent) reads a feature request and picks one of three events. When it asks
a question, the run waits at a [Gate](../reference/glossary.md#gate) until you answer. You answer one run from the CLI
and one run from the [Console](../reference/glossary.md#console).

## Before you start

Do [Connect a model](connect-a-model.md) first. The [Instance](../reference/glossary.md#instance) `my-instance` must
have the model of your tab.

You need the port forward of [Create an Instance](create-an-instance.md). Keep it open in its terminal. Then open a new
terminal in `my-instance` for `jr2 send`. This page calls it the send terminal. Give the other commands in your first
terminal, in `my-instance`.

## Write the Workflow

Make the file `workflows/triage.ts` in `my-instance`. The name of the file is the name of the Workflow, so the Workflow
is `triage`. Copy this code into the file:

::::tabs

:::tab{label="Anthropic"}

::include{file="../examples/get-started/a-model-decides/anthropic/triage.ts"}

:::

:::tab{label="Local"}

::include{file="../examples/get-started/a-model-decides/local/triage.ts"}

:::

::::

The two tabs are different only in the `model` line and its comment. The file has five parts:

- **The run input.** `door` is a zod schema. A run of `triage` starts with one `request`.
- **The Vocabulary.** Each [`defineEvent()`](../reference/authoring-surface.md#defineevent) makes one event of the
  [Vocabulary](../reference/glossary.md#vocabulary). Each transition belongs to the party that its state invokes.
  `triaging` invokes the Agent, so only the Agent can send `accept`, `needs_info` and `reject`. `clarify` invokes a
  Gate, so only the Gate can take `answer`.
- **The Agent.** [`agent()`](../reference/authoring-surface.md#agent) makes the Agent `triager`, with its model and its
  instructions. `workspace: "none"` gives it no [Sandbox](../reference/glossary.md#sandbox) and no
  [Working tools](../reference/glossary.md#working-tools). It can only read its prompt and pick an event.
  `thinkingLevel: "off"` makes the model pick with no thinking step. [Agents and Turns](../concepts/agents-and-turns.md)
  explains the other fields.
- **The Machine.** [`jr2Setup()`](../reference/authoring-surface.md#jr2setup) takes the Vocabulary and the Agent. Then
  `createMachine` gives the states of the [Machine](../reference/glossary.md#machine).
- **The prompt.** `prompt()` makes the text of each [Turn](../reference/glossary.md#turn) from the request and each
  question and answer.

The state `triaging` invokes `triager`. Its transitions take `accept`, `needs_info` and `reject`, so these three events
are the [Menu](../reference/glossary.md#menu) of the Agent. The model sees each event as a tool, with its `description`
and its input schema. The Agent ends its Turn when it calls one of them. The fourth transition,
[`agent.fault`](../reference/mechanism-events.md#agent-fault), is not on the Menu. jr2 sends it when a Turn fails with
no pick. Then the run waits at the Gate, and the Gate shows a `fault` in place of a question.

The state `clarify` invokes [`gate`](../reference/authoring-surface.md#jr2setup), which jr2 supplies. Its `meta` holds
the question of the Agent, and its one transition takes `answer`. The Gate has the name of its state: `clarify`. When
you send `answer`, the run goes back to `triaging`. The next Turn gets the request, the question, and your answer in its
prompt.

## Converge the Instance

[`jr2 up`](../reference/cli.md#up) puts the Workflows in the image of the Instance. Thus you run it each time that you
change a Workflow. In the first terminal, run:

```sh
jr2 up
```

`jr2 up` prints who can send each event, in each state of `triage`. Then it converges the cluster.

::::tabs

:::tab{label="Anthropic"}

The output shows where the model key goes:

<!-- output: not run -->

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
seats: workflow "triage" — who may send what, per state (ADR-0015)
  triage.triaging agent:triager: [accept, needs_info, reject]
  triage.clarify gate: [answer]
agents: triager (carried by 2 workflow machine(s))
…
secret ANTHROPIC_API_KEY: Held in the Instance Harness
the Instance Harness: Custodian holds ANTHROPIC_API_KEY (provider)
held secret ANTHROPIC_API_KEY → api.anthropic.com (literal)
…
instance harness: converging (triager declares workspace: "none")
…
converged — `jr2 run <workflow>` when ready
```

The warning of Connect a model, `secrets[0] (ANTHROPIC_API_KEY) is named by nothing; goes nowhere`, is gone. `triager`
names an Anthropic model, so `jr2 up` gives the key to the [Custodian](../reference/glossary.md#custodian) of the pod
that runs its Turns.

:::

:::tab{label="Local"}

`jr2 up` asks your model for one tool call, from inside the cluster:

<!-- output: not run -->

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
seats: workflow "triage" — who may send what, per state (ADR-0015)
  triage.triaging agent:triager: [accept, needs_info, reject]
  triage.clarify gate: [answer]
agents: triager (carried by 2 workflow machine(s))
…
the Instance Harness: Custodian holds nothing
…
provider: probing http://<address>:8000/v1 from inside the cluster (model qwen3.6-35b-a3b)
provider: qwen3.6-35b-a3b reachable, and it completed a tool call
…
instance harness: converging (triager declares workspace: "none")
…
converged — `jr2 run <workflow>` when ready
```

`<address>` is the address in your `.env`.

The line of Connect a model, `provider: <url> configured, but no carried Agent names a "local/…" model — skipped`, is
gone. `triager` names a `local/…` model, so `jr2 up` checks that the endpoint completes a tool call. If the check fails,
`jr2 up` stops and prints what to examine.

:::

::::

`jr2 up` replaces the [Orchestrator](../reference/glossary.md#orchestrator) pod. If the port forward stops, start it
again in its terminal:

```sh
kubectl -n my-instance port-forward svc/jr2-orchestrator 4000:4000
```

## Start the first run

In the first terminal, run:

```sh
jr2 run triage --input '{"request":"People keep asking what version they are running."}'
```

[`jr2 run`](../reference/cli.md#run) starts the run and stays attached to it. The Agent reads the request. The request
does not say where to show the version, so the Agent normally asks a question. The run goes to `clarify` and waits
there:

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run 6f56c5d9-23a0-4ce4-8e16-5b0323f4f924 (triage) — attached
  → active "triaging"
  → active "clarify"
```

Your run id is different. The line `→ active "triaging"` can show more than one time. `jr2 run` prints a line for each
status that the run sends. Two lines can show the same state. `jr2 run` does not return while the run waits. Keep it
open.

:::note

The model decides, so your run can be different. If the Agent picks `accept` or `reject`, the run ends with no Gate. For
example, a run that the Agent accepts immediately prints:

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run <run id> (triage) — attached
  → active "triaging"
  → done "accepted"
{"runId":"<run id>","workflow":"triage","instanceId":"<instance id>","status":"done","value":"accepted","context":{"request":"People keep asking what version they are running.","exchange":[],"summary":"<summary>"},"children":[],"waiting":[],"held":[]}
```

`<run id>` is the id of this run, and `<instance id>` is the [Instance ID](../reference/glossary.md#instance-id) of the
run. jr2 makes a new one for each run. `<summary>` is the text of the model. Start the run again until it waits at
`clarify`.

:::

## Read the question

The Gate holds the question of the Agent in its `meta`. In the send terminal, run:

```sh
jr2 status <run id>
```

`<run id>` is the run id that `jr2 run` printed. You can give its first 4 characters or more, such as `6f56c5d9`.
[`jr2 status`](../reference/cli.md#status) prints the status of the run as one line of JSON. The Gate is in `gates`, at
the end:

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
{"runId":"6f56c5d9-23a0-4ce4-8e16-5b0323f4f924","workflow":"triage","instanceId":"610f245a-2638-4a1c-b4c9-ed56d8d9d459","status":"active","value":"clarify","context":{"request":"People keep asking what version they are running.","exchange":[{"question":"<question>"}]},"children":[],"waiting":[],"held":[],"gates":[{"gate":"clarify","path":["clarify"],"accepts":[{"name":"answer","description":"Answer the triager's question. It triages the request again with the answer in hand.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"info":{"type":"string","description":"The answer, in prose."}},"required":["info"],"additionalProperties":false}}],"acceptsNow":["answer"],"meta":{"question":"<question>"}}]}
```

`<question>` is the question of the model. Your instance id is different too. The Gate `clarify` takes `answer`, with an
`info` string.

## Answer from the CLI

In the send terminal, run:

```sh
jr2 send <run id> --gate clarify --event answer --input '{"info":"Add a --version flag to the CLI. It prints the installed version and exits."}'
```

[`jr2 send`](../reference/cli.md#send) gives the event to the Gate:

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered answer to gate "clarify" on 6f56c5d9-23a0-4ce4-8e16-5b0323f4f924
```

The run goes back to `triaging`, and the Agent reads your answer. Look at the first terminal. When the Agent picks
`accept`, the run ends, and `jr2 run` prints the last status:

<!-- output: not run -->

```text
…
  → active "triaging"
  → active "triaging"
  → done "accepted"
{"runId":"6f56c5d9-23a0-4ce4-8e16-5b0323f4f924","workflow":"triage","instanceId":"610f245a-2638-4a1c-b4c9-ed56d8d9d459","status":"done","value":"accepted","context":{"request":"People keep asking what version they are running.","exchange":[{"question":"<question>","info":"Add a --version flag to the CLI. It prints the installed version and exits."}],"summary":"<summary>"},"children":[],"waiting":[],"held":[]}
```

`summary` is the request as the model wrote it again, in one sentence. If the Agent asks a second question, the run goes
to `clarify` again. Read the question, and answer it in the same way.

## Start the second run

In the first terminal, run:

```sh
jr2 run triage --input '{"request":"The greeting looks wrong sometimes."}'
```

This request does not say what is wrong. The run goes to `clarify` and waits, as the first run did:

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run <run id> (triage) — attached
  → active "triaging"
  → active "clarify"
```

`<run id>` is the id of the second run. If the Agent picks `accept` or `reject`, start the run again.

## Answer from the Console

Open `http://localhost:4000` in your browser. If the badge after the `instance token` box shows `live`, go to the next
step. If the box is empty, get the token. In the send terminal, run:

```sh
kubectl -n my-instance get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d
```

Type the token in the `instance token` box. Push Enter. The badge after the box shows `live`.

Click `triage` in the Fleet rail on the left. The center shows the Machine of `triage`, with its states and transitions.
Click the run in the rail. The Console lights the state of the run, `clarify`.

Click the `Attention` tab in the drawer on the right. It has one card for the Gate:

- The card starts with `⚑ clarify`, then `triage` and the first 8 characters of the run id.
- Under `question`, it shows the question of the Agent.
- Under `answer`, it has a form with the field `info *`. The `*` shows that the field is necessary.

Type this text in the `info` field:

```text
Spaces around the name show in the greeting. Trim the name.
```

Click `send`. The card disappears, and the run goes back to `triaging`. When the Agent picks `accept`, the run ends. The
`jr2 run` in the first terminal prints the last status.

## What happened

You wrote a Machine with two waiting states. In `triaging`, a model chose the next state. In `clarify`, a person sent
the event that moved it. The Machine gave all of the transitions. The model chose only among the events of its state.
[Agents and Turns](../concepts/agents-and-turns.md) explains the Agent and its Turn.

The Menu of `triager` came from the transitions of `triaging`. You did not give the Agent a list of picks. A pick that
the state does not take moves nothing. [The Menu](../concepts/the-menu.md) explains what the Agent can pick, and
[ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md) gives the reasons.

The Gate `clarify` was open only while the run was in its state. It took only `answer`. `jr2 send` and the Console sent
the same event to a Gate with the same name, through the same route. [Gates](../concepts/gates.md) explains who can
answer a Gate. [Answer a Gate](../guides/answer-a-gate.md) gives the other ways to answer one.

`triager` has `workspace: "none"`, so its Turns ran on the
[Instance Harness](../reference/glossary.md#instance-harness). No Sandbox started for the run.
[Architecture](../concepts/architecture.md) shows what runs where.

## Next

[An Agent in a Sandbox](an-agent-in-a-sandbox.md).
