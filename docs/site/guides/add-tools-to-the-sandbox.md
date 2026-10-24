---
title: Add tools to the Sandbox
description: Put the programs that your Agents use into the Sandbox Image, or run a service in a User Container.
---

Put the programs that your [Agents](../reference/glossary.md#agent) and
[`command`](../reference/authoring-surface.md#command) [Effects](../reference/glossary.md#effect) use into the
[Sandbox Image](../reference/glossary.md#sandbox-image).

A [Workspace](../reference/glossary.md#workspace) runs its body in a [Sandbox](../reference/glossary.md#sandbox): a pod
of its own. The Sandbox Image is the image of the pod's `harness` container. The Agent's
[Working tools](../reference/glossary.md#working-tools) run in that container, and so do the `command` Effects and the
shell that you get with `kubectl exec`. Thus a program that is in the image is a program that they can run.

Use this table to choose:

| You want                                       | Do this                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The same tools for each Workspace              | Change `images/default/Dockerfile`.                                                                            |
| Different tools for the Workspaces of one file | Put a docker context beside the workflow module, and name it in the `image` option.                            |
| An image that you build and push yourself      | Write its registry ref in the `image` option.                                                                  |
| A service that runs beside the Agent           | Name its image in the `user` option. It runs in the [User Container](../reference/glossary.md#user-container). |

## Add a tool to the default image

`jr2 init` writes `images/default/Dockerfile`. Each Workspace that names no `image` in
[`workspace()`](../reference/authoring-surface.md#workspace) uses it. This example adds pnpm to the file that `jr2 init`
wrote:

<<< @/examples/guides/add-tools-to-the-sandbox/images/default/Dockerfile{dockerfile}

The example does not show the comments at the start of the file. Keep them in your file.

Install a tool at a fixed version, as the example does. Then each build of the image gets the same version.

Run [`jr2 up`](../reference/cli.md#up). It builds the image. Then it loads the image into kind, or pushes it to the
[`registry`](../reference/config.md#registry) of `jr2.config.ts`:

```sh
jr2 up
```

```text
…
sandbox image "default": building jr2-sandbox-my-instance-default:fce23ddc3cce-amd64
  no USER declared — the pod's uid-1000 fallback applies
  kind load → cluster "jr2"
…
```

- The tag is the hash of the files in the folder, then the architecture of the nodes. Your hash is different. A change
  to a file in the folder changes it. The architecture is such as `amd64`.
- On kind, `jr2 up` loads the image into the cluster. The next line names the cluster.
- When no file in the folder changed, `jr2 up` does not build the image again. The line then ends with
  `(fresh — build skipped; --force to rebuild anyway)`.
- `jr2 up` builds the Sandbox Images only when a registered [Machine](../reference/glossary.md#machine) has a
  `workspace()`. Otherwise it prints `sandbox images: skipped (no registered Machine composes a Sandbox)`.

A Sandbox that runs now keeps its image. The next Sandbox gets the new image. `jr2 up` removes the old image at the end
of a later converge, when no Sandbox uses it. On a kind node, it keeps the old image for one more converge. It does not
remove an image from a registry. [`jr2 gc`](../reference/cli.md#gc) does the same work when you ask for it (see
[Clean up](clean-up.md)).

To see the tool, open a shell in a Sandbox (see [Look inside a Sandbox](look-inside-a-sandbox.md)), and run it:

```sh
pnpm --version
```

```text
10.9.0
```

## What the image must have

The image is yours. jr2 adds no layer to it, and does not read the Dockerfile. When the pod starts, jr2 mounts its own
runtime at `/opt/jr2`, and starts the [Harness](../reference/glossary.md#harness) from there. Thus:

- The `ENTRYPOINT` and the `CMD` of the image do not run. To run a process all the time, use a User Container (see
  [Run a service beside the Agent](#run-a-service-beside-the-agent)).
- jr2 adds `/opt/jr2/bin` at the end of `PATH`. Thus a tool of the same name in your image comes first.
- The `USER` and the `HOME` of the image stay as you set them. When an image that `jr2 up` built sets no `USER`, the pod
  runs as uid 1000, with `HOME=/home/jr2`.

The image must have these, or the Sandbox does not start:

- A glibc base no older than the glibc of jr2's node, such as a current Debian or Ubuntu. An Alpine base has musl, and
  jr2's runtime does not run on it.
- `git` on the system `PATH`. The Harness clones, makes the [Worktrees](../reference/glossary.md#worktree) and commits
  with it.
- A `HOME` that the image's `USER` can write.
- A `USER` that is a number and is not `0`, such as `USER 1000`. An image that `jr2 up` builds can also have no `USER`.
  The `harness` container does not run as root.
- Nothing at `/opt/jr2` or `/work`, and nothing that listens on port `8080`.

The image does not need a git author. When the image sets none, a commit in the `harness` container has the author
`jr2 Agent <agent@jr2.invalid>`. jr2 puts this default at git's system level, under the image's own `/etc/gitconfig`, so
each git author that the image sets is used in its place: in `/etc/gitconfig`, in the `HOME` of its `USER`, or in
`GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`. When the image sets `GIT_CONFIG_SYSTEM` or `GIT_CONFIG_NOSYSTEM`, or its git
reads another system file than `/etc/gitconfig`, jr2 does not set the default.

Before the Harness starts, a `preflight` step in the pod checks the image. When the check fails, the run faults. Read
the log of the step with `kubectl -n <namespace> logs <sandbox> -c preflight`. `<namespace>` is the namespace of the
Instance, such as `my-instance`. [Look inside a Sandbox](look-inside-a-sandbox.md) tells how to find `<sandbox>`.

## Give one Workflow its own image

Put a docker context in a folder beside the workflow module. Name the folder in the `image` option of `workspace()`. In
this example, `workflows/pytest.ts` runs the tests of a Python [Repo](../reference/glossary.md#repo), with the image in
`workflows/python/`:

<<< @/examples/guides/add-tools-to-the-sandbox/workflows/python/Dockerfile{dockerfile}

<<< @/examples/guides/add-tools-to-the-sandbox/workflows/pytest.ts

- `import.meta.resolve("./python")` gives a `file:` URL to the folder. The folder is the build context. A `COPY` in the
  Dockerfile reads from it.
- jr2 reads only the `.ts` files in `workflows/` as [Workflows](../reference/glossary.md#workflow). A folder there is
  not a Workflow.
- An Agent in the body gets the same tools. Its Working tools run in the same container as the `command`.
- `jr2 up` finds the folder from the registered Machines, and builds it. Its line is
  `sandbox image "python": building jr2-sandbox-my-instance-python:<hash>-<arch>`. The name of the folder is the name in
  the tag.

A Machine that you register from a package, such as `task` from [`@jr2/machines`](../reference/machines.md), takes an
image from [`customize()`](../reference/authoring-surface.md#customize): `customize(task, { image })`. The value has the
same two forms, and it replaces the image of the Machine's `workspace()`. See
[Bind a shipped Machine's Open parts](bind-open-parts.md).

A Machine that you publish as an npm package carries its docker context in the package. See
[Publish a Machine as an npm package](publish-a-machine-as-an-npm-package.md).

## Use an image from a registry

When you build and push the image yourself, write its ref in place of the `file:` URL:
`image: "registry.example.com/python-sandbox:1.0"`. A value that does not start with `file:` is a registry ref.

- jr2 does not build the image, does not read it, and does not remove it.
- The nodes of the cluster pull it. jr2 gives the pod no pull credential.
- The image must be for the architecture of the nodes.
- The image must have each item in [What the image must have](#what-the-image-must-have). jr2 does not supply uid 1000
  for a registry image: an image with no `USER` runs as root, and the pod does not start.
- For each change, push a new tag. Then change the `image` value to the new tag. A node that has a tag does not pull it
  again, unless the tag is `latest`.

## Run a service beside the Agent

The User Container is a third container in the Sandbox pod. Use it for a process that must run without an Agent, such as
an sshd for a person. This image gives a person a shell beside the Agent:

<<< @/examples/guides/add-tools-to-the-sandbox/workflows/shell/Dockerfile{dockerfile}

Save it as `workflows/shell/Dockerfile`. Name it in the `workspace()` options with
`user: import.meta.resolve("./shell")`. `user` takes the same two forms as `image`, and `jr2 up` builds a `file:`
context in the same way. Open the shell with `kubectl -n <namespace> exec -it <sandbox> -c user -- sh`.

The User Container is not a second Sandbox Image:

- Its own `ENTRYPOINT` and `CMD` run. Its process must keep running: when it ends, the pod is not ready.
- jr2 gives it `/work`, which it can write, and `/repos` and `/opt/jr2`, which it can only read. jr2 gives it no other
  mount, no environment variable and no command.
- It has no floor: an Alpine base is correct here. It runs as the `USER` of its image, and root is permitted.
- Its user can be different from the user that owns the Worktrees, for example root. Thus an image that runs git needs
  `git config --system --add safe.directory '*'`, as the example has.
- The pod has one network. The User Container cannot listen on the ports of jr2's containers: `8080`, `8082` and
  `15021`, and `8081` and `15001` on loopback.
- To give it a part of the [Size](../reference/glossary.md#size), write `user: { image, resources }`. See
  [Size a Workspace](size-a-workspace.md).

A `push`, an `http` Effect whose body is a Worktree file, and a `command` that names an Effect secret run in a different
container, the [Sandbox Effector](../reference/glossary.md#sandbox-effector). By default it uses the Sandbox Image. The
`effector` option gives it an image of its own. See
[Run a command or call a URL with an Effect](run-a-command-or-call-a-url.md) and
[Push and sign a branch](push-and-sign-a-branch.md).

## Rules

- `workspace()` refuses an `image` that is empty or not a string:
  ``workspace(): `image` must be a non-empty string (got <value>) — either a `file:` URL to a docker context this module ships (`import.meta.resolve("./image")`) or a registry ref (ADR-0037).``
- `workspace()` and `customize()` refuse a `user` that is not an image or `{ image, resources? }`. `<where>` is
  `workspace()` or `customize()`:
  ``<where>: `user` must be a non-empty string (an image), or { image, resources? } (got <value>) — either a `file:` URL to a docker context this module ships (`import.meta.resolve("./image")`) or a registry ref (ADR-0037, ADR-0060).``
  and `<where>: user.<key> is not accepted — the User Container is { image, resources? } (ADR-0005, ADR-0060)`.
- `customize()` refuses `image` or `user` for a Machine that has no `workspace()`:
  ``customize(): `image`/`user` say what a SANDBOX is made of, how big it is and which Repos it attaches, and machine "<id>" composes none — only a workspace() wrapper carries those seats, that Size and those slots (ADR-0049, ADR-0037, ADR-0051, ADR-0060).``
- `jr2 up` refuses a `file:` URL to a folder that does not exist. `<path>` is the folder:
  ``the Sandbox Image context <path> cannot be read (<code>) — a `workspace()` names its image with `import.meta.resolve("./<dir>")`, so that directory must exist beside the Machine's own module (ADR-0037/0049).``
- `jr2 up` refuses an `images/default` folder that has no `Dockerfile`:
  ``the Instance's `images/default` has no Dockerfile (<path>) — that directory IS a build context (ADR-0037), and it is the Sandbox Image every `workspace()` that names none falls back to.``
- An image that `jr2 up` built, with a `USER` that is not a number or is `0`, faults the run before the pod is made.
  `<image>` is the `image` value, or `default`:
  ``the Sandbox Image "<image>" declares `USER <user>`, which cannot run a jr2 seat: every jr2-owned container is `runAsNonRoot` with no `runAsUser`, so the kubelet needs a NUMERIC non-zero uid it can check without reading the image (ADR-0005). Change the Dockerfile's last `USER` to that uid (e.g. `USER 1000`, or drop the line entirely and jr2 supplies uid 1000 with a writable HOME — ADR-0037), then re-run `jr2 up`.``
- A registry image that runs as root faults the run. The text starts with
  `Sandbox "<sandbox>" cannot start: its image runs as ROOT, and every jr2-owned seat is hardened with runAsNonRoot (ADR-0005).`
- An image that does not have the floor stops the `preflight` step. Its log says:
  `jr2: this Sandbox Image does not meet the floor (ADR-0037): a glibc base no older than jr2's node (musl is out entirely), git on the system PATH, a writable HOME for the image's USER, and /opt/jr2 + /work + :8080 unclaimed. jr2 vendors the rest.`
  The run faults with a text that starts with
  ``Sandbox "<sandbox>" never reached Ready (last phase: <phase>) — if its Sandbox Image is new, check the preflight: `kubectl logs <sandbox> -c preflight` ``.
- The [Orchestrator](../reference/glossary.md#orchestrator) refuses a `file:` image that the last `jr2 up` did not
  build. Run `jr2 up` again:
  ``no Sandbox Image for <url> (context digest <digest>) — this instance's last converge built <n> image(s), none of them this one. Re-run `jr2 up`: it walks the registered Machines and builds every `file:` context they carry (ADR-0037/0049).``

## Read next

- [Workspaces](../concepts/workspaces.md): the pod, the Sandbox Image and the User Container.
- [Converge](../concepts/converge.md): how `jr2 up` builds and loads the images.
- [Look inside a Sandbox](look-inside-a-sandbox.md)
- Reference: [`workspace`](../reference/authoring-surface.md#workspace),
  [`SandboxOptions`](../reference/authoring-surface.md#type-sandboxoptions),
  [`UserContainer`](../reference/authoring-surface.md#type-usercontainer), [`jr2 up`](../reference/cli.md#up)
- [ADR-0037](../reference/decisions/0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md): the Instance
  builds its Sandbox Images, and jr2 injects the Harness.
- [ADR-0005](../reference/decisions/0005-sandbox-pod-composition.md): the containers of the Sandbox pod.
- [ADR-0049](../reference/decisions/0049-a-machine-carries-its-parts-and-composes-by-invoke.md): a Machine carries its
  images.
