---
title: Give a Caller a scope
description: Make a named token for a CI job or a bridge, give it only the scopes that it needs, and rotate it.
---

Give a CI job, a bridge or a script a token of its own, with only the scopes that it needs.

A [Caller](../reference/glossary.md#caller) is a client that acts on the Instance from outside its
[Machines](../reference/glossary.md#machine). The CLI on your kubectl context is the Caller `token/instance`, and it can
do everything. A named Caller token can do less. Declare each one in
[`callers.tokens`](../reference/config.md#callers-tokens) of `jr2.config.ts`, with its scopes. This example declares
two:

<<< @/examples/guides/give-a-caller-a-scope/jr2.config.ts

Each scope is `"all"`, or a list of the names of the [Workflows](../reference/glossary.md#workflow) that it opens:

| Scope    | What the Caller can do                                                            |
| -------- | --------------------------------------------------------------------------------- |
| `start`  | Start a run.                                                                      |
| `read`   | Read the full state of a run, and follow it.                                      |
| `answer` | Answer a [Gate](../reference/glossary.md#gate), and read the open Gates of a run. |
| `cancel` | Cancel a run.                                                                     |
| `steer`  | Send a [Steering message](../reference/glossary.md#steering-message) to an Agent. |

A scope that the entry does not give opens nothing. A scope does not limit what the run does: a run that a Caller starts
can start a run of a different Workflow with a [`dispatch`](../reference/authoring-surface/dispatch.md) Effect.

## Make the tokens

Run `jr2 up`. It makes the value of each new name one time, and keeps it in a Secret of its own:

```sh
jr2 up
```

<!-- output: not run -->

```text
…
caller token "chat-bridge": made — `jr2 caller token chat-bridge` prints it
caller token "ci": made — `jr2 caller token ci` prints it
…
```

The [Orchestrator](../reference/glossary.md#orchestrator) gets only the SHA-256 digest of each value. A value is `jr2c_`
and 43 more characters.

## Give the token to the Caller

Print the value with [`jr2 caller token`](../reference/cli.md#caller-token). It reads the Secret over the Kubernetes
API, so your Kubernetes RBAC decides who can read it:

```sh
jr2 caller token ci
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
jr2c_<value>
```

Only the value goes to stdout. Put it in the secret store of the CI job, as `JR2_TOKEN`. Keep it as you keep a password.

## Check what the token can do

The Caller reaches the Orchestrator at a URL. In a new terminal, forward a port to the Orchestrator. Keep this command
open:

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

Run [`jr2 whoami`](../reference/cli.md#whoami) with the token:

```sh
JR2_URL=http://localhost:4000 JR2_TOKEN=$(jr2 caller token ci) jr2 whoami
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
→ http://localhost:4000
{"via":"token","name":"ci","may":{"start":["release"],"read":["release"]}}
```

The CI job runs `jr2 run`, `jr2 status` and `jr2 logs` with the same two variables, as
[Start a run](start-a-run.md#use-the-cli-without-the-instance-folder) shows. The run records its Caller in `startedBy`,
and `jr2 status` prints it on stderr as `started by: token/ci`.

## Rotate a token

Run [`jr2 caller rotate`](../reference/cli.md#caller-rotate). It makes a new value, and prints no value:

```sh
jr2 caller rotate ci
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
caller token "ci": rotated — the old value stops working when the Orchestrator reads the new digest, about a minute; `jr2 caller token ci` prints the new one
```

Give the new value to the Caller. No pod restarts.

## Remove a token

Remove its entry from `callers.tokens`, and run `jr2 up`. It deletes the Secret of the name, and the value stops
working:

<!-- output: not run -->

```text
…
caller token "chat-bridge": deleted — callers.tokens no longer declares it
…
```

## Rules

- The config load refuses a name that is not a DNS label of 40 characters or fewer:
  `<file> at callers.tokens.<name>: a token name is lowercase letters, digits and -, at most 40, starts with a letter and ends with a letter or digit — <shape>`.
  `<shape>` is the shape of the `callers` block.
- The config load refuses the name `instance`, which is the name of the Instance token:
  `<file> at callers.tokens.instance: the name instance is the Instance token's — <shape>`
- The config load refuses a scope that is not one of the five, and a list with no Workflow:
  `<file> at callers.tokens.<name>.may<path>: <problem> — <shape>`
- The Orchestrator refuses a value that it does not know, such as a value from before a rotation, with the status code
  `401`: `unauthorized`. The old value works until the kubelet updates the mount of the Orchestrator, about one minute.
- The Orchestrator refuses a request that needs a scope that the token does not have for the Workflow, with the status
  code `403`: `the Caller token/<name> needs the "<scope>" scope for Workflow "<workflow>" (ADR-0078)`
- It refuses a request that needs a scope that the token has for no Workflow, with the status code `403`:
  `the Caller token/<name> has no "<scope>" scope for any Workflow (ADR-0078)`
- It refuses a route that no scope opens, such as a runtime Chart, with the status code `403`:
  `this route needs the Instance token: no scope opens it, so the Caller token/<name> cannot`
- `jr2 caller token` prints nothing on stdout and exits with `1` when the Secret is not there:
  ``error: no Caller token "<name>" here (context <context>, namespace <namespace>) — declare it in callers.tokens of jr2.config.ts, then `jr2 up` makes it``
- `jr2 caller rotate` changes nothing and exits with `1` when the Secret is not there:
  ``error: no Caller token "<name>" in namespace "<namespace>" — declare it in callers.tokens of jr2.config.ts and run `jr2 up` (tokens here: <names>)``.
  The part `(tokens here: <names>)` shows only when the namespace has a token.
- `jr2 caller token` and `jr2 caller rotate` take `-n` and `--context`, and not `--url`: the Orchestrator holds no
  value.

## Read next

- [Callers and Hooks](../concepts/callers-and-hooks.md)
- [Secrets and trust](../concepts/secrets-and-trust.md)
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): the
  Callers, the scopes, and the named tokens.
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): which scope opens which route.
- [Start a run](start-a-run.md)
