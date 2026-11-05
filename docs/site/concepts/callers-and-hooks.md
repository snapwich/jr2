---
title: Callers and Hooks
description: Who acts on an Instance from outside its Machines, what each one may do, and what a Hook does.
---

A [Caller](../reference/glossary.md#caller) is the holder of a credential that acts on an
[Instance](../reference/glossary.md#instance) from outside its [Machines](../reference/glossary.md#machine). A person, a
CI job, a bridge to a chat service and an outside service are Callers. A Caller can start a run, read it, answer a
[Gate](../reference/glossary.md#gate), send a [Steering message](../reference/glossary.md#steering-message) or cancel a
run, for the [Workflows](../reference/glossary.md#workflow) that its scopes name. A
[Hook](../reference/glossary.md#hook) is the door of an Instance for one outside service, such as a forge. It is a
Caller that can only answer a Gate or bring items to a Source. Its [Hook kind](../reference/glossary.md#hook-kind) is
the protocol of the service.

## Why it exists

One Instance token can do everything on each run. A CI job that starts runs, a bridge that answers Gates, and a teammate
with a browser need less than that. If each one holds the Instance token, each one can do each act on each run, and the
run cannot say who acted. Thus jr2 knows each Caller by its credential, gives it only its scopes, and records it on each
act.

An outside service sends a delivery, such as a review on a forge. It does not send a bearer token, and each service has
its own signature, its own body and its own handshake. A Hook checks that a delivery comes from its service, and decides
nothing. The Gate or the Source that hears it decides what the delivery means for its run.

## How a Caller is known

The Orchestrator has an ordered list of authenticators. Each one looks at the credential of a request. It gives a
Caller, or it says that the credential is not its credential. The first one that claims the credential decides. When it
finds the credential bad, the answer is 401, and the next authenticator does not look at it. A credential that no
authenticator claims also gets 401.

| Authenticator     | The credential                                                                                            | The Caller                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Instance token    | The token in the `jr2-instance` Secret. The CLI reads it over the Kubernetes API.                         | `token/instance`, with each scope for each Workflow |
| Named token       | A value that starts with `jr2c_`, for a name in [`callers.tokens`](../reference/config.md#callers-tokens) | `token/<name>`, with the scopes of its entry        |
| JWT               | A JWT of an issuer in [`callers.issuers`](../reference/config.md#callers-issuers)                         | `jwt/<sub>`, with the scopes that its groups give   |
| A Hook's verifier | A delivery at `POST /hooks/<name>`, with no bearer token                                                  | `hook/<name>`, with `answer` only                   |

The tokens of a Sandbox and the publish token are not Callers, and no authenticator makes a Caller from them. Thus an
Agent cannot answer a Gate. [Secrets and trust](secrets-and-trust.md#the-tokens) tells where each token is kept.

For a JWT, jr2 checks the signature with the published keys of the issuer, and the issuer, the audience and the expiry.
The name of the Caller is the `sub` claim, and the name that jr2 shows is the `email` claim. The `groups` map of the
issuer entry gives scopes for the values of a claim, such as the groups of a person. A JWT that gets no scope from the
map can do nothing. An issuer with `login: true` also lets a person log in to the
[Console](../reference/glossary.md#console) ([Open the Console](../guides/open-the-console.md#log-in)).

[`jr2 whoami`](../reference/cli.md#whoami) and [`GET /whoami`](../reference/http-api.md#get-whoami) show the Caller of a
credential, with its scopes. Use them to see what a credential can do before a request fails.

## Scopes

A scope is one act of a Caller. Its value is `"all"`, or a list of the names of the Workflows that it opens:

| Scope    | The act                                                         |
| -------- | --------------------------------------------------------------- |
| `start`  | Start a run.                                                    |
| `read`   | Read the full state of a run, and follow its feed.              |
| `answer` | Answer a Gate, and read the open Gates of a run and their meta. |
| `cancel` | Cancel a run.                                                   |
| `steer`  | Send a Steering message to an Agent of a run.                   |

For a route that addresses a run, jr2 checks the scope against the Workflow of that run. The name of a Chart wrapper
also opens each named Chart of that wrapper. A request without the scope gets 403, which names the scope and the
Workflow. [`GET /runs`](../reference/http-api.md#get-runs) shows only the runs of the Workflows that the Caller can
read. A few routes, such as a runtime Chart and the log of a Hook, need the Instance token: no scope opens them. The
[HTTP API](../reference/http-api.md#band-guarded) gives the scope of each route.

A scope does not limit what a run does. A run that a Caller starts can start a run of a different Workflow with a
[`dispatch`](../reference/authoring-surface/dispatch.md) Effect. The Machine is the limit of what its run does.

## On behalf of

A Caller can say that it acts on behalf of a different party, in the header `jr2-on-behalf-of`. The CLI sends the name
of your Kubernetes user. A bridge can send the name of the person in the chat service. jr2 records this name and shows
it, but it does not check it. The one exception is a Hook: the name comes from the body of the delivery, and the
signature of the service covers the body.

## The record of each act

The run records the Caller of each act on a guarded route: its `via`, its `name`, the name that jr2 shows, and
`onBehalfOf`. It does not record the scopes.

- `startedBy`: the Caller that started the run. A run that a local `dispatch` started records that run and the slot. A
  run that jr2 started, such as the run of a standing Pool, records `jr2` and why: `boot`, `publish`, `hand-over` or
  `resume`.
- `cancelledBy`: the Caller that cancelled the run.
- `answers`: the last 100 answers to the Gates of the run, each with the Caller that answered.

The [Sender](../reference/glossary.md#sender) of an event that a Gate delivers also holds the Caller, and `checked`
names the fields of it that jr2 checked. [`jr2 status`](../reference/cli.md#status) follows `startedBy` from run to run,
to the first Caller, and prints it as `started by:`. The open routes do not show these records.

## How a Hook behaves

The `hooks` block of `jr2.config.ts` declares each Hook by its name, with its kind. The address of the Hook is
`POST /hooks/<name>`. The kind makes the Hook from two things: the credential, and `may.answer`, the Workflows whose
Gates the Hook can answer. The default is every Workflow. A Hook never starts a run. To bring items to a
[Pool](../reference/glossary.md#pool), it answers the `source` Gate of the Pool, so `may.answer` must name the Workflow
of the Pool.

::: diagram sequence One delivery at a Hook

- **Service**: a forge or a chat service
- **Door**: the Hook's address in the Orchestrator
- **Instance Effector**: holds a mac secret
- **Kind**: the protocol of the service
- **Handlers**: of the open Gates and Sources
- Service → Door: a delivery
- Door → Instance Effector: the signed bytes, for mac only
- Instance Effector → Door: match, or no match
- Door → Kind: the request, without a token header
- Kind → Door: a handshake, or the event key, the id and the payload
- Door → Handlers: the parsed payload
- Door → Service: the outcome, or a text for a person

:::

The door does the same steps for each kind:

1. **It verifies the delivery.** The kind tells what the service signed. The door runs one of three verifiers:
   - `mac`: a shared secret signs the bytes, such as on GitHub and Slack. The
     [Instance Effector](../reference/glossary.md#instance-effector) holds the secret, and it answers only "match" or
     "no match". The Orchestrator never holds the secret, because a secret that verifies a delivery can also make one.
   - `token`: the service sends a shared token in a header, such as on GitLab. The Orchestrator keeps only the SHA-256
     digest of the token, and removes the header before the kind reads the request.
   - `ed25519`: a key pair signs the delivery, such as on Discord. The config holds the public key, which cannot sign.

   When the service signs a time, the door refuses a time that is more than 300 seconds from its clock. A delivery that
   fails gets 401, and nothing more occurs.

   Before the verifier, the door refuses a body that is larger than 2 MiB with 413. It reads no more of the body than
   this limit.

2. **The kind reads the delivery.** A handshake, such as a GitHub `ping`, gets the answer of the kind, and goes to no
   Gate. Otherwise the kind gives the event key, the id of the delivery, `onBehalfOf` and the payload.
3. **The schema of the event key parses the payload.** A payload that the schema refuses goes to no Gate.
4. **The door looks for a repeat.** A delivery whose id or body the Hook got before goes to no Gate. The door does this
   check after the parse, so a payload that the schema refused is parsed again when the service sends it again.
5. **The delivery goes to each handler that hears it**: each open Gate and each Source, in each live run of a Workflow
   that the Hook can answer, whose handlers name the kind and the event key. [Gates](gates.md#a-gate-that-hears-a-hook)
   and [Pools and Sources](pools-and-sources.md#a-hook-reaches-a-source) tell what a handler gives.

The answer is the outcome of the delivery, as JSON: where it went, and what each Gate or Source did with it. For a chat
command or a click, the person who acted reads one text in the envelope of the kind
([The answer that a person reads](gates.md#the-answer-that-a-person-reads)).

The log of the Hook keeps each delivery and its outcome for a week. The repeat check reads it. Print it with
[`jr2 hooks <name>`](../reference/cli.md#hooks).

## Hook kinds

A Hook kind is code that `jr2.config.ts` imports. It tells what the service signed, how to read a delivery and its
payloads, the handshake of the service, and the envelope of a text that a person reads. A workflow module imports the
same kind for the types of its handlers. Thus a handler for an event key that the kind does not give does not compile.

- `@jr2/hooks` ships the kinds `github`, `gitlab`, `slack` and `discord`.
- [`webhook()`](../reference/hooks.md#webhook) makes a kind from data, for a service that sends JSON, signs only the
  body, and has no handshake.
- [`defineHookKind()`](../reference/hooks.md#definehookkind) makes a kind for any other service, in a module of the
  Instance or in a package of its own.

A kind never gets the credential: jr2 makes the constructor of the kind, so the credential goes from the config to the
door. A kind is pure and synchronous. It does no I/O, and it does not read a clock. The door does the verify, the time
window, the repeat check and the follow-up post. When a kind gives a follow-up post, such as the reply to a Slack click,
it declares the hosts of its posts, and `jr2 up` adds them to the targets of the Instance Effector.

## Rules

- The first authenticator that claims a credential decides. A credential that it finds bad gets 401.
- A Sandbox token, a control token and the publish token are not Callers.
- A request without the scope for the Workflow gets 403. A JWT that gets no scope gets 403 on each route that needs a
  scope.
- `onBehalfOf` is a claim. jr2 checks it only for a Hook, where the signature covers it.
- A named token's value is in a Secret of its own. The Orchestrator keeps only its SHA-256 digest.
- `cors` lists the origins of the browser apps on a different origin that can call the Orchestrator. The Console needs
  no entry.
- A Hook can only answer a Gate or bring items to a Source, of the Workflows in its `may.answer`. It never starts a run.
- The door refuses a signed time that is more than 300 seconds from its clock. No config changes the window.
- Two kinds with one id fail the typecheck and `jr2 up`.

## Read next

- [Give a Caller a scope](../guides/give-a-caller-a-scope.md)
- [Answer a Gate from a forge](../guides/answer-a-gate-from-a-forge.md)
- [Start a run for each alert](../guides/start-a-run-for-each-alert.md)
- [Write a Hook kind](../guides/write-a-hook-kind.md)
- [Open the Console](../guides/open-the-console.md)
- [Secrets and trust](secrets-and-trust.md), [Gates](gates.md) and [Pools and Sources](pools-and-sources.md)
- Reference: [`callers`](../reference/config.md#callers), [`hooks`](../reference/config.md#hooks),
  [`cors`](../reference/config.md#cors), [`@jr2/hooks`](../reference/hooks.md),
  [`jr2 whoami`](../reference/cli.md#whoami), [`jr2 hooks`](../reference/cli.md#hooks), and the
  [HTTP API](../reference/http-api.md)
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): the
  Callers, the scopes, the Hooks and the Hook kinds
- [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md): which scope opens which route
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): a Gate hears a Hook
