---
title: Write a tool as an MCP server
description: Write a small MCP server in TypeScript, put it in the Sandbox Image, and give its tool to an Agent.
---

Write a tool for your [Agents](../reference/glossary.md#agent) as a small MCP server in TypeScript, put it in the
[Sandbox Image](../reference/glossary.md#sandbox-image), and give it to an Agent as a stdio server.

jr2 has no tool API of its own. A tool that you write is an MCP server: a remote server that you run yourself, or a
stdio server, which is a program in the Sandbox Image. An Agent in a [Sandbox](../reference/glossary.md#sandbox) gets
each tool of a stdio server as one of its [MCP tools](../reference/glossary.md#mcp-tools).

The server on this page has one tool, `next_version`. It gives the next version number after a release. It uses only the
modules of Node, so it needs no package. Save it as `images/default/semver-mcp.ts` in your
[Instance](../reference/glossary.md#instance), beside the `Dockerfile` that `jr2 init` wrote:

<<< @/examples/guides/write-a-tool-as-an-mcp-server/images/default/semver-mcp.ts

## What the server does

A stdio server reads one JSON-RPC message on each line of its stdin. It writes each answer as one line on its stdout. It
answers these methods:

- `initialize`: the revision of MCP that it speaks, `2025-11-25`, and `capabilities: { tools: {} }`.
- `tools/list`: its tools. Each tool has a `name`, a `description` and an `inputSchema`, which is JSON Schema. The model
  reads the description and the schema.
- `tools/call`: the result of one call, as `content`. A tool that fails gives a result with `isError: true` and the
  reason as text. The model reads the reason.

A message with no `id` is a notification, such as `notifications/initialized`, and gets no answer. A method that the
server does not have gets the JSON-RPC error `-32601`. Write only messages on stdout: the Harness reads each line as a
message, and drops a line that is not one. The Harness does not read stderr.

## Try the server on your computer

Send it the messages that the Harness sends, with Node 24 or later:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"next_version","arguments":{"version":"1.4.2","change":"minor"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"next_version","arguments":{"version":"x","change":"minor"}}}' \
  | node images/default/semver-mcp.ts
```

```text
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"semver","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"next_version","description":"The next version number after a release. Give the current version and the kind of change.","inputSchema":{"type":"object","properties":{"version":{"type":"string","description":"The current version, such as 1.4.2."},"change":{"type":"string","enum":["major","minor","patch"]}},"required":["version","change"]}}]}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"1.5.0"}]}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"x is not a version such as 1.4.2"}],"isError":true}}
```

The notification gets no line. The last call is the tool's own error.

## Put the server in the Sandbox Image

Copy the file into the image. The folder of the `Dockerfile` is the context of the build, so `COPY` finds the file
there:

<<< @/examples/guides/write-a-tool-as-an-mcp-server/images/default/Dockerfile{dockerfile}

The example does not show the comments at the start of the file. Keep them in your file. Node 24 runs a `.ts` file that
has only types that it can remove, so the image needs no build step. For an MCP server from a package, install the
package at a fixed version in the `Dockerfile` instead, such as `RUN npm install -g <package>@<version>`.

[`jr2 up`](../reference/cli.md#up) builds the image, because a file in its folder changed.
[Add tools to the Sandbox](add-tools-to-the-sandbox.md) tells how `jr2 up` builds and loads it.

## Declare the server and give it to an Agent

Declare the server in the [`mcp`](../reference/config.md#mcp) block of `jr2.config.ts`, beside the fields that are
there. `command` and `args` are the program and its arguments in the image:

<<< @/examples/guides/write-a-tool-as-an-mcp-server/jr2.config.ts

Then name the server in the `mcp` list of an Agent that works in a Sandbox. In this
[Workflow](../reference/glossary.md#workflow), a releaser reads the changes of a release, asks `next_version` for the
next version, and picks `decided`. Save the file as `workflows/next-version.ts`:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/write-a-tool-as-an-mcp-server/anthropic/next-version.ts

== Local

<<< @/examples/guides/write-a-tool-as-an-mcp-server/local/next-version.ts

:::

The releaser uses the model of the tab. The model reads the tool as `mcp__semver__next_version`. A stdio server takes no
`tools` list: the Agent gets each tool of the server. Run `jr2 up`, then start a run:

```sh
jr2 run next-version --input '{"version":"1.4.2","changes":"Add the --json flag.\nFix the help text."}'
```

## What the server can reach

A stdio server is [Workspace code](../reference/glossary.md#workspace-code), as the Agent's shell is:

- The Harness starts it through the spawner, inside the Landlock confinement of the Sandbox, in the directory of the
  [Turn](../reference/glossary.md#turn). It cannot read `/run/jr2`, and it cannot read the control Stand-in of the
  Harness.
- Its env is the env of the confined programs. It holds only the [Stand-ins](../reference/glossary.md#stand-in) of the
  [Held secrets](../reference/glossary.md#held-secret) that the
  [`workspace()`](../reference/authoring-surface/workspace.md) lists under `secrets`. A server that calls an API sends
  the Stand-in, and the [Custodian](../reference/glossary.md#custodian) puts the value in its place.
- It runs as one process for each conversation of the Agent, from the first Turn to the end of the conversation. When it
  stops, its call fails, and the next call starts it again.

The Agent's other programs run in the same confinement. They can trace the server and write to its stdin. Thus trust the
result of the server as much as the output of a command that the Agent runs, and no more.
[Secrets and trust](../concepts/secrets-and-trust.md#confined-programs) tells what the confinement stops.

A Menu-only Agent cannot use a stdio server: its Turns run on the
[Instance Harness](../reference/glossary.md#instance-harness), where no Workspace code runs. An `mcp` Effect cannot use
one either. To use a tool from those, run it as a remote server, and declare its `url`.

## Rules

- At the first Turn of a conversation, the server must answer `initialize` and `tools/list`. When it fails, the Turn
  fails before the model reads anything, and the Machine gets
  [`agent.fault`](../reference/mechanism-events.md#agent-fault) with the reason `<server> did not answer: <reason>`.
- A line on stdout that is longer than 16 MiB stops the server.
- `jr2 up` refuses a `tools` list on a stdio server:
  `refusing: workflow "<workflow>": Agent "<slot>" gives a tools list for the stdio MCP server "<server>" — a stdio server takes none: the Agent gets every tool, because the server runs as Workspace code, and a list would guard nothing. Write { server: "<server>" } (ADR-0079)`
- `jr2 up` refuses a stdio server on a Menu-only Agent:
  `refusing: workflow "<workflow>": Agent "<slot>" has workspace: "none" and names the stdio MCP server "<server>" — a stdio server runs as Workspace code, inside a Sandbox's confinement, and a "none" Agent's Turns run on the Instance Harness, which has none: name a remote server, or give the Agent a Workspace (ADR-0079, ADR-0031)`
- `jr2 up` does not check the tools of a stdio server, because the program runs only in a Sandbox.
- A tool whose name, as `mcp__<server>__<tool>`, has a character other than letters, digits, `_` and `-`, or more than
  128 characters, is not given to the model. The Harness writes one line in its log:
  `the MCP server <server> lists the tool "<tool>", and "mcp__<server>__<tool>" does not match ^[A-Za-z0-9_-]{1,128}$: the tool is not offered (ADR-0079)`

[Give an Agent MCP tools](give-an-agent-mcp-tools.md#rules) gives the refusals of the `mcp` block.

## Read next

- [Agents and Turns](../concepts/agents-and-turns.md#the-mcp-tools): the MCP tools of an Agent.
- [Workspaces](../concepts/workspaces.md): the Sandbox Image.
- [Give an Agent MCP tools](give-an-agent-mcp-tools.md): remote servers, and the allowlist.
- Reference: [`mcp`](../reference/config.md#mcp) and
  [`AgentMcpServer`](../reference/authoring-surface/type-agentmcpserver.md).
- [ADR-0079](../reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md):
  MCP is the one contract for tools, and a stdio server is Workspace code.
- [ADR-0076](../reference/decisions/0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md): the
  confinement of Workspace code.
