---
title: Open the Console
description: Forward the port of the Orchestrator, open the Console, and unlock it with a token or a login.
---

Open the [Console](../reference/glossary.md#console) in a browser. Paste a token, or log in, to start runs and answer
[Gates](../reference/glossary.md#gate). The Console shows only what the [Caller](../reference/glossary.md#caller) of the
token may do.

The [Orchestrator](../reference/glossary.md#orchestrator) serves the Console on port 4000, in the cluster. To reach it
from your computer, forward the port with `kubectl`. In the commands on this page, replace `<namespace>` with the
namespace of your [Instance](../reference/glossary.md#instance). It is the [`name`](../reference/config.md#name) in
`jr2.config.ts`. When `jr2.config.ts` sets no `name`, it is the name of the Instance folder. No `jr2` command opens the
Console.

## Forward the port

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

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
- A run on an [Assembly](../reference/glossary.md#assembly) that is not the current one shows the mark
  `older Assembly · <hash>`. The center then shows the Machine of that run, not the current Machine.
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

Paste the token into the box `Caller token` in the nav of the Console. Push Enter. The badge after the box shows `…`
while the Console checks the token, then `live`. The nav then shows who the Console acts as, such as
`as token/instance`. Put the pointer on the name to see its scopes.

The Console asks the Orchestrator what the token may do ([`GET /whoami`](../reference/http-api.md#get-whoami)). Then it
shows each control that a scope of the token opens:

| Scope    | What the Console shows                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | A `start` button for the Workflow in the Fleet rail. It opens a form for the run input of the Workflow.                                                                                   |
| `answer` | The Attention tab of the right drawer, with a card for each open Gate and a form for each event it takes.                                                                                 |
| `read`   | The full state of the selected run: why it waits, why it failed, and who started it. The ended runs of the Workflow in the Fleet rail. The conversations of the run in the bottom drawer. |
| `cancel` | A `cancel run` button on the selected run, while the run is live.                                                                                                                         |
| `steer`  | A box in the bottom drawer, beside the [Agent](../reference/glossary.md#agent) slot, to send a [Steering message](../reference/glossary.md#steering-message) while the run is live.       |

The Instance token has each scope for each Workflow, so it shows each control. A named Caller token shows the controls
of its scopes, for its Workflows ([Give a Caller a scope](give-a-caller-a-scope.md)). A Workflow that declares no run
input gets a box for JSON in its start form. In the Attention tab, select `all workflows` to see the Gates of each
Workflow.

The Console keeps the token in the browser tab. A reload keeps it. When you close the tab, the token is gone. Click
`sign out` to forget it before then.

## Read a conversation

With `read`, the Fleet rail lists the ended runs of the selected Workflow under its live runs, each with its status. A
`drifted` run shows its reason. Click an ended run to see its Machine, the state where it ended, and its conversations,
for as long as jr2 keeps the run ([`runs.retain`](../reference/config.md#runs)).

The bottom drawer shows the [Conversations](../reference/glossary.md#conversation) of the selected run. Closed, it is a
bar with one tab for each Agent slot of the run. A dot shows a slot whose [Turn](../reference/glossary.md#turn) is open.
Click a tab to open the drawer on that slot. The drawer shows what the model wrote, each tool call with the answer of
its pick, the refusals, the Steering messages and the notices. While the Turn is open, the drawer adds each new entry.
Drag the top edge of the drawer to change its height. The browser keeps the height for you.

## Log in

When the Instance declares an issuer with [`login: true`](../reference/config.md#callers), the nav shows a `log in`
button. Click it. The browser goes to the login page of the issuer, and then comes back to the Console. The Console then
acts as you, with the scopes that your groups give. The nav shows the name that jr2 shows for you, such as your email.

To make the login work, register a client at the issuer:

- A public client, with no secret. Its client id is the `audience` of the issuer entry.
- The redirect URI is the root of the Console, such as `http://localhost:4000/`.
- The issuer must let the origin of the Console call its discovery document and its token endpoint (CORS).

The login needs the Console on `https`, or on `localhost`, because the browser makes its code challenge only there.

## Rules

- A token that the Orchestrator does not accept reads `invalid`. The Console then shows no `start` button and no
  Attention tab.
- When the Orchestrator refuses the token later, with the status 401, the Console goes back to view only. An expired
  login and a rotated token do this.
- A login whose groups give no scope reads `live` and shows no control. The nav shows who you are, so that you can see
  why.
- A [Sandbox](../reference/glossary.md#sandbox) token is not a Caller. It reads `invalid`.
- The Console hides a control that the scopes do not open, so that you do not get a 403. The Orchestrator still checks
  each request.
- The port forward stops when you stop its command, or when the Orchestrator pod restarts. Then run the command again.

## Read next

- [Architecture](../concepts/architecture.md)
- [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-a-callers-credential.md): why a Caller's credential
  unlocks the Console, and how the login works.
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): the
  Callers and their scopes.
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): what the Console shows with no token.
- [`GET /`](../reference/http-api.md#get) and the [open band](../reference/http-api.md#band-open)
- [Answer a Gate](answer-a-gate.md)
- [Start a run](start-a-run.md)
