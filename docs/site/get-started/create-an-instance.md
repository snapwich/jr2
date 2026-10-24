---
title: Create an Instance
description: Make an Instance folder, converge it into the kind cluster, run its first Workflow, and open the Console.
---

At the end of this page, you have an [Instance](../reference/glossary.md#instance) in the kind cluster. You ran its
first [Workflow](../reference/glossary.md#workflow), `ping`, and you looked at it in the
[Console](../reference/glossary.md#console).

## Before you start

Do [Install](install.md) first. You need the jr2 CLI, Docker and the kind cluster `jr2`. The current kubectl context
must be `kind-jr2`.

## Make the Instance folder

Run:

```sh
jr2 init my-instance
```

`jr2 init` makes the folder `my-instance` and writes the files of a new Instance in it:

```text
jr2 init — scaffolding my-instance in /tmp/my-instance
  create package.json
  create tsconfig.json
  create jr2.config.ts
  create .gitignore
  create workflows/ping.ts
  create images/default/Dockerfile
  create AGENTS.md
  create CLAUDE.md
done — install dependencies (npm, pnpm, or bun), then `jr2 up` and `jr2 run ping`
```

The path of your folder is different.

## Read the folder

Open the folder in your editor. Each file has a job:

| File                        | What it holds                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`              | The dependencies. `@jr2/orchestrator` and `@jr2/cli` have one exact version: the [Kit version](../reference/glossary.md#kit-version) of the Instance.                                                                                        |
| `tsconfig.json`             | The TypeScript settings. They come from `@jr2/orchestrator`, so that your editor and `jr2 up` check the code in the same way.                                                                                                                |
| `jr2.config.ts`             | The facts of this Instance that a [Machine](../reference/glossary.md#machine) does not hold, such as the git credentials and the secrets. The next page adds a model to it. The [config reference](../reference/config.md) gives each field. |
| `.gitignore`                | It keeps `.env`, `node_modules/` and `.jr2/` out of git. `.env` holds your secret values.                                                                                                                                                    |
| `workflows/ping.ts`         | The Workflow `ping`. Each `.ts` file in `workflows/` is one Workflow, unless its name starts with `_` or ends with `.d.ts`. Its name is the file name without `.ts`.                                                                         |
| `images/default/Dockerfile` | The [Sandbox Image](../reference/glossary.md#sandbox-image): the tools that an [Agent](../reference/glossary.md#agent) can use in a [Sandbox](../reference/glossary.md#sandbox). This tutorial does not change it.                           |
| `AGENTS.md`                 | The instructions for your [Assistant](../reference/glossary.md#assistant). `jr2 init` and `jr2 up` write the index of the jr2 docs between the two `jr2-docs` markers. Write your own instructions after the `END` marker.                   |
| `CLAUDE.md`                 | One line, `@AGENTS.md`. Claude Code reads `CLAUDE.md`, and this line tells it to read `AGENTS.md` too.                                                                                                                                       |

Open `workflows/ping.ts`. Its last part is the Machine: an xstate state machine with two states. In `responding`, the
Machine calls a function that replies `pong: <message>`, where `<message>` is the `message` of the run input. Then it
goes to `done`, its final state. `ping` uses no model and no Sandbox, so it runs before you connect a model.

## Install the dependencies

Go into the folder `my-instance` (`cd my-instance`). Run:

```sh
npm install
```

npm installs the Kit at the version that `package.json` gives. npm prints its progress and a summary of the packages
that it added. This page does not show that output. From now on, run each `jr2` command in `my-instance`.

## Converge the Instance

Run:

```sh
jr2 up
```

`jr2 up` checks the folder with the TypeScript compiler before it changes the cluster. Then it converges the cluster of
your current kubectl context. The first time, it asks before it makes the namespace. Type `y`:

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
agents: (none) (carried by 1 workflow machine(s))
assembly: staging
assembly: ba71fa27f37f (kit v<version>; 1 workflow(s): ping)
kubernetes: v1.36.1 (floor 1.35, ADR-0037)
first contact: deploy instance "my-instance" to context kind-jr2 (create namespace "my-instance")? [y/N] y
platforms: linux/amd64 (from 1 schedulable node(s))
images: installed kit — the published v<version> Harness, operator and Orchestrator, pulled from ghcr.io/snapwich
…
orchestrator: waiting for rollout
orchestrator: verified — 1 pod(s) running ghcr.io/snapwich/jr2-orchestrator:<version>
instance effector: none (no Effect is placed there)
assembly: publishing ba71fa27f37f (no current Assembly)
assembly: ba71fa27f37f is current — workflows: ping
swept nothing — every labeled image is named by a live root
converged — `jr2 run <workflow>` when ready
```

`<version>` is the Kit version, such as `0.4.1`. `ba71fa27f37f` is the hash of the
[Assembly](../reference/glossary.md#assembly) of your Instance: your Workflows and your config. Your hash can be
different. It changes each time that your Workflows or your config change.

The namespace is `my-instance`, because `jr2.config.ts` sets no `name`. The first `jr2 up` takes longer than the next
ones, because the cluster pulls the images of the Orchestrator and of the operator. If `jr2 up` stops with `refusing:`,
read [Fix a failed converge](../guides/fix-a-failed-converge.md).

## Run ping

Run:

```sh
jr2 run ping --input '{"message":"hi"}'
```

`jr2 run` starts a run of `ping` and stays attached to it. When the run ends, it prints the last status of the run as
JSON:

```text
→ context kind-jr2 / namespace my-instance
run a256ff8a-f99f-42f5-975c-4f93a5008c56 (ping) — attached
  → done "done"
{"runId":"a256ff8a-f99f-42f5-975c-4f93a5008c56","workflow":"ping","instanceId":"0e82cc83-7c15-426f-86ff-e7354873a429","status":"done","value":"done","context":{"message":"hi","reply":"pong: hi"},"children":[],"waiting":[],"held":[],"assembly":"ba71fa27f37f"}
```

Your run id and your [Instance ID](../reference/glossary.md#instance-id) are not the same as the ones here. The run is
`done`, and its `context` holds the `reply`, `pong: hi`.

`jr2 run` writes the JSON on stdout and the other lines on stderr. Thus `jr2 run ping | jq` gives only the JSON. The
[CLI reference](../reference/cli.md#run) gives the options of `jr2 run`.

## Open the Console

No jr2 command opens the Console. Forward the port of the [Orchestrator](../reference/glossary.md#orchestrator) to your
computer. Open a second terminal. Run:

```sh
kubectl -n my-instance port-forward svc/jr2-orchestrator 4000:4000
```

kubectl stays open while it forwards the port:

```text
Forwarding from 127.0.0.1:4000 -> 4000
Forwarding from [::1]:4000 -> 4000
```

Open `http://localhost:4000` in your browser. The Fleet rail on the left lists the Workflows of the Instance: `ping`.
Click `ping`. The center shows its Machine, with the states `responding` and `done`.

## Unlock the Console

Without a token, you can look at the runs in the Console, but you cannot start a run or answer a
[Gate](../reference/glossary.md#gate). For these, you need the Instance token. In the first terminal, run:

```sh
kubectl -n my-instance get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d
```

The command prints the token, 48 hexadecimal characters, with no newline after it. Paste the token in the
`instance token` box in the Console nav. Push Enter. The Console checks the token. Then the badge after the box shows
`live`, and a `start` button shows next to `ping`. The browser tab keeps the token until you close the tab. `jr2 up`
keeps the same token each time that it runs.

Keep the port forward open. The next pages use the Console. [Open the Console](../guides/open-the-console.md) gives more
about the Console.

## What happened

`jr2 init` made an Instance: a folder that you own, with its config and its Workflows. `jr2 up` read the folder and
converged the cluster to it. It started the Orchestrator in the namespace `my-instance`, from the image of your Kit
version. Then it published your Workflows and your config to the Orchestrator, as the Assembly. You run `jr2 up` again
each time that you change the folder. [Converge](../concepts/converge.md) explains what `jr2 up` makes, and
[ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md) gives the reasons.

`jr2 run` started a run of `ping` in the Orchestrator. A Workflow is a Machine with a name, and the Orchestrator runs
it. [Machines and Workflows](../concepts/machines-and-workflows.md) explains the two words.

The Console is a page that the Orchestrator serves, at [`GET /`](../reference/http-api.md#get). Anyone who can reach it
can see the runs. Only the holder of the Instance token can start a run or answer a Gate
([ADR-0032](../reference/decisions/0032-the-console-unlocks-with-the-instance-token.md)).

`jr2 init` wrote `AGENTS.md` for your Assistant. It points to the docs that the Kit installs in
`node_modules/@jr2/orchestrator/docs/`. These are the docs of your Kit version
([ADR-0072](../reference/decisions/0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md)). The
last page of this tutorial uses them.

## Next

[Connect a model](connect-a-model.md).
