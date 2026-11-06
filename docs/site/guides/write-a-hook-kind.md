---
title: Write a Hook kind
description: Write the kind of a service that jr2 ships no kind for, declare a Hook of it, and hear it at a Gate.
---

Write a [Hook kind](../reference/glossary.md#hook-kind) for an outside service that jr2 ships no kind for, and that
[`webhook()`](../reference/hooks.md#webhook) cannot read.

`webhook()` reads a service that sends JSON and signs only the raw body. Write a kind with
[`defineHookKind()`](../reference/hooks.md#definehookkind) when the service does one of these:

- It signs more than the body, such as a time and the body.
- It sends a body that is not JSON, such as a form.
- It sends a handshake that needs an answer.
- A person reads the answer, as in a chat command.

The example is a kind for Stripe. Stripe signs `<t>.<raw body>` with the signing secret of the endpoint, and sends the
time `t` and the signature in the header `Stripe-Signature: t=<seconds>,v1=<hex>`. The type of the event is the event
key, and the id of the event is the id of the delivery.

The interface of a kind is `@jr2/orchestrator/hooks`. It is part of `@jr2/orchestrator`, so your
[Instance](../reference/glossary.md#instance) installs nothing more.

## Write the kind

Save the kind as `hooks/stripe.ts`, beside `workflows/`. A kind is not a Workflow, so it does not go in `workflows/`:

<<< @/examples/guides/write-a-hook-kind/hooks/stripe.ts

A kind has these parts:

- `api: 1`: the version of the interface of a kind.
- `id`: the key of the kind in the `hooks` of a Gate or a Source. It is lowercase letters, digits and `-`, and it starts
  with a letter. One id is one kind in an Assembly.
- `events`: a zod schema for each event key that a handler can hear. The door parses each payload with the schema of its
  key before a handler gets it. Use `z.looseObject`, and name only the fields that the handlers read. A key that ends in
  `.*` gives the schema of each key with that prefix.
- `verify`: one of `mac`, `token` or `ed25519`. For `mac` and `ed25519`, `signed` gives the bytes that the service
  signed, the signature without its prefix, and `at`, the time of the delivery in seconds. Give `at` only when the
  signature covers it. The door refuses a time that is more than 300 seconds from its clock. When the request does not
  have a signature, give `{ unsigned: "<why>" }`. For `token`, give the header of the token.
- `read`: the request after the verifier, as a delivery or as a handshake. A delivery has the event key, the id, the
  payload, and `onBehalfOf` when the service names the party that acted. A handshake is `{ handshake: { body } }`, and
  goes to no handler. A throw is the status 400.

A kind whose answer a person reads also has `answer`, the envelope of the text, and `maxText`, the limit of the service
on its length. Its `read` gives `readBy: "person"`. When the answer gives a follow-up post, `posts` lists the URLs that
the post can go to. See the [`slack` kind](../reference/hooks.md#slack).

A kind is pure and synchronous: it does no I/O, gives no Promise, and reads no clock. It never gets the secret. The
`declare module` block adds the kind to `HookKinds`, so that the handlers of a Gate or a Source get the types of its
payloads.

## Declare a Hook of the kind

Add the Hook to `jr2.config.ts`, and its secret to the `secrets` list:

<<< @/examples/guides/write-a-hook-kind/jr2.config.ts

The kind is also the constructor of its Hooks. It takes the credential and `may.answer`. For a `mac` kind,
[`jr2 up`](../reference/cli.md#up) puts the secret in the
[Instance Effector](../reference/glossary.md#instance-effector) only, which checks each signature. Put the value in
`.env`:

```sh
STRIPE_HOOK=<signing secret>
```

`<signing secret>` is the signing secret that Stripe shows for the endpoint. Give the endpoint the URL
`https://<host>/hooks/billing`.

## Hear it at a Gate

Import the kind's types in the workflow module, and give the Gate slot a handler for each event key that it hears:

<<< @/examples/guides/write-a-hook-kind/workflows/dunning.ts

A handler for a key that the kind does not give does not compile, and a handler reads only the fields that the schema
names. [Answer a Gate from a forge](answer-a-gate-from-a-forge.md) tells the other parts of a Gate slot, such as the
look. A Source hears a kind in the same way ([Start a run for each alert](start-a-run-for-each-alert.md)).

## Put the kind in a package

A kind in a package of its own uses the same interface. Its package has a peer dependency on `@jr2/orchestrator` and
states `api: 1`, and its `jr2.config.ts` and its workflow modules import it as they import a local file. `jr2 up`
bundles the kind into the [Assembly](../reference/glossary.md#assembly). jr2 finds no kind in a folder, and loads none
while the Instance runs.

## Rules

- `defineHookKind()` refuses an `id` of another form:
  `a Hook kind's id is lowercase letters, digits and "-", and starts with a letter: <id>`
- `defineHookKind()` refuses an `api` that it does not know:
  `Hook kind <id> states api <api>; this @jr2/orchestrator/hooks knows api 1 only`
- `defineHookKind()` refuses an event key with no zod schema: `Hook kind <id>: the event key <key> has no zod schema`
- `defineHookKind()` refuses a `verify` that is not one of the three:
  `Hook kind <id>: verify is one of mac, ed25519 or token`
- `defineHookKind()` refuses a `mac` verifier without an algorithm or a `signed` function:
  `Hook kind <id>: a mac verifier has an alg (sha256, sha1, sha512) and a signed function`
- `defineHookKind()` refuses a `token` header that is not lowercase:
  `Hook kind <id>: a token verifier names its header in lowercase`
- `defineHookKind()` refuses a `posts` entry that is not an `https://` URL that ends in `/`:
  `Hook kind <id>: a posts entry is an https:// url that ends in "/": <entry>`
- `defineHookKind()` refuses a `maxText` that is not a positive integer: `Hook kind <id>: maxText is a positive integer`
- The constructor of a `mac` or `token` kind refuses a credential that is not a named secret:
  `a <id> Hook takes secret: a named secret, secret("NAME")`
- The constructor of an `ed25519` kind refuses a public key that is not 64 hex characters:
  `a <id> Hook takes publicKey: the Ed25519 public key in hex (64 characters)`
- The constructor refuses a `may.answer` that is not `"all"` or a list of Workflow names:
  `a <id> Hook's may.answer is "all" or a list of Workflow names`
- Two kinds with one id do not compile (`Subsequent property declarations must have the same type`), and the config load
  refuses them:
  `<file> at hooks: two different Hook kinds have the id <id>: one id is one kind in an Assembly (ADR-0078)`
- The type of `read` refuses `readBy: "person"` in a kind that has no `answer`.
- A request that `signed` gives `unsigned` for, or whose signature does not match, gets 401. A request that `read`
  throws for gets 400: `the <kind> kind cannot read the delivery: <error>`
- `jr2 up` refuses a `mac` Hook whose secret is not in the `secrets` list:
  ``hooks.<name> names secret("<NAME>"), which the `secrets` list does not hold — add it: secrets: [{ name: "<NAME>", value: process.env.<NAME> }] (ADR-0068)``

## Read next

- [Callers and Hooks](../concepts/callers-and-hooks.md)
- [Answer a Gate from a forge](answer-a-gate-from-a-forge.md) and
  [Start a run for each alert](start-a-run-for-each-alert.md)
- Reference: [`@jr2/orchestrator/hooks`](../reference/hooks.md), [`HookKind`](../reference/hooks.md#type-hookkind),
  [`Signed`](../reference/hooks.md#type-signed), [`Delivery`](../reference/hooks.md#type-delivery) and the
  [`hooks`](../reference/config.md#hooks) field of `jr2.config.ts`
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): a
  Hook kind, the three verifiers, and the window
- [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md): the Instance
  Effector holds a `mac` secret
