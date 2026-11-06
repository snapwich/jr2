# An Agent holds MCP tools, a Machine calls them as an Effect, and the Machine is the approval

An Agent of the v1 target user works with services: it reads a Jira ticket, posts to Slack, opens a GitHub issue. Before
this decision an Agent had two kinds of tool, its Working tools and its Menu, and no third
([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)). It could reach a service only
from Workspace code, with `curl` and a Held secret that its `workspace()` grants, or through a Machine's `http` Effect.
The first gives the Agent the whole credential: Workspace code can spend it on every API that the token opens. The
second makes the author write each call of the service again as an Effect. The services ship MCP servers, and each agent
framework that we read speaks MCP. So jr2 takes MCP as the one contract for tools beyond its own.

Each of those frameworks (Claude Code, the OpenAI Agents SDK, LangGraph, Mastra, the Vercel AI SDK) puts an approval in
the harness: a mode or a callback that stops the loop before a tool call and asks a person. jr2 has an approval already.
A Machine's Gate stops the run, keeps it across a restart, names who answered
([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)) and routes on the answer. A
second approval in the Harness would be a state that the Machine cannot see.

## Decision

- **Two ways to use an MCP server, both in v1.** An Agent holds **MCP tools**: its definition names a server, and the
  server's tools join the Agent's tools. The Harness is the MCP client, and the server's credential is a Held secret
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). A Machine calls a server as an
  Effect: the `mcp` Effect runs in the Instance Effector, with an Effect secret and no model
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).
- **The Machine is the approval.** An Agent's MCP tool runs when the model calls it, within its allowlist (below). The
  Harness has no `requireApproval`, no ask mode and no callback. A call that needs approval is the Machine's: the Agent
  makes a pick, a Gate takes the approval, and an `mcp` Effect makes the call. The Effect's output is the pick's answer
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). So the approval is in
  the run's record, it survives a restart, and a Caller with the `answer` scope gives it.
- **MCP is the one extension contract for tools.** jr2 has no tool API of its own. An author's own tool is an MCP
  server: a remote server that the author deploys, or a stdio server in the Sandbox Image. A guide in the docs shows a
  small TypeScript server in the Sandbox Image. An Instance `tools/` folder and a server that the Effector hosts are
  Later.
- **The config declares each server, by the author's name.** The `mcp` block of `jr2.config.ts` maps a name to a server:
  `{ url, secret?, timeout? }` for a remote server (Streamable HTTP), or `{ command, args?, timeout? }` for a stdio
  server. The name is the author's, so one Instance can declare two servers of one service with two secrets
  (`slack-acme`, `slack-partner`). A name matches `[a-z][a-z0-9-]*`. `jr2` is reserved, because the Menu's tools are
  `mcp__jr2__<event>` ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)), and the config
  load refuses it. `secret` names an entry of the top-level `secrets` list. With no `hosts`, that entry is bound to the
  host of the server's `url`, as a model key is bound to its provider's host. The Harness sends it as
  `Authorization: Bearer <Stand-in>`, so `jr2 up` refuses explicit `headers` on that entry that leave out
  `authorization`, explicit `hosts` that leave out the url's host, and explicit `paths` that do not cover the url's
  path. A server with a `secret` needs an `https://` url, as a model endpoint with a bound key does
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)); a server with no secret can use
  `http://`, as a keyless model endpoint can. In v1 a credential is a static bearer token, a Held secret or an Effect
  secret. OAuth grants are the next round. `timeout` is for one call, 60 seconds by default.
- **An Agent names the servers and the tools that it uses.** `AgentDefinition` gains `mcp?: Array<{ server, tools? }>`.
  `server` is a name of the config's `mcp` block, and `tools` is the allowlist. The field is plain data, as the
  definition is ([ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)). Each entry is an
  object, so that `resources` can be added beside `tools` later. A packaged Machine's Agent names the server that it
  needs, and the composer rebinds the list with the existing `customize(machine, { agents: { <slot>: { mcp } } })`
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)). `jr2 up` refuses a server
  name that the config does not declare. It prints the `customize(machine, { agents: { <slot>: { mcp } } })` line that
  binds the slot to a declared server, and the `mcp` block entry that declares a new one. A Menu-only Agent can name a
  remote server only: `jr2 up` refuses a stdio server on a `"none"` Agent (below).
- **The allowlist is offered only where jr2 can keep it.** It guards the server's credential:
  - A remote server needs `tools`: a list of tool names, or `"*"`. The list is a guarantee. The Harness offers only
    those tools and runs only those tools, and no Workspace code can spend the server's secret.
  - A remote server whose secret Workspace code of the Sandbox where the Agent's Turns run can spend takes only `"*"`,
    and `jr2 up` refuses a list. That is the case when the `workspace()` of that Sandbox grants the secret, when a
    credentialed `command` of that Workspace names it, or when an `http` Effect of that Workspace whose body is a
    Worktree file names it ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). Each lets a
    file that the Agent wrote call every tool of the server, so a list would be a hint, and jr2 does not give a hint the
    form of a guarantee. A `"none"` Agent's Turns run on the Instance Harness, where no Workspace code runs, so it keeps
    its list.
  - A stdio server has no `tools` field. The Agent gets every tool of the server. The server's version is fixed in the
    Sandbox Image, and it runs as Workspace code (below), so a list would guard nothing.

  The token's own scopes are the outer limit: the allowlist narrows what the Agent can do with a token, and never widens
  it. One token under two secret names is the author's own act, and jr2 cannot see it.

- **The tool list is fixed for a conversation.** `jr2 up` checks each allowlisted name against the live server, from the
  check pod and through its Custodian, as the provider preflight checks a model
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). It refuses a name that the server does not
  list, and it fails when the server refuses the request (a 401 or a 403: a wrong or expired token), as it fails on a
  model key that the provider refuses. It only warns when the server does not answer. The Harness reads `tools/list` at
  the first Turn of a conversation. It keeps the allowed tools, sorted by name, records them with the conversation, and
  offers the same tools until the conversation ends, across a park and a Harness restart. It never reads the list again
  for a Turn, because a tools block that changes misses the provider's prompt cache
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). It ignores a
  `listChanged` notice. A tool that the server took away fails its call with jr2's text. The tools block is the Working
  tools, then the MCP tools, then the Menu.
- **Names.** An MCP tool is `mcp__<server>__<tool>`, and the name must match `[A-Za-z0-9_-]{1,128}`, Anthropic's bound.
  `jr2 up` refuses an allowlisted tool whose name breaks it. A tool that `"*"` reaches and whose name breaks it is not
  offered, and the Harness writes one log line that names it. A name is in the tools block one time: `jr2 up` refuses an
  allowlist that names a tool twice, and the Harness keeps the first tool of a name that a server lists twice. A server
  name has no `_`, so the prefix is never ambiguous.
- **A server that does not answer at the first Turn fails the Turn.** The Turn fails with a named error,
  `slack-acme did not answer: <reason>`, before the model reads anything. The Machine gets it as `agent.fault`, with
  that text as its `reason` ([ADR-0016](0016-agent-turn-mechanics-are-internal.md),
  [ADR-0074](0074-an-unrouted-mechanism-event-is-refused-at-load-and-faults-the-run.md)). A server that does not answer
  at a later call fails that call with jr2's text, and the model reads it.
- **A stdio server is Workspace code.** The Harness starts it through the spawner, inside the Landlock domain
  ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)), with the domain's env:
  only the Stand-ins that the `workspace()` grants. Its program comes from the Sandbox Image. A stdio server has no
  `secret` of its own: the secrets that it can spend are those that its Workspace grants. The Harness never starts a
  server with pi-mcp's own spawn: that process would be outside the domain, and it would inherit the env of the Harness
  process, every Stand-in and the path to the control Stand-in with it. The Instance Harness has no domain
  ([ADR-0077](0077-jr2-requires-landlock-on-every-sandbox-node.md)), so a Menu-only Agent gets remote servers only.
- **Lifetimes.** A stdio server runs one process for each Agent conversation, from its first Turn to the end of the
  conversation or of the Harness. Two Agents never share a process. When the process stops, the call fails with jr2's
  text, and the next call starts a new process. A remote server has one connection for each Harness, which every
  conversation of that pod uses.
- **What an Agent gets: tools, and the text and images of each result.** The model reads a result's text content and its
  images. The engine replaces an image with a line of text for a model that reads no image, and an image larger than
  about 5 MiB is one line of jr2's text. A result with `structuredContent` and no text gives the model the JSON as text.
  Other content (audio, a resource) is replaced by one line of jr2's text that names its kind. A result with `isError`
  reaches the model as an error. A result longer than 64 KiB is cut, and the model reads
  `[jr2 cut this result at 64 KiB]` at the cut. The text of a failure that holds the server's words, such as a JSON-RPC
  error's message, is cut in the same way. A call past the server's `timeout` is cancelled, and the model reads jr2's
  text. The Harness gives the server no elicitation capability, and a call that asks for input fails with jr2's text.
  Not in v1: elicitation, tool search, sampling, roots, and an Agent's resources and prompts (Later).
- **The `mcp` Effect has the shape of `http`.** `mcp.call(server, tool, { input })`, `mcp.read(server, uri)` and
  `mcp.prompt(server, name, { input })`. `server` and `tool` can each be Open and bind under
  `customize(machine, { effects: { <slot>: { server } | { tool } } })`, one object with both keys when both are Open, as
  `url` and `secret` bind for `http`. The `server` of `mcp.read` and `mcp.prompt` can be Open too; their `uri` and
  `name` are the author's. `fromPick` gives a pick's params to `input`. The server's secret is its Effect secret, placed
  in the Instance Effector. `jr2 up` refuses an `mcp` Effect whose server the config's `mcp` block does not declare, or
  whose server is a stdio server. It prints the `mcp` block entry that declares a remote server, and the
  `customize(machine, { effects: { <slot>: { server } } })` line for an Open server. An Effect's `timeout` replaces the
  server's `timeout` for that Effect. Outputs: `returned { isError, text, structured?, truncated? }` for a call
  (`{ text, structured?, truncated? }` for a read and a prompt), `refused`, `unreachable`, `input-required` and
  `unknown`. A call's `structuredContent` is `structured`, typed `unknown`; a read's `structured` is its `contents`
  list, and a prompt's is its `messages` list. An `output:` schema is Later. The Effector bounds `text` and `structured`
  as it bounds an `http` body, and sets `truncated` when it cuts one. It cuts a JSON-RPC error's message in a reason at
  1 KiB, with a jr2 marker at the cut. The client speaks the revisions `2025-11-25`, `2025-06-18` and `2025-03-26`; a
  server that answers `initialize` with another revision is `unreachable`. When a server closes the event stream of the
  request before its answer, after an event id, the client opens the stream again with a GET and `Last-Event-ID` (within
  the timeout, and at most five times in a row that bring no new event). It does not send the request again. `refused`
  means that the request did not run: an HTTP 3xx or 4xx at any step (a 401 or a 403 included), a refused handshake, or
  one of the JSON-RPC errors `-32700`, `-32600`, `-32601` and `-32602`, or `-32002` (resource not found) for a read,
  which does not act. Another JSON-RPC error, or a 5xx, after the request was sent is `unknown`, because the tool may
  have acted. `input-required` is a server that asked for input: the error `-32042` (URL elicitation required), before
  the tool ran, or an `elicitation/create` request, which the client declared no capability for. That request comes
  while the tool runs, so the tool may have begun. jr2 does not send the request again. It is a named outcome that the
  Machine can route. The client reads an event stream whose lines end with CRLF, LF or a lone CR. It scrubs a server's
  words in a reason before it cuts them, so that no part of a secret stays at the cut. ADR-0067 states each outcome. An
  `mcp` Effect runs at most once unless the author marks it `idempotent` (ADR-0067). The server's `idempotentHint` is
  ignored: the server is not the author. In v1 an `mcp` Effect calls a remote server only, from the Instance Effector. A
  stdio server for an Effect is Later.
- **Two clients, one protocol.** The Harness uses `@earendil-works/pi-mcp` behind a jr2 interface, with a jr2 stdio
  transport over the spawner. The interface does not depend on the engine, so another engine keeps the MCP tools. The
  Effector has a small MCP client of its own in Go, with the standard library only, over Streamable HTTP. Both speak
  protocol `2025-11-25`, the revision that pi-mcp speaks.
- **The printed conversation shows an MCP call as `<server>/<tool>`**, with its input bounded as every call's is
  ([ADR-0023](0023-the-harness-prints-the-conversation.md)). A pick prints by its event's name, as before, so the two
  never print alike. The result of an MCP call does not print, as the result of a Working tool does not.
- **The Briefing says that MCP tools are not picks.** An Agent with MCP tools reads one more line in the standing part
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)).

## Considered options

- **An approval mode in the Harness**, as every other framework has: a `requireApproval` on a tool, and a Turn that
  stops until a person answers. Rejected. The stop would be a state in the Harness that the Machine cannot see, keep or
  route on. A Gate already does each of these, and the Machine already decides which act needs a person. A Turn that
  waits on a person also holds a conversation, a Sandbox and its Size for that time.
- **Servers on the Agent definition** (the shape of 2026-10-27: `mcp: { slack: { url, secret, tools? } }` in `agent()`).
  Rejected. A url and a secret are facts of the Instance, not of the Agent's definition, so a packaged Machine would
  ship them. Two Agents of one server would declare it twice, and an Effect could not name the same server.
- **Read the tool list again on each Turn.** Rejected. A changed tools block misses the provider's prefix cache
  (ADR-0029), and the history then calls tools that the request no longer defines.
- **An allowlist that is only a hint**, offered on every server. Rejected. Where Workspace code holds the Stand-in, or a
  stdio server holds the token, the list stops nothing. A field that reads as a limit and is not one is worse than no
  field.
- **A tool API of jr2's own** (a TypeScript function and a schema, run by the Harness). Rejected. It is a second
  contract beside MCP, its code would run in the Harness process or in the domain with a new seat, and an engine change
  would carry it again. An MCP server is the same function behind a contract that every engine speaks.
- **One secret for each host and header**, which `jr2 up` refused before this decision (ADR-0059's R5). Rejected: two
  servers of one service (two Slack workspaces) send their tokens to one host in one header, and the Menu-only Agents of
  an Instance share one Custodian. The Custodian already chose the value by the Stand-in in the header, so only the
  refusal went.
- **Start a stdio server with pi-mcp's own spawn.** Rejected: the process would be outside the domain, with every
  Stand-in in its env (ADR-0076).
- **Protocol `2026-07-28`.** Not now: pi-mcp speaks `2025-11-25`, and the servers that the target user runs speak it.

## Consequences

- `jr2.config.ts` gains the `mcp` block, and `AgentDefinition` gains `mcp`. The Effect kinds gain `mcp` (ADR-0067).
- A Custodian holds what its pod's Agents name, the Instance Harness's too (ADR-0059): an Agent's MCP server secret is
  held in the pod where its Turns run. The Custodian chooses a secret by the Stand-in that a request carries, so two
  secrets can share one host and one header.
- An Agent's MCP tools reach the model, so the `@model` tier gains the claim `mcp-then-pick` (ADR-0066).
- A stdio server shares the domain with the other Workspace code of its Sandbox. Other Agents' code can trace it and
  write to its stdin. It holds no control credential, but its results are as trusted as the output of `bash`, and no
  more.
- An `elicitation/create` request does not name the call that sent it. When it comes on a connection with one call in
  flight, that call fails with jr2's text. When more calls are in flight, which a remote server's one connection for
  each Harness makes possible, jr2 cannot tell which call asked: no call is marked, and each fails with the server's own
  error.
- A remote server's results come from outside the Instance. They can carry a prompt injection, as a web page can. The
  allowlist bounds what the Agent can do with the server's token; the Machine bounds what the run does.
- Tests: the unit tier checks the config and the allowlist rules, and the Harness's client against an in-memory server.
  The Harness's tests drive a stdio server through the spawner, and check that it holds only the granted Stand-ins. The
  default e2e tier checks the refusals of `jr2 up` and of the publish door. The `@kind` tier checks the live tool list
  from the check pod, an Agent's calls to two servers on one host, each through the Custodian with its own value, and an
  `mcp` Effect from the Instance Effector; the server sees each value and never a Stand-in. The Effector's Go tests
  check the `mcp` kind against a test server. The Custodian suite checks two secrets on one host in one header.
- The OAuth round must look again at client registration: the `2026-07-28` spec deprecates dynamic client registration
  for Client ID Metadata Documents.
