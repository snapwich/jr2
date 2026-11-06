---
title: Give an Agent MCP tools
description: Declare MCP servers in jr2.config.ts, and give an Agent the tools that it can call on each server.
---

Declare the MCP servers of your [Instance](../reference/glossary.md#instance) in `jr2.config.ts`, and give an
[Agent](../reference/glossary.md#agent) the tools that it can call on each server.

An MCP server gives tools for a service, such as a chat, a ticket tracker or a forge. The tools that an Agent gets from
the servers that its definition names are its [MCP tools](../reference/glossary.md#mcp-tools). The model calls them in
its [Turn](../reference/glossary.md#turn), as it calls its [Working tools](../reference/glossary.md#working-tools). A
call of an MCP tool is not a pick: the Turn goes on after it. When a call needs the approval of a person, the
[Machine](../reference/glossary.md#machine) makes it.
[Call an MCP tool from a Machine](call-an-mcp-tool-from-a-machine.md) tells how.

In this [Workflow](../reference/glossary.md#workflow), a Menu-only Agent reads the stand-up channel of two chat
workspaces, Acme and a partner. Then it posts one summary to the Acme workspace, and picks `posted`. Each workspace has
its own server entry and its own token. Save the file as `workflows/standup.ts` in your Instance:

::: tabs key:provider

== Anthropic

<<< @/examples/guides/give-an-agent-mcp-tools/anthropic/standup.ts

== Local

<<< @/examples/guides/give-an-agent-mcp-tools/local/standup.ts

:::

The Agent uses the model of the tab. Add the two servers and their tokens to `jr2.config.ts`, beside the fields and the
entries that are there:

<<< @/examples/shared/slack/jr2.config.ts

`https://mcp.slack.example/mcp` is an example. Write the URL of the MCP endpoint of your service. Then put the two
tokens in `.env`:

```sh
SLACK_ACME_TOKEN=<acme token>
SLACK_PARTNER_TOKEN=<partner token>
```

`<acme token>` and `<partner token>` are the tokens that the service gave you for each workspace. Run
[`jr2 up`](../reference/cli.md#up). Then start a run:

```sh
jr2 run standup --input '{"day":"2026-11-04"}'
```

## Declare the servers

The [`mcp`](../reference/config.md#mcp) block of `jr2.config.ts` gives each server a name of yours. An Agent and an
[Effect](../reference/glossary.md#effect) name a server by this name, and never by its URL or its token. A name has
lowercase letters, digits and `-`, and it starts with a letter. `jr2` is not a server name, because the tools of the
[Menu](../reference/glossary.md#menu) have the names `mcp__jr2__<event>`.

A server is one of two kinds:

- **A remote server**, `{ url, secret?, timeout? }`. The Harness speaks to it over Streamable HTTP. `secret` is the name
  of an entry of the [`secrets`](../reference/config.md#secrets) list: the bearer token of the server. With a `secret`,
  the URL is `https://`. With no `secret`, it can be `http://`.
- **A stdio server**, `{ command, args?, timeout? }`. It is a program of the
  [Sandbox Image](../reference/glossary.md#sandbox-image). See [A stdio server](#a-stdio-server).

`timeout` is the longest time of one call, such as `"90s"` or `"5m"`. The default is 60 seconds. After it, jr2 cancels
the call, and the model reads that the server did not answer. The server can still do the work of the call.

The token of a remote server is a [Held secret](../reference/glossary.md#held-secret). The Harness sends
`Authorization: Bearer <Stand-in>`, and the [Custodian](../reference/glossary.md#custodian) puts the token in place of
the [Stand-in](../reference/glossary.md#stand-in). The model and the
[Workspace code](../reference/glossary.md#workspace-code) never read the token. With no `hosts`, `headers` or `paths` on
the entry of the `secrets` list, jr2 binds the token to the host of the server's URL, in the header `authorization`.
When you set them, they must let the Stand-in through to the URL.

## Name the servers in the Agent

The `mcp` field of the definition is a list. Each entry names one server, and `tools` is the allowlist for a remote
server:

- `tools: ["read_channel", "post_message"]`: the Agent gets these tools of the server, and no other tool.
- `tools: "*"`: the Agent gets each tool of the server.

A stdio server takes no `tools`. The Agent gets each tool of the server.

The model reads each tool as `mcp__<server>__<tool>`, such as `mcp__slack-acme__post_message`. That name has only
letters, digits, `_` and `-`, and at most 128 characters. When `"*"` gives a tool whose name breaks this rule, the
Harness does not give the tool, and it writes one line in its log that names it.

An Agent can name a server only one time. A Menu-only Agent can name remote servers only. Its Turns run on the
[Instance Harness](../reference/glossary.md#instance-harness), where no Workspace code runs.

## When the allowlist is a guarantee

The allowlist guards the token of the server. For a remote server, it is a guarantee: the Harness gives the model only
those tools, and it runs only those tools. The Harness holds the Stand-in of the token in a file that no Workspace code
can read. Thus only a call of the Harness gets the token from the Custodian.

Workspace code in the Agent's [Sandbox](../reference/glossary.md#sandbox) can spend the token in three cases. In each
case, jr2 takes only `tools: "*"`:

- The [`workspace()`](../reference/authoring-surface/workspace.md) of the Sandbox lists the secret under `secrets`.
- A `command` Effect of that Workspace names the secret in its `env`.
- An `http` Effect of that Workspace sends a file of a Worktree with the secret.

In these cases, a file that the Agent wrote can call each tool of the server with the token. Thus a list would not be a
limit, and `jr2 up` refuses it. A Menu-only Agent keeps its list, because its Turns run on the Instance Harness.

The scopes of the token are the outer limit. The allowlist makes what the Agent can do with a token smaller, and it
never makes it larger. Give the server a token with the smallest scopes that the Agent needs. jr2 cannot see one token
under two secret names. When you do that, a list on one name does not limit what the other name can do.

## Two servers of one service

In the example, `slack-acme` and `slack-partner` have the same URL, and each has its own token. Each Agent that names
one of them gets its own tools: `mcp__slack-acme__read_channel` and `mcp__slack-partner__read_channel` are two tools.

The two tokens go to one host in one header. The Custodian chooses the token by the Stand-in that the request carries.
Thus each call goes out with the token of its own server.

## A stdio server

A stdio server is a program in the Sandbox Image. Name its `command` and its `args` in the `mcp` block. The Harness
starts the program for each conversation of an Agent that names it, at the first Turn. The program runs until the
conversation ends, or until the Harness stops. Two Agents never share one process. When the process stops, its call
fails, and the next call starts the program again.

The program is Workspace code. The Harness starts it through the spawner, inside the Landlock confinement of the
Sandbox, in the directory of the Turn. Its env has only the Stand-ins that the `workspace()` grants, so a stdio server
has no `secret` of its own. [Write a tool as an MCP server](write-a-tool-as-an-mcp-server.md) adds a stdio server to the
Sandbox Image.

## The tools of a conversation

`jr2 up` asks each remote server for its tools before it converges, from the check pod and through its Custodian. Each
name in an allowlist must be a tool of the server:

<!-- output: not run -->

```text
…
mcp: listing the tools of "slack-acme" at https://mcp.slack.example/mcp on the Instance Harness, through a Custodian that holds SLACK_ACME_TOKEN, with its Stand-in
mcp: listing the tools of "slack-partner" at https://mcp.slack.example/mcp on the Instance Harness, through a Custodian that holds SLACK_PARTNER_TOKEN, with its Stand-in
provider: the check pod has up to 5 min to start, then up to 6 min for its model and 1 min for each of its 2 MCP servers
…
mcp: "slack-acme" lists <n> tool(s); every allowlisted name is there
mcp: "slack-partner" lists <n> tool(s); every allowlisted name is there
…
```

The check pod has the placement of the pods that run the Agent: here, the Instance Harness. `<n>` is the number of tools
of the server. `jr2 up` stops when a name is not there, and when the server refuses the token. It only warns when the
server does not answer. `--skip-provider-preflight` skips the check of the tools and the check of the models. `jr2 up`
does not check a stdio server.

The Harness reads the tools of each server at the first Turn of a conversation. It keeps the allowed tools, sorted by
name, and it records them with the conversation. Each later Turn of the conversation gets the same tools, also after a
park and after a restart of the Harness. A change in the tools block makes the model provider read the full conversation
again, so the Harness does not read the list again. When the server removes a tool, a call of it fails with the text
`<server> no longer has the tool <tool>`. A new conversation gets the new list.

The tools block has the Working tools first, then the MCP tools, then the Menu. The
[Briefing](../reference/glossary.md#briefing) of an Agent with MCP tools tells the model that a call of an MCP tool is
not a pick and does not end its Turn (see [The Briefing](../concepts/agents-and-turns.md#the-briefing)).

The printed conversation shows a call of an MCP tool as `[<server>/<tool>] <input>`, such as
`[slack-acme/post_message] {"channel":"C024","text":"…"}`. A pick prints by the name of its event, so the two never look
the same. The Harness does not print the result of an MCP tool. [Watch a run](watch-a-run.md) gives each line.

## What the model reads

- The text of the result. A result with `structuredContent` and no text gives the JSON as text.
- The images of the result, such as a screenshot. A model that reads no image gets a line of text in place of each
  image. An image larger than about 5 MiB is one line of jr2:
  `[jr2: the result has an image that is too large or not base64, which the model does not read]`.
- One line of jr2 for each audio or resource in the result:
  `[jr2: the result has <kind>, which the model does not read]`.
- A result with `isError` as an error.
- At most 64 KiB of a result. At the cut, the model reads `[jr2 cut this result at 64 KiB]`.
- When a call passes the `timeout` of its server:
  `<server> did not answer the call of <tool> in <seconds> s, so jr2 cancelled the call. The server can still do the work that the call asked for`
- When the server asks for input during a call:
  `<server> asked for input during the call of <tool>, and no one can answer it: an Agent's MCP call cannot ask for input. The call failed`
- When a stdio server stops during a call: `<server> stopped while it ran <tool>. The next call starts it again`

When a server does not answer at the first Turn of a conversation, the Turn fails before the model reads anything. The
Machine gets [`agent.fault`](../reference/mechanism-events.md#agent-fault), and its `reason` is
`<server> did not answer: <reason>`. In the example, `agent.fault` goes to `failed`, and the run ends `failed` with that
reason. At a later call, the model reads the same text, and the Turn goes on.

A result comes from outside the Instance. It can hold text that tries to give the model orders, as a web page can. The
allowlist limits what the Agent can do with the token. The Machine limits what the run does.

## Bind the servers of a packaged Machine

A Machine from a package names the servers that its Agents need. When your `mcp` block has other names, bind the Agent
to your servers with [`customize()`](../reference/authoring-surface/customize.md), on the line that registers the
Machine. For example, `customize(standup, { agents: { reporter: { mcp: [{ server: "chat-main", tools: "*" }] } } })`
gives the `reporter` each tool of your server `chat-main`.

The list replaces the whole `mcp` list of the Agent. [Bind a shipped Machine's Open parts](bind-open-parts.md) tells how
to bind the parts of a Machine that you get from a package.

## Rules

When the config loads, it refuses:

- the name `jr2`:
  `<file> at mcp.jr2: the server name jr2 is reserved — the Menu's tools are named mcp__jr2__<event>; give the server another name (ADR-0079)`
- a name with other characters:
  `<file> at mcp.<name>: a server name is lowercase letters, digits and -, and starts with a letter ([a-z][a-z0-9-]*) — it is the <server> of the tool names mcp__<server>__<tool> (ADR-0079)`
- a `secret` that the `secrets` list does not have:
  `<file> at mcp.<name>.secret: "<NAME>" is not an entry of secrets — add it: secrets: [{ name: "<NAME>", value: process.env.<NAME> }] (ADR-0079)`
- a `timeout` that is not a positive duration:
  `<file> at mcp.<name>.timeout: a timeout is a positive duration, such as "90s", "5m" or "1h" — an entry is <name>: { url, secret?, timeout? } for a remote server, or <name>: { command, args?, timeout? } for a stdio server (ADR-0079)`
- an entry that is not one of the two kinds, such as one with a `url` and a `command`:
  `<file> at mcp.<name>: Unrecognized key: "<key>" — an entry is <name>: { url, secret?, timeout? } for a remote server, or <name>: { command, args?, timeout? } for a stdio server (ADR-0079)`

`jr2 up` refuses a URL:

- that is not `http://` or `https://`, such as an empty URL from a variable that `.env` does not set:
  `refusing: mcp.<name>.url "<url>" is not an http:// or https:// URL — an unset .env variable reads as empty; set it, such as url: process.env.<NAME>_URL (ADR-0079)`
- with a user name or a password:
  `refusing: mcp.<name>.url carries userinfo — put the credential in secret, never in the url (ADR-0079)`
- with `http://`, for a server with a `secret`:
  `refusing: mcp.<name>.url must be an https:// URL — the server has a secret, <NAME>, and the Custodian carries TLS only (ADR-0059, ADR-0079)`

`jr2 up` refuses a binding of a server's secret that does not let its Stand-in through to the URL. `<i>` is the place of
the entry in the `secrets` list:

- `secrets[<i>].headers leaves out "authorization", where the Harness sends the Stand-in of <NAME> to mcp.<name>.url — each call of that server would arrive with no credential. Add it, or drop headers to take that default (ADR-0059, ADR-0079)`
- `secrets[<i>].hosts leaves out <host>, the host of mcp.<name>.url, whose secret <NAME> is — each call of that server would arrive with the Stand-in and fail with 401. Add it, or drop hosts to take that default (ADR-0059, ADR-0079)`
- `secrets[<i>].paths does not cover <path>, the path of mcp.<name>.url, whose secret <NAME> is — each call of that server would be refused with 403. Add "<path>", or drop paths (ADR-0059, ADR-0079)`

`jr2 up` refuses an Agent's `mcp` list, and prints the line to write. Each refusal starts with
`refusing: workflow "<workflow>": Agent "<slot>"`, then:

- a server that the `mcp` block does not declare:
  `names the MCP server "<server>", which the mcp block declares "<names>" — bind the Agent to a declared server where the Machine is registered: export const machine = customize(<import>, { agents: { <slot>: { mcp: [<entries>] } } }); or declare it in jr2.config.ts: mcp: { "<server>": { url: "https://<host>/mcp", secret: "<SECRET>" } } (ADR-0079)`
- a remote server with no `tools`:
  `names the remote MCP server "<server>" with no tools — a remote server needs its allowlist: { server: "<server>", tools: ["<tool>"] }, or tools: "*" for every tool (ADR-0079)`
- an empty list:
  `gives MCP server "<server>" an empty tools list, which offers no tool — name the tools, or drop the entry (ADR-0079)`
- a list for a stdio server:
  `gives a tools list for the stdio MCP server "<server>" — a stdio server takes none: the Agent gets every tool, because the server runs as Workspace code, and a list would guard nothing. Write { server: "<server>" } (ADR-0079)`
- a stdio server on a Menu-only Agent:
  `has workspace: "none" and names the stdio MCP server "<server>" — a stdio server runs as Workspace code, inside a Sandbox's confinement, and a "none" Agent's Turns run on the Instance Harness, which has none: name a remote server, or give the Agent a Workspace (ADR-0079, ADR-0031)`
- a tool whose name breaks the rule:
  `lists the tool "<tool>" of MCP server "<server>": the model would read it as "mcp__<server>__<tool>", and a tool name is [A-Za-z0-9_-], at most 128 characters — a model provider refuses any other (ADR-0079)`
- a tool that the list names two times:
  `lists the tool "<tool>" of MCP server "<server>" twice — a model provider refuses a tools block that has one name two times: list each tool once (ADR-0079)`
- a server that the list names two times: `names the MCP server "<server>" twice — one entry for each server (ADR-0079)`
- a list where Workspace code in the Sandbox can spend the secret. `<how>` is one of
  `its workspace() lists it under secrets`, `the command Effect "<effect>" names it` and
  `the http Effect "<effect>" sends a Worktree file with it`:
  `gives a tools list for MCP server "<server>", and Workspace code in its Sandbox can spend that server's secret, <NAME>: <how>. A list would be a hint, not a limit — write { server: "<server>", tools: "*" }, or keep <NAME> out of that Workspace (ADR-0079, ADR-0028)`

For a child Machine, `(on the Machine composed as "<slot>")` comes after the Agent's slot. The publish door of the
Orchestrator runs the same check of the lists. Thus a publish that did not go through `jr2 up` is refused too, and the
Orchestrator keeps the Assembly that it has.

`jr2 up` checks the tools of each remote server from the check pod. It stops with an error for:

- a name in an allowlist that the server does not list:
  `error: mcp: workflow "<workflow>": Agent "<slot>" allowlists the tool "<tool>", which "<server>" does not list — it lists: <tools> (ADR-0079)`
- a server that refuses the request with 401 or 403:
  `error: mcp: "<server>" at <url> refused the request from a pod on <where> (HTTP <status>) — a wrong or expired value of <NAME>, or a binding of it (hosts, headers, paths) that does not let its Stand-in through to the url; every call of an Agent that names it would fail (ADR-0079)`

It warns about a server that does not answer:
`warning: mcp: "<server>" at <url> did not answer from a pod on <where> (<reason>) — its tool names are not checked; a Turn of an Agent that names it fails if it does not answer then (ADR-0079)`.
With `--skip-provider-preflight`, it warns:
`warning: provider: preflight skipped (--skip-provider-preflight) — these models were not checked: <models>; these MCP servers' tool lists were not checked: <servers>`.

## Read next

- [Agents and Turns](../concepts/agents-and-turns.md#the-mcp-tools): the MCP tools beside the Working tools and the
  Menu.
- [Secrets and trust](../concepts/secrets-and-trust.md): who holds the token of a server.
- [Call an MCP tool from a Machine](call-an-mcp-tool-from-a-machine.md): a call that a person approves first.
- [Write a tool as an MCP server](write-a-tool-as-an-mcp-server.md): your own tool, in the Sandbox Image.
- Reference: [`mcp`](../reference/config.md#mcp),
  [`AgentMcpServer`](../reference/authoring-surface/type-agentmcpserver.md) and
  [`AgentDefinition`](../reference/authoring-surface/type-agentdefinition.md).
- [ADR-0079](../reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md):
  an Agent holds MCP tools, a Machine calls them as an Effect, and the Machine is the approval.
- [ADR-0028](../reference/decisions/0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md): the
  allowlist is a guarantee about the credential.
- [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md): the Custodian
  holds the keys.
