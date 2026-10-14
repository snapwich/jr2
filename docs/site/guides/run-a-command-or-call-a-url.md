---
title: Run a command or call a URL with an Effect
description: Run a program or call a URL as an Effect, give it input from a pick, and route on its output.
---

Run a program in the [Workspace](../reference/glossary.md#workspace), or call a URL, as an
[Effect](../reference/glossary.md#effect), and route the [Machine](../reference/glossary.md#machine) on its output.

Put the Effect under `actors` in [`jr2Setup`](../reference/authoring-surface.md#jr2setup), beside the
[Agents](../reference/glossary.md#agent). Then invoke it by its key from a state, and route on its output in `onDone`.
In this [Workflow](../reference/glossary.md#workflow), a coder fixes the tests. It picks `run_test` to run one test file
with a [`command`](../reference/authoring-surface.md#command) Effect. When it picks `finished`, an
[`http`](../reference/authoring-surface.md#http) Effect posts its summary to a URL. Save the file as
`workflows/fix-and-report.ts` in your [Instance](../reference/glossary.md#instance):

::: tabs key:provider

== Anthropic

<<< @/examples/guides/run-a-command-or-call-a-url/anthropic/fix-and-report.ts

== Local

<<< @/examples/guides/run-a-command-or-call-a-url/local/fix-and-report.ts

:::

Write your GitHub user name in place of `<you>`. The Agent uses the model of the tab. `https://hooks.example.com/jr2` is
an example. Write the URL of your own service.

The `http` Effect names the [Effect secret](../reference/glossary.md#effect-secret) `hook-token`. Add it to the
[`secrets`](../reference/config.md#secrets) list of `jr2.config.ts`, beside the entries that are there:

<<< @/examples/guides/run-a-command-or-call-a-url/jr2.config.ts

The file shows only the `secrets` field. Keep the other fields and entries of your `jr2.config.ts`.

Then put the value in `.env`:

```sh
HOOK_TOKEN=<token>
```

`<token>` is the token of your service. It has 8 characters or more.

## Run a command

`command(argv, options)` runs one program. `argv` is a list, and each entry is one argument. jr2 starts `argv[0]` with
no shell. An [`arg("name")`](../reference/authoring-surface.md#arg) entry is one argument that the input of the Effect
fills, whatever its characters. To use a shell, write it in the argv: `["sh", "-c", "<script>"]`.

The options:

- `timeout`: how long the program can run, such as `"90s"`, `"10m"` or `"1h"`. The default is `"10m"`. After it, jr2
  kills the process group, and the outcome is `timeout`.
- `tail`: how many characters of the end of the output the Machine gets. The default is 4096.
- `slot`: the [Repo Slot](../reference/glossary.md#repo-slot) whose [Worktree](../reference/glossary.md#worktree) the
  program runs in. Write it only when the Workspace has more than one Repo Slot.

The program starts in the root of the Worktree. To run it in a subfolder, give the path as an argument, such as
`["node", "--test", "<dir>/test/*.test.js"]`, or write `["sh", "-c", "cd <dir> && <program>"]`.

A `command` with no Effect secret runs in the [Harness](../reference/glossary.md#harness) container of the
[Sandbox](../reference/glossary.md#sandbox), in the Worktree, beside the
[Working tools](../reference/glossary.md#working-tools) of the Agent. It uses the tools of the
[Sandbox Image](../reference/glossary.md#sandbox-image). Thus invoke it in the body of a
[`workspace()`](../reference/authoring-surface.md#workspace).

Each outcome is output for `onDone`, also a failure. Route on `outcome`
([`CommandOutput`](../reference/authoring-surface.md#type-commandoutput)):

- `exited`, with `code` and `tail`. A test that fails is `exited` with a `code` that is not 0. A program that the
  container does not have is `exited` with code 127.
- `timeout`, with `tail`.
- `killed`, with `signal` and `tail`.
- `unknown`, with `reason`: jr2 cannot tell what the program did. jr2 does not run it again.

## Use an Effect secret in a command

A program that needs a credential gets it from the `env` option. Each value is an Effect secret, for example
`env: { NODE_AUTH_TOKEN: secret("npm-token") }`. [`secret("<name>")`](../reference/authoring-surface.md#secret) gives
the value. `secret("<name>").path` gives the path of a file that holds the value. The name is an entry of the `secrets`
list of `jr2.config.ts`, as for `hook-token`.

A `command` with an Effect secret in `env` does not run beside the Agent. It runs in the
[Sandbox Effector](../reference/glossary.md#sandbox-effector), a container that the Agent cannot reach. It runs against
one commit of the branch, not against the live Worktree:

- By default, the commit is the tip of the branch when the Effect starts. When the Worktree holds changes that the
  program did not see, its output has `dirty: true`.
- With `pin: true`, the commit is the `sha` of the input of the Effect: `{ sha: "<full commit id>" }`. Use it for a
  commit that a [Gate](../reference/glossary.md#gate) approved.

The Sandbox Effector runs in the Sandbox Image, or in the image of the `effector` option of `workspace()`. Thus that
image must hold the program.

## Call a URL

`http(definition)` makes one call to a URL. The definition fixes all of the call except what `request` makes:

- `method`: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`.
- `url`: `http://` or `https://`, then a literal host. An Effect secret can be only in the path, in a
  [`text`](../reference/authoring-surface.md#text) template:
  `` text`https://api.example.com/bot${secret("<name>")}/send` ``.
- `auth`: the `Authorization` header. Use [`bearer(secret("<name>"))`](../reference/authoring-surface.md#bearer),
  [`basic(user, password)`](../reference/authoring-surface.md#basic), or a `text` that is the full value.
- `headers`: the headers that are the same for each run. Each name is in lower case. A value is a string, a
  `secret("<name>")` or a `text`.
- `input`: the zod schema of the input of the Effect. jr2 parses the input with it before the call.
- `request`: a function of the input. It gives the `path` segments that jr2 adds to the URL, and a `json` or a `text`
  body. It cannot change the host, a header or an Effect secret.
- `timeout`: how long jr2 waits for the answer. The default is `"30s"`. After it, the outcome is `unknown`.
- `maxBody`: how many bytes of a text body the output keeps. The default is 65536.
- `idempotent`: `true` when a second call is safe. The default is `false`. See [Effects](../concepts/effects.md).

To send a file of the Worktree as the body, use [`file(path)`](../reference/authoring-surface.md#file) as `body`. jr2
sends a file body only with `PUT`, `POST` or `PATCH`.

An `http` Effect runs in the [Instance Effector](../reference/glossary.md#instance-effector). The
[Effector](../reference/glossary.md#effector) puts the value of each Effect secret into the call. The Agent never reads
the value. You can invoke an `http` Effect in a Machine with no Workspace. An `http` Effect with a file body runs in the
Sandbox Effector, so invoke it in the body of a `workspace()`.

Each outcome is output for `onDone`. Route on `outcome`
([`HttpOutput`](../reference/authoring-surface.md#type-httpoutput)):

- `response`, with `status`, `headers`, `contentType`, `size` and, for a text body, `body`. A 4xx or 5xx status is a
  `response` too. The example goes to `done` only for a status below 300.
- `unreachable`: the call did not go out.
- `refused`: jr2 or the Effector refused the call, and sent nothing.
- `unknown`: the call can have gone out, but no answer came.

## Give the input from a pick

The input of an Effect is the `input` of the invoke. When a pick of the Agent enters the state, the input can come from
the params of the pick:

- [`fromPick(def)`](../reference/authoring-surface.md#frompick) gives each param of the pick to the key of the same
  name. In the `testing` state, the `file` of `run_test` goes to `arg("file")`.
- `fromPick(def, fill)` adds the keys that `fill` gives. In the `reporting` state, the Agent gives `summary`, and the
  Machine gives `branch`. Thus the Agent cannot choose the branch in the report.
- [`paramsOf(event, def)`](../reference/authoring-surface.md#paramsof) reads the params in a plain `input` function. Use
  it when the Machine changes a param before the Effect gets it.

TypeScript checks the keys of the pick and of `fill` against the input of the Effect. When the Agent's state holds the
Effect, the Agent waits for the answer to its pick. [`answer(fn)`](../reference/authoring-surface.md#answer) sets that
answer. In the `testing` state, the Agent reads one line, or the end of the test output. Without `answer`, it reads the
`CommandOutput` of the command, as JSON.

## What jr2 up shows

Run [`jr2 up`](../reference/cli.md#up). It reads each Effect without running it, and it shows what the Effect runs, and
where. It also shows where each Effect secret goes:

```sh
jr2 up
```

<!-- output: not run -->

```text
…
effects: workflow "fix-and-report" — what it runs outside itself (ADR-0067)
  test: command ["node","--test","<file>"] — 300s, in the Harness
  report: http POST https://hooks.example.com — 30s, in the Instance Effector, secrets "hook-token"
…
secret hook-token: an Effect secret in the Instance Effector (fix-and-report/report)
…
```

`<file>` is the `arg("file")` entry. Each time is in seconds.

## Rules

When you call `command()`, it refuses:

- an empty argv: `command(argv): argv is a non-empty list — each entry one argument, never shell text`
- an entry that is not a string or an `arg()`: `command(argv): an argv entry is a string or arg("name"), got <entry>`
- a timeout that is not a positive duration:
  `command: timeout "<timeout>" is not a positive duration (like "90s", "10m", "1h")`
- an `env` name that is not a variable name, or that is `PATH`, `HOME` or `TMPDIR`:
  `command(argv, { env }): "<name>" is not a variable the author sets — PATH, HOME and TMPDIR are the Effector's (ADR-0067)`
- `pin: true` with no Effect secret in `env`:
  ``command(argv, { pin: true }) names no secret in its env: `pin` chooses the commit a credentialed command runs against in the Sandbox Effector, and a command that names no secret runs in the live Worktree (ADR-0067) — name its secret, command(argv, { env: { NAME: secret("x") }, pin: true }), or drop `pin` ``

When a `command` starts, it refuses:

- a state outside a `workspace()`. With no Effect secret in `env`:
  `command "<slot>" runs in the Harness container of a Workspace, and its state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`.
  With one:
  `command "<slot>" runs in the Sandbox Effector of a Workspace, and its state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`
- no `slot` under a Workspace with more than one Repo Slot:
  `command "<slot>" runs under a Workspace carrying more than one Repo Slot (<slots>) and names none — say which Worktree it runs in: command(argv, { slot: "<slot>" }) (ADR-0051)`.
  With an Effect secret in `env`, the text is
  `command "<slot>" runs under a Workspace carrying more than one Repo Slot (<slots>) — say which: { slot: "<slot>" } (ADR-0051)`
- with an Effect secret in `env`, a Workspace with no Repo Slot:
  `command "<slot>" runs under a Workspace carrying no Repo Slot (none) — say which: { slot: "<slot>" } (ADR-0051)`
- a `slot` that the Workspace does not have:
  `command "<slot>" names Repo Slot "<name>", which its Workspace does not carry (<slots>)`
- an `arg()` with no string in the input. The angle brackets around the name are in the text, and `<type>` is `nothing`
  when the input has no such key:
  `command "<slot>": argv slot <<name>> has no string value in its input (got <type>) — map it in the invoke's input`
- with `pin: true`, an input `sha` that is not a full commit id:
  `command "<slot>" (pin): its input's sha is not a full commit id`

When you call `http()`, it refuses:

- a method that is not in the list:
  `http({ method: "<method>" }): the method is one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
- a scheme or a host that is not literal:
  ``http({ url }): the url is an http:// or https:// url whose scheme and host are literal — a secret may sit only in its path, after a "/": text`https://api.example.com/bot${secret("tg")}/send` (ADR-0068)``
- an Effect secret after `?` or `#` in the URL:
  ``http({ url }): secret("<name>") sits in the url's query or fragment — a secret may sit only in its path; send it in `auth` or a header instead: headers: { "x-api-key": text`${secret("...")}` } (ADR-0068)``
- a user name or a password in the URL: ``http({ url }): the url carries userinfo — use `auth` ``
- a header name that is not in lower case, or that frames or routes the request, such as `host` or `content-length`:
  `http({ headers }): "<name>" is not a header an Effect sets — a lowercase name that does not frame or route the request (ADR-0068)`
- an `authorization` header beside `auth`: ``http({ headers }): "authorization" is set by `auth` — write one of them``
- a timeout that is not a positive duration: `http: timeout "<timeout>" is not a positive duration (like "30s", "2m")`
- a `maxBody` that is not a positive whole number: `http({ maxBody }): a positive number of bytes`
- a file body with a method other than `PUT`, `POST` or `PATCH`:
  `http({ method: "<method>", body: file(...) }): a file body is sent with PUT, POST, PATCH (ADR-0068)`
- a `body` that is not `file()`:
  ``http({ body }): a body is file(path, { slot?, segments?, contentType? }) — json and text come from `request` ``
- a `content-type` header beside the `contentType` of `file()`:
  `http({ headers, body: file(path, { contentType }) }): "content-type" is set by file()'s contentType — write one of them (ADR-0067)`
- a `request` with a file body:
  ``http({ body: file(...), request }): with a file body the run's part is file()'s — its path, from the input if it must be, and its `segments` — so write no `request` (ADR-0068)``
- a URL whose host is not a host: `http({ url }): "<scheme>://<host>" is not a host`

When an `http` Effect starts, it refuses an input that its `input` schema does not accept. The Effect takes its
`onError` route, and each problem is `<path>: <message>`, with `; ` between them:
`http "<slot>": its input does not match the definition's input schema — <path>: <message>`. With a file body, the text
ends after `input schema`.

An `http` Effect with a file body runs in the Sandbox Effector. When it starts, it refuses a state outside a
`workspace()`:
`http "<slot>" runs in the Sandbox Effector of a Workspace, and its state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`

When you call `secret()`, `bearer()` or `text`, they refuse:

- an Effect secret name with characters other than letters, digits, `.`, `_` and `-`, or that starts with `.`:
  `secret("<name>"): a secret's name is letters, digits, ".", "_" and "-", and does not start with "." — it is the file the Effector reads it from (ADR-0068)`
- a `bearer()` value that is not a `secret()`: `bearer(…) takes a secret("name")`
- a `text` value that is not a `secret()` or a string: ``text`…`: a value is a secret("name") or a string, got <value>``

`createMachine` refuses:

- an Effect that you write directly in an `invoke`:
  `machine "<id>": state "<state>" invokes an Effect inline — a Part is a key of actors, so it has a name that the ledger, the report and customize() share: actors: { <name>: <kind>(...) }, then invoke: { src: "<name>" }`
- a param of a pick that reaches no key of the Effect's input, and that nothing else reads:
  ``machine "<id>": pick "<pick>" enters state "<state>" (Effect "<slot>") with fromPick: "<param>" is no key of the Effect's input (<keys>), and nothing else reads it — the Agent supplies it and it reaches nothing; name an argv slot for it, read it in `fill`, store it with assign, or drop it from the def``
- a key that `fill` sets and that is also a param of the pick:
  ``machine "<id>": pick "<pick>" enters state "<state>" (Effect "<slot>"): `fill` sets "<param>", which is also a param of the pick — the Machine's value wins and the Agent's is dropped; rename one, or drop it from the def``
- a `fromPick` in a state that a different event enters:
  `machine "<id>": state "<state>" (Effect "<slot>") reads the params of pick "<pick>" but is entered on "<event>" — that event does not carry them`
- a param of a pick that enters an Effect's state with no `fromPick`, when nothing reads it:
  `machine "<id>": pick "<pick>" enters state "<state>" (Effect "<slot>"), which never reads "<param>": the Agent supplies it and nothing uses it — map it in an invoke's input, store it with assign, or drop it from the def`

[`paramsOf()`](../reference/authoring-surface.md#paramsof) refuses an event that is not the pick:
`state entered by "<event>", but its input reads the params of pick "<pick>"`

`jr2 up` refuses:

- an Effect secret that the `secrets` list does not have:
  ``workflow "<workflow>": the <kind> Effect "<slot>" names secret("<name>"), which the `secrets` list does not hold — add it: secrets: [{ name: "<name>", value: process.env.<NAME> }] (ADR-0068)``
- an Effect secret with no value, for example when `HOOK_TOKEN` is not in `.env`. `<name>` is the `name` of the entry,
  such as `hook-token`. Set the variable that `process.env` reads, such as `HOOK_TOKEN`:
  `secrets[<i>] needs exactly one of value or valueFrom — <name> has neither, which is what an unset .env variable reads as: set <name> in .env, or reference a Secret with valueFrom: { secretKeyRef: { name, key } } (ADR-0059)`
- an Effect secret with a value shorter than 8 characters:
  `secrets[<i>] (<name>) is an Effect secret shorter than 8 characters — the Effector replaces every match of a secret in what it returns, and a value this short would match ordinary text. Use the whole credential; the value itself is not shown (ADR-0068)`

## Read next

- [Effects](../concepts/effects.md): the kinds of Effect, where each runs, and at most once.
- [Secrets and trust](../concepts/secrets-and-trust.md): who holds an Effect secret.
- [The Menu](../concepts/the-menu.md): how a pick waits for its answer.
- [Push and sign a branch](push-and-sign-a-branch.md): the `push` Effect.
- Reference: [`command`](../reference/authoring-surface.md#command),
  [`CommandOptions`](../reference/authoring-surface.md#type-commandoptions),
  [`http`](../reference/authoring-surface.md#http), [`secret`](../reference/authoring-surface.md#secret),
  [`fromPick`](../reference/authoring-surface.md#frompick) and [`answer`](../reference/authoring-surface.md#answer).
- [ADR-0067](../reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md):
  an Effect is an actor slot, and runs at most once unless marked idempotent.
- [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md): an Effector holds
  the secrets of an Effect, and signs its wire.
