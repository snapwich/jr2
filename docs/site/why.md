---
title: Why jr2
description: The problems of agentic workflows that jr2 solves, and how it solves each one.
---

An agentic workflow gives work to a model, and the model decides how to do it. This page gives the problems that jr2
solves for such a workflow. Each section states a problem, says how jr2 answers it, and links to the Concept that
explains it.

## Non-determinism

A model does not do the same thing two times. When the steps of a workflow are text in a prompt, the model can skip a
step or change the order. "You must" and "never" are requests to the model, not rules that it must obey. You can review
the code that an agentic workflow makes, but you cannot easily review how it made that code.

In jr2, a workflow is a [Machine](reference/glossary.md#machine): an xstate state machine in TypeScript. Its states and
its transitions are a graph that you can read before a run starts. The [Console](reference/glossary.md#console) draws
that graph, and while a run runs, it shows the state that the run is in. An [Agent](reference/glossary.md#agent) does
not move the Machine itself. It picks events from its [Menu](reference/glossary.md#menu), and the Machine refuses a pick
that is not one of its [Allowed picks](reference/glossary.md#allowed-picks) now. Thus the model makes the decisions in
each state, and the Machine sets the transitions that each decision can cause. You review how the work happens, not only
the code that comes out of it.

Read [Machines and Workflows](concepts/machines-and-workflows.md) and [The Menu](concepts/the-menu.md).

## Isolation

A filesystem sandbox is not isolation. Agents on one computer share its ports, its processes and its credentials. Two
Agents can need the same port, or the same file in your home folder. An Agent can also leave a process or a server that
runs after the work stops.

In jr2, an Agent that works on a [Repo](reference/glossary.md#repo) works in a [Sandbox](reference/glossary.md#sandbox).
A Sandbox is a pod with its own filesystem, network and processes. There is one Sandbox for each
[Workspace](reference/glossary.md#workspace), and the Agents of one Workspace share it. An Agent that needs only its
Menu has no Sandbox. It runs on the [Instance Harness](reference/glossary.md#instance-harness).

An Agent never holds a model key. The Agent works in the [Harness](reference/glossary.md#harness) container, which holds
only a [Stand-in](reference/glossary.md#stand-in). The [Custodian](reference/glossary.md#custodian) is a different
container in the same pod, and it holds the real key. A Stand-in has no value outside its pod.

When the Workspace ends, its Sandbox ends too. When a [Lease](reference/glossary.md#lease) lapses, the operator removes
what the Agents left behind.

Read [Workspaces](concepts/workspaces.md) and [Secrets and trust](concepts/secrets-and-trust.md).

## Distribution

One computer has a limit. One build can use all of its CPU, and the other Agents then wait. A run on a laptop also stops
when the laptop stops.

In jr2, the compute is remote. The [Orchestrator](reference/glossary.md#orchestrator) runs in the cluster. For each
Agent, it holds only an [Actor](reference/glossary.md#actor): a local handle. The Harness that runs the Turns of the
Agent runs where the cluster puts it. A Sandbox can go on each node that can run an ordinary pod. On a shared cluster, a
run continues when your computer is off.

Read [Architecture](concepts/architecture.md).

## Composition

An Agent does one thing well. When you give it many things at the same time, it loses its focus. The infrastructure of a
workflow, such as a Sandbox or a set of work items, also must not get into the task of the Agent.

In jr2, each of these parts is xstate. A Workspace wraps a body Machine that does not know about the Sandbox. A
[Pool](reference/glossary.md#pool) runs one worker Machine for each item that a [Source](reference/glossary.md#source)
gives. A [Gate](reference/glossary.md#gate) is an actor that a state invokes to wait for an outside input. Each state
sets the [Frame](reference/glossary.md#frame) of one [Turn](reference/glossary.md#turn), so an Agent does one thing at a
time.

A Machine can invoke a different Machine. A Machine can also leave a part [Open](reference/glossary.md#open), such as
the URL of a Repo or the model of an Agent. You bind that part with
[`customize()`](reference/authoring-surface.md#customize). Thus a Machine can come from an npm package, such as the
[`task`](reference/machines.md#task) Machine in `@jr2/machines`.

Read [Composition](concepts/composition.md) and [Pools and Sources](concepts/pools-and-sources.md).

## Model agnostic

A workflow must not depend on one model or one provider. You can change the model of one Agent, and keep the Machine.

jr2 has one Harness, and it is jr2's own. An Agent is a model and its instructions. The model is a name such as
`<provider>/<model>`. The provider is one from the model catalog of the Harness, or an endpoint that you run and set in
[`harness.provider`](reference/config.md#harness-provider). The same Harness runs the Turns of each Agent, with each
provider. A state can set the model of one Turn.

Read [Agents and Turns](concepts/agents-and-turns.md).

## Headless

A workflow must connect to the systems that you use, such as a code review, a chat or a CI job. One user interface
cannot be the right one for each of them.

The Orchestrator is an HTTP API. The jr2 CLI and the Console are its clients. You can write a different client, such as
a webhook, with the same API. For example, a client can start a run with
[`POST /workflows/:name/runs`](reference/http-api.md#post-workflows-name-runs), or answer a Gate with
[`POST /runs/:runId/gates/:gate/events`](reference/http-api.md#post-runs-runid-gates-gate-events).

Read [Architecture](concepts/architecture.md) and [Gates](concepts/gates.md).

## One converging command

A workflow that runs on a laptop must also run on a shared cluster, without a second set of steps.

[`jr2 up`](reference/cli.md#up) converges an [Instance](reference/glossary.md#instance) folder into the cluster of the
current kubectl context. The same folder converges into kind on a laptop or into a shared cluster. You select the
cluster with the kubectl context. A shared cluster also needs a container registry, which `.env` gives to
[`registry`](reference/config.md#registry). You can run `jr2 up` again at any time.

Read [Converge](concepts/converge.md).

## A typed Instance

An error in a workflow or in its config can show only when a run gets to it. A run can take many minutes to get there.

In jr2, a Machine names its Agents, its [Repo Slots](reference/glossary.md#repo-slot) and the Machines that it invokes,
and TypeScript checks each name. `jr2.config.ts` uses [`defineConfig()`](reference/authoring-surface.md#defineconfig),
so TypeScript checks the config too. `jr2 up` runs the typecheck first. When the typecheck fails, `jr2 up` builds
nothing and changes nothing on the cluster. Next, it refuses an Open part that no `customize()` binds. Thus you find
these errors before a run starts.

Read [Converge](concepts/converge.md) and [Machines and Workflows](concepts/machines-and-workflows.md).
