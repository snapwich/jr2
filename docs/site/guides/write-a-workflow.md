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
  [`HostInjectedInput`](../reference/authoring-surface/type-hostinjectedinput.md) to the input type when the Machine
  reads it. Do not put it in the door. No caller sends it.
- **The Vocabulary.** Make each event with [`defineEvent`](../reference/authoring-surface/defineevent.md), and list it
  in the `events` of [`jr2Setup`](../reference/authoring-surface/jr2setup.md). Write its name as an `on` key on each
  state that takes it.
- **The Gate.** The state `canary` invokes `gate`. The Gate takes the events of the `on` keys of that state. Its `meta`
  is the data that `jr2 status` and the [Console](../reference/glossary.md#console) show to the person who answers.
- **The [Emit](../reference/glossary.md#emit).** `emit()` tells the people who watch the run what happened. It does not
  move the Machine. Declare its type in `types.emitted`.

A Machine with a door uses `jr2Setup`, also when it takes no workflow event. Then leave out `events`, as in
`jr2Setup()`. The `setup()` of xstate does not read the `input` of `createMachine`. TypeScript accepts a zod `input`
there, but no door reads it, so `jr2 up` refuses that Machine. Without the refusal, a run would start with any input,
and the Console start form would be only a field for JSON. Only a Machine with no door and no workflow event can use
`setup()`, as the `ping` Workflow that `jr2 init` writes does.

## Give the run an output

The output of a run is the `output` at the root of `createMachine`, beside `id` and `states`. The status of the run
shows it as `output`. When a different Machine invokes this Machine, the `onDone` of that invoke gets it as
`event.output`. The `rollout` example has no root `output`. Thus its run has no output, and its result is only in its
`context`.

xstate does not use the `output` of a final state as the output of the Machine. It gives that output to the root
`output` as `event.output`. Thus a Machine that has an `output` only on its final states has no output. TypeScript does
not find this error, but `createMachine` refuses it when the module loads (see [the refusal](#rules)). Write the root
`output` in one of these two forms:

- From the context: `output: ({ context }) => ({ reason: context.reason })`.
- From the final state that ended the run: `output: ({ event }) => event.output as Output`, with an `output` on each
  final state. The example of [Gates](../concepts/gates.md) does this.

Give the same type to `types.output`.

A final state inside a compound state can have an `output` without a root `output`. The `onDone` of that compound state
gets it as `event.output`. A Machine with no `output`, such as `rollout`, is also correct.

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

```text
→ context kind-jr2 / namespace my-instance
run 921d9a0a-da2d-4caf-bb32-5f95acfd3a59 (rollout) — attached
  → active "canary"
```

Your run id is different. When your Instance folder has a `.env` file, the output starts with one more line, `→ .env:`,
with the keys that the CLI took from it. In a second terminal, answer the Gate. Write the run id in place of `<run id>`,
or its first 4 characters or more:

```sh
jr2 send <run id> --gate canary --event roll_back --input '{"reason":"The error rate went up."}'
```

```text
→ context kind-jr2 / namespace my-instance
delivered roll_back to gate "canary" on 921d9a0a-da2d-4caf-bb32-5f95acfd3a59
```

In the first terminal, the run ends. Its `context` holds the default of `canaryPercent`, the `instanceId` that jr2
added, and the `reason`:

```text
  emit {"type":"decided","promoted":false}
  → done "rolledBack"
{"runId":"921d9a0a-da2d-4caf-bb32-5f95acfd3a59","workflow":"rollout","instanceId":"b5d9ee34-69c3-4b0f-9438-403e19898953","status":"done","value":"rolledBack","context":{"service":"billing","version":"1.4.0","canaryPercent":10,"instanceId":"b5d9ee34-69c3-4b0f-9438-403e19898953","reason":"The error rate went up."},"children":[],"waiting":[],"held":[],"assembly":"a44731886e21"}
```

Your instance id and your `assembly` hash are different.

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
- `npm run typecheck` does not find a refusal of `defineEvent`, `createMachine` or `workspace()`. These refusals occur
  when a module loads. `jr2 up` loads each module after the typecheck and before it connects to the cluster, so a
  refusal stops it before it changes the cluster.
- The name of a Workflow file has lower-case letters, digits and `-`, such as `release-notes.ts`. `jr2 up` refuses a
  different name, and gives the name to use:
  ``error: <folder>/workflows/<file>.ts: a Workflow is named by its filename stem, in lowercase letters, digits and "-", so that `jr2 run` and a `dispatch` slot name it the same way — rename it to <name>.ts (ADR-0071)``
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
- `jr2 up` refuses a registered Machine that has a zod `input` if `setup()` or `createMachine()` of xstate made the
  Machine in place of `jr2Setup`. The compiler does not find this error:
  ``refusing: workflow "<workflow>": machine "<id>" has a zod `input` on createMachine, but jr2Setup did not make this Machine, so no door reads that input: a run starts with any input, and the Console start form is only a field for JSON — make the Machine with jr2Setup in place of setup() or createMachine() (leave out `events` if it takes no workflow event) (ADR-0033)``.
  The Orchestrator refuses a publish of that Machine with the same line.
- `createMachine` refuses an `output` on a final state directly below the root when the root has no `output`, because
  the run then has no output (see [Give the run an output](#give-the-run-an-output)). Move the `output` to the root, or
  pass it on from the root:
  `machine "<id>": final state "<state>" declares an output, and the root has no output — xstate v5 gives a run only its root output, so this output reaches nothing and the run ends with none: write it at the root, as output: ({ context }) => ..., or keep it on the final state and pass it on with output: ({ event }) => event.output at the root`.
  With more than one such final state, the refusal names each one:
  `final states "<state>", "<state>" declare an output`. `jr2 up` also refuses this in a Machine that you make with the
  `setup()` of xstate, and in a child Machine.
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
- Reference: [`jr2Setup`](../reference/authoring-surface/jr2setup.md),
  [`defineEvent`](../reference/authoring-surface/defineevent.md),
  [`HostInjectedInput`](../reference/authoring-surface/type-hostinjectedinput.md),
  [`GET /workflows/:name`](../reference/http-api.md#get-workflows-name)
