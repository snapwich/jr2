---
title: Cancel a run
description: End a live run with CANCEL, and delete its Sandboxes or keep them to look inside.
---

End a live run with `CANCEL`, and delete its [Sandboxes](../reference/glossary.md#sandbox) or keep them to look inside.

In the commands on this page, replace these values:

- `<run id>`: the id of the run. A prefix of the id, 4 characters or more, also works with `jr2`. `jr2 run` prints the
  id in the line `run <run id> (<workflow>) — attached`.
- `<namespace>`: the namespace of your [Instance](../reference/glossary.md#instance). It is the
  [`name`](../reference/config.md#name) in `jr2.config.ts`. When `jr2.config.ts` sets no `name`, it is the name of the
  Instance folder.
- `<context>`: the kubectl context that `jr2` uses. It is the current kubectl context, or the value of `--context`.

Give each `jr2` command in the Instance folder.

## Cancel the run

```sh
jr2 send <run id> --event CANCEL
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
sent CANCEL to <run id>
```

`jr2` prints the full run id, also when you give a prefix. Then these things occur:

- The run ends with the status `cancelled`. It does not start again when the
  [Orchestrator](../reference/glossary.md#orchestrator) restarts.
- The [Turn](../reference/glossary.md#turn) of each [Agent](../reference/glossary.md#agent) in the run ends.
- The Orchestrator deletes each Sandbox of the run. When a Sandbox goes, a commit that you did not push goes with it.

A `jr2 run` that is attached to the run prints `→ cancelled`, then the state that the run was in. Then it prints the
status of the run as JSON and exits with the code 0.

## Keep the Sandboxes

To look inside the Sandboxes after the run ends, add `--keep`:

```sh
jr2 send <run id> --event CANCEL --keep
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
sent CANCEL to <run id>; its Workspaces are kept
```

The run ends as before, but the Orchestrator does not delete its Sandboxes. To open a shell in one, see
[Look inside a Sandbox](look-inside-a-sandbox.md). A [Workspace](../reference/glossary.md#workspace) in
[Placing](../reference/glossary.md#placing) deletes its Sandbox at once, also with `--keep`. Its Sandbox has no node
yet, so it has nothing to look inside.

Nothing renews the [Lease](../reference/glossary.md#lease) of a Workspace that you keep. The
[operator](../concepts/architecture.md#the-operator) deletes its Sandbox 30 minutes after the last renewal. To delete
the Sandbox before then, find its name. The label `jr2.dev/run` takes the full run id that `jr2 send` printed:

```sh
kubectl -n <namespace> get sandboxes -l jr2.dev/run=<run id>
```

[Look inside a Sandbox](look-inside-a-sandbox.md#find-the-sandbox) shows the output of this command. Then give the name
to this command:

```sh
kubectl -n <namespace> delete sandbox <sandbox>
```

<!-- output: not run -->

```text
sandbox.core.jr2.dev "<sandbox>" deleted
```

## Read how the run ended

```sh
jr2 status <run id>
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"<run id>",…,"status":"cancelled",…}
```

`jr2 status` prints the status of the run as one line of JSON. Its `status` is `cancelled`, and its `value` is the state
that the run was in when you cancelled it.

## Cancel from HTTP

A client that is not the CLI sends `CANCEL` to
[`POST /runs/:runId/events`](../reference/http-api.md#post-runs-runid-events), with the Instance token. The path takes
the full run id, not a prefix. To get the Instance token, see
[Open the Console](open-the-console.md#get-the-instance-token). To keep the Sandboxes, add `"keep": true` to the body.
This example reaches the Orchestrator through the port forward in [Open the Console](open-the-console.md):

```sh
curl -X POST http://localhost:4000/runs/<run id>/events \
  -H "authorization: Bearer <Instance token>" \
  -d '{"type":"CANCEL","keep":true}'
```

<!-- output: not run -->

```text
{"ok":true}
```

## Rules

- `--keep` goes only with `--event CANCEL`. With `--gate` or with a different event, `jr2 send` exits with the code 2:
  `jr2 send: --keep goes with --event CANCEL alone (it keeps a cancelled run's Workspaces)`
- Without `--gate`, `CANCEL` is the only event. Each other event exits with the code 2:
  `jr2 send: unknown event "<event>" (run control accepts: CANCEL; workflow events need --gate)`. To send an event of
  the [Workflow](../reference/glossary.md#workflow) to a [Gate](../reference/glossary.md#gate), see
  [Answer a Gate](answer-a-gate.md).
- A prefix of fewer than 4 characters exits with the code 2: `jr2: run id "<run id>" is too short (need 4+ characters)`
- A prefix that finds no run exits with the code 1: `no run "<run id>"`. A prefix that finds two or more runs exits with
  the code 1, and lists them: `error: run id "<run id>" is ambiguous`
- `CANCEL` changes only a live run. A run that has already ended does not change, and `jr2 send` still prints
  `sent CANCEL to <run id>`. A full id of no run also prints `sent CANCEL to <run id>`, because `jr2 send` does not look
  up a full id.
- A run that faults is not live, so `CANCEL` does not delete its Sandboxes. The operator deletes them 30 minutes after
  the last renewal of their Lease.
- A cancelled run does not continue. To do the work again, start a new run.
- [`POST /runs/:runId/events`](../reference/http-api.md#post-runs-runid-events) refuses a body with a different `type`
  with the status 400: `unknown event type "<type>" (accepts: CANCEL)`
- It refuses a `keep` that is not `true` or `false` with the status 400: `"keep" must be a boolean`
- It refuses a request with no valid token with the status 401: `unauthorized`. It refuses a Sandbox token with the
  status 403: `run state and control need the Instance token — a Sandbox token has neither`
- A path with a prefix of the run id, or with an id of no run, gets `{"ok":true}` with the status 200. Nothing changes.

## Read next

- [Durable runs](../concepts/durable-runs.md)
- [ADR-0025](../reference/decisions/0025-cancel-ends-a-run-stop-parks-it.md): why CANCEL ends a run and deletes its
  Sandboxes.
- [`jr2 send`](../reference/cli.md#send)
- [Look inside a Sandbox](look-inside-a-sandbox.md)
