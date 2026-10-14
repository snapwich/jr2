---
title: Clean up
description: Remove old images and unused Repo resources with jr2 gc, and remove an Instance with jr2 down.
---

Remove the images and the [Repo](../reference/glossary.md#repo) resources that nothing uses, or remove an
[Instance](../reference/glossary.md#instance) from its cluster.

The examples on this page use the [Get started](../get-started/install.md) names: the Instance `my-instance` and the
kubectl context `kind-jr2`. Your output shows your names, sizes and counts.

## Know what removes images

You seldom need a command to remove images. [`jr2 up`](../reference/cli.md#up) removes the images that nothing uses at
the end of each converge that succeeds. [`jr2 down`](../reference/cli.md#down) removes them after it deletes the
namespace. [`jr2 gc`](../reference/cli.md#gc) does the same work when you ask for it, for example when your disk is
full.

jr2 removes only an image that it built and labeled, and only when no live root in the cluster names it. It removes the
image from your computer. On a kind cluster, it also removes it from each node. It does not remove an image from a
registry. [Converge](../concepts/converge.md#clean-up) explains the live roots.

## See what jr2 gc removes

Run `jr2 gc` with `--dry-run` first. It removes nothing, and it lists each image and each Repo resource that it would
remove:

```sh
jr2 gc --dry-run
```

<!-- output: not run -->

```text
jr2 gc — images on kind-jr2 that no live root names (dry run: nothing is removed)
would sweep <count> image(s) (<size>)
  <image>
  <image>
repos: would sweep nothing — every Repo resource is bound by a Machine or was attached within 7d
```

`jr2 gc` reads the cluster of the current kubectl context. It does not read an Instance folder, so you can run it from
any folder. It reads each Instance on the cluster, so it has no `-n` option. To use a different cluster, add
`--context <context>`.

## Remove the images and the Repo resources

```sh
jr2 gc
```

<!-- output: not run -->

```text
jr2 gc — images on kind-jr2 that no live root names
swept <count> image(s) (<size>)
repos: swept <count> Repo resource(s) no Machine binds and no run attached within 7d
```

`jr2 gc` does not ask you to confirm. It removes a Repo resource when these two conditions are true:

- No registered [Machine](../reference/glossary.md#machine) binds the Repo.
- No run attached the Repo, and nothing made it, in the last 7 days.

After jr2 removes a Repo resource, the Repo cache on each node can remove its copy of the Repo. It removes the copy when
nothing on the node uses it. `--repo-ttl` changes the time limit of the second condition. For example, `--repo-ttl 12h`
removes a Repo resource that no Machine binds and that no run attached in the last 12 hours. `--repo-ttl 0` removes each
Repo resource that no Machine binds.

## Remove an Instance from the cluster

Run `jr2 down` in the Instance folder:

```sh
jr2 down
```

<!-- output: not run -->

```text
remove instance "my-instance" from context kind-jr2 (delete namespace "my-instance")? [y/N] y
deleting namespace "my-instance" (runs, store, and Sandboxes go with it)
swept <count> image(s) (<size>)
removed
```

`jr2 down` asks you to confirm, unless you add `--yes`. Type `y`. Then it deletes the namespace of the Instance and
waits until the namespace is gone. These things go with the namespace:

- The [Orchestrator](../reference/glossary.md#orchestrator) and the runs, with the store of the runs.
- Each [Sandbox](../reference/glossary.md#sandbox). A commit that is not pushed is lost with its Sandbox.
- The [Instance Harness](../reference/glossary.md#instance-harness) and the conversations that it keeps.
- Each Secret in the namespace. This includes the Instance token and the Secrets that you made with `kubectl`, for
  example for [`harness.envFrom`](../reference/config.md#harness-envfrom), for a `valueFrom` in
  [`secrets`](../reference/config.md#secrets) and for the git ssh key.

Then `jr2 down` removes the images that nothing uses now. The Instance folder does not change.

To put the Instance on the cluster again, make your Secrets again first. Then run `jr2 up`. When `jr2 up` makes a new
deploy key for git, it is a new key. Register its public key again. See
[Give the cluster git credentials](give-the-cluster-git-credentials.md).

`jr2 down` does not remove the copies of the Repos on each node. They are in `/var/lib/jr2/<namespace>/repos` on the
node, and nothing uses them. On kind, they are in the node container, and they go when you delete the cluster.

To remove the Instance in CI, add `--yes`. To remove it from a different namespace or cluster, add `-n <namespace>` or
`--context <context>`.

## Remove the operator too

The operator is in the namespace `jr2-system`. All the Instances on a cluster share it. When you remove the last
Instance, run `jr2 down --all` in place of `jr2 down`:

```sh
jr2 down --all
```

<!-- output: not run -->

```text
remove instance "my-instance" from context kind-jr2 (delete namespace "my-instance" AND the per-cluster operator)? [y/N] y
deleting namespace "my-instance" (runs, store, and Sandboxes go with it)
uninstalling the operator (jr2-system)
swept <count> image(s) (<size>)
removed
```

:::danger

Use `--all` only when no other Instance is on the cluster. `--all` deletes the Sandbox and Repo resource types. Thus the
Sandboxes and the Repo resources of each Instance on the cluster go with them.

:::

`jr2 down --all` removes the operator only while the namespace of the Instance is on the cluster. After a plain
`jr2 down`, it refuses with `not deployed here …`. To remove the operator then, run `jr2 up` again. Then run
`jr2 down --all`. On kind, you can delete the cluster.

`jr2 down --all` does not remove the two PriorityClasses that `jr2 up` adds, `jr2-control` and `jr2-sandbox`. To remove
them, run this command:

```sh
kubectl delete priorityclass jr2-control jr2-sandbox --ignore-not-found
```

When [`priorityClasses`](../reference/config.md#priorityclasses) names your own class for `control` or `sandbox`,
`jr2 up` does not add `jr2-control` or `jr2-sandbox` for that tier.

## Remove the kind cluster

Run `jr2 down` in each Instance folder. For the last one, add `--all`. Then delete the kind cluster:

```sh
jr2 down --all
kind delete cluster --name jr2
```

`jr2 down` removes the images of its Instance from your computer. `kind delete cluster` cannot do this, because the
images are in your docker, not in the cluster. The images that your Dockerfiles name in `FROM` stay, and so does the
build cache of docker.

## Rules

- `jr2 down` runs only in an Instance folder. In a different folder, it exits with the code 1:
  `error: not inside a jr2 instance — no jr2.config.ts found walking up from cwd`
- `jr2 down` with no kubectl context exits with the code 1: `error: no kube context — nothing to remove from`
- `jr2 down` refuses a namespace that holds no Instance, and exits with the code 1:
  `not deployed here — namespace "<namespace>" on <context> holds no jr2 instance`. Check the context and the namespace.
  `-n` and `--context` change them. `jr2 down --all` also refuses this way after a plain `jr2 down`, and the operator
  stays.
- `jr2 down` refuses a namespace that belongs to a different Instance, and exits with the code 1:
  `refusing: namespace "<namespace>" on <context> belongs to another instance ("<owner>")`
- When you do not type `y` or `yes`, `jr2 down` changes nothing, and exits with the code 1:
  `aborted — nothing was changed`
- When no terminal is attached, `jr2 down` cannot ask, so it changes nothing. It prints
  `<question> — not a tty; pass --yes to proceed non-interactively`, then `aborted — nothing was changed`. It exits with
  the code 1. Add `--yes`.
- `jr2 down` refuses when the Instance and the [jr2 CLI](../reference/glossary.md#jr2-cli) do not use the same
  [Kit version](../reference/glossary.md#kit-version). The refusal starts with
  `error: Kit version mismatch — an Instance has one (ADR-0056):`. See
  [Fix a failed converge](fix-a-failed-converge.md#rules).
- When the namespace is gone but the image sweep fails, `jr2 down` exits with the code 0. It prints:
  `image sweep failed (<error>) — the instance is still removed`. Run `jr2 gc` later.
- `jr2 gc` with no kubectl context exits with the code 1:
  ``error: no kube context — `jr2 gc` decides what is garbage by asking a cluster what it still needs``
- `jr2 gc` refuses a `--repo-ttl` that is not a number with `d`, `h` or `m`, or `0`. It exits with the code 1 before it
  reads the cluster: `error: --repo-ttl "<ttl>" is not a TTL — use <n>d, <n>h, or <n>m (or 0 for now)`
- When `jr2 gc` cannot read each live root, it removes nothing, and exits with the code 1:
  `error: the roots could not be read (<error>)`, then
  `  nothing was swept — a keep set missing one root would delete images the cluster still needs`. The error in the
  parentheses can come from kubectl, from docker or from a kind node. Fix that cause, then run `jr2 gc` again.
- When `jr2 gc` cannot read the Repo resources, it exits with the code 1:
  `error: the Repo resources could not be read (<error>)`
- On a kind node, jr2 removes a whole image. Thus it keeps a tag whose image also has a tag that a live root names. It
  prints: `kept <count> tag(s) — their image id also carries a tag a live root names: <tags>`. On your computer, jr2
  removes each tag that no live root names.
- When docker or a node refuses to remove an image, jr2 prints: `failed to remove <count> image(s): <images>`
- When `jr2 up` cannot remove the old images, the converge still succeeds. It prints:
  `images: sweep skipped (<error>) — the converge stands`. Run `jr2 gc` later.

## Read next

- [Converge](../concepts/converge.md)
- [ADR-0039](../reference/decisions/0039-image-garbage-collects-by-reachability.md): why jr2 removes an image when no
  live root names it.
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): why `jr2 gc`
  removes a Repo resource when no Machine binds it and no run attached it in the last 7 days.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): why `jr2 down` asks you
  to confirm.
- [`jr2 gc`](../reference/cli.md#gc), [`jr2 down`](../reference/cli.md#down)
- [Cancel a run](cancel-a-run.md)
