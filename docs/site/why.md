---
title: Why jr2
description: The parts of jr2, the problems of agentic workflows that each part solves, and one run through them.
---

jr2 runs an agentic workflow as a [Machine](reference/glossary.md#machine): a graph of states that you write. In a
state, an [Agent](reference/glossary.md#agent) or an [Effect](reference/glossary.md#effect) does the work, or a
[Gate](reference/glossary.md#gate) waits for an answer. The Machine decides which state comes next. The diagram shows
the parts of jr2, from you to the world outside your cluster.

::: diagram layers The parts of jr2, from you to the world outside your cluster

- **You**: start runs, and answer them
  - jr2 CLI
  - Console
  - your own app
- ↓ you start a run · ↑ approval → You: a Gate asks you · ↓ You → approval: you answer
- **your cluster**: `jr2 up` sets it up
  - **Orchestrator**: runs your Machine, and keeps each run
    - ● → code → **review** → approval → ◉ done
      - review → approval: `approved`
      - review → code: `changes`
      - approval → code: `changes`
  - ↓ `review` gives the reviewer a Turn and its Menu · ↑ the reviewer picks `approved`
  - **Sandbox**: one pod for each Workspace
    - **Harness**: runs each Turn, with a shell
      - **coder** (Agent): edits and commits
      - **reviewer** (Agent): its Menu: `approved` `changes`
      - **Worktree**: your code
    - **Custodian**: keys that the Agents can use but not read, such as the model key
    - **Effector**: keys that only your Effects use, such as a git credential
- ↓ Custodian → Outside · Effector → Outside
- **Outside**: what the work uses
  - model provider
  - your APIs
  - git host

:::

Each section below gives one problem of agentic workflows, and the part of the diagram that solves it. The sections go
from the top of the diagram to the bottom.

## Headless

A workflow must connect to the systems that you use, such as a code review, a chat or a CI job. One user interface
cannot be the right one for each of them.

The You band of the diagram holds the clients of jr2. The [Orchestrator](reference/glossary.md#orchestrator) is an HTTP
API. The [jr2 CLI](reference/glossary.md#jr2-cli) and the [Console](reference/glossary.md#console) are its clients, and
your own app, such as a webhook, can be one too. For example, a client can start a run with
[`POST /workflows/:name/runs`](reference/http-api.md#post-workflows-name-runs). In the diagram, a
[Gate](reference/glossary.md#gate) in the state `approval` asks you, and you answer from any of these clients, with
[`POST /runs/:runId/gates/:gate/events`](reference/http-api.md#post-runs-runid-gates-gate-events).

Read [Architecture](concepts/architecture.md) and [Gates](concepts/gates.md).

## Determinism

A workflow must do the steps that it sets, in the order that it sets. But a model does not do the same thing two times.
When the steps of a workflow are text in a prompt, the model can skip a step or change the order. "You must" and "never"
are requests to the model, not rules that it must obey. You can review the code that an agentic workflow makes, but you
cannot easily review how it made that code.

In jr2, a workflow is a Machine: an [xstate](https://xstate.js.org) state machine in TypeScript. The Orchestrator band
of the diagram holds an example Machine, with the states `code`, `review` and `approval`, and the final state `done`.
Its states and its transitions are a graph that you can read before a run starts. The Console draws that graph, and
while a run runs, it shows the state that the run is in. A Machine can have loops: in the diagram, `changes` sends the
run back to `code`.

An Agent does not move the Machine itself. A [Turn](reference/glossary.md#turn) is one piece of work for one Agent. The
state that the run is in gives the Agent a prompt and a [Menu](reference/glossary.md#menu): the events that go out of
that state. In the diagram, the run is in `review`, so the Menu of the reviewer is `approved` and `changes`. The Agent
ends its Turn with one pick from its Menu, and the Machine refuses a pick that is not one of its
[Allowed picks](reference/glossary.md#allowed-picks) now. Thus the model makes the decision in each state, and the
Machine sets the transition that each decision causes. You review how the work happens, not only the code that comes out
of it. The model is not deterministic, but the Machine is: in one state, one pick always causes the same transition.

The Agent can also decide the order of the work. A pick whose target is inside the Agent's state does not end the Turn.
The Machine runs the work of the pick, such as an Effect or a Gate, and answers the pick with the result. A
[mode](reference/glossary.md#mode) or a guard sets which picks the Agent can make next. Thus the Agent decides when each
step runs, and the Machine decides what each step does. An Agent can also write a [Chart](reference/glossary.md#chart):
a Machine as data, which jr2 checks before it runs.

Read [Machines and Workflows](concepts/machines-and-workflows.md),
[The Menu](concepts/the-menu.md#keep-the-turn-or-end-it) and [Charts](concepts/charts.md).

## Composition

An Agent does one thing well. When you give it many things at the same time, it loses its focus. The infrastructure of a
workflow, such as a Sandbox or a set of work items, also must not get into the task of the Agent.

The diagram shows one Machine, but the infrastructure around it is xstate too. A
[Workspace](reference/glossary.md#workspace) wraps a body Machine that does not know about the Sandbox. A
[Pool](reference/glossary.md#pool) runs one worker Machine for each item that a [Source](reference/glossary.md#source)
gives. A Gate is an actor that a state invokes to wait for an outside input, such as the Gate in `approval`. Each state
sets the [Frame](reference/glossary.md#frame) of one Turn, so an Agent does one thing at a time.

A Machine can invoke a different Machine. A Machine can also leave a part [Open](reference/glossary.md#open), such as
the URL of a Repo or the model of an Agent. You bind that part with
[`customize()`](reference/authoring-surface/customize.md). Thus a Machine can come from an npm package, such as the
[`task`](reference/machines.md#task) Machine in `@jr2/machines`.

Read [Composition](concepts/composition.md) and [Pools and Sources](concepts/pools-and-sources.md).

## Isolation

A filesystem sandbox is not isolation. Agents on one computer share its ports, its processes and its credentials. Two
Agents can need the same port, or the same file in your home folder. An Agent can also leave a process or a server that
runs after the work stops.

The Sandbox band of the diagram is one pod. An Agent that works on a [Repo](reference/glossary.md#repo) works in a
[Sandbox](reference/glossary.md#sandbox): a pod with its own filesystem, network and processes. There is one Sandbox for
each Workspace, and the Agents of one Workspace share it. The [Harness](reference/glossary.md#harness) runs each Turn.
It talks to the model, and it runs the tools of the Agent. The Agent can run each command in the Harness container. An
Agent that needs only its Menu has no Sandbox. Its Turns run on the
[Instance Harness](reference/glossary.md#instance-harness).

The Harness container holds no credential, so a command that an Agent runs cannot read one. jr2 keeps each credential in
one of the two containers beside it:

- The [Custodian](reference/glossary.md#custodian) holds each [Held secret](reference/glossary.md#held-secret): a key
  that the Agents can use, but cannot read. The Harness holds only a [Stand-in](reference/glossary.md#stand-in) for it.
  The Custodian puts the real key in place of the Stand-in, in each request to the host of that key. A Stand-in has no
  value outside its pod. The model key is a Held secret. A token for an API that the Agents call can be one too.
- The [Effector](reference/glossary.md#effector) holds each [Effect secret](reference/glossary.md#effect-secret): a key
  that only an [Effect](reference/glossary.md#effect) of your Machine uses, such as a push or a call to an API. The
  Agents cannot use it.

Put a key in the Custodian when the Agents can use it as they decide. Put it in the Effector when only your Machine
decides when to use it. One key can be in both containers.

When the Workspace ends, its Sandbox ends too. When a [Lease](reference/glossary.md#lease) lapses, the operator removes
what the Agents left behind.

Read [Workspaces](concepts/workspaces.md) and [Secrets and trust](concepts/secrets-and-trust.md).

## Model agnostic

A workflow must not depend on one model or one provider. You can change the model of one Agent, and keep the Machine.

In the diagram, the line from the Custodian goes to a model provider outside your cluster. jr2 has one Harness, and it
is jr2's own. An Agent is a model and its instructions. The model is a name such as `<provider>/<model>`. The provider
is one from the model catalog of the Harness, or an endpoint that you run and set in
[`harness.provider`](reference/config.md#harness-provider). The same Harness runs the Turns of each Agent, with each
provider. A state can set the model of one Turn.

Read [Agents and Turns](concepts/agents-and-turns.md).

## Distribution

One computer has a limit. One build can use all of its CPU, and the other Agents then wait. A run on a laptop also stops
when the laptop stops.

In the diagram, the bracket is your cluster, and the compute is in it. For each Agent, the Orchestrator holds only an
[Actor](reference/glossary.md#actor): a local handle. The Harness that runs the Turns of the Agent runs where the
cluster puts it. A Sandbox can go on each node that can run an ordinary pod. The Orchestrator keeps a snapshot of each
run on its volume, so a run continues after a restart of the Orchestrator. On a shared cluster, a run continues when
your computer is off.

Read [Architecture](concepts/architecture.md).

## One converging command

A workflow that runs on a laptop must also run on a shared cluster, without a second set of steps.

The bracket of the diagram has the label `jr2 up`. [`jr2 up`](reference/cli.md#up) converges an
[Instance](reference/glossary.md#instance) folder into the cluster of the current kubectl context. It builds the images
that the folder needs, and it puts the Orchestrator and the operator in the cluster. It does not start a Sandbox: during
a run, the operator makes one Sandbox for each Workspace. The same folder converges into kind on a laptop or into a
shared cluster. You select the cluster with the kubectl context. A shared cluster also needs a container registry, which
`.env` gives to [`registry`](reference/config.md#registry). You can run `jr2 up` again at any time.

Read [Converge](concepts/converge.md).

## A typed Instance

An error in a workflow or in its config can show only when a run gets to it. A run can take many minutes to get there.

In jr2, a Machine names its Agents, its [Repo Slots](reference/glossary.md#repo-slot) and the Machines that it invokes,
and TypeScript checks each name. `jr2.config.ts` uses [`defineConfig()`](reference/authoring-surface/defineconfig.md),
so TypeScript checks the config too. `jr2 up` runs the typecheck first. When the typecheck fails, `jr2 up` builds
nothing and changes nothing on the cluster. Next, it refuses an Open part that no `customize()` binds. Thus you find
these errors before a run starts.

Read [Converge](concepts/converge.md) and [Machines and Workflows](concepts/machines-and-workflows.md).

## One run

These steps follow one run of the example Machine in the diagram. You write a Machine like it in TypeScript, or your
[Assistant](reference/glossary.md#assistant) writes it for you.

::: diagram steps

1. **You start a run.** You run `jr2 run feature`, with the ticket as the input of the run. The Machine starts in its
   first state, `code`.
2. **The coder works in a Sandbox.** The state `code` is in a Workspace, so jr2 makes a Sandbox for it. The Sandbox
   holds a [Worktree](reference/glossary.md#worktree) of your Repo, on the branch of the run. The coder edits the files,
   runs the tests and commits. Then it picks `finish`, and the Machine moves to `review`.
3. **The reviewer gets a Turn.** The state `review` gives the reviewer a prompt and its Menu: `approved` and `changes`.
   The reviewer reads the change in the same Sandbox.
4. **The reviewer picks.** If it picks `approved`, the Machine moves to `approval`. If it picks `changes`, the Machine
   goes back to `code`, and the coder continues its work.
5. **The run waits for you.** In `approval`, a Gate holds the run until you answer. You approve the work, or you ask for
   changes. You answer in the Console, with `jr2 send`, or from your own app.
6. **The run ends.** The Machine gets to `done`. The Workspace ends, and its Sandbox pod stops with it.

:::

The [`task`](reference/machines.md#task) Machine in `@jr2/machines` is a smaller Machine of this kind: a coder in a
Sandbox, and a Gate that you answer. The [Get started](get-started/install.md) tutorial runs it.
