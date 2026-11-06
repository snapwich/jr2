---
title: Call an MCP tool from a Machine
description: Call a tool of an MCP server as an Effect, after the approval of a person, and route on its output.
---

Call a tool of an MCP server as an [Effect](../reference/glossary.md#effect), after a person approves the call, and
route the [Machine](../reference/glossary.md#machine) on its output.

An [Agent](../reference/glossary.md#agent) that holds [MCP tools](../reference/glossary.md#mcp-tools) calls them with no
approval, within its allowlist. When a call needs the approval of a person, the Machine makes the call: the Agent picks,
a [Gate](../reference/glossary.md#gate) waits for the approval, and an [`mcp`](../reference/authoring-surface/mcp.md)
Effect calls the tool. The output of the Effect is the answer to the pick. Thus the approval is in the record of the
run, it stays across a restart, and the Machine routes on it.

In this [Workflow](../reference/glossary.md#workflow), the Machine first reads a resource and gets a prompt from the
server. Then a writer finds the channel with `find_channel`, and asks to post the announcement with `post_message`. A
person approves the message, and the Machine posts it. Save the file as `workflows/announce.ts` in your
[Instance](../reference/glossary.md#instance):

::: tabs key:provider

== Anthropic

<<< @/examples/guides/call-an-mcp-tool-from-a-machine/anthropic/announce.ts

== Local

<<< @/examples/guides/call-an-mcp-tool-from-a-machine/local/announce.ts

:::

The writer uses the model of the tab. The `mcp` Effects name the server `slack-acme`. Declare it in the
[`mcp`](../reference/config.md#mcp) block of `jr2.config.ts`, beside the fields and the entries that are there:

<<< @/examples/shared/slack/jr2.config.ts

`https://mcp.slack.example/mcp` is an example. Write the URL of the MCP endpoint of your service, and put the token in
`.env`. [Give an Agent MCP tools](give-an-agent-mcp-tools.md) tells what each field of the block does.
`guide://announcements` and `announcement` are examples too: write a resource and a prompt that your server has.

## Call a tool

`mcp.call(server, tool, options)` calls one tool. `server` is a name of the `mcp` block, and `tool` is the name of the
tool on the server. Put the Effect under `actors` in [`jr2Setup`](../reference/authoring-surface/jr2setup.md), and
invoke it by its key from a state. The options:

- `input`: the zod schema of the input of the Effect. jr2 parses the input with it before the call. The parsed input is
  the arguments of the tool. With no schema, the input of the invoke is the arguments as it is.
- `timeout`: how long jr2 waits for the answer, such as `"30s"`. The default is the `timeout` of the server in
  `jr2.config.ts`, 60 seconds when it sets none. After it, the outcome is `unknown`.
- `maxBody`: how many bytes of `text`, and of `structured` as JSON, the output keeps. The default is 65536.
- `idempotent`: `true` when it is safe to send the call two times, such as a search. The default is `false`. jr2 does
  not read the `idempotentHint` of the tool, because the server is not the author of the Machine.

An `mcp` Effect runs in the [Instance Effector](../reference/glossary.md#instance-effector). The `secret` of the server
is its [Effect secret](../reference/glossary.md#effect-secret): `jr2 up` puts it in the Instance Effector, and the
Effector sends it as `Authorization: Bearer <value>`. The Agent and the Orchestrator never read the value. You can
invoke an `mcp` Effect in a Machine with no [Workspace](../reference/glossary.md#workspace). An `mcp` Effect calls a
remote server only.

## Route on the output

Each outcome is output for `onDone`. Route on `outcome`
([`McpCallOutput`](../reference/authoring-surface/type-mcpcalloutput.md)):

- `returned`, with `isError`, `text`, and `structured` when the result has `structuredContent`. `isError` is `true` when
  the tool ran and says that it failed. `text` joins the text of the result. A part that is not text is one line that
  names its kind. Past `maxBody`, jr2 cuts `text`, drops `structured`, and sets `truncated`.
- `refused`: the call did not run. The server answered an HTTP 3xx or 4xx status, such as 401 for a wrong token. Or it
  refused the request as one that it cannot run, such as an unknown tool or bad arguments.
- `unreachable`: jr2 sent nothing of the call. The server did not answer, or it does not speak MCP, or it speaks a
  revision of MCP that jr2 does not speak.
- `input-required`: the server asked for input, which jr2 does not give. The tool can have started. jr2 does not send
  the call again.
- `unknown`: jr2 sent the call, and no answer came, or the server answered with an error after it got the call. The tool
  can have acted. jr2 does not send it again, unless it is `idempotent`.

Each outcome other than `returned` has a `reason` in words. The union is open: give the rest a last arm with no guard.
jr2 changes each value of an Effect secret in the output to `[secret:<name>]`.

In the example, the writer reads the result of each call as the answer to its pick. After `unknown`, it reads that jr2
cannot tell if the call acted. The Machine does not send the call again by itself: the writer decides if it posts again.

## Approve the call first

The `post_message` pick goes to `approving`, a child state of the writer's state that invokes a Gate. The writer waits
for the answer to its pick while the Gate is open. A person answers the Gate with `approve` or `reject`:

- `approve` goes to `posting`, which invokes the `mcp` Effect. Its output is the answer to the pick.
- `reject` goes back to `ready`, and the writer reads the reason as the answer.

The pick enters `approving`, and `approve` enters `posting`. Thus the input of `post` comes from the context, where the
pick put the channel and the text. [Answer a Gate](answer-a-gate.md) tells how a person answers.

## Give the input from a pick

When a pick enters the state of the Effect, [`fromPick(def)`](../reference/authoring-surface/frompick.md) gives each
param of the pick to the key of the same name. In `searching`, the `query` of `find_channel` goes to the `query` of the
tool's arguments. `fromPick(def, fill)` adds the keys that `fill` gives, so that the Machine sets a key that the Agent
cannot choose. TypeScript checks the keys against the `input` of the Effect. A Gate between the pick and the Effect
gives a different event, so use the context there, as `posting` does.
[Run a command or call a URL with an Effect](run-a-command-or-call-a-url.md#give-the-input-from-a-pick) gives the rules
of `fromPick`.

## Read a resource and get a prompt

- `mcp.read(server, uri, options)` reads one resource. `uri` is the URI of the resource on the server. The output
  ([`McpReadOutput`](../reference/authoring-surface/type-mcpreadoutput.md)) is `returned` with `text`, the text of the
  contents, and `structured`, the list of the contents. A binary part is given only as its type and its size.
- `mcp.prompt(server, name, options)` gets one prompt. `name` is the name of the prompt. The `input` schema is the
  arguments of the prompt, and each field is a string. The output is `returned` with `text`, the text of the messages,
  and `structured`, the list of the messages.

Their other outcomes are those of a call, with no `isError`. `uri` and `name` are always yours. The options are the
options of a call: `input` for a prompt, `timeout`, `maxBody` and `idempotent`. A read and most prompts change nothing,
so the example marks them `idempotent`.

## Bind the server or the tool of a packaged Machine

A Machine from a package can leave the server and the tool of an `mcp` Effect [Open](../reference/glossary.md#open):
`mcp.call(open, open, { input })`. Bind them with `effects`, by the slot of the Effect, on the line that registers the
Machine, such as `customize(machine, { effects: { post: { server: "slack-acme", tool: "post_message" } } })`. Bind only
the part that is Open: `{ server }` or `{ tool }`. The `server` of `mcp.read` and `mcp.prompt` can be Open too.
[Bind a shipped Machine's Open parts](bind-open-parts.md#bind-the-open-parts-of-an-effect) tells more.

## What jr2 check shows

Run [`jr2 check`](../reference/cli.md#check). It reads each Effect without running it, and it shows what the Effect
runs, and where. [`jr2 up`](../reference/cli.md#up) runs the same check before it converges:

```sh
jr2 check
```

```text
jr2 check — instance "my-instance" (no cluster)
typecheck: tsc --noEmit (the instance's own compiler)
effects: workflow "announce" — what it runs outside itself (ADR-0067)
  rules: mcp read slack-acme — the server's timeout, in the Instance Effector, idempotent
  brief: mcp prompt slack-acme — the server's timeout, in the Instance Effector, idempotent
  search: mcp call slack-acme/find_channel — the server's timeout, in the Instance Effector, idempotent
  post: mcp call slack-acme/post_message — the server's timeout, in the Instance Effector
failures: workflow "announce" — the states that fail the run (ADR-0073)
  announce.failed: invokes fail
seats: workflow "announce" — who may send what, per state (ADR-0015)
  announce.writing agent:writer: [find_channel, finished, post_message]
  announce.writing.approving gate: [approve, reject]
agents: writer (carried by 2 workflow machine(s))
check: passed — 2 workflow(s): announce, ping; `jr2 up` stages the Assembly and converges the cluster after the same check
```

`seats` shows that only the Gate takes `approve` and `reject`. Thus the writer cannot approve its own message.

## Rules

When you call `mcp.call()`, `mcp.read()` or `mcp.prompt()`, it refuses:

- a server name that does not have the form of a name of the `mcp` block, or that is `jr2`:
  ``mcp.<op>(server): "<server>" is not a server name — a name of the mcp block of jr2.config.ts, lowercase letters, digits and -, not "jr2"; or `open`, which the composer binds (ADR-0079)``
- an empty tool, URI or prompt name. `<what>` is `tool`, `uri` or `prompt name`:
  `mcp.<op>(): the <what> is a non-empty string`
- `open` for a URI or a prompt name:
  `mcp.<op>(): its <what> is the author's, never Open — only a call's tool is (ADR-0079)`
- a timeout that is not a positive duration: `mcp: timeout "<timeout>" is not a positive duration (like "30s", "2m")`
- a `maxBody` that is not a positive whole number: `mcp({ maxBody }): a positive number of bytes`
- a field of a prompt's `input` that is not a string:
  `mcp.prompt("<name>"): the input field "<key>" is not a string schema, and a prompt's arguments are strings (MCP's prompts/get)`

`jr2 check` and `jr2 up` refuse:

- a server that the `mcp` block does not declare:
  `refusing: workflow "<workflow>": the mcp Effect "<slot>" names the MCP server "<server>", which the mcp block declares "<names>" — declare it in jr2.config.ts: mcp: { "<server>": { url: "https://<host>/mcp", secret: "<SECRET>" } }, or name a declared remote server (ADR-0079)`
- a stdio server:
  `refusing: workflow "<workflow>": the mcp Effect "<slot>" names the stdio MCP server "<server>" — an mcp Effect runs in the Instance Effector, which starts no program, so it calls a remote server only: declare one for it in jr2.config.ts, mcp: { "<server>": { url: "https://<host>/mcp", secret: "<SECRET>" } } (ADR-0079)`
- an Open part that nobody bound. `<parts>` is `server`, `tool`, or `server and tool`:
  `refusing: workflow "<workflow>" leaves the <parts> of Effect "<slot>" open — bind it where the Machine is registered: export const machine = customize(<import>, { effects: { <slot>: { server: "<name>", tool: "<tool>" } } })  (ADR-0054)`.
  The binding holds only the parts that are Open.

`customize()` refuses a binding that has no key, or a key that is not an Open part of the Effect. `<parts>` is the
Effect's Open parts: `customize(): the mcp Effect "<slot>" leaves its <parts> Open — bind it with <binding> (ADR-0054)`.
A binding that leaves out one Open part leaves that part Open, and `jr2 up` refuses it as above.

When an `mcp` Effect starts, it refuses an input that its `input` schema does not accept. The Effect takes its `onError`
route, and each problem is `<path>: <message>`, with `; ` between them:
`mcp "<slot>": its input does not match the definition's input schema — <path>: <message>`. With no schema, it refuses
an input that is not an object: `mcp "<slot>": its input is the request's arguments, an object`. A prompt refuses an
argument that is not a string: `mcp.prompt: the argument "<key>" is <type>, and a prompt's arguments are strings`.

## Read next

- [Effects](../concepts/effects.md): the kinds of Effect, where each runs, and at most once.
- [Give an Agent MCP tools](give-an-agent-mcp-tools.md): the `mcp` block, and the tools that an Agent calls itself.
- [Gates](../concepts/gates.md) and [Answer a Gate](answer-a-gate.md): the approval.
- [The Menu](../concepts/the-menu.md): how a pick waits for its answer.
- Reference: [`mcp`](../reference/authoring-surface/mcp.md),
  [`McpOptions`](../reference/authoring-surface/type-mcpoptions.md),
  [`McpCallOutput`](../reference/authoring-surface/type-mcpcalloutput.md),
  [`McpReadOutput`](../reference/authoring-surface/type-mcpreadoutput.md),
  [`fromPick`](../reference/authoring-surface/frompick.md) and [`answer`](../reference/authoring-surface/answer.md).
- [ADR-0079](../reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md):
  the Machine is the approval.
- [ADR-0067](../reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md):
  an Effect runs at most once unless marked idempotent.
