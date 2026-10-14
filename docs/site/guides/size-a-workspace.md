---
title: Size a Workspace
description: Give a Workspace the memory and cpu that its Sandbox needs, and see how jr2 divides them in the pod.
---

Give a [Workspace](../reference/glossary.md#workspace) the memory and cpu that its
[Sandbox](../reference/glossary.md#sandbox) needs.

The [Size](../reference/glossary.md#size) is the most memory and cpu that the whole Sandbox can use. jr2 reserves all of
it on a node, so the Sandbox always has it. Write it in the `resources` option of `workspace()`. In this example, the
[Workflow](../reference/glossary.md#workflow) `workflows/e2e.ts` runs Playwright with 4 GiB of memory and 2 cpus:

::include{file="../examples/guides/size-a-workspace/workflows/e2e.ts"}

The [Sandbox Image](../reference/glossary.md#sandbox-image) must have Playwright and its browsers.
[Add tools to the Sandbox](add-tools-to-the-sandbox.md) tells how.

## Choose the numbers

A Size is `{ limits: { memory, cpu } }`, and nothing else. Each value is a Kubernetes quantity: `"4Gi"` or `"512Mi"` for
memory, `"2"` or `"1500m"` for cpu.

The kit default is memory `2Gi` and cpu `1`. It is enough for `tsc` and vitest, for `cargo build`, and for Playwright
with 2 workers. State a larger Size for Playwright with more workers, or for a large monorepo.

A larger Size is not free. The Sandbox holds all of its Size while the run waits, also at a
[Gate](../reference/glossary.md#gate). When no node has room for the Size, the Workspace waits in the
[Placing](../reference/glossary.md#placing) state, with no time limit. [Workspaces](../concepts/workspaces.md#placing)
tells how to see the wait.

`jr2 up` warns when no node can hold a Size now. It does not stop, because the nodes can change:

<!-- output: not run -->

```text
warning: no Sandbox node right now has the allocatable for a Size of memory 4Gi, cpu 2 (workflow "e2e") — its Sandbox stays Pending until one does
```

## Where the Size comes from

The Size is a fact of the [Machine](../reference/glossary.md#machine). A run cannot change it. jr2 uses the first of
these that states a Size:

1. [`customize(machine, { resources })`](../reference/authoring-surface.md#customize), in the
   [Instance](../reference/glossary.md#instance) that registers the Machine.
2. `resources` on the `workspace()`.
3. [`sandbox.resources`](../reference/config.md#sandbox-resources) in `jr2.config.ts`, such as
   `sandbox: { resources: { limits: { memory: "3Gi" } } }`.
4. The kit default.

These rules apply to the order:

- `customize()` writes over the Size of the `workspace()` one field at a time. Thus
  `customize(machine, { resources: { limits: { memory: "6Gi" } } })` keeps the cpu of the Machine.
- `sandbox.resources` applies only to a Workspace that states no Size. It never changes a Size that a Machine states.
- A field that the chosen Size does not state comes from the kit default. For example, under
  `resources: { limits: { memory: "4Gi" } }`, the cpu is `1`, also when `sandbox.resources` states a cpu.

Use `customize()` to change the Size of a Machine from a package, such as `task` from
[`@jr2/machines`](../reference/machines.md). See [Bind a shipped Machine's Open parts](bind-open-parts.md).

## How jr2 divides the Size in the pod

The pod has the Size as one limit. Inside the pod, jr2 divides it among the containers:

| Container                                                         | Its part                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The [Custodian](../reference/glossary.md#custodian)               | A fixed part: memory `64Mi`, cpu `50m`.                                                                          |
| The [User Container](../reference/glossary.md#user-container)     | The part that `user.resources` gives. With no part, it shares the rest.                                          |
| The [Sandbox Effector](../reference/glossary.md#sandbox-effector) | No part of its own. It shares the rest.                                                                          |
| The `harness` container                                           | The rest, as its own limit. The [Agent](../reference/glossary.md#agent)'s processes and the `command`s run here. |

`jr2 up` refuses a Size that leaves the `harness` container less than `256Mi` of memory, or no cpu.

To give the User Container a part, write `user` as an object:
`user: { image: import.meta.resolve("./shell"), resources: { limits: { memory: "256Mi", cpu: "250m" } } }`. The part
comes out of the part of the `harness` container. It is not added to the Size.

The Size holds only memory and cpu. jr2 also sets these, and you cannot change them:

- `/dev/shm` in the `harness` container is 25% of the container's memory, and not less than `64Mi`. It counts in that
  memory. To get more, state a larger Size.
- `/work` has a disk request of `10Gi`, with no limit. The disk is not part of the Size.

## Use the cpus

jr2 enforces the cpu limit. Many tools read the limit, such as Node's `availableParallelism()`, Go, cargo and the JVM.
For tools that do not read it, these environment variables in the `harness` container hold its cpu limit, rounded up to
a whole number: `JR2_CPUS`, `OMP_NUM_THREADS`, `PYTHON_CPU_COUNT` and `GOMAXPROCS`.

Node's `os.cpus()` gives the cpus of the node, not the limit. Playwright uses it to choose its number of workers. Thus
the example gives `--workers=$JR2_CPUS`. A `command` sees these variables.

## When the memory is not enough

The [Harness](../reference/glossary.md#harness) watches the memory of its container. Near the limit, it stops all of the
Agent's processes. Then the Agent's `bash` call returns this text, and the Agent can try again with less:

```text
killed: memory limit (peak <peak> of <limit>); use fewer workers or a larger Size
```

The Harness can miss a fast increase. Then the kernel stops the whole container, and the
[Turn](../reference/glossary.md#turn) faults. The reason starts with `memory limit`:

```text
memory limit (OOMKilled, limit <memory>): the Workspace's processes passed the Harness container's memory limit and the kernel killed the container, the conversation with it. Use fewer workers, or give the Workspace a larger Size (ADR-0060, ADR-0061).
```

The next Agent in the Workspace gets a notice of the kill. When you see either text again and again, state a larger
Size.

## Rules

- `workspace()`, `customize()` and the config refuse a key other than `limits`, where you write it. `<where>` is
  `workspace(): resources`, `customize(): resources`, `<file> at sandbox.resources`, `workspace() user.resources` or
  `customize() user.resources`:
  `<where>.requests is not accepted — jr2 reserves the whole Size, so every request equals its limit — a Size is { limits: { memory?, cpu? } } and nothing else — Agent Substrate's template size (ADR-0060)`
  and
  `<where>.<key> is not accepted — a Size is { limits: { memory?, cpu? } } and nothing else — Agent Substrate's template size (ADR-0060)`.
- They refuse a key in `limits` other than `memory` and `cpu`:
  `<where>.limits.<key> is not accepted — a Size is { limits: { memory?, cpu? } } and nothing else — Agent Substrate's template size (ADR-0060)`.
- They refuse a value that is not a quantity more than zero:
  `<where>.limits.memory: <value> is not a positive quantity (e.g. "2Gi", "512Mi")` and
  `<where>.limits.cpu: <value> is not a positive quantity (e.g. "2", "1500m")`.
- They refuse a Size, or a `limits`, that is not an object:
  `<where>: expected an object (got <value>) — a Size is { limits: { memory?, cpu? } } and nothing else — Agent Substrate's template size (ADR-0060)`
  and the same text for `<where>.limits`.
- `customize()` refuses `resources` for a Machine that has no `workspace()`:
  ``customize(): `resources` say what a SANDBOX is made of, how big it is and which Repos it attaches, and machine "<id>" composes none — only a workspace() wrapper carries those seats, that Size and those slots (ADR-0049, ADR-0037, ADR-0051, ADR-0060).``
- `jr2 up` refuses a Size that leaves the `harness` container less than `256Mi` of memory. The text names each number
  and where it came from. The part `− the User Container's <memory> (its user.resources.limits.memory)` is there only
  when `user.resources` gives a memory:
  `refusing: workflow "<workflow>": the Size leaves the Harness container <memory> memory, below its 256Mi floor: memory <size> (<source>) − the Custodian's 64Mi − the User Container's <memory> (its user.resources.limits.memory) — raise the Size's limits.memory, or shrink the User Container's split (ADR-0060)`.
  The text can also name the Machine that states the Size, and it can end with the `customize()` line that changes the
  Size. For cpu, the text holds `the Size leaves the Harness container no cpu:`.
- `jr2 up` refuses a cluster that drops pod-level resources:
  `refusing: <context> (Kubernetes <version>) drops pod-level resources — the PodLevelResources feature gate is off, and a Workspace's Size cannot hold (ADR-0060). Enable the gate on the API server and kubelets. The namespace was created; nothing else was applied.`

## Read next

- [Workspaces](../concepts/workspaces.md#size): the Size, and Placing.
- [Add tools to the Sandbox](add-tools-to-the-sandbox.md): the User Container.
- Reference: [`Size`](../reference/authoring-surface.md#type-size),
  [`UserContainer`](../reference/authoring-surface.md#type-usercontainer),
  [`sandbox.resources`](../reference/config.md#sandbox-resources), [`jr2 up`](../reference/cli.md#up)
- [ADR-0060](../reference/decisions/0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md): a Workspace states
  its Size, and jr2 reserves all of it.
- [ADR-0061](../reference/decisions/0061-a-memory-kill-ends-the-agents-processes-not-the-harness.md): a memory kill ends
  the Agent's processes, not the Harness.
- [ADR-0064](../reference/decisions/0064-a-workspace-waits-for-capacity.md): a Workspace waits for capacity.
