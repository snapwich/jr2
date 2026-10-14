---
title: Mirror the Kit images
description: Copy the Kit images and the Pinned image into your own registry, and make the cluster pull them from there.
---

Copy the Kit images and the Pinned image into your own registry, and make the cluster pull them from there.

An installed Kit builds none of its own images. The nodes pull the two [Kit images](../reference/glossary.md#kit-image),
`jr2-harness` and `jr2-operator`, from `ghcr.io/snapwich`. They pull the
[Pinned image](../reference/glossary.md#pinned-image), the Envoy image of the
[Custodian](../reference/glossary.md#custodian), from `docker.io`. Mirror these three images when the nodes cannot reach
those registries, or when the cluster pulls from one registry only.

One more image does not come from the mirror. When the [Instance](../reference/glossary.md#instance) sets
`harness.provider` and an [Agent](../reference/glossary.md#agent) names one of its models, `jr2 up` checks the model
from a pod in the cluster. That pod uses the image `node:24-slim`, which the nodes pull from `docker.io`. `kitRegistry`
does not change this image, and `jr2 kit push` does not copy it. On a cluster that cannot pull from `docker.io`, this
check fails, and `jr2 up` stops.

[`jr2 kit push`](../reference/cli.md#kit-push) copies the images. [`kitRegistry`](../reference/config.md#kitregistry)
tells `jr2 up` where the nodes pull them from:

<<< @/examples/guides/mirror-the-kit-images/jr2.config.ts

## Before you start

- An Instance, with its dependencies installed at the [Kit version](../reference/glossary.md#kit-version) that you want
  to mirror.
- Docker with Buildx on your computer. `jr2 kit push` uses `docker buildx imagetools`.
- A registry that you can push to, and that the nodes can pull from. Log in to it with `docker login`. In the commands
  on this page, `<registry>` is the registry and its path, such as `registry.example.com/jr2`.
- Your computer can pull from `ghcr.io` and `docker.io`.

## Copy the images

Run `jr2 kit push` in the Instance folder:

```sh
jr2 kit push <registry>
```

<!-- output: not run -->

```text
…
jr2 kit push — mirroring the v<version> kit images to <registry>
harness: copied ghcr.io/snapwich/jr2-harness:<version> → <registry>/jr2-harness:<version>
operator: copied ghcr.io/snapwich/jr2-operator:<version> → <registry>/jr2-operator:<version>
custodian: copied docker.io/envoyproxy/envoy:<tag>@<digest> → <registry>/envoy:<tag>@<digest>
mirrored 3 image(s), 0 already present
{"registry":"<registry>","version":"<version>","images":{"harness":"<registry>/jr2-harness:<version>","operator":"<registry>/jr2-operator:<version>","custodian":"<registry>/envoy:<tag>@<digest>"}}
```

`<version>` is the Kit version. `<tag>` and `<digest>` are the tag and the digest of the Envoy image that this Kit
version pins. The first line (`…`) is the `.env` line, when `.env` sets a variable that your shell does not set. The
last line is on stdout. The other lines are on stderr.

`jr2 kit push` copies the images from registry to registry. It copies each platform of an image, with the same digests,
and it does not put the images on your computer.

`jr2 kit push` does not read the Instance. In the Instance folder, the global `jr2` runs the Instance's own `@jr2/cli`
([Handoff](../reference/glossary.md#handoff)), so the command copies the images of the Instance's Kit version. Outside
an Instance, it copies the images of the version of your global `jr2`.

A version tag of jr2 never moves to different content. Thus `jr2 kit push` does not copy an image that is in the
registry already. You can run it again at any time:

<!-- output: not run -->

```text
…
jr2 kit push — mirroring the v<version> kit images to <registry>
harness: already present — <registry>/jr2-harness:<version>
operator: already present — <registry>/jr2-operator:<version>
custodian: already present — <registry>/envoy:<tag>@<digest>
mirrored 0 image(s), 3 already present
…
```

## Pull from the mirror

Set `kitRegistry` in `jr2.config.ts`, as in the example. The example reads it from `.env`. Add this line to `.env`:

```text
JR2_KIT_REGISTRY=<registry>
```

Give `kitRegistry` the same value that you gave `jr2 kit push`, with no `/` at the end. The nodes then pull
`<registry>/jr2-harness:<version>`, `<registry>/jr2-operator:<version>` and `<registry>/envoy:<tag>@<digest>`.

`jr2 version --local` shows where the Kit images come from:

```sh
jr2 version --local
```

<!-- output: not run -->

```text
→ .env: JR2_KIT_REGISTRY, …
cli:       <version>    <instance folder>/node_modules/@jr2/cli
global:    <global version>    <global folder>
kit:       <version>    <instance folder>/node_modules/@jr2/orchestrator  ok
instance:  my-instance  <instance folder>  (installed kit → <registry>)
node:      v24.18.0
```

`<instance folder>` is the path of your Instance folder. `<global version>` and `<global folder>` are the version and
the folder of your global `jr2`, which runs the Instance's own `@jr2/cli`. `node` gives your version of Node.js.

Then converge:

```sh
jr2 up
```

<!-- output: not run -->

```text
…
images: installed kit — the published v<version> Harness and operator, pulled from <registry> (kitRegistry)
custodian image: <registry>/envoy:<tag>@<digest> (pinned, deployed — never built)
…
converged — `jr2 run <workflow>` when ready
```

## Mirror each new Kit version

The mirror holds the images of the versions that you copied, and no others. `jr2 up` never pushes to `kitRegistry`.
Thus, when you upgrade the Kit version, run `jr2 kit push <registry>` again before `jr2 up`. Run it in the Instance
folder after you install the new version. See [Upgrade the Kit version](upgrade-the-kit-version.md).

One mirror can serve each Instance on the cluster, and each cluster of your organization. It can hold the images of more
than one Kit version.

`kitRegistry` is not `registry`. [`registry`](../reference/config.md#registry) is where `jr2 up` pushes the images that
it builds. `kitRegistry` is where the nodes pull the Kit images and the Pinned image. You can set one, the other, or
both.

jr2 sets no image pull secret on its pods. The nodes must pull from the mirror with no pull secret.

## Rules

- `jr2 kit push` needs the registry:

  ```text
  jr2 kit push: no target registry
  usage: jr2 kit push <registry>
  …
  ```

  It exits with code 2.

- `push` is the only subcommand of `jr2 kit`. `jr2 kit` refuses any other word with `unknown kit subcommand: <word>`,
  and exits with code 2. With no word, it prints `jr2 kit: no subcommand`, and exits with code 2.
- When the image is not at its published place, `jr2 kit push` stops:
  `error: <image>: <source> is not there, so nothing can be mirrored to <target>`. `<image>` is `harness`, `operator` or
  `custodian`. `<source>` is its published reference, and `<target>` is its reference in the mirror. The next lines of
  the error say why. Check that `<version>` is a released Kit version.
- When a copy fails, `jr2 kit push` stops, and exits with code 1. It gives
  `error: Command failed: docker buildx imagetools create -t <target> <source>`, then the lines of Docker. Check that
  `docker login` has logged you in to the registry, and that the registry is reachable.

## Read next

- [Converge](../concepts/converge.md)
- [ADR-0044](../reference/decisions/0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md): the canonical
  place of the Kit images, and the mirror.
- [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md): the Custodian
  and its Envoy image.
- [Move from kind to a shared cluster](move-from-kind-to-a-shared-cluster.md)
