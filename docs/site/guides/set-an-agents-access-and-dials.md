---
title: Set an Agent's access and Dials
description: Choose what an Agent can do to the Workspace, and set the Dials and continue of one Turn.
---

Set what an [Agent](../reference/glossary.md#agent) can do to the [Workspace](../reference/glossary.md#workspace), and
set the [Dials](../reference/glossary.md#dials) and `continue` of one [Turn](../reference/glossary.md#turn).

The definition of the Agent sets its access, in the `workspace` field of
[`agent()`](../reference/authoring-surface/agent.md). The state that invokes the Agent sets the Dials and `continue`, in
the `input` of the invoke. In this [Workflow](../reference/glossary.md#workflow), a reviewer reads one commit and asks
for changes. A coder makes the changes on the branch. Then a Menu-only checker decides if the changes are complete. Save
the file as `workflows/review.ts` in your [Instance](../reference/glossary.md#instance):

::: tabs key:provider

== Anthropic

<<< @/examples/guides/set-an-agents-access-and-dials/anthropic/review.ts

== Local

<<< @/examples/guides/set-an-agents-access-and-dials/local/review.ts

:::

Write your GitHub user name in place of `<you>`. Each Agent uses the model of the tab.

## Set the access

The `workspace` field selects the [Working tools](../reference/glossary.md#working-tools) of the Agent. It also selects
where its Turns run. The default is `"write"`.

| `workspace`         | The Working tools                            | Where the Turn runs                                                                |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `"write"` (default) | read, write, edit, bash, grep and find       | The [Sandbox](../reference/glossary.md#sandbox) of the Workspace                   |
| `"read"`            | read, bash, grep and find: no write, no edit | The Sandbox of the Workspace                                                       |
| `"none"`            | none                                         | The [Instance Harness](../reference/glossary.md#instance-harness), with no Sandbox |

An Agent with `"write"` or `"read"` works in a Sandbox. Thus invoke it in the body of a
[`workspace()`](../reference/authoring-surface/workspace.md). An Agent with `"none"` is a Menu-only Agent. It reads its
prompt and picks from its [Menu](../reference/glossary.md#menu). You can invoke it in the body of a `workspace()`, as
the example does, or in a [Machine](../reference/glossary.md#machine) with no Workspace.

A `"read"` Agent keeps bash, so a command can still change a file or the branch. To keep a reviewer away from the
branch, give its Turn a detached [Worktree](../reference/glossary.md#worktree):

1. Cut the Worktree with [`worktree()`](../reference/authoring-surface/worktree.md), with `{ path, detach }`.
2. In the Turn, set `cwd` to that path.

The Worktree holds the commit, with no branch. In the example, the path is `/work/app/review`, and the commit comes from
the run input. [Cut a Worktree](cut-a-worktree.md) tells more.

The Sandbox is the security boundary. The Agents of one Workspace share `/work`, and in it each Agent can change all the
files. jr2 keeps their identities apart: an Agent cannot make a pick for a different Agent. The access and the review
Worktree keep an Agent that follows its instructions on its path. They do not stop an Agent that sets out to change the
work of a different Agent. For a review that sees only the commit, give the final review its own Sandbox: a state of the
coder's body invokes a nested `workspace()`, which takes the commit as a [Handoff](../reference/glossary.md#handoff).
Each round of that review costs a new Sandbox, a clone and an install of the dependencies.

The access is a part of the identity of the Agent. Only the definition sets it. A Turn cannot change it.

## Set the Dials of a Turn

The Dials are `model` and `thinkingLevel`. Write them in the `input` of the invoke, beside the
[Frame](../reference/glossary.md#frame) (`prompt` and `cwd`). A Dial changes only that Turn. When the Turn sets no Dial,
it uses the value of the definition.

- `thinkingLevel` is one of `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"` and `"xhigh"`. In the example, the
  definition of `checker` sets `"low"`, and the `reviewing` state sets `"high"` for the reviewer's Turn. A definition
  with no `thinkingLevel` uses `"off"`. A model can lack a level. Then the [Harness](../reference/glossary.md#harness)
  runs the Turn at a different level, and the printed conversation names it in a `[thinking level]` line. See
  [Watch a run](watch-a-run.md).
- `model` is `<provider>/<model id>`, as in the definition. In the example, the `fixing` state gives the coder the
  `model` of the run input. When the run input has no `model`, the value is `undefined`, and the Turn uses the model of
  the definition.

Run [`jr2 up`](../reference/cli.md#up) to converge the new Workflow:

```sh
jr2 up
```

The `effects:` lines show the cut. The `seats:` lines show the picks of the three Agents.

To give a model to the coder's Turns, add `model` to the run input:

```sh
jr2 run review --input '{"branch":"<branch>","sha":"<commit>","model":"<provider>/<model id>"}' --detach
```

```text
→ context kind-jr2 / namespace my-instance
{"runId":"48401e39-f8b2-4246-a24e-6ee2665ee892"}
```

The first line gives your kubectl context and the namespace of the Instance. `runId` is the id of the new run. Your run
id is different.

Write a new branch name for the coder in place of `<branch>`. The branch starts from the default branch of the
[Repo](../reference/glossary.md#repo). Thus write the full id of a commit on the default branch in place of `<commit>`,
such as its tip. [Start a run](start-a-run.md) tells how to follow the run.

[`jr2 up`](../reference/cli.md#up) reads the models of the definitions. It cannot read a model that a Turn sets as a
Dial. Thus:

- The Harness checks a Dial model only when it admits the Turn. A model that it cannot find gives
  [`agent.fault`](../reference/mechanism-events.md#agent-fault).
- `jr2 up` gives each pod the model key of the providers that the definitions of its Agents name. For an Agent in a
  Sandbox, use a Dial model of a provider that a definition in that Sandbox names. For a Menu-only Agent, use a provider
  that a Menu-only definition of the Instance names.
- In the same way, `jr2 up` gives each pod the secret of each MCP server that the definitions of its Agents name. The
  [MCP tools](../reference/glossary.md#mcp-tools) of an Agent come from its definition only. A Turn cannot change them.

## Continue a conversation

Without `continue`, each Turn starts a new conversation. With `continue: true`, the Turn continues the conversation of
this Agent in this Machine instance. In the example, the first `fixing` Turn starts the coder's conversation. When the
checker picks `request_changes`, the run goes back to `fixing`, and the coder continues with what it did before.

Set `continue: true` on each Turn that must join the conversation. A Turn without it starts a new conversation and does
not join.

After `agent.fault` on a Turn with `continue: true`, the next Turn with `continue: true` starts a new conversation. A
Harness restart that cut only the Turn is the exception: the conversation stays. Thus write a prompt that gives the full
task, also on a Turn that continues. In the example, each `fixing` prompt gives the notes of the review.

## Rules

- jr2 refuses a Turn whose `input` has a key that a Turn does not have, such as `instructions` or `workspace`. Only the
  definition sets those two. `<keys>` is each key that is not correct, in backticks, with a comma between them:
  ``agent "<slot>": the Turn's input carries <keys>, which a Turn has no use for — its input is its Frame (`prompt`, `cwd`), its Dials (`model`, `thinkingLevel`), and `continue` (ADR-0057)``
- Under a Workspace with [Repo Slots](../reference/glossary.md#repo-slot), jr2 refuses a Turn of an Agent with Working
  tools that sets no `cwd`:
  ``turn <id>: agent "<slot>" works under a Workspace with Repo Slots (<slots>) and its Turn framed no `cwd`: say where it works, a Worktree, or `cwd: "/work"` above them (ADR-0057)``
- `workspace()` refuses a body with an invoke that does not say where it works, when it can read the input:
  ``workspace(): state "<state>": "<slot>" names no `<key>`, and a Workspace with Repo Slots says where each Turn and Effect works: a Worktree, or `cwd: "/work"` for a Turn (ADR-0057)``
- The Harness refuses a `cwd` that is not an absolute path. The run gets `agent.fault`, with this reason:
  ``harness admission failed (400): agent "<slot>": the Turn's Frame carries a `cwd` that is not an absolute path — the Frame says WHERE this Turn works (ADR-0057), and a Turn rooted anywhere else would work in the wrong directory silently``
- The Harness refuses a model that is not in its catalog and not a model of the custom provider. The run gets
  `agent.fault`, with this reason:
  `harness admission failed (400): agent "<slot>": model "<provider>/<model id>" resolves to nothing — not in pi's catalog, and no custom provider "<provider>" is configured (ADR-0018)`
- The Harness refuses a model that is not in the form `<provider>/<modelId>`. The run gets `agent.fault`, with this
  reason:
  `harness admission failed (400): agent "<slot>": model "<model>" is not a <provider>/<modelId> specifier (ADR-0018)`
- jr2 refuses a Turn of a `"write"` or `"read"` Agent outside a `workspace()`:
  ``turn <id>: agent "<slot>" has workspace: "<access>" — invoke it inside a workspace() (ambient resolution), or pass an explicit `endpoint` (workspace-less stub path)``
- `model` is required in each definition. A Machine from a package can leave it [Open](../reference/glossary.md#open).
  `jr2 up` refuses an Open model that nobody bound:
  `refusing: workflow "<workflow>" leaves Agent "<slot>" open — bind it where the Machine is registered: export const machine = customize(<import>, { agents: { <slot>: { model: "<provider>/<model>" } } })  (ADR-0054)`
- When a Turn starts with an Open model, jr2 refuses it:
  ``agent "<slot>" has an Open model — nobody bound it; bind it where the Machine is registered (`customize(<machine>, { agents: { <slot>: { model: "<provider>/<model>" } } })`), because a packaged Machine cannot pick a model on your behalf (ADR-0054)``

## Read next

- [Agents and Turns](../concepts/agents-and-turns.md): the definition, the Frame, the Dials and `continue`.
- [Workspaces](../concepts/workspaces.md): the Worktrees.
- [Cut a Worktree](cut-a-worktree.md): a detached Worktree for a reviewer.
- [The Menu](../concepts/the-menu.md): the picks of an Agent.
- [Bind a shipped Machine's Open parts](bind-open-parts.md): bind an Open model.
- Reference: [`agent`](../reference/authoring-surface/agent.md),
  [`AgentDefinition`](../reference/authoring-surface/type-agentdefinition.md),
  [`ThinkingLevel`](../reference/authoring-surface/type-thinkinglevel.md),
  [`WorkspaceAccess`](../reference/authoring-surface/type-workspaceaccess.md) and
  [`agent.fault`](../reference/mechanism-events.md#agent-fault).
- [ADR-0028](../reference/decisions/0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md): what an
  Agent can do to the Workspace is a part of its definition.
- [ADR-0057](../reference/decisions/0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md): a Turn is its
  Frame, its Dials, and `continue`.
- [ADR-0018](../reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md): an Agent is a
  definition.
