---
title: Answer a Gate
description: Send an event to an open Gate of a run, from the CLI, the Console, a webhook handler or a CI job.
---

Send an event to an open [Gate](../reference/glossary.md#gate) of a run from the CLI, the
[Console](../reference/glossary.md#console), a webhook handler or a CI job.

A run waits at a Gate until a person or a different system answers it. The Gate is open while the run is in the state
that invokes it, and it closes when the run leaves that state. An open Gate has an id, its events, and the input schema
of each event. Its `meta` is the data that the [Machine](../reference/glossary.md#machine) shows to the person or the
system that answers.

The examples on this page use the [Workflow](../reference/glossary.md#workflow) `release`. Its Gate `review` takes
`approve`, with no input, and `reject`, with a `reason`. The Workflow has no [Agent](../reference/glossary.md#agent), so
you can try the steps with no model. Save the file as `workflows/release.ts` in your
[Instance](../reference/glossary.md#instance). Then run `jr2 up`:

<<< @/examples/guides/answer-a-gate/release.ts

In the commands, replace these values:

- `<namespace>`: the namespace of your Instance. It is the [`name`](../reference/config.md#name) in `jr2.config.ts`.
  When `jr2.config.ts` sets no `name`, it is the name of the Instance folder.
- `<run id>`: the run id, or its first 4 characters or more. `jr2 run` prints the run id in the line
  `run <run id> (<workflow>) — attached`.

Give each `jr2` command in the Instance folder.

## Start a run that waits

Start a run in one terminal. `jr2 run` stays attached while the run waits at the Gate:

```sh
jr2 run release --input '{"version":"1.4.0"}'
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
run 8c14e8f1-3bcf-4951-b400-a56973f5a38a (release) — attached
  → active "review"
```

Your run id is different. Give the commands in the next steps in a second terminal. [Start a run](start-a-run.md) gives
the other ways to start a run.

## Find the open Gate

Run [`jr2 status`](../reference/cli.md#status) with the run id:

```sh
jr2 status 8c14
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"8c14e8f1-3bcf-4951-b400-a56973f5a38a","workflow":"release","instanceId":"8af78244-a186-43b9-a30d-cd16f9df4afe","status":"active","value":"review","context":{"version":"1.4.0"},"children":[],"waiting":[],"held":[],"gates":[{"gate":"review","path":["review"],"accepts":[{"name":"approve","description":"Release this version.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}},{"name":"reject","description":"Do not release this version. Say why.","input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"reason":{"type":"string"}},"required":["reason"],"additionalProperties":false}}],"acceptsNow":["approve","reject"],"meta":{"version":"1.4.0"}}]}
```

`gates` holds each open Gate of the run, as a [`GateView`](../reference/http-api.md#type-gateview):

- `gate` is the id of the Gate. Give it in `--gate`. When the Machine gives the Gate no id, jr2 makes the id from the
  path of the Gate's state. Here it is `review`, the key of the state.
- `accepts` holds each event that the Gate accepts: its `name`, its `description`, and its `input` as JSON Schema.
- `acceptsNow` holds the events that the run takes now. A guard on a transition can remove an event from this list.
- `meta` holds the data that the Machine gives to the Gate.

A run that has no open Gate has `"gates":[]`.

## Answer from the CLI

Run [`jr2 send`](../reference/cli.md#send). Give the Gate in `--gate`, the event in `--event`, and the input of the
event as a JSON object in `--input`:

```sh
jr2 send 8c14 --gate review --event reject --input '{"reason":"The changelog is not ready."}'
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
delivered reject to gate "review" on 8c14e8f1-3bcf-4951-b400-a56973f5a38a
```

`jr2 send` prints `delivered` only when the run took the event. In the first terminal, the run ends:

<!-- output: not run -->

```text
  → done "rejected"
{"runId":"8c14e8f1-3bcf-4951-b400-a56973f5a38a","workflow":"release","instanceId":"8af78244-a186-43b9-a30d-cd16f9df4afe","status":"done","value":"rejected","context":{"version":"1.4.0","reason":"The changelog is not ready."},"children":[],"waiting":[],"held":[]}
```

The run ended, so its Gate closed. Each example below answers a run that waits. Before each example, start a new run in
the first terminal:

```sh
jr2 run release --input '{"version":"1.4.0"}'
```

For an event with no input, such as `approve`, do not give `--input`:

```sh
jr2 send <run id> --gate review --event approve
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
delivered approve to gate "review" on <run id>
```

`jr2 send` prints the full run id, also when you give a prefix.

## Answer from the Console

You need the Instance token to answer a Gate from the Console. [Open the Console](open-the-console.md) tells how to open
it and how to get the token.

1. Open the Console.
2. Type the Instance token in the `instance token` box in the nav.
3. Push Enter. The badge beside the box shows `…`, then `live`.
4. Click the `Attention` tab in the drawer on the right. It shows a card for each open Gate of the Workflow that you
   selected. To see the Gates of all the Workflows, select `all workflows`. When you select no Workflow, it shows them
   all.
5. Find the card. Its top line shows `⚑` and the id of the Gate at the left. At the right, it shows the Workflow and the
   first 8 characters of the run id. Below it, the card shows the `meta` of the Gate.
6. The card has a form for each event that the Gate accepts. Fill in the form of the event that you send. A field that
   has `*` after its name is necessary.
7. Click `send` in that form.

When the run takes the event, the card goes away. When the [Orchestrator](../reference/glossary.md#orchestrator) refuses
the event, the form shows the refusal text below the `send` button.

The `⚑` badge in the nav gives the number of open Gates in all the Workflows. Click it to open the `Attention` tab.

## Answer from a webhook or CI

A webhook handler or a CI job answers a Gate with
[`POST /runs/:runId/gates/:gate/events`](../reference/http-api.md#post-runs-runid-gates-gate-events) and the Instance
token. jr2 has no webhook receiver of its own. Your handler or job reads its own event, finds the run and the Gate, and
sends the call. The body is the event: `type` is the name of the event, and the other properties are its input.

`jr2 up` makes the Service `jr2-orchestrator` on port 4000, with no address outside the cluster. Thus a caller outside
the cluster uses a port forward, or an address that you make for the Service.

In a new terminal, forward a port to the Orchestrator. Keep this command open:

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

In a different terminal, get the Instance token into a variable:

```sh
TOKEN=$(kubectl -n <namespace> get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d)
```

Send the event. Use the full run id, because the route does not accept a prefix:

```sh
curl -s -X POST http://localhost:4000/runs/<run id>/gates/review/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"approve"}'
```

<!-- output: not run -->

```text
{"ok":true}
```

A webhook handler often knows a fact, such as a version, but not the run id. It can find the run from the `meta` of the
Gate. [`GET /runs`](../reference/http-api.md#get-runs) gives the live runs, and
[`GET /runs/:runId`](../reference/http-api.md#get-runs-runid) gives the open Gates of one run. This script approves the
`release` run that waits for one version. It needs `curl` and `jq`. Save it as `approve-release.sh`:

<<< @/examples/guides/answer-a-gate/approve-release.sh

```sh
JR2_URL=http://localhost:4000 JR2_TOKEN=$TOKEN VERSION=1.4.0 sh approve-release.sh
```

<!-- output: not run -->

```text
{"ok":true}
```

A CI job can also run `jr2 send`. With `JR2_URL` and `JR2_TOKEN`, `jr2 send` needs no Instance folder and no kubectl
context, and it accepts a prefix of the run id:

```sh
JR2_URL=http://localhost:4000 JR2_TOKEN=$TOKEN jr2 send <run id> --gate review --event approve
```

<!-- output: not run -->

```text
→ http://localhost:4000
delivered approve to gate "review" on <run id>
```

## Rules

- The Orchestrator refuses a Gate that is not open on the run, with the status code `404`:
  `no open gate "<gate>" on run "<run id>" (open: <gates>)`. The part `(open: <gates>)` shows only when the run has an
  open Gate. When an event takes the run out of the state of the Gate, the Gate closes. Thus a second answer gets this
  refusal.
- The Orchestrator refuses an event that the Gate does not accept, with the status code `400`:
  `"<gate>" does not accept "<event>" (accepts: <events>)`
- The Orchestrator refuses an input that does not agree with the schema of the event, with the status code `400`:
  `invalid "<event>" payload: <issues>`. `<issues>` is the list of the problems as JSON.
- The Orchestrator refuses an event that the run does not take now, with the status code `409`, and delivers nothing:
  `gate "<gate>" is open, and the run does not take "<event>" now: <why> — not delivered (takes now: <events>)`. The
  body also holds `acceptsNow`.
- The Orchestrator refuses a body with no `type`, with the status code `400`:
  `event body must carry a string "type" (one of the gate's accepted names)`
- The Orchestrator refuses a body that holds `sender`, with the status code `400`:
  `` `sender` is written by the Orchestrator on every delivered event; a caller cannot send it ``
- The Orchestrator refuses an event without the Instance token, with the status code `401`: `unauthorized`.
- The Orchestrator refuses an event with the token of a [Sandbox](../reference/glossary.md#sandbox), with the status
  code `403`: `a Sandbox token cannot deliver to a gate — gates are not on the Agent's surface`. Thus an Agent cannot
  answer a Gate.
- `jr2 send` prints each refusal of the Orchestrator as `error: <refusal>`, and exits with `1`. After a `404` refusal,
  it also prints the version of the Instance in one more line:
  ``instance: <version> (<hash>) — if it predates this CLI, `jr2 up` converges the cluster to this kit``. `<hash>` is
  the content hash of the image of the Instance.
- `jr2 send` without `--gate` sends run control, and run control accepts only `CANCEL`. For a different event, it exits
  with `2`: `jr2 send: unknown event "<event>" (run control accepts: CANCEL; workflow events need --gate)`
- With `--gate`, `jr2 send` sends nothing when `--input` is not valid JSON. It exits with `2`:
  `jr2 send: --input is not valid JSON`
- `jr2 send` with no run id or no `--event` sends nothing. It prints its help and exits with `2`.

## Read next

- [Gates](../concepts/gates.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): a Gate, its events, and its `meta`.
- [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md): why an
  Agent cannot answer a Gate, and why a refused event is not delivered.
- [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-the-instance-token.md): the Instance token in the
  Console.
- [Start a run](start-a-run.md)
- [Watch a run](watch-a-run.md)
