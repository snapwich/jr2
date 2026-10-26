---
title: Effects
description: How a Machine runs a command, calls a URL, pushes a branch or starts a run, at most once.
---

An [Effect](../reference/glossary.md#effect) is work that a [Machine](../reference/glossary.md#machine) does outside
itself. jr2 has four kinds: `command` runs a program in the [Workspace](../reference/glossary.md#workspace), `http`
calls a URL, `push` pushes the Workspace's branch, and `dispatch` starts a run of a
[Workflow](../reference/glossary.md#workflow). You write an Effect as an actor slot, beside the
[Agents](../reference/glossary.md#agent) of the Machine.

## Why Effects exist

A Machine often needs a fact from the world: do the tests pass, did the call succeed, is the branch on the remote.
Without an Effect, the Machine can only ask an Agent to do the work. Then the Machine must trust what the Agent says. An
Effect gives the Machine its own result, and the Machine routes on it.

An Effect also keeps a credential away from the Agent. A `push` uses a push credential, and an `http` call uses an
[Effect secret](../reference/glossary.md#effect-secret). The Agent never reads either one. jr2 also records each Effect
before it starts, so that a restart of the [Orchestrator](../reference/glossary.md#orchestrator) does not do the work
two times. A plain xstate promise has no such record.

## An Effect is an actor slot

Put an Effect under `actors` in [`jr2Setup`](../reference/authoring-surface/jr2setup.md). Invoke it by its key from a
state. The state's `onDone` gets the output of the Effect. This example is a Workflow with a Workspace. An Agent fixes
the code, and it can ask for a test run with the pick `run_tests`. When the Agent picks `finished`, the Machine pushes
the branch:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/effects/anthropic/test-and-push.ts

== Local

<<< @/examples/concepts/effects/local/test-and-push.ts

:::

[Agents and Turns](agents-and-turns.md) tells how to define an Agent.

The Effect has the life of the state that invokes it. It starts when the run enters the state, and it stops when the run
leaves the state. Its input goes into the run's snapshot. A typo in `src` is a compile error.
[`customize()`](../reference/authoring-surface/customize.md) binds an [Open](../reference/glossary.md#open) part of the
Effect by its slot key (see [Composition](composition.md)).

[`jr2 up`](../reference/cli.md#up) reads each Effect slot without running it, and prints what it found. For each
Workflow, it lists each Effect with its kind, its argv or its method and host, its timeout, and where it runs. For the
example above, `jr2 up` prints these lines:

```text
effects: workflow "test-and-push" — what it runs outside itself (ADR-0067)
  tests: command ["node","--test"] — 300s, in the Harness
  publish: push — 300s, in the Sandbox Effector
```

The first line gives the name of the Workflow. Each next line gives the slot of one Effect.

`jr2 up` also lists each state that invokes [`fail`](../reference/authoring-surface/fail.md), because each one ends the
run `failed`:

<!-- output: not run -->

```text
failures: workflow "test-and-push" — the states that fail the run (ADR-0073)
  test-and-push.notPushed: invokes fail
  test-and-push.failed: invokes fail
  test-and-push.lost: invokes fail
```

## The four kinds

### `command`

[`command`](../reference/authoring-surface/command.md) runs one program. Its argv is a list, and each entry is one
argument. jr2 starts `argv[0]` with no shell. An [`arg("name")`](../reference/authoring-surface/arg.md) entry is one
argument that the input of the Effect fills. Thus an Agent's text cannot become shell syntax. To use a shell, write it
in the argv: `["sh", "-c", "…"]`. Then the result is the result of your script. The Agent can change the files that the
script runs, so do not trust its result more than the Agent.

A `command` uses the [Worktree](../reference/glossary.md#worktree) of one
[Repo Slot](../reference/glossary.md#repo-slot): the only slot, or the slot that its `slot` option names. Its default
timeout is 10 minutes. Its output keeps the end of what the program wrote: 4096 characters by default (the `tail`
option). The full output goes to the run's feed.

### `http`

[`http`](../reference/authoring-surface/http.md) calls a URL. The definition fixes the method, the URL, the headers and
the auth. The scheme and the host of the URL are literal text. An Effect secret can be in the path of the URL, in a
header or in the auth, but never in the host. A `request` function makes the part that changes for each run: path
segments, and a JSON or text body. Thus a value from the run can change a path segment or the body, but not where the
call goes.

In the second example, an Agent with `workspace: "none"` writes one comment, and the Machine posts it on a ticket. This
Agent has no [Sandbox](../reference/glossary.md#sandbox). The `jira` Effect secret must be in the
[`secrets`](../reference/config.md#secrets) list of `jr2.config.ts`:

::: tabs key:provider

== Anthropic

<<< @/examples/concepts/effects/anthropic/comment.ts

== Local

<<< @/examples/concepts/effects/local/comment.ts

:::

The body can also be a file of the Worktree: `body: file(path)` (see [`file`](../reference/authoring-surface/file.md)).
The default timeout of an `http` Effect is 30 seconds.

### `push`

[`push`](../reference/authoring-surface/push.md) pushes the Workspace's branch to the
[Binding](../reference/glossary.md#binding) of its Repo Slot. It uses the push credential of the `git.credentials` entry
that the URL matches (see [`git.credentials`](../reference/config.md#git-credentials)). The Agent never reads that
credential. These options change what a push publishes:

- `pin`: push the commit that the input names, such as a commit that a [Gate](../reference/glossary.md#gate) approved.
  Without `pin`, jr2 pushes the tip of the Agent's branch when the Effect starts.
- `sign`: push signed copies of the commits.
- `squash`: push one commit that holds all the changes, with the message that the input gives.
- `force`: replace what the remote branch holds.

With `pin`, the input gives `{ sha }`. With `squash`, it gives `{ message }`.

After a signed or a squashed push, the commits on the remote are not the Agent's own commits. Then jr2 moves the Agent's
branch to the published commits. The Agent's files, index and stash do not change. The default timeout is 5 minutes.

### `dispatch`

[`dispatch`](../reference/authoring-surface/dispatch.md) starts a run of a Workflow. The new run is a run of its own: it
has its own line in [`jr2 runs`](../reference/cli.md#runs), its own Workspaces and its own `CANCEL`. Its record names
the run that started it: it is **dispatched by** that run. Use `dispatch` when a Machine waits for work, for example at
a [Gate](../reference/glossary.md#gate) that a webhook answers, and each item of work needs a run of a Workflow that you
have. To use a Machine as a part of one run, invoke it in the run instead (see [Composition](composition.md)).

- The name of the Workflow is a constant of the definition, as `jr2 run` writes it: `"triage"`, or `"<wrapper>/<name>"`
  for a named [Chart](../reference/glossary.md#chart). An Agent cannot choose it.
- The `input` of the invoke is the run input of the new run: the same JSON that `jr2 run --input` sends. The `input`
  option of the definition is a zod schema of that run input. It types the invoke, and `jr2 up` compares it with the
  input that the Workflow declares.
- By default, the Effect ends when the Orchestrator accepts the new run. With `wait: true`, the Effect ends when the new
  run ends, and its output holds the status and the output of that run. The default timeout is 30 seconds, and 10
  minutes with `wait`.
- With no `target`, the new run starts in the same Orchestrator. With
  `target: { url: "https://<host>", token: secret("<name>") }`, it starts on a different Orchestrator. `url` is the
  origin of that Orchestrator, and the secret holds its Instance token.
- The new run starts under the current [Assembly](../reference/glossary.md#assembly), as a run of `jr2 run` does.

The two runs are independent. A `CANCEL` of one run does not cancel the other. When the run that dispatched ends, the
new run continues.

## Where an Effect runs

You do not choose where an Effect runs. The kind, and what the Effect names, decide it. Each
[Effector](../reference/glossary.md#effector) is a container that runs jr2's own process, and the Agent cannot run
commands in it:

| The Effect                              | Where it runs                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| A `command` that names no Effect secret | The [Harness](../reference/glossary.md#harness) container of the Sandbox            |
| A `command` that names an Effect secret | The [Sandbox Effector](../reference/glossary.md#sandbox-effector), against a commit |
| An `http` Effect                        | The [Instance Effector](../reference/glossary.md#instance-effector)                 |
| An `http` Effect with a Worktree file   | The Sandbox Effector                                                                |
| A `push`                                | The Sandbox Effector                                                                |
| A `dispatch` with no `target`           | The Orchestrator, in its own process                                                |
| A `dispatch` with a `target`            | The Instance Effector                                                               |

A `command` that names no Effect secret runs beside the Agent's [Working tools](../reference/glossary.md#working-tools).
It runs as the Agent's user, with the tools of the [Sandbox Image](../reference/glossary.md#sandbox-image). It has the
same [Stand-ins](../reference/glossary.md#stand-in) as the Agent's shell, and no credential of its own.

A `command` that names an Effect secret in its `env` runs in the Sandbox Effector, a container in which the Agent runs
nothing. It does not run in the live Worktree. It runs against one commit: the tip of the branch when it starts, or with
`pin`, the commit that its input names. When the Worktree held changes that the command did not see, its output has
`dirty: true`.

A `command`, a `push` and an `http` Effect with a file body need a Workspace. Invoke them from the body of a
[`workspace()`](../reference/authoring-surface/workspace.md). [Architecture](architecture.md) tells what each Effector
is, and [Secrets and trust](secrets-and-trust.md) tells how an Effector holds the Effect secrets.

## Every outcome is output

An Effect gives each outcome to `onDone`, a failure too. Route on the `outcome` field:

| Kind       | The outcomes                                              | The output type                                                           |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `command`  | `exited`, `timeout`, `killed`, `unknown`                  | [`CommandOutput`](../reference/authoring-surface/type-commandoutput.md)   |
| `http`     | `response`, `unreachable`, `refused`, `unknown`           | [`HttpOutput`](../reference/authoring-surface/type-httpoutput.md)         |
| `push`     | `pushed`, `rejected`, `diverged`, `unknown`               | [`PushOutput`](../reference/authoring-surface/type-pushoutput.md)         |
| `dispatch` | `started`, `settled`, `refused`, `unreachable`, `unknown` | [`DispatchOutput`](../reference/authoring-surface/type-dispatchoutput.md) |

A test that fails is `exited` with a code that is not 0. A program that the container does not have is `exited` with
code 127. An HTTP 4xx or 5xx status is a `response`. A Workflow that refuses the run input of a `dispatch` is `refused`,
with the status code and the report of the refusal. `unknown` means that jr2 cannot tell what the Effect did.

The `onError` route of an Effect is only for a defect in the Machine or in the config. For example, the Effect is not in
a Workspace, or an `arg()` has no value, or an Open part has no binding. An outcome that means that the work did not
succeed goes to a state that invokes [`fail`](../reference/authoring-surface/fail.md). Then the run ends `failed`, with
a reason (see [How a run ends](machines-and-workflows.md#how-a-run-ends)). Do not throw to fail: a throw is a defect,
and the run ends `error`.

## At most once

jr2 writes a record of each Effect before the Effect starts, and saves it with the run's snapshot. When the Effect ends,
jr2 records its output. After an Orchestrator restart, jr2 reads the record:

- An Effect that ended gives its output. jr2 does not run it again.
- An Effect that did not start, starts.
- An Effect that started follows the rule of its kind.

| Kind                                    | After a restart, when the Effect started                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `command` that names no Effect secret | jr2 attaches to it again. When the Harness does not know it, the outcome is `unknown`. It never runs again.                                                  |
| A `command` that names an Effect secret | jr2 follows it. When the Sandbox Effector lost it, jr2 runs it again against the same commit. With no commit recorded, the outcome is `unknown`.             |
| A `push`                                | jr2 follows it. When the Sandbox Effector lost it, jr2 pushes the same commit again, and no other commit. With no commit recorded, the outcome is `unknown`. |
| An `http` Effect                        | jr2 follows it. When no Effector holds it, jr2 sends it again only if it is `idempotent`. Else the outcome is `unknown`.                                     |
| A `dispatch`                            | jr2 sends the start again, with the same key. The Orchestrator answers with the run that the key started, and it starts no second run.                       |

A `command` that names no Effect secret runs the code of the Worktree, and that code can spend a Stand-in. Thus jr2 does
not run it two times. A `push`, and a `command` that names an Effect secret, run against a commit that jr2 records. Thus
jr2 can send them again with that commit.

To try again, write it in the Machine: a route from the outcome back into the state. Mark an `http` Effect `idempotent`
only when a second call is safe: the call has its own idempotency key, or it only reads.

## When the state exits

When the run leaves the state, the Effect stops:

- jr2 kills the process group of a `command` that names no Effect secret.
- The Sandbox Effector stops a `command` that names an Effect secret. It sends `SIGTERM`, waits 5 seconds, then sends
  `SIGKILL`.
- An `http` Effect and a `push` have no stop. jr2 stops waiting for the output, but the Effector can still finish the
  work.
- A `dispatch` with `wait` stops its wait. The run that it started continues.

jr2 records the stop, and the Machine gets no output. There is no "finally" in a Machine: cleanup is a state. Put an
Effect that must not stop in a state of its own. The only exit of that state is its `onDone`. That state handles the
events of the states above it.

## From a pick to an Effect

An Agent can start an Effect with a pick. The pick moves the run into a state that invokes the Effect. Three names help
you write that state. Each one is optional.

- [`fromPick(def, fill)`](../reference/authoring-surface/frompick.md) is the `input` of the state. The params of the
  pick go into the Effect's input, by name. `fill` gives only the keys that the Machine adds. In `comment.ts`, the Agent
  gives `body`, and the Machine gives `ticket`. Thus the Agent cannot post on a different ticket. TypeScript checks the
  sum against the input type of the Effect.
- [`paramsOf(event, def)`](../reference/authoring-surface/paramsof.md) reads the same params in a plain `input` mapper.
  Use it when the Machine changes a param before the Effect gets it.
- [`answer(fn)`](../reference/authoring-surface/answer.md) sets what the Agent reads when jr2 answers its pick. In
  `test-and-push.ts`, the Agent reads one line, or the end of the test output. Without `answer`, it reads the
  `CommandOutput` of the command, as JSON. [The Menu](the-menu.md) tells more about `answer`.

While the Effect runs below the Agent's state, the Agent's pick is [outstanding](../reference/glossary.md#outstanding).
The state is not at [Rest](../reference/glossary.md#rest) until the Effect ends. [The Menu](the-menu.md) tells how a
pick waits for its answer.

## Rules

- An Effect is a key of `actors`. `createMachine` refuses an Effect that you write directly in an `invoke`.
- A `command`, a `push` and an `http` Effect with a file body run only inside a `workspace()`.
- Under a Workspace with more than one Repo Slot, a `command`, a `push` and a file body name their slot.
- The host of an `http` URL is literal. An Effect secret never goes in the host, the query or the fragment of a URL.
- Each Effect secret that an Effect names is in the `secrets` list of `jr2.config.ts`, with a value of 8 characters or
  more. `jr2 up` refuses a name that is not in the list, and a value that is shorter.
- A `push` with `sign` needs a `sign` field on its `git.credentials` entry. A `squash` without `sign` needs a `sign` or
  a `committer` field there.
- Each param of a pick that enters an Effect's state has a reader: the Effect's input, `fill`, a guard or an `assign`.
  `createMachine` refuses a param that nothing reads, and a `fill` key that is also a param.
- A packaged Machine can leave an `http` URL, a `command` argv, one Effect secret name or the `target` of a `dispatch`
  Open. The composer binds it one time with `customize()`. `jr2 up` refuses an Open part that nobody bound.
- A `dispatch` with no `target` names a Workflow that the Assembly has. `jr2 up` refuses a name that it does not have,
  and an `input` schema that the input of that Workflow does not take.
- The `url` of a `dispatch` target is an origin only: a scheme, a host and a port, with no path, no query and no user.

The guides give the refusal text of each rule.

## Read next

- [Run a command or call a URL with an Effect](../guides/run-a-command-or-call-a-url.md)
- [Push and sign a branch](../guides/push-and-sign-a-branch.md)
- [Start a run from a run](../guides/start-a-run-from-a-run.md)
- [Workspaces](workspaces.md), [The Menu](the-menu.md), [Secrets and trust](secrets-and-trust.md)
- Reference: [`command`](../reference/authoring-surface/command.md), [`http`](../reference/authoring-surface/http.md),
  [`push`](../reference/authoring-surface/push.md), [`dispatch`](../reference/authoring-surface/dispatch.md),
  [`fromPick`](../reference/authoring-surface/frompick.md), [`answer`](../reference/authoring-surface/answer.md)
- [ADR-0067](../reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md):
  an Effect is an actor slot, and runs at most once unless marked idempotent
- [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md): an Effector holds
  an Effect's secrets and signs its wire
- [ADR-0071](../reference/decisions/0071-a-run-starts-a-run-through-a-dispatch-effect.md): a run starts a run through a
  `dispatch` Effect
