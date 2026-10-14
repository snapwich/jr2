---
title: Home
description: jr2 is a Kit for agentic workflows. You write each one as an xstate Machine, and jr2 runs it.
---

jr2 is a Kit for agentic workflows. You write each workflow as an xstate [Machine](reference/glossary.md#machine), and
jr2 runs it on Kubernetes. An [Agent](reference/glossary.md#agent) that works on a [Repo](reference/glossary.md#repo)
works in a [Sandbox](reference/glossary.md#sandbox): a pod with its own filesystem, network and processes. jr2 is for
you if you want Agents to do work on a cluster, and you want to read the steps of that work before it starts. Your
[Assistant](reference/glossary.md#assistant) can write the Machines, and you review their graphs.

## Start in three commands

These commands install the jr2 CLI, make an [Instance](reference/glossary.md#instance) in the folder `my-instance`, and
converge it into the cluster of your current kubectl context. First, install the tools and make the kind cluster, as
[Install](get-started/install.md) tells you:

```sh
npm i -g @jr2/cli
jr2 init my-instance && cd my-instance && npm install
jr2 up
```

`jr2 init` writes one [Workflow](reference/glossary.md#workflow), `ping`, that runs with no model. The Get started
tutorial gives these steps one at a time, and then runs `ping`.

## Where to go next

- [Why jr2](why.md) gives the problems that jr2 solves.
- [Get started](get-started/install.md) is a tutorial. It goes from the install to a branch that an Agent fixed and that
  you approved.
- [Concepts](concepts/machines-and-workflows.md) explains each idea of jr2. For the picture of what runs where, read
  [Architecture](concepts/architecture.md).
- [Guides](guides/start-a-run.md) gives the steps for one task on each page.
- [Reference](reference/authoring-surface.md) gives each export, config field, command and HTTP route, from the code.
