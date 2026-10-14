---
title: Install
description: Install the tools that jr2 needs and the jr2 CLI, and make a kind cluster on your computer.
---

At the end of this page, you have the [jr2 CLI](../reference/glossary.md#jr2-cli) and a kind cluster on your computer.
The next pages use them to make an [Instance](../reference/glossary.md#instance) and run it.

## Before you start

This is the first page of the tutorial. You need a computer with these tools:

- [Node.js](https://nodejs.org/) 24 or later. Node.js includes npm.
- [Docker](https://docs.docker.com/get-started/get-docker/). Make sure that the Docker daemon runs.
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), which runs a Kubernetes cluster in Docker.
- [kubectl](https://kubernetes.io/docs/tasks/tools/), which speaks to the cluster.

kind makes the cluster from Docker containers. `jr2 up` builds an image with Docker and loads it into the kind cluster.
kubectl is the tool that `jr2 up`, `jr2 run` and the other commands use to speak to the cluster.

## Check Node.js

Run:

```sh
node --version
```

The version must be `v24` or later:

```text
v24.18.0
```

Your version can be different.

## Install the jr2 CLI

Run:

```sh
npm i -g @jr2/cli
```

npm installs the `jr2` command and the `@jr2/orchestrator` package that it uses. npm prints its progress and a summary
of the packages that it added. This page does not show that output. The next step checks the install.

## Check the jr2 CLI

Run:

```sh
jr2 --version
```

The CLI shows its version, its folder and the version of Node.js. Outside an Instance, it shows no Instance:

<!-- output: not run -->

```text
cli:       <version>    /usr/local/lib/node_modules/@jr2/cli
instance:  none — no jr2.config.ts walking up from cwd
node:      v24.18.0
```

`<version>` is the version of jr2 that you installed, such as `0.3.0`. The folder is in the global folder of your npm,
so it can be different.

## Make the kind cluster

Run:

```sh
kind create cluster --name jr2
```

kind makes a cluster with one node. It sets your current kubectl context to the new cluster:

<!-- output: not run -->

```text
Creating cluster "jr2" ...
…
Set kubectl context to "kind-jr2"
…
```

The context of the cluster is `kind-jr2`. `jr2 up` converges into the current kubectl context, so the next pages use
this cluster.

## Check the Kubernetes version

Run:

```sh
kubectl version
```

The `Server Version` must be `v1.35` or later:

```text
Client Version: v1.35.7
Kustomize Version: v5.7.1
Server Version: v1.36.1
```

Your versions can be different. If the server version is earlier than `v1.35`, delete the cluster with
`kind delete cluster --name jr2`. Then install a newer kind release. Make the cluster again. `jr2 up` refuses an older
cluster with this message, where `<server version>` is the `Server Version` of the cluster:

```text
refusing: kind-jr2 runs Kubernetes <server version>; jr2 needs Kubernetes 1.35 or newer (every Sandbox mounts jr2's runtime as an image volume, ADR-0037). Nothing was applied.
```

## What happened

You installed the jr2 CLI globally. It is the command that you use for each step of this tutorial. Each Instance also
installs its own copy of `@jr2/cli`. In an Instance folder, the global `jr2` gives the command to that copy. Thus the
version that runs is the version that the Instance pins. The glossary calls this a
[Handoff](../reference/glossary.md#handoff).

You also made a kind cluster. jr2 needs no setup in the cluster other than Kubernetes 1.35 or later. `jr2 up` puts in it
all that an Instance needs. [Converge](../concepts/converge.md) explains what `jr2 up` makes. The
[CLI reference](../reference/cli.md) gives each command and its options.

## Next

[Create an Instance](create-an-instance.md).
