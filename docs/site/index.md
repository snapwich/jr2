---
title: Home
description: jr2 is a Kit for agentic workflows. You write each one as an xstate Machine, and jr2 runs it.
---

jr2 is a Kit for agentic workflows. Each workflow is written as an xstate [Machine](reference/glossary.md#machine), and
jr2 runs it on Kubernetes. An [Agent](reference/glossary.md#agent) that works on a [Repo](reference/glossary.md#repo)
works in a [Sandbox](reference/glossary.md#sandbox): a pod with its own filesystem, network and processes. Your
[Assistant](reference/glossary.md#assistant) writes the Machines, and you review the graph.

jr2 supports two primary patterns for making Agent-enabled workflows. You can let the Machine decide the order of the
work, and give each Agent one step of it in a [Turn](reference/glossary.md#turn). Or an Agent can decide when each step
runs, and the Machine runs that step and limits the next choices
([how to choose](concepts/the-menu.md#keep-the-turn-or-end-it)). In both patterns, the Machine sets what each step does.
An Agent can also write a [Chart](reference/glossary.md#chart), much like a "dynamic workflow": jr2 checks it against
the parts that your Machine lends it, and then executes it at runtime.

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

- [Why jr2](why.md) shows the parts of jr2, gives the problems that each part solves, and follows one run through them.
- [Get started](get-started/install.md) is a tutorial. It goes from the install to a branch that an Agent fixed and that
  you approved.
- [Concepts](concepts/machines-and-workflows.md) explains each idea of jr2. For the picture of what runs where, read
  [Architecture](concepts/architecture.md).
- [Guides](guides/start-a-run.md) gives the steps for one task on each page.
- [Reference](reference/authoring-surface.md) gives each export, config field, command and HTTP route, from the code.
