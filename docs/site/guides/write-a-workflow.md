---
title: Write a Workflow
description: Write a module in workflows/ that exports a Machine, with the input that starts a run and its Vocabulary.
---

Write a module in `workflows/` that exports a [Machine](../reference/glossary.md#machine), so that the
[Instance](../reference/glossary.md#instance) registers it as a [Workflow](../reference/glossary.md#workflow).

The module contract has three parts:

- The file is `workflows/<name>.ts`. `<name>` is the name of the Workflow. `jr2 run <name>` starts it.
- The file exports its Machine as `machine`. jr2 reads no other export.
- The Machine holds all that it needs: its [Vocabulary](../reference/glossary.md#vocabulary), its
  [Agents](../reference/glossary.md#agent), its [Effects](../reference/glossary.md#effect) and its
  [Sandbox Image](../reference/glossary.md#sandbox-image). The Workflow is only a name for it.

## The example

This module is the Workflow `rollout`. A run waits at a [Gate](../reference/glossary.md#gate) until a person sends
`promote` or `roll_back`. It has no Agent, so you can try it with no model. Save it as `workflows/rollout.ts`:

<<< @/examples/guides/write-a-workflow/rollout.ts

The parts of the module:

- **The door.** The `input` of `createMachine` is a zod object. It is the input that starts a run. jr2 examines each
  start against it, and it starts the run with the input that zod parsed. Thus `canaryPercent` gets its default when the
  caller does not send it. Give the same type to `types.input`, with `z.infer`, so that TypeScript and jr2 agree.
- **`instanceId`.** jr2 adds `instanceId` to the input of the root Machine of a run. Add
  [`HostInjectedInput`](../reference/authoring-surface.md#type-hostinjectedinput) to the input type when the Machine
  reads it. Do not put it in the door. No caller sends it.
- **The Vocabulary.** Make each event with [`defineEvent`](../reference/authoring-surface.md#defineevent), and list it
  in the `events` of [`jr2Setup`](../reference/authoring-surface.md#jr2setup). Write its name as an `on` key on each
  state that takes it.
- **The Gate.** The state `canary` invokes `gate`. The Gate takes the events of the `on` keys of that state. Its `meta`
  is the data that `jr2 status` and the [Console](../reference/glossary.md#console) show to the person who answers.
- **The [Emit](../reference/glossary.md#emit).** `emit()` tells the people who watch the run what happened. It does not
  move the Machine. Declare its type in `types.emitted`.

A Machine that takes no workflow event can use the `setup()` of xstate in place of `jr2Setup`. The `ping` Workflow that
`jr2 init` writes does this. To declare a door, use `jr2Setup`.

## Register it and run it

Run [`jr2 up`](../reference/cli.md#up) in the Instance folder. `jr2 up` typechecks the Instance, then loads each module
in `workflows/` before it changes the cluster. An error in a module stops it. The
[Orchestrator](../reference/glossary.md#orchestrator) runs only the Machines that the last `jr2 up` gave it.
[Iterate on a Machine on kind](iterate-on-a-machine-on-kind.md) gives the loop.

```sh
jr2 up
```

Start a run in one terminal. The run waits at the Gate, so `jr2 run` stays attached. The output uses the kind cluster
`jr2` and the Instance `my-instance` from [Get started](../get-started/install.md):

```sh
jr2 run rollout --input '{"service":"billing","version":"1.4.0"}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
run a078c3f8-0346-4464-a768-45c44b8ac310 (rollout) — attached
  → active "canary"
```

Your run id is different. In a second terminal, answer the Gate. Write the run id in place of `<run id>`, or its first 4
characters or more:

```sh
jr2 send <run id> --gate canary --event roll_back --input '{"reason":"The error rate went up."}'
```

<!-- output: not run -->

```text
→ context kind-jr2 / namespace my-instance
delivered roll_back to gate "canary" on a078c3f8-0346-4464-a768-45c44b8ac310
```

In the first terminal, the run ends. Its `context` holds the default of `canaryPercent`, the `instanceId` that jr2
added, and the `reason`:

<!-- output: not run -->

```text
  emit {"type":"decided","promoted":false}
  → done "rolledBack"
{"runId":"a078c3f8-0346-4464-a768-45c44b8ac310","workflow":"rollout","instanceId":"dd6f251e-4d9c-40bb-ab28-ed8537837a1d","status":"done","value":"rolledBack","context":{"service":"billing","version":"1.4.0","canaryPercent":10,"instanceId":"dd6f251e-4d9c-40bb-ab28-ed8537837a1d","reason":"The error rate went up."},"children":[],"waiting":[],"held":[],"assembly":"0c7d4e5f9a18"}
```

[Start a run](start-a-run.md) gives the other ways to start a run. [Answer a Gate](answer-a-gate.md) gives the other
ways to answer one.

## Put shared code in a file that jr2 does not register

jr2 registers each `.ts` file in `workflows/`, also a file that a different Workflow imports. It does not register a
file whose name starts with `_`, or a `.d.ts` file. Thus put the code that two Workflows share in a file such as
`workflows/_events.ts`, or outside `workflows/`. Import it with its `.ts` extension:
`import { promote } from "./_events.ts";`.

## Rules

- `jr2 up` changes nothing when the Instance does not typecheck. It prints
  `refusing: this instance does not typecheck — nothing was built and nothing was applied`, then each line of the output
  of the compiler. Run `npm run typecheck` to see the same errors without `jr2 up`.
- `jr2 up` refuses a module with no `machine` export. It prints the error and exits with `1`:
  ``error: workflow "<name>" (<file>) has no `machine` named export (module contract, ADR-0011/0015: `export const machine`)``
- `defineEvent` refuses a name with a character other than a letter, a digit, `_` or `-`:
  `defineEvent: invalid name "<name>" — must match /^[a-zA-Z0-9_-]+$/ (it becomes an MCP tool name and an xstate event type)`
- `defineEvent` refuses an input with a `sender` field:
  ``defineEvent: "<name>" declares `sender` in its input — the Orchestrator writes that field on every delivered event (who sent it); name the payload field something else``
- `createMachine` refuses an `on` key that no listed event has. The compiler does not find this error, so `jr2 up` finds
  it when it loads the module:
  `machine "<id>" handles event "<key>", which no def in jr2Setup({ events }) declares (declared: <names>) — a typo, or a missing defineEvent`.
  An `on` key with a `.` is a jr2 or xstate event, such as `agent.fault`, and you do not list it.
- `createMachine` refuses a listed event that no state takes:
  `machine "<id>" declares "<name>", which no state handles — a pick no state takes is on no Menu and no Gate: handle it, or drop it from jr2Setup({ events })`
- `createMachine` refuses an entry of `events` that `defineEvent` did not make, and a name that you list two times:
  ``machine "<id>": `events` entry is not a defineEvent() def: <entry>`` and
  `` machine "<id>": duplicate event "<name>" in `events` ``
- `createMachine` refuses an `agent()`, an Effect or a `workspace()` that a state writes in its `invoke.src`. Put it
  under `actors`, and invoke it by its key:
  `machine "<id>": state "<state>" invokes <part> inline — a Part is a key of actors, so it has a name that the ledger, the report and customize() share: actors: { <name>: <factory>(...) }, then invoke: { src: "<name>" }`
- `workspace()` refuses a body that declares a door. Declare the door with the `input` option of `workspace()`:
  ``workspace(): the body "<id>" declares its own run input, which nothing will ever serve or enforce — the wrapper feeds the body the run input PLUS the injected `workspace` handles, so the body's schema is not the door. Move it to the wrapper: workspace(body, { input, spec }) (ADR-0033).``
- `jr2 up` prints each refusal of `defineEvent`, `createMachine` and `workspace()` as `error: <refusal>`, and exits with
  `1`. It changes nothing in the cluster.
- The Orchestrator refuses a start whose input does not agree with the door, with the status code `400`:
  `invalid input for workflow "<workflow>": <issues>`. `<issues>` is the list of the problems as JSON. `jr2 run` prints
  `error: invalid input for workflow "<workflow>": <issues>` and exits with `1`. No run starts.
- The Orchestrator refuses a name that no file in `workflows/` registers, with the status code `404`:
  `no workflow registered as "<workflow>"`.

## Read next

- [Machines and Workflows](../concepts/machines-and-workflows.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): the events are the Workflow's, and jr2 delivers
  them.
- [ADR-0015](../reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md): `jr2Setup`, the Vocabulary and the
  module contract.
- [ADR-0033](../reference/decisions/0033-a-machine-declares-the-input-that-starts-it.md): the door.
- [ADR-0050](../reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md): jr2
  finds a Workflow by its file name.
- [Gates](../concepts/gates.md) and [The Menu](../concepts/the-menu.md)
- [Set an Agent's access and Dials](set-an-agents-access-and-dials.md), to add an Agent to the Machine.
- [Bind a shipped Machine's Open parts](bind-open-parts.md), to register a Machine from a package.
- Reference: [`jr2Setup`](../reference/authoring-surface.md#jr2setup),
  [`defineEvent`](../reference/authoring-surface.md#defineevent),
  [`HostInjectedInput`](../reference/authoring-surface.md#type-hostinjectedinput),
  [`GET /workflows/:name`](../reference/http-api.md#get-workflows-name)
