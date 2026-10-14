---
title: Iterate on a Machine on kind
description: Change a Machine, converge the change into your kind cluster, and run it again.
---

Change a [Machine](../reference/glossary.md#machine), converge the change into your kind cluster, and run it again.

kind runs a Kubernetes cluster on your computer, and jr2 uses it as its local cluster. The loop has three steps: edit
the file, run [`jr2 up`](../reference/cli.md#up), and run the [Workflow](../reference/glossary.md#workflow). The
[Orchestrator](../reference/glossary.md#orchestrator) runs only the Machines that the last `jr2 up` gave it. Thus a
change that you save does nothing until you converge it.

The examples on this page use the kind cluster `jr2` and the [Instance](../reference/glossary.md#instance) `my-instance`
from [Get started](../get-started/install.md). They change `ping`, the Workflow that `jr2 init` writes. It needs no
model.

## Change the Machine

Open `workflows/ping.ts`. In the line of the `respond` actor, change `` `pong: ${input.message}` `` to
`` `pong, again: ${input.message}` ``. Save the file.

To find the type errors before you converge, run the typecheck of the Instance. `jr2 up` runs the same check first:

```sh
npm run typecheck
```

To also see the walk of each Machine with no cluster, give `jr2 up` a context that does not exist, such as
`jr2 up --context nope`. It prints the typecheck, the `effects:` lines and the `seats:` lines. Then it stops with
`refusing: cannot reach the API server of nope (<error>). Nothing was applied.` The checks of `git.credentials` and of
the images come after that refusal, so they need the cluster.

## Converge the change

Run `jr2 up` in the Instance folder:

```sh
jr2 up
```

For an Instance that has only `ping`, the output is:

<!-- output: not run -->

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
agents: (none) (carried by 1 workflow machine(s))
…
image: building jr2-instance-my-instance:<hash>-<arch>
  kind load → cluster "jr2"
sandbox images: skipped (no registered Machine composes a Sandbox)
…
orchestrator: applying (image jr2-instance-my-instance:<hash>-<arch>)
orchestrator: waiting for rollout
orchestrator: verified — 1 pod(s) running jr2-instance-my-instance:<hash>-<arch>
…
converged — `jr2 run <workflow>` when ready
```

`<hash>` is the content hash of the image of the Orchestrator, and `<arch>` is the architecture of the node, such as
`amd64`. The hash changed, because the Workflow changed. Thus `jr2 up` built the image again, loaded it into the kind
nodes, and replaced the pod of the Orchestrator. Your output has more lines when your Machines use a model, a
[Sandbox](../reference/glossary.md#sandbox) or an [Effect](../reference/glossary.md#effect).

`jr2 up` says `converged` only when the new pod runs the new image. When it stops with `refusing:`, it did not change
the Orchestrator. An `error:` after the line `orchestrator: applying` comes after the change. In both cases, fix the
cause, then run `jr2 up` again. [Fix a failed converge](fix-a-failed-converge.md) gives each refusal and its fix.

## Run it again

Run the Workflow:

```sh
jr2 run ping --input '{"message":"hi"}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run 56f83075-b4eb-4095-a350-4c7428ae0bd9 (ping) — attached
  → done "done"
{"runId":"56f83075-b4eb-4095-a350-4c7428ae0bd9","workflow":"ping","instanceId":"25e49524-27b0-47ae-b1c0-242cb759580f","status":"done","value":"done","context":{"message":"hi","reply":"pong, again: hi"},"children":[],"waiting":[],"held":[]}
```

Your run id is different. The `reply` comes from the new Machine.

A `kubectl port-forward` stops when its pod stops. Thus, after a converge that replaces the Orchestrator, start the port
forward of the [Console](../reference/glossary.md#console) again. Then the Console draws the new Machine.
[Open the Console](open-the-console.md) gives the command.

## Why a repeated jr2 up is fast

`jr2 up` does the full converge each time, but it builds an image only when its inputs changed.
[Converge](../concepts/converge.md#the-images) tells why. You see it in these lines:

- `(fresh — build skipped; --force to rebuild anyway)`: the tag did not change, so `jr2 up` did not build the image.
- `(host-built — build skipped, delivering; --force to rebuild)`: your computer holds the image of the Orchestrator with
  that tag, so `jr2 up` loaded it and did not build it. For a [Sandbox Image](../reference/glossary.md#sandbox-image),
  the line ends with `(host-built — build skipped; --force to rebuild)`.

A second `jr2 up` with no change builds nothing:

<!-- output: not run -->

```text
…
image: jr2-instance-my-instance:<hash>-<arch> (fresh — build skipped; --force to rebuild anyway)
…
converged — `jr2 run <workflow>` when ready
```

To build all the images again, run `jr2 up --force`. It builds an image again also when its tag did not change.

## The runs that are live when you converge

`jr2 up` replaces the pod of the Orchestrator. The new pod continues each live run under the new Machine. A run that
waits at a [Gate](../reference/glossary.md#gate) still waits there, and its Sandbox stays.

A `jr2 run` that is attached when `jr2 up` replaces the pod exits with `1` and prints an `error:` line. The run
continues in the new pod. Follow it with [`jr2 logs -f <run id>`](../reference/cli.md#logs).

The Orchestrator continues a run only when the [Machine shape](../reference/glossary.md#machine-shape) did not change.
The shape is the states, the invokes and the transitions of the Machine. A change to an action, a guard, a prompt or a
description does not change the shape. A run that continues uses the new code from its next transition.

When the shape changed, the Orchestrator does not continue the run. It keeps the run with the status `drifted`.
[`jr2 status`](../reference/cli.md#status) shows the reason. In this example, a run of `rollout` from
[Write a Workflow](write-a-workflow.md) waited at its Gate, and the converge added a state to the Machine. `<run id>` is
the id that `jr2 run` printed, or its first 4 characters or more:

```sh
jr2 status <run id>
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
{"runId":"929a1f3c-4223-42f2-b687-e685ca27684f","workflow":"rollout","instanceId":"73ad59b5-7d89-42bc-9d3d-8c3dced7ee8e","status":"drifted","value":"canary","context":{"service":"billing","version":"1.4.0","canaryPercent":10,"instanceId":"73ad59b5-7d89-42bc-9d3d-8c3dced7ee8e"},"children":[],"waiting":[],"held":[],"reason":"workflow \"rollout\" changed shape since this run was saved (saved under bad70d4393d1, now 6580f29b090f)","gates":[]}
```

Your run id and digests are different.

jr2 cannot move a drifted run to the new Machine. Thus, before you converge a change to the shape, let the live runs of
the Workflow end. Or cancel them with `jr2 send <run id> --event CANCEL`. [Cancel a run](cancel-a-run.md) tells how.

The Orchestrator does not continue a run whose Workflow file you removed. It marks the run `lost`.

## Rules

- `jr2 up` changes nothing in the cluster when the Instance does not typecheck:
  `refusing: this instance does not typecheck — nothing was built and nothing was applied`. The output of the compiler
  follows, one line for each error.
- `jr2 up` changes nothing in the cluster when a registered Machine has an [Open](../reference/glossary.md#open) part
  that nobody bound. It prints the line that binds it:
  `refusing: workflow "<name>" leaves <part> open — bind it where the Machine is registered: export const machine = customize(<import>, <binding>)  (<adr>)`.
  [Bind a shipped Machine's Open parts](bind-open-parts.md) tells how.
- `jr2 up` prints an error in a Workflow module as `error: <message>`, and exits with `1`. It changes nothing in the
  cluster. [Write a Workflow](write-a-workflow.md) gives each error.
- `jr2 up` refuses when kubectl has no current context:
  ``error: no kube context — `kind create cluster` (or point kubectl at one), then re-run `jr2 up` ``
- `jr2 up` loads the images into the nodes only on a kind cluster: a context whose name starts with `kind-`. For a
  different context with no [`registry`](../reference/config.md#registry), it builds nothing:
  ``error: context <context> is not a kind cluster and no `registry` is configured — set `registry` in jr2.config.ts (from env) so the image can be pushed (ADR-0019)``
- The Orchestrator does not continue a run whose Machine changed shape. `jr2 status` shows the status `drifted` and the
  reason: `workflow "<workflow>" changed shape since this run was saved (saved under <digest>, now <digest>)`

## Read next

- [Converge](../concepts/converge.md)
- [Durable runs](../concepts/durable-runs.md): the Machine shape and drift.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): one converging command
  against the current context.
- [ADR-0038](../reference/decisions/0038-jr2-up-builds-every-image-it-deploys.md): `jr2 up` builds each image that the
  cluster runs, with a content hash as its tag.
- [ADR-0041](../reference/decisions/0041-a-build-the-host-already-holds-is-not-spent-again.md): a build that your
  computer holds is not done again.
- [ADR-0050](../reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md): the
  typecheck is the first step of `jr2 up`.
- [Write a Workflow](write-a-workflow.md)
- [Move from kind to a shared cluster](move-from-kind-to-a-shared-cluster.md)
- Reference: [`jr2 up`](../reference/cli.md#up), [`jr2 run`](../reference/cli.md#run),
  [`jr2 status`](../reference/cli.md#status)
