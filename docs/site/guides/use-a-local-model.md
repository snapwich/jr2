---
title: Use a local model
description: Connect your Agents to a model on an OpenAI-compatible endpoint, with or without TLS and a key.
---

Connect your [Instance](../reference/glossary.md#instance) to a model that you serve yourself, on an OpenAI-compatible
endpoint such as vLLM or llama.cpp.

The example on this page serves Qwen3.6-35B-A3B as `qwen3.6-35b-a3b`, on port 8000, with a context window of 65536
tokens. The first part uses plain `http://` and no key. [Serve over TLS with a key](#serve-over-tls-with-a-key) adds TLS
and a key.

## Start the server

The server must obey three conditions:

- It serves the model under one name. An [Agent](../reference/glossary.md#agent) uses this name.
- It listens on an address that a pod can reach, such as the LAN address of your computer. `localhost` does not work
  from a pod. Thus the server listens on `0.0.0.0`. llama.cpp listens on its loopback address by default.
- It completes a tool call. `jr2 up` sends one tool call to the endpoint before it converges, and stops when it fails.

To install the server, see the install page of [llama.cpp](https://github.com/ggml-org/llama.cpp) or of
[vLLM](https://docs.vllm.ai). Then start one of them.

### llama.cpp

<<< @/examples/shared/local/llama-server.sh

`--jinja` lets the model call tools. `--temp 0.6` and `--presence-penalty 1.0` are the sampling settings for Qwen.
`-ctk q8_0 -ctv q8_0 -fa on` make the KV cache smaller, so that 65536 tokens fit in memory.

### vLLM

<<< @/examples/shared/local/vllm.sh

`--enable-auto-tool-choice` and `--tool-call-parser` let the model call tools.

## Add the provider

Add a `harness` entry to `jr2.config.ts`. It declares a custom provider with the id `local`:

<<< @/examples/shared/local/jr2.config.ts

Add the address of the endpoint to `.env`. Write the LAN address of the computer that runs the server in place of
`<address>`:

```sh
LOCAL_MODEL_URL=http://<address>:8000/v1
```

The fields of [`harness.provider`](../reference/config.md#harness-provider) do these things:

- `id` is the first part of each model name. An Agent names this model as `local/qwen3.6-35b-a3b`.
- `api` is the wire protocol. `"openai-completions"` is the only value.
- `baseUrl` is the endpoint. It changes from one computer to the next, so `jr2.config.ts` reads it from `.env`.
- `models` holds the token limits of each model. Its key is the name that the endpoint gives for `GET /v1/models`.

Set `contextWindow` to the context of the server: `-c` for llama.cpp, `--max-model-len` for vLLM. A limit that nothing
sets is 0. Then [Compaction](../reference/glossary.md#compaction) has no context budget.

## Name the model in an Agent

An Agent names the model in the `model` field of its definition, as `<provider>/<modelId>`: `"local/qwen3.6-35b-a3b"`.
See [`agent()`](../reference/authoring-surface/agent.md) for the other fields of the definition.

## Run jr2 up

```sh
jr2 up
```

`jr2 up` starts a pod in the cluster, on the nodes where the Agents that name the model run. The pod asks the endpoint
for one tool call for each model, as a Turn asks. You see these lines when the Agent is a `workspace: "none"` Agent:

```text
…
provider: checking local/qwen3.6-35b-a3b on the Instance Harness, with no held key (harness.provider has no apiKey), direct, as a pod that holds no secret calls it
provider: the check pod has up to 5 min to start, then up to 6 min for its model
provider: the check pod is not running yet — custodian: PodInitializing
provider: the check pod is not running yet — check: PodInitializing
provider: local/qwen3.6-35b-a3b reachable, and it completed a tool call
…
```

While the check pod starts, `jr2 up` prints a `the check pod is not running yet` line for each change of its state. Your
output can have fewer of these lines, or more.

`jr2 up` checks each model of the provider that an Agent names. When no Agent names a model of the provider, it checks
nothing and prints this line:

```text
provider: http://<address>:8000/v1 configured, but no carried Agent names a "local/…" model — skipped
```

## Serve over TLS with a key

The server listens on `0.0.0.0`, so each device on your network can use it. A key stops this. The key is a
[Held secret](../reference/glossary.md#held-secret). The [Harness](../reference/glossary.md#harness) container holds
only its [Stand-in](../reference/glossary.md#stand-in). The [Custodian](../reference/glossary.md#custodian) of the pod
puts the key into the requests. The Custodian sends a key over TLS only. Thus a key needs an `https://` endpoint, and
the cluster must trust its certificate.

### Make a key

Make a random key:

```sh
openssl rand -hex 32
```

Put the key in `.env`. Change the address to `https://`:

```sh
LOCAL_MODEL_URL=https://<address>:8000/v1
LOCAL_MODEL_API_KEY=<key>
```

### Make a CA and a certificate

`jr2 up` puts each file of the Instance folder into the image of the
[Orchestrator](../reference/glossary.md#orchestrator). It leaves out only `node_modules`, `.git`, `.jr2`, `.npmrc`,
`.env` and `.env.*`. Thus, do not put a private key in the Instance folder. These commands put the keys in
`~/local-model-certs`, and copy only the CA certificate into the Instance folder.

Run these commands in the Instance folder. Write the IP address of `LOCAL_MODEL_URL` in place of each `<address>`:

<<< @/examples/guides/use-a-local-model/certs.sh

The commands make a CA (`ca.crt`) and a certificate for the server (`server.crt`), which the CA signs. For a DNS name in
`LOCAL_MODEL_URL`, write `DNS:<name>` in place of `IP:<address>`.

Commit `certs/ca.crt`, because a CA certificate is public. Keep `ca.key` and `server.key` in `~/local-model-certs`. If
the server runs on a different computer, copy `server.key` and `server.crt` to `~/local-model-certs` on that computer.
On that computer, set `LOCAL_MODEL_API_KEY` to the same key before you start the server.

### Start the server with TLS and the key

Stop the server that you started without TLS. The new server uses the same port.

Load `.env` into your shell, so that the server gets the key:

```sh
set -a && . ./.env && set +a
```

Then start the server with its certificate. The server reads the key from an environment variable, not from its command
line, so the process list does not show the key. For llama.cpp:

<<< @/examples/guides/use-a-local-model/llama-server.sh

For vLLM:

<<< @/examples/guides/use-a-local-model/vllm.sh

### Change the provider

Add `apiKey` to `harness.provider`. Add `caBundle` to `harness`:

<<< @/examples/guides/use-a-local-model/jr2.config.ts

[`harness.provider.apiKey`](../reference/config.md#harness-provider-apikey) becomes the Held secret
`JR2_PROVIDER_API_KEY`. `jr2 up` binds it to the host and port of `baseUrl`, and the Custodian sends it to no other
host.

[`harness.caBundle`](../reference/config.md#harness-cabundle) is a path to a PEM file, relative to the Instance folder.
`jr2 up` puts the file in the `jr2-ca` ConfigMap. The check of the endpoint, the Harness container and the Custodian
trust it. An `https://` endpoint whose certificate comes from a private CA needs `caBundle` also when it needs no key.

### Run jr2 up again

```sh
jr2 up
```

```text
…
the Instance Harness: Custodian holds JR2_PROVIDER_API_KEY (provider)
held secret JR2_PROVIDER_API_KEY → <address>:8000 (literal)
held secrets: minted the Instance's CA into jr2-held-ca
provider: checking local/qwen3.6-35b-a3b on the Instance Harness, through a Custodian that holds JR2_PROVIDER_API_KEY for <address>:8000
provider: the check pod has up to 5 min to start, then up to 6 min for its model
provider: the check pod is not running yet — custodian: PodInitializing
provider: local/qwen3.6-35b-a3b reachable, and it completed a tool call
…
```

The Custodian of the Instance Harness holds the key. `jr2 up` prints the `held secrets:` line when the namespace has no
CA for the Custodians yet, as on the first `jr2 up` with a Held secret.

To change the key, edit `.env`. Then start the server again. Then run `jr2 up` again. When a Menu-only Agent names the
model, `jr2 up` restarts the [Instance Harness](../reference/glossary.md#instance-harness) with the new key. A live
[Sandbox](../reference/glossary.md#sandbox) keeps the old key, so its calls to the server fail after the restart. A
Sandbox that starts after `jr2 up` gets the new key.

## Rules

`jr2 up` prints each refusal after `error: `.

- `jr2 up` stops when the check of the endpoint fails. A pod in the cluster asks the endpoint for one tool call for each
  model, as a Turn asks. The pod has a Custodian, so a key in `apiKey` is held as in a Harness pod. The first line gives
  the error. The other lines are the usual causes:

  ```text
  provider preflight failed for model "<model>" against <host> (from a pod on <where>, as a Turn calls it): <error>
    - localhost never works from a pod; use a LAN address
    - the model id must be exactly what the endpoint serves (vLLM: GET /v1/models)
    - vLLM needs --enable-auto-tool-choice and a matching --tool-call-parser
    - stop reason "length" means the model ran out of tokens before the call (a thinking model reasons first)
  ```

- When an Agent names a model of the provider, `jr2 up` refuses a key with an endpoint that is not `https://`:
  `harness.provider.apiKey is set, and harness.provider.baseUrl is not https:// — the key is a held secret and the Custodian carries TLS only (ADR-0059). Serve the endpoint over TLS (and name its CA in harness.caBundle), or drop apiKey for an endpoint that needs none.`
- `jr2 up` refuses a `caBundle` that it cannot read:
  `harness.caBundle names "<path>" but <file> is not readable — the path is relative to the instance folder; commit the PEM bundle there (CA certs are public)`.
- While a Held secret exists, `jr2 up` refuses a proxy or trust variable in `harness.env`, such as
  `NODE_EXTRA_CA_CERTS`. Put the CA in `caBundle`:
  `harness.env[<i>] sets <NAME>, which the Custodian owns while a held secret exists — it cannot chain to another proxy or trust store yet. Drop the entry; put a private CA in harness.caBundle (ADR-0059).`
- `jr2 up` warns about a key when no Agent names a model of the provider:
  `warning: harness.provider.apiKey is named by nothing; goes nowhere — no Agent names a "<id>/…" model (ADR-0059)`.
- `jr2 up` refuses an `api` other than `"openai-completions"` before it builds or applies anything:
  `refusing: harness.provider.api is "<api>" — the Harness speaks: openai-completions (ADR-0018)`.
- `harness.provider.id` must not also be a key of `harness.catalog`. `jr2 up` refuses it:
  `harness.catalog.<id>: "<id>" is also harness.provider.id — a custom provider owns its own baseUrl; rename the custom provider or drop the catalog entry (ADR-0059)`.

## Read next

- [Secrets and trust](../concepts/secrets-and-trust.md): Held secrets, Stand-ins and the Custodian.
- [Connect a model](../get-started/connect-a-model.md): the tutorial step that adds this provider.
- [Use a hosted provider or a gateway](use-a-hosted-provider.md): a model from the model catalog.
- [`harness.provider`](../reference/config.md#harness-provider) and
  [`harness.caBundle`](../reference/config.md#harness-cabundle) in the `jr2.config.ts` Reference.
- [ADR-0018](../reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md): an Agent names
  its model, and the config declares what the Harness can reach.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): `jr2 up` checks the
  endpoint from inside the cluster.
- [ADR-0020](../reference/decisions/0020-private-ca-trust-is-a-named-concept.md): `caBundle`.
- [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md): the Custodian
  holds the key.
