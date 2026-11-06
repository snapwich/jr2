---
title: Answer a Gate from a forge
description: Make a Gate that a review on GitHub or GitLab answers, and that looks for the review it waits for.
---

Make a [Gate](../reference/glossary.md#gate) that a review on a forge, such as GitHub, answers through a
[Hook](../reference/glossary.md#hook), and that looks for the review when no delivery comes.

A Gate slot is a Gate that hears a Hook. You declare it with `gate({ … })` in `actors`, and a state invokes it by its
key. It is the same Gate as `src: "gate"`: it has the same id, the same events, the same card in the
[Console](../reference/glossary.md#console), and `jr2 send` can answer it too. It adds four parts:

- `meta`: a zod object of the data that the state gives the Gate. The Gate checks the data when it opens.
- `delivers`: the events that the Gate can give from a delivery or from its look.
- `hooks`: a handler for each [Hook kind](../reference/glossary.md#hook-kind) and event key. A handler reads the payload
  of a delivery, and gives one event of `delivers`, or `undefined` when the delivery is not for this Gate.
- `look`: a read of the fact that the Gate waits for, with an `http` Effect that is marked `idempotent: true`.

The example is the [Workflow](../reference/glossary.md#workflow) `review`. A run waits for a review of one commit of one
pull request. The `github` kind is `@jr2/orchestrator/hooks/github`, so your
[Instance](../reference/glossary.md#instance) installs nothing more.

Save the file as `workflows/review.ts`:

<<< @/examples/guides/answer-a-gate-from-a-forge/review.ts

The `import type {} from "@jr2/orchestrator/hooks/github"` line gives the handlers their types: the event key
`pull_request_review.submitted` and its payload. A key that no kind in scope gives does not compile. A handler reads
only the fields that the kind's schema names.

## The handler

A delivery of the kind and the event key goes to each open Gate whose handlers hear them. Thus each handler compares the
payload with the Gate's `meta`. In the example, the handler gives `undefined` for a review of another pull request or of
an older commit. A handler is pure and synchronous: it does no I/O and reads no clock.

The event of a handler has the Gate as its [Sender](../reference/glossary.md#sender), with the Hook as its
[Caller](../reference/glossary.md#caller). The run takes the event only when it takes it from this Gate now, as for
`jr2 send`.

## The look

A delivery can come before the Gate opens, or it can be lost while the
[Orchestrator](../reference/glossary.md#orchestrator) is down. The look reads the fact, so these cases come to the same
read:

- The look reads once after the Gate opens, again after each restart of the Orchestrator, and every `every` while the
  Gate is open. The default `every` is `"10m"`.
- `until` gives one event of `delivers` from the read's output, or `undefined` for "not yet".
- When the run takes the event, the look stops until the Gate opens again. The run's feed shows `looked`. A looked event
  has the Gate as its Sender and no Caller.
- The `http` Effect of the look is an Effect, so the secret that it names is an entry of the `secrets` list, as
  `github-token` is in the example's `jr2.config.ts`. Put its value in `.env` as `GITHUB_TOKEN`.

A state that goes back to its own Gate must change the `meta`, for example to a new `sha`. If not, the look reads the
same verdict again.

Give `look: "none"` to a Gate that hears a command, such as a `/retry` comment. A command is not a fact that a read can
find, so a lost delivery of a command stays lost.

## The Hook

The Gate hears a delivery only when the [Instance](../reference/glossary.md#instance) declares a Hook of its kind. Each
Hook is a name in the `hooks` block of `jr2.config.ts`, and its address is `POST /hooks/<name>`. Set up the service with
this address one time:

<<< @/examples/guides/answer-a-gate-from-a-forge/jr2.config.ts

A Hook takes a credential and `may.answer`. `may.answer` is the list of Workflows whose Gates the Hook can answer. The
default is every Workflow. A Hook never starts a run. The kind tells how the service signs:

- `github` and `slack` sign with a shared secret (`mac`). The
  [Instance Effector](../reference/glossary.md#instance-effector) holds the secret and checks the signature. The
  Orchestrator does not hold the secret.
- `gitlab` sends a shared token in a header (`token`). The Orchestrator keeps only the sha-256 of the token, and removes
  the header before the kind reads the delivery.
- `discord` signs with a key pair (`ed25519`). The config holds the public key, which cannot sign.

Each secret that a Hook names is an entry of the `secrets` list. For a `mac` Hook, [`jr2 up`](../reference/cli.md#up)
places the secret in the Instance Effector alone, as it places an
[Effect secret](../reference/glossary.md#effect-secret), and it converges the Instance Effector for the Hook. For a
`token` Hook, `jr2 up` writes the sha-256 of the secret into the Secret `jr2-hook-digests`, which the Orchestrator
mounts. The Orchestrator reads it again when it changes, so a new value needs no restart. The kubelet updates the mount
in about one minute, and `jr2 up` waits for it before it says `converged`. A kind that posts a follow-up, such as the
reply to a Slack click, declares the hosts of the post. `jr2 up` adds these hosts to the Instance Effector's list of
targets, with no secret. The output of `jr2 up` names the Hook as `hook forge`, in the line of the secret and in the
line of the Instance Effector.

When a delivery comes, the door does these steps in this sequence:

1. The door refuses a body that is larger than 2 MiB. It reads no more of the body than this limit.
2. The verifier checks the delivery. A signed time that is more than 300 seconds from the Orchestrator's clock fails the
   check.
3. The kind reads the delivery. A handshake (a GitHub `ping`, a Discord `PING`, a Slack `url_verification`) gets the
   kind's answer and goes to no Gate.
4. The kind's schema parses the payload.
5. The door looks for a repeat: a delivery whose id or body this Hook got before.
6. The delivery goes to each open Gate, in each live run of a Workflow that the Hook may answer, whose handlers hear its
   kind and event key.

The answer is the outcome:
`{ delivery, seen, delivered: [{ run, workflow, gate, event }], refused: [{ run, gate, event?, reason }], ignored, sources }`.
`ignored` counts the open Gates whose handler gave `undefined`. A Gate whose handler throws, or gives an event that the
run does not take now, is in `refused`, and the run's feed shows `hook-refused`. The run continues.

To see what the door did, print the Hook's log. It keeps each delivery for `runs.retain` (30 days by default), newest
first:

```sh
jr2 hooks forge
```

## A Gate in a package

A [packaged Machine](publish-a-machine-as-an-npm-package.md) writes its handlers, because a forge's payload is public.
It leaves its look `open`, because the look needs a url and a token. The composer binds the look with `customize()`, and
can add, replace or remove a handler by kind and event key, where `null` removes one:
`customize(machine, { gates: { review: { look, hooks: { gitlab: { "note.MergeRequest": null } } } } })`.

## Rules

- The door refuses a delivery that fails the verifier, or whose signed time is more than 300 seconds from the
  Orchestrator's clock, with 401. Nothing else occurs, and the Hook's log keeps no line.
- The door refuses a body that is larger than 2 MiB with 413, before the verifier:
  `the delivery's body is larger than 2097152 bytes, the most the door reads` The Hook's log keeps a `too-large` line,
  which does not claim the delivery's id.
- The door refuses a name that the config does not declare with 404:
  `no Hook named "<name>" in the current Assembly's config`
- With no current Assembly, the door answers 503:
  `the Orchestrator has no current Assembly, so no Hook is declared now — ask again`
- `jr2 up` refuses a `mac` Hook whose secret is not in the `secrets` list:
  ``hooks.<name> names secret("<NAME>"), which the `secrets` list does not hold — add it: secrets: [{ name: "<NAME>", value: process.env.<NAME> }] (ADR-0068)``
  It refuses a `token` Hook whose secret is not in the list with the same text, which ends with `(ADR-0078)`.
- `jr2 up` names the secret of a `token` Hook: `secret <NAME>: a digest in the Orchestrator (hook <name>)`
- A `mac` Hook whose check the Instance Effector cannot answer gets 503:
  `the Hook's signature cannot be checked now: no Instance Effector (ADR-0068)`
- A request that the kind cannot read gets 400: `the <kind> kind cannot read the delivery: <error>`
- A payload that the kind's schema refuses gets 200, with `payloadRefused: { kind, key, issues }`. It goes to no Gate.
  When the service sends it again, the door parses it again.
- A delivery whose id or body the Hook got before gets 200 with `seen: true`, and goes to no Gate.
- The config load refuses a Hook's name that is not lowercase letters, digits and `-`, at most 40 characters:
  `<file> at hooks.<name>: a Hook's name is lowercase letters, digits and -, at most 40, starts with a letter and ends with a letter or digit (ADR-0078)`
- The config load refuses a value that no kind made:
  `<file> at hooks.<name>: not a Hook — make it with its kind, such as github({ secret: secret("GH_HOOK") }) (ADR-0078)`
- `jr2 hooks <name>` needs the Instance token.

- `gate()` refuses a part that it does not know:
  `gate(): "<key>" is not a part of a Gate slot (meta, delivers, hooks, look, reply) (ADR-0011)`
- `gate()` refuses an empty `delivers`: `gate(): its delivers lists at least one event that defineEvent made (ADR-0011)`
- `gate()` refuses a look whose read is a different Effect:
  ``gate(): its look reads with <an http Effect that is not marked idempotent: true | a <kind> Effect> — a look reads again after each restore and every `every`, so its read is an http Effect marked idempotent: true, or a promise (ADR-0067) (ADR-0011)``
- `gate()` refuses an `every` that is not a duration:
  `gate(): its look's every "<every>" is not a positive duration (like "90s", "10m", "2h") (ADR-0011)`
- `createMachine` refuses an event of `delivers` that the Machine does not declare:
  `machine "<id>": Gate slot "<slot>" delivers "<event>", which no def in jr2Setup({ events }) declares (declared: <events>) — list it in events (ADR-0011)`
- `createMachine` refuses an event of `delivers` that the Gate does not take at the state that invokes it:
  `machine "<id>": state "<state>" invokes Gate slot "<slot>", which delivers "<event>", and its Gate does not accept it (accepts: <events>) — no handler or look could deliver it: handle it on that state, a state above it or a plain child, or drop it from delivers (ADR-0011)`
- The Gate does not open when its `meta` does not agree with the schema, and the invoke fails:
  `gate "<gate>": its meta does not match the Gate slot's meta schema — <path>: <message>`
- `customize()` refuses a slot that holds no Gate slot:
  `customize(): machine "<id>" carries no Gate slot "<slot>" — its Gate slots are: <slots> (ADR-0011). Only declared parts can be bound.`
- `customize()` refuses `open` as a look:
  ``customize(): Gate slot "<slot>"'s look is bound once, to a look or "none" — not `open` again (ADR-0054)``
- The Chart door refuses a Chart that invokes a lent Gate slot whose `delivers` holds an event that is not in the
  Chart's `events`:
  ``<path>: the Gate slot "<slot>" delivers "<event>", which is not in the Chart's `events` (events: <events>); declare it in `events` and handle it on this state``
- `jr2 up` and `jr2 check` warn, and do not refuse, about a Gate slot that hears a Hook and has no look and no `after`
  on its state:
  ``warning: workflow "<workflow>": Gate slot "<slot>" on "<state>" hears a Hook and has no look and no `after` on its state — a delivery lost in an outage stops the run until a person answers the Gate: give it a look, or look: "none" for a Gate that hears a command (ADR-0011)``
- `jr2 up` and `jr2 check` warn about a look that a package left `open` and that nobody bound:
  `warning: workflow "<workflow>": Gate slot "<slot>" on "<state>" leaves its look open — a delivery lost in an outage stops the run until a person answers the Gate: bind it with customize(machine, { gates: { <slot>: { look } } }), or give it look: "none" (ADR-0011, ADR-0054)`

## Read next

- [Gates](../concepts/gates.md) and [Callers and Hooks](../concepts/callers-and-hooks.md)
- [Write a Hook kind](write-a-hook-kind.md), for a service that jr2 ships no kind for
- [Answer a Gate](answer-a-gate.md) and [Bind Open parts](bind-open-parts.md)
- [ADR-0011](../reference/decisions/0011-workflow-defined-events.md): a Gate hears a Hook, and looks before it waits
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): a
  Hook is a Caller that can only answer a Gate or bring items to a Source
