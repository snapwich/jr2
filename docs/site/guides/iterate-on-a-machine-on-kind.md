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

```text
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
agents: (none) (carried by 1 workflow machine(s))
assembly: staging
assembly: 0adf5bff234d (kit v<version>; 1 workflow(s): ping)
…
sandbox images: skipped (no registered Machine composes a Sandbox)
…
orchestrator: applying (image ghcr.io/snapwich/jr2-orchestrator:<version>)
orchestrator: waiting for rollout
orchestrator: verified — 1 pod(s) running ghcr.io/snapwich/jr2-orchestrator:<version>
instance effector: none (no Effect is placed there)
assembly: publishing 0adf5bff234d (current is ba71fa27f37f)
assembly: 0adf5bff234d is current — workflows: ping
swept nothing — every labeled image is named by a live root
converged — `jr2 run <workflow>` when ready
```

`0adf5bff234d` is the hash of the new [Assembly](../reference/glossary.md#assembly), and `ba71fa27f37f` is the hash of
the Assembly that was current. Your hashes can be different. `<version>` is the
[Kit version](../reference/glossary.md#kit-version). The hash changed, because the Workflow changed. Thus `jr2 up`
published the new Assembly to the [Orchestrator](../reference/glossary.md#orchestrator). The image of the Orchestrator
did not change, so its pod did not start again. Your output has more lines when your Machines use a model, a
[Sandbox](../reference/glossary.md#sandbox) or an [Effect](../reference/glossary.md#effect).

`jr2 up` says `converged` only when the Orchestrator made the new Assembly current. When it stops with `refusing:`, the
Assembly that was current stays current. In both cases, fix the cause, then run `jr2 up` again.
[Fix a failed converge](fix-a-failed-converge.md) gives each refusal and its fix.

## Run it again

Run the Workflow:

```sh
jr2 run ping --input '{"message":"hi"}'
```

```text
→ context kind-jr2 / namespace my-instance
run 7df09f94-d26d-44c3-ba1e-0279f16ccacb (ping) — attached
  → done "done"
{"runId":"7df09f94-d26d-44c3-ba1e-0279f16ccacb","workflow":"ping","instanceId":"b2ec6504-553e-495a-a8be-62715c6d8595","status":"done","value":"done","context":{"message":"hi","reply":"pong, again: hi"},"children":[],"waiting":[],"held":[],"assembly":"0adf5bff234d"}
```

Your run id and your instance id are different. The `reply` comes from the new Machine, and `assembly` is the hash of
the new Assembly.

The pod of the Orchestrator did not start again, so the port forward of the [Console](../reference/glossary.md#console)
stays open. Load the page again. Then the Console draws the new Machine. [Open the Console](open-the-console.md) gives
the command for the port forward.

## Why a repeated jr2 up is fast

`jr2 up` does the full converge each time, but it builds an image only when its inputs changed, and it publishes the
Assembly only when its hash changed. [Converge](../concepts/converge.md#the-images) tells why. You see it in these
lines:

- `(fresh — build skipped; --force to rebuild anyway)`: the tag of a
  [Sandbox Image](../reference/glossary.md#sandbox-image) did not change, so `jr2 up` did not build it.
- `(host-built — build skipped; --force to rebuild)`: your computer holds the Sandbox Image with that tag, so `jr2 up`
  did not build it.
- `(current — publish skipped)`: the Orchestrator already has the Assembly with this hash.

A second `jr2 up` with no change builds nothing and publishes nothing:

```text
…
assembly: 0adf5bff234d (current — publish skipped)
swept nothing — every labeled image is named by a live root
converged — `jr2 run <workflow>` when ready
```

To build all the images again, run `jr2 up --force`. It builds an image again also when its tag did not change. It also
sends the Assembly again, and the Orchestrator answers that the Assembly did not change.

## The runs that are live when you converge

A publish does not start the pod of the Orchestrator again. A run that is live keeps the Assembly that it started under.
Thus it continues on the old Machine, to its end, also after a restart. A run that waits at a
[Gate](../reference/glossary.md#gate) still waits there, and its Sandbox stays. A `jr2 run` that is attached stays
attached. Each new run uses the new Machine.

[`jr2 status`](../reference/cli.md#status), with no run id, shows each Assembly that a live run holds:

```sh
jr2 status
```

In this output, a run of the Workflow `rollout` from [Write a Workflow](write-a-workflow.md) waits at its Gate. It
started before the last `jr2 up`:

```text
→ context kind-jr2 / namespace my-instance
assembly: a44731886e21 (kit v<version>, current), 0 live runs hold it
assembly: 3a3fa3c403f9 (kit v<version>), 1 live run holds it
data plane: yes
```

The Orchestrator removes the old Assembly when the last run that holds it ends. `data plane: yes` tells that the
Orchestrator runs in a cluster, so it can make Sandboxes.

A live run cannot continue when the Orchestrator cannot read its Assembly: the volume lost it, or it is for a different
Kit version. Then the Orchestrator keeps the run with the status `drifted`, and `jr2 status <run id>` gives the reason.
[Upgrade the Kit version](upgrade-the-kit-version.md) tells when this occurs.

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
- `jr2 up` loads the Sandbox Images into the nodes only on a kind cluster: a context whose name starts with `kind-`. For
  a different context with no [`registry`](../reference/config.md#registry), it builds nothing:
  ``error: context <context> is not a kind cluster and no `registry` is configured — set `registry` in jr2.config.ts (from env) so the image can be pushed (ADR-0019)``
- The Orchestrator refuses an Assembly that fails its checks. `jr2 up` prints the reason and the lines of the report,
  and the Assembly that was current stays current:
  `refusing: the Orchestrator refused Assembly <hash> (HTTP <status>): <error> — the previous Assembly is still current`

## Read next

- [Converge](../concepts/converge.md)
- [Durable runs](../concepts/durable-runs.md): the Machine shape and drift.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): one converging command
  against the current context.
- [ADR-0069](../reference/decisions/0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md): a
  publish loads the Assembly with no restart, and a run keeps its Assembly.
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
