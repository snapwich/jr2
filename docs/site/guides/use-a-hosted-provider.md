---
title: Use a hosted provider or a gateway
description: Give your Agents a model from a hosted provider, directly or through a gateway.
---

Give the [Agents](../reference/glossary.md#agent) of your [Instance](../reference/glossary.md#instance) a model from a
hosted provider, such as Anthropic, directly or through a gateway.

The [Harness](../reference/glossary.md#harness) has a model catalog. The catalog knows the providers, their models, and
the limits of each model. An Agent names a catalog model as `<provider>/<modelId>`, such as `anthropic/<modelId>`. The
config needs no provider entry for it. It needs only the key.

## Hold the provider's key

Add the key to the `secrets` list of `jr2.config.ts`:

::include{file="../examples/shared/anthropic/jr2.config.ts"}

Put the value in `.env`:

```sh
ANTHROPIC_API_KEY=<your key>
```

The `name` of the entry is the env var that the provider reads. When an Agent names a model of that provider, the key is
a [Held secret](../reference/glossary.md#held-secret) in the pod of the Agent. The Harness container holds only its
[Stand-in](../reference/glossary.md#stand-in). The [Custodian](../reference/glossary.md#custodian) of the pod puts the
key into the requests to the provider.

You do not say which pods get the key. jr2 finds them from the models that the Agents of each pod name.

The name tells jr2 the provider and its host. For a key that goes to one host, `hosts` can stay out: the key then goes
to that host only. Some of these names are:

| Name                 | Provider     | Host                                |
| -------------------- | ------------ | ----------------------------------- |
| `ANTHROPIC_API_KEY`  | `anthropic`  | `api.anthropic.com`                 |
| `OPENAI_API_KEY`     | `openai`     | `api.openai.com`                    |
| `GEMINI_API_KEY`     | `google`     | `generativelanguage.googleapis.com` |
| `MISTRAL_API_KEY`    | `mistral`    | `api.mistral.ai`                    |
| `OPENROUTER_API_KEY` | `openrouter` | `openrouter.ai`                     |

Some providers have no single host, because the address has a region or an account in it. Examples are
`AWS_BEARER_TOKEN_BEDROCK`, `AZURE_OPENAI_API_KEY` and `GOOGLE_CLOUD_API_KEY`. For these, add the hosts to the entry,
such as `hosts: ["<resource host>"]`.

To keep the value in a Kubernetes Secret that you manage, write `valueFrom` in place of `value`:
`valueFrom: { secretKeyRef: { name: "<secret>", key: "<key>" } }`. See [`secrets`](../reference/config.md#secrets) for
each field.

Run `jr2 up`:

```sh
jr2 up
```

For an Instance whose Agent has only the [Menu](../reference/glossary.md#menu) and uses Anthropic, you see these lines:

<!-- output: not run -->

```text
…
secret ANTHROPIC_API_KEY: Held in the Instance Harness
…
the Instance Harness: Custodian holds ANTHROPIC_API_KEY (provider)
…
held secret ANTHROPIC_API_KEY → api.anthropic.com (literal)
…
```

For an Agent in a [Workspace](../reference/glossary.md#workspace), the line names its
[Workflow](../reference/glossary.md#workflow): `Workspace of workflow "<workflow>"`. For a Workspace inside a different
Machine, the label continues with its route, such as ` → "<state>"`.

`jr2 up` does not check a catalog model, and it does not send a request to the provider. A wrong model id or a wrong key
shows when the first [Turn](../reference/glossary.md#turn) starts.

## Send the calls through a gateway

A gateway, such as LiteLLM, serves the API of a provider at a different address. The catalog keeps every fact about the
models. Only the address of the calls changes.

Change the `secrets` entry: read its value from `GATEWAY_API_KEY`, and add `paths`. Then add the gateway to
[`harness.catalog`](../reference/config.md#harness-catalog), under the id of the provider:

::include{file="../examples/guides/use-a-hosted-provider/gateway/jr2.config.ts"}

Put the address and the key of the gateway in `.env`:

```sh
GATEWAY_URL=https://<gateway>
GATEWAY_API_KEY=<gateway key>
```

Obey these conditions:

- `baseUrl` is the whole base URL that the provider's API adds its paths to. For `anthropic`, it is `https://<gateway>`,
  and the API adds `/v1/messages`. For `openai`, it is `https://<gateway>/v1`.
- `baseUrl` is `https://`, because the Custodian sends a key over TLS only.
- The gateway serves each model under its catalog id. The Harness sends the catalog id, not a name that you choose.
- The key has the name that the provider reads, here `ANTHROPIC_API_KEY`. With no `hosts`, the key goes to the host of
  `baseUrl`, not to `api.anthropic.com`.

`paths` limits the key to the path prefixes that the Agents use. A gateway key can often reach admin routes too, such as
a route that makes new keys. An Agent could take a new key out of the pod. Thus give a gateway key `paths`.

When the certificate of the gateway comes from a private CA, name the CA in
[`harness.caBundle`](../reference/config.md#harness-cabundle). The guide
[Use a local model](use-a-local-model.md#change-the-provider) shows `caBundle`.

Run `jr2 up` again:

```sh
jr2 up
```

The key now goes to the gateway:

<!-- output: not run -->

```text
…
held secret ANTHROPIC_API_KEY → <gateway> (literal)
…
```

A gateway that serves its own model names, or only `/v1/chat/completions`, is not a catalog provider. Declare it as a
custom provider, with `harness.provider` and `apiKey`. The guide
[Use a local model](use-a-local-model.md#serve-over-tls-with-a-key) shows how.

## Rules

`jr2 up` prints each refusal after `error: `.

- `jr2 up` refuses an empty value: `secrets[<i>].value is empty — set <NAME> in .env (ADR-0059)`.
- `jr2 up` refuses a key that a pod gets, but that has no value. A `.env` variable that is not set reads as no value:
  `secrets[<i>] needs exactly one of value or valueFrom — <NAME> has neither, which is what an unset .env variable reads as: set <NAME> in .env, or reference a Secret with valueFrom: { secretKeyRef: { name, key } } (ADR-0059)`.
- `jr2 up` refuses a key with no `hosts` when its name has no single host:
  `secrets[<i>].hosts is absent, and <NAME> has no single default host — name where the value may go: hosts: ["gateway.example.com"] (ADR-0059)`.
- `jr2 up` refuses `hosts` that leave out the host to which an Agent's calls go:
  `secrets[<i>].hosts leaves out <host>, where pi sends every "<provider>/…" turn an Agent here names — each would arrive with the Stand-in and fail with 401. Add it, or drop hosts to take that default (ADR-0059)`.
- `jr2 up` refuses a model key in `harness.env`, because the Agent can read that env:
  `harness.env[<i>] sets <NAME>, a model key the Agent could read and take out of the pod — hold it instead: secrets: [<entry>] (ADR-0059)`.
- `jr2 up` refuses a Secret or a ConfigMap that `harness.envFrom` names, when it carries a model key. `<kind>` is
  `Secret` or `ConfigMap`:
  `harness.envFrom[<i>] loads <kind> "<name>", which carries <NAME> — a model key the Agent could read. Hold it instead: secrets: [{ name: "<NAME>", valueFrom: { secretKeyRef: { name: "<secret>", key: "<NAME>" } } }], and drop the key from that <kind> (ADR-0059)`.
- `jr2 up` refuses a `valueFrom` that names a Secret that does not exist:
  `secrets[<i>].valueFrom names Secret "<name>", which does not exist in the instance's namespace — create it first: kubectl create secret generic <name> --from-literal=<key>=... (ADR-0019, ADR-0059)`.
- `jr2 up` refuses a `harness.catalog` key that is not a catalog provider with a known key:
  `harness.catalog.<id>: "<id>" is not a pi catalog provider jr2 knows a key for — the catalog ids are <ids> (ADR-0059)`.
- `jr2 up` refuses a gateway address that is not `https://`:
  `harness.catalog.<id>.baseUrl must be an https:// URL — the Custodian carries TLS only (ADR-0059). Read it from .env: catalog: { anthropic: { baseUrl: process.env.LITELLM_URL ?? "" } }`.
- `jr2 up` warns about a key that no pod gets:
  `warning: secrets[<i>] (<NAME>) is named by nothing; goes nowhere — no workspace() lists it, no Agent's provider reads it, and no Effect names it (ADR-0059, ADR-0068)`.
- A credential that signs each request, such as `AWS_ACCESS_KEY_ID`, cannot be a Held secret. `jr2 up` warns when
  `harness.env` sets one. Send the calls through a gateway that holds the credential, and hold the key of the gateway:
  `warning: harness.env sets <NAME>: a signing credential cannot be held (a Stand-in cannot be swapped into a signature), so the Agent can read it — route the provider through a gateway that holds it, and hold the gateway's key instead (ADR-0059)`.
- The Harness refuses a model that is not in the catalog when it admits the Turn:
  `harness admission failed (400): agent "<agent>": model "<provider>/<modelId>" resolves to nothing — not in pi's catalog, and no custom provider "<provider>" is configured (ADR-0018)`.

## Read next

- [Secrets and trust](../concepts/secrets-and-trust.md): Held secrets, Stand-ins and the Custodian.
- [Connect a model](../get-started/connect-a-model.md): the tutorial step that adds the Anthropic key.
- [Use a local model](use-a-local-model.md): a model that you serve yourself.
- [`secrets`](../reference/config.md#secrets) and [`harness.catalog`](../reference/config.md#harness-catalog) in the
  `jr2.config.ts` Reference.
- [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md): the Custodian
  holds the keys, and a catalog provider can move to a gateway.
- [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md): one `secrets`
  list, and a secret goes where something names it.
- [ADR-0018](../reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md): an Agent names
  its model.
