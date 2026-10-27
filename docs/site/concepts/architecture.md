---
title: Architecture
description: What runs on your computer, in the cluster and in a Sandbox, and which part does what.
---

Most parts of an [Instance](../reference/glossary.md#instance) run in one Kubernetes namespace. The
[Orchestrator](../reference/glossary.md#orchestrator) runs your [Machines](../reference/glossary.md#machine). A
[Harness](../reference/glossary.md#harness) runs each [Agent](../reference/glossary.md#agent)'s
[Turn](../reference/glossary.md#turn). A [Custodian](../reference/glossary.md#custodian) holds the credentials of a
Harness pod. An [Effector](../reference/glossary.md#effector) runs each `http` and `push`
[Effect](../reference/glossary.md#effect), each `command` that names an
[Effect secret](../reference/glossary.md#effect-secret), and each `dispatch` to a different Orchestrator. The operator
makes the pod of each [Sandbox](../reference/glossary.md#sandbox). One operator serves each cluster. The Repo cache
keeps a copy of each [Repo](../reference/glossary.md#repo) on each node that needs it. This page tells where each part
runs and what it does.

## Why the parts are separate

An Agent that works on a Repo runs code. Its [Working tools](../reference/glossary.md#working-tools) give it a shell.
With the shell, it can read each file and each variable in its container. It can also connect to each address that its
pod can reach. Thus jr2 puts each thing that the Agent must not touch in a different place:

- The control of a run is in the Orchestrator. An Agent cannot change its own Machine. It can only pick from its
  [Menu](../reference/glossary.md#menu), and the Orchestrator decides what each pick does.
- Each [Workspace](../reference/glossary.md#workspace) has its own Sandbox: a pod with its own filesystem, network and
  processes. Agents in two Workspaces share no files and no ports. [Workspaces](workspaces.md) tells more.
- The credentials are in containers in which the Agent executes nothing: the Custodian, the Effector and the Repo cache.
  [Secrets and trust](secrets-and-trust.md) tells how.

## What runs where

::: diagram layers What runs where, from your computer to the world outside the cluster

- **You**: your computer, where no part of a run executes
  - jr2 CLI
  - **Console**: in a browser
  - **Assistant**: writes your Machines
- ↓ the HTTP API, through a port forward
- **the cluster**
  - **Instance**: in the namespace of the Instance, one of each
    - **Orchestrator**: runs your Machines, and keeps each run
    - **Instance Harness**: runs the Turns of the Menu-only Agents
      - Harness
      - Custodian
    - **Instance Effector**: runs the Effects that read no Worktree file
    - **Repo cache**: one pod on each Sandbox node
  - ↓ a Turn, an Effect · ↑ a pick, through the Custodian · ↓ the Repo cache gives each Repo
  - **Sandbox**: one pod for each Workspace, in the same namespace
    - **Harness**: runs the Turns of the Agents that work on a Repo
    - **Custodian**: holds the Held secrets of the pod
    - **Sandbox Effector**: runs the Effects that work on the Worktree
    - **User Container**: when the Workspace names one
  - ↑ the operator makes the pod of each Sandbox
  - **jr2-system**: one for each cluster
    - **operator**: makes each Sandbox pod, and removes it when its Lease lapses
- ↓ the Custodians call the model provider · ↓ the Repo cache fetches from the git host
- **Outside**: what the work uses
  - model provider
  - git host

:::

The [Instance Harness](../reference/glossary.md#instance-harness), the
[Instance Effector](../reference/glossary.md#instance-effector), the Repo cache and the
[Sandbox Effector](../reference/glossary.md#sandbox-effector) exist only when a Machine of the Instance needs them. The
sections below tell when.

A Sandbox pod can also have a [User Container](../reference/glossary.md#user-container), when its `workspace()` names
one. It runs its own image, and it mounts the [Worktree](../reference/glossary.md#worktree) read-write.
[Workspaces](workspaces.md) tells more.

## On your computer

The [jr2 CLI](../reference/glossary.md#jr2-cli) runs on your computer, in the Instance folder. The
[Assistant](../reference/glossary.md#assistant) works there too, and writes Machines and config in that folder. Nothing
of a run executes on your computer.

[`jr2 up`](../reference/cli.md#up) reads the folder and converges the cluster of the current kubectl context.
[Converge](converge.md) tells what it makes. By default, each other command that talks to the Orchestrator, such as
[`jr2 run`](../reference/cli.md#run), reads the Instance token from the cluster. Then it opens a `kubectl port-forward`
to the Orchestrator's Service, for the life of the command. The [global options](../reference/cli.md#global-options)
tell how to give a URL and a token instead. The CLI keeps no local state about the cluster.

The [Console](../reference/glossary.md#console) is a page that the Orchestrator serves. You open it in a browser,
through a port forward that you start. [Open the Console](../guides/open-the-console.md) gives the commands.

## The Orchestrator

The Orchestrator is one pod for each Instance (`replicas: 1`), with the Service `jr2-orchestrator` on port 4000. It
hosts all the [Workflows](../reference/glossary.md#workflow) of the Instance and many runs of each Workflow. It keeps
the snapshot of each run on its own volume, so a run continues after a restart. [Durable runs](durable-runs.md) tells
how.

The pod runs the `jr2-orchestrator` [Kit image](../reference/glossary.md#kit-image), which holds no code of yours. The
Orchestrator loads your Workflows and your config from the [Assembly](../reference/glossary.md#assembly) that `jr2 up`
publishes to it, and it keeps each Assembly on its volume. [Converge](converge.md#the-assembly) tells how.

The Orchestrator does these things:

- It runs each Machine as an xstate actor, and holds the state of each run.
- It serves the HTTP API that the CLI, the Console, a webhook and the Custodians call. See the
  [HTTP API](../reference/http-api.md).
- It sends each Turn to a Harness, and judges each pick that comes back.
- It writes a Sandbox resource when a run enters a Workspace. Then it watches the Sandbox resource until the Workspace
  ends.
- It sends each Effect to the place where it runs. It runs a `dispatch` with no target itself: the Effect starts a run
  of a Workflow of the same Instance.

The Orchestrator does no work of an Agent. It runs no model and no Working tools. That work runs in the pods that the
cluster places.

To isolate two sets of Workflows, use two Instances. Each Instance has its own namespace and its own Orchestrator.

## The Harness

The Harness is jr2's own server for the Turns of Agents. It speaks to the model provider. It gives the model the Agent's
Menu and its Working tools. It executes each Working tool that the model calls, and sends each pick through the
Custodian. It holds no Agents of its own. Each Turn brings the Agent's definition with it.
[Agents and Turns](agents-and-turns.md) tells what happens in a Turn.

The Harness has two placements:

- **In each Sandbox.** The Harness is the primary container of the Sandbox pod, named `harness`. It runs in the
  [Sandbox Image](../reference/glossary.md#sandbox-image), and jr2 mounts the Harness into the pod at `/opt/jr2`. Thus
  the Working tools of the Agent reach the tools of that image. An Agent that works on a Repo has its Turns here.
- **As the Instance Harness.** The Instance Harness is one StatefulSet for each Instance, `jr2-instance-harness`. Each
  Turn of a Menu-only Agent (`workspace: "none"`) runs here. Its pod has a Harness and a Custodian, and no Worktree. It
  keeps each conversation on its volume while a run can continue it. `jr2 up` converges it when a Machine of the
  Instance has a Menu-only Agent.

A Harness answers only the Orchestrator. The Orchestrator sends a bearer token on each call, and the Harness accepts no
call without it, except its health check. `jr2 up` also converges NetworkPolicies that let only the Orchestrator's pods
connect to a Harness pod.

## The Custodian

Each Harness pod has a Custodian: each Sandbox, and the Instance Harness. The Custodian is a container beside the
Harness. The Agent executes no code in it. It does two things:

- It carries four kinds of call from the pod to the Orchestrator: the Menu reads, the picks, the polls for the answer to
  a pick, and the fetch asks. It sends each one with the pod's Sandbox token. These four routes are all that it
  forwards. It refuses all other routes.
- It holds the [Held secrets](../reference/glossary.md#held-secret) of its pod, such as a model API key. It puts the
  value into the requests that go to the hosts of each Held secret.

The Custodian runs Envoy, from a [Pinned image](../reference/glossary.md#pinned-image). The Orchestrator writes its
config for a Sandbox, and `jr2 up` writes it for the Instance Harness. [Secrets and trust](secrets-and-trust.md) tells
how the Custodian holds a credential.

## The Effector

The Effector runs each `http` and `push` Effect, each `command` that names an Effect secret, and each `dispatch` that
names a target. Thus a credential that an Effect uses stays out of the Harness container. The Effector is jr2's own
program, and it runs in a container in which the Agent executes nothing. [Effects](effects.md) tells which Effect runs
where. It has two placements:

- **The Sandbox Effector** is a container in a Sandbox pod, named `effector`. It mounts the Worktree read-only. It runs
  a `push`, an `http` Effect whose body is a Worktree file, and a `command` that names an Effect secret. Its image is
  the Sandbox Image, unless the `workspace()` names a different image.
- **The Instance Effector** is one pod for each Instance, `jr2-instance-effector`. It runs each `http` Effect that reads
  no Worktree file, and each `dispatch` that starts a run on a different Orchestrator. It holds the Instance token of
  that Orchestrator as an Effect secret. It runs in the `jr2-harness` Kit image.

Each placement exists only when a Machine of the Instance puts an Effect there. A `command` that names no Effect secret
does not use an Effector. It runs in the Harness container of its Sandbox, with the same tools and access as the Agent.

The Orchestrator signs each request that it sends to an Effector, and the Effector signs each answer. The Orchestrator
only asks, and the Effector holds the credentials.

## The operator

The operator is a Kubernetes operator. One copy serves the whole cluster: it runs in the namespace `jr2-system`, and
each Instance on the cluster shares it. By default, `jr2 up` converges it. With `operator.manage: false`, you run it
yourself.

The operator reconciles two custom resources:

- A **Sandbox resource** becomes one pod and a Service. The Orchestrator writes the Sandbox resource, and the operator
  makes the pod and reports its state. The operator never makes a second pod for a Sandbox. When the pod ends, the
  Sandbox is lost.
- A **Repo** names one git repository that the Repo cache keeps.

The operator knows nothing about Agents, Turns or Worktrees. The Orchestrator does that work after the Sandbox is ready.
The operator also removes a Sandbox resource when its [Lease](../reference/glossary.md#lease) lapses, for example after
the Orchestrator stopped for longer than the Lease allows. [Workspaces](workspaces.md) tells how the Lease works.

## The Repo cache

The Repo cache keeps one bare clone of each Repo on each node that needs it. It is a DaemonSet, `jr2-repo-cache`, in the
namespace of the Instance. It has one pod on each [Sandbox node](../reference/glossary.md#sandbox-node). `jr2 up`
converges it when a Machine of the Instance uses a Sandbox.

The operator mounts the cache of each Repo into a Sandbox, read-only, at `/repos`. The clone in the Sandbox gets its
objects from that cache. A `git fetch origin` in the Sandbox asks the Repo cache for a fetch. Then the Repo cache
fetches from the host of the Repo, with the clone credential of the cluster. Thus the Harness container needs no git
credential to fetch.

## Rules

- An Instance has exactly one Orchestrator, and the Orchestrator always runs in the cluster.
- A namespace holds one Instance. `jr2 up` refuses a namespace that a different Instance owns.
- By default, the CLI reaches the cluster of the current kubectl context. Kubernetes RBAC decides who can read the
  Instance token.
- A Harness accepts a call only from the Orchestrator, with the bearer of its own pod. Only its health check needs no
  bearer.
- The Agent executes code only in the Harness container. It executes nothing in the Custodian or in the Effector.
- The Orchestrator watches the Sandbox resources and never reads a pod. The operator puts the facts of the pod on the
  status of the Sandbox resource.
- A Sandbox has one pod for its life. A lost pod is never made again.

## Read next

- [Open the Console](../guides/open-the-console.md)
- [Look inside a Sandbox](../guides/look-inside-a-sandbox.md)
- [Watch a run](../guides/watch-a-run.md)
- [Workspaces](workspaces.md), [Secrets and trust](secrets-and-trust.md) and [Converge](converge.md)
- The [HTTP API](../reference/http-api.md) and the [`operator`](../reference/config.md#operator) and
  [`sandbox`](../reference/config.md#sandbox) fields of `jr2.config.ts`
- [ADR-0001](../reference/decisions/0001-operator-owned-generic-sandbox.md),
  [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md),
  [ADR-0008](../reference/decisions/0008-orchestrator-as-deployed-app.md),
  [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md),
  [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md),
  [ADR-0031](../reference/decisions/0031-menu-only-agents-run-on-the-instance-harness.md),
  [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md),
  [ADR-0053](../reference/decisions/0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md),
  [ADR-0058](../reference/decisions/0058-a-harness-answers-the-orchestrator-alone.md),
  [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md),
  [ADR-0063](../reference/decisions/0063-the-orchestrator-watches-the-cluster.md) and
  [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)
