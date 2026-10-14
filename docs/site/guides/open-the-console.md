---
title: Open the Console
description: Forward the port of the Orchestrator, open the Console, and unlock it with the Instance token.
---

Open the [Console](../reference/glossary.md#console) in a browser, and paste the Instance token to start runs and answer
[Gates](../reference/glossary.md#gate).

The [Orchestrator](../reference/glossary.md#orchestrator) serves the Console on port 4000, in the cluster. To reach it
from your computer, forward the port with `kubectl`. In the commands on this page, replace `<namespace>` with the
namespace of your [Instance](../reference/glossary.md#instance). It is the [`name`](../reference/config.md#name) in
`jr2.config.ts`. When `jr2.config.ts` sets no `name`, it is the name of the Instance folder. No `jr2` command opens the
Console.

## Forward the port

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

<!-- output: not run -->

```text
Forwarding from 127.0.0.1:4000 -> 4000
Forwarding from [::1]:4000 -> 4000
```

The command stays in the foreground. Keep it open while you use the Console. Give the other commands in a second
terminal. To use a different port on your computer, change the first number, such as `8080:4000`. For a cluster that is
not the current kubectl context, add `--context <context>`, with the name of its kubectl context.

## Open the page in a browser

Open `http://localhost:4000` in a browser.

Without the token, the Console shows the runs, and you cannot change them:

- The Fleet rail on the left lists each [Workflow](../reference/glossary.md#workflow), with the number of its live runs.
  Click the caret of a Workflow to list its runs.
- The center shows the [Machine](../reference/glossary.md#machine) of the Workflow that you select. When you select a
  run, the Console shows the states that the run is in.
- The Activity tab of the right drawer lists the type of each [Emit](../reference/glossary.md#emit) of the runs of the
  Workflow, the newest first.

The address shows the Workflow that you select. Open `http://localhost:4000/workflows/<workflow>` to go to one Workflow
directly. Replace `<workflow>` with its name, such as `ping`.

## Get the Instance token

`jr2 up` makes the [Instance token](../concepts/secrets-and-trust.md#the-tokens) when it first converges the Instance,
and keeps it after that. It is in the Kubernetes Secret `jr2-instance`:

```sh
kubectl -n <namespace> get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d
```

The command prints the token, with no line break after it.

::: warning

The Instance token starts runs, answers Gates and cancels runs. Keep it as you keep a password.

:::

## Paste the token

Paste the token into the box `instance token` in the nav of the Console. Push Enter. The badge after the box shows `…`
while the Console checks the token, then `live`. With a live token, the Console shows more:

- A `start` button for each Workflow in the Fleet rail. It opens a form for the run input of the Workflow. A Workflow
  that declares no run input gets a box for JSON.
- The Attention tab of the right drawer. It shows a card for each open Gate of the selected Workflow, with a form to
  send each event that the Gate takes. Select `all workflows` to see the Gates of each Workflow.

The Console keeps the token in the browser tab. A reload keeps it. When you close the tab, the token is gone.

## Rules

- A token that the Orchestrator does not accept reads `invalid`. The Console then shows no `start` button and no
  Attention tab.
- When the Orchestrator refuses the token later, with the status 401, the Console goes back to view only.
- Only the Instance token unlocks the Console. A [Sandbox](../reference/glossary.md#sandbox) token reads `invalid`.
- The port forward stops when you stop its command, or when the Orchestrator pod restarts. Then run the command again.

## Read next

- [Architecture](../concepts/architecture.md)
- [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-the-instance-token.md): why the token unlocks the
  Console.
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): what the Console shows with no token.
- [`GET /`](../reference/http-api.md#get) and the [open band](../reference/http-api.md#band-open)
- [Answer a Gate](answer-a-gate.md)
- [Start a run](start-a-run.md)
