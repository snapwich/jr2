---
title: Connect a model
description: Add a model to the Instance, with its key or its address in .env, and converge the Instance again.
---

At the end of this page, the config of your [Instance](../reference/glossary.md#instance) names a model. `jr2.config.ts`
names its key or its endpoint, `.env` holds the value, and the cluster has the new config. The next page gives the model
its first task.

## Before you start

Do [Create an Instance](create-an-instance.md) first. The Instance `my-instance` must be in the kind cluster.

Choose a tab. Choose Anthropic for a model of the Anthropic API. Choose Local for a model that you serve on a computer
on your network. Each page after this one uses the model of the tab that you choose.

::: tabs key:provider

== Anthropic

You need an Anthropic API key. Make one on the [Anthropic website](https://console.anthropic.com/).

== Local

You need a computer that can serve Qwen3.6-35B-A3B with a context window of 65536 tokens. It can be the computer that
runs kind, or a different one on your network. Install one of these two servers on it:

- [vLLM](https://docs.vllm.ai/en/latest/getting_started/installation/)
- [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md)

:::

## Add the model to jr2.config.ts

::: tabs key:provider

== Anthropic

Open `jr2.config.ts`. Find the line that starts with `// secrets:`. Remove the `//`. Keep the other lines and their
comments. This is the result. Its comments are shorter than the comments in your file:

<<< @/examples/shared/anthropic/jr2.config.ts

The `secrets` line gives jr2 the value of `ANTHROPIC_API_KEY` from `.env`. An [Agent](../reference/glossary.md#agent)
that names an `anthropic/` model uses this key.

== Local

Open `jr2.config.ts`. Add the `harness` entry after the `git` entry. Keep the other lines and their comments. This is
the result. Its comments are shorter than the comments in your file:

<<< @/examples/shared/local/jr2.config.ts

The entry adds a custom provider with the id `local`. An [Agent](../reference/glossary.md#agent) names a model of this
provider as `local/<model>`, such as `local/qwen3.6-35b-a3b`. `<model>` is the name that the endpoint gives for
`GET /v1/models`.

:::

The [config reference](../reference/config.md#secrets) gives each field of `secrets` and of
[`harness.provider`](../reference/config.md#harness-provider).

## Put the value in .env

::: tabs key:provider

== Anthropic

Make the file `.env` in `my-instance`. Put this line in it, with your key in place of `<your key>`:

```text
ANTHROPIC_API_KEY=<your key>
```

== Local

Make the file `.env` in `my-instance`. Put this line in it:

```text
LOCAL_MODEL_URL=http://<address>:8000/v1
```

`<address>` is an address of the server computer that a pod can reach, such as its LAN address. Do not use `localhost`.
In a pod, `localhost` is the pod itself.

:::

The jr2 CLI reads `.env` before each command, and names each key that it takes from `.env`. A variable that you set in
your shell has priority over `.env`. Do not put `.env` in git: the `.gitignore` that `jr2 init` wrote keeps it out.

## Start the model server

::: tabs key:provider

== Anthropic

There is no server to start. Go to the next step.

== Local

On the server computer, start one of the two servers. Each command serves the model as `qwen3.6-35b-a3b`, on port 8000,
on all addresses (`0.0.0.0`). The pods cannot reach a server that listens only on its loopback address.

To start llama.cpp, run:

<<< @/examples/shared/local/llama-server.sh

`--jinja` lets the model call tools. `--temp 0.6` and `--presence-penalty 1.0` are the sampling settings for Qwen.
`-ctk q8_0 -ctv q8_0 -fa on` make the KV cache smaller, so that 65536 tokens fit in memory.

To start vLLM, run:

<<< @/examples/shared/local/vllm.sh

`--enable-auto-tool-choice` and `--tool-call-parser` let the model call tools.

With each of the two servers, the model must make tool calls. `jr2 up` asks the model for one tool call before it
converges, and stops when the model does not make one.

:::

## Check the model server

::: tabs key:provider

== Anthropic

There is no server to check. Go to the next step.

== Local

From the computer that runs kind, run:

```sh
curl http://<address>:8000/v1/models
```

The server sends a JSON object:

<!-- output: not run -->

```text
{"object":"list","data":[{"id":"qwen3.6-35b-a3b","object":"model",…}]}
```

The `data` list in the JSON that the server sends has the id `qwen3.6-35b-a3b`. If `curl` cannot connect, make sure that
the server listens on `0.0.0.0`. Also make sure that no firewall stops port 8000.

:::

## Converge the Instance again

Run:

```sh
jr2 up
```

`jr2 up` reads the new config and converges the cluster again. The namespace is there, so it does not ask this time.

::: tabs key:provider

== Anthropic

<!-- output: not run -->

```text
→ .env: ANTHROPIC_API_KEY
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
…
warning: secrets[0] (ANTHROPIC_API_KEY) is named by nothing; goes nowhere — no workspace() lists it, no Agent's provider reads it, and no Effect names it (ADR-0059, ADR-0068)
…
converged — `jr2 run <workflow>` when ready
```

The warning is correct for now. No [Workflow](../reference/glossary.md#workflow) has an Agent that names an `anthropic/`
model, so no pod gets the key.

The next page adds a Workflow with an Agent that names the model. On the next page, `jr2 up` gives the key to the
[Custodian](../reference/glossary.md#custodian) of the pod where the Agent works. The first
[Turn](../reference/glossary.md#turn) of the run is the first call to the model.

== Local

<!-- output: not run -->

```text
→ .env: LOCAL_MODEL_URL
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
…
provider: http://<address>:8000/v1 configured, but no carried Agent names a "local/…" model — skipped
…
converged — `jr2 run <workflow>` when ready
```

`jr2 up` skips the check of the provider for now. No [Workflow](../reference/glossary.md#workflow) has an Agent that
names a `local/` model, so there is no model to check.

The next page adds a Workflow with an Agent that names the model. On the next page, `jr2 up` checks the endpoint before
it converges. It is the first `jr2 up` that reaches the model.

:::

`jr2 up` replaced the [Orchestrator](../reference/glossary.md#orchestrator) pod, because `jr2.config.ts` is in the image
of the Instance. Thus the port forward of [Create an Instance](create-an-instance.md) stopped. Start it again in its
terminal:

```sh
kubectl -n my-instance port-forward svc/jr2-orchestrator 4000:4000
```

## What happened

::: tabs key:provider

== Anthropic

The API key is a [Held secret](../reference/glossary.md#held-secret). In this Instance, `jr2 up` gives its value only to
the Custodian of each pod whose Agents use an `anthropic/` model. The Custodian is a container next to the
[Harness](../reference/glossary.md#harness) container, where the Agent works. The Harness container holds only a
[Stand-in](../reference/glossary.md#stand-in): a value that is worth nothing outside the pod. The Custodian puts the
real key into each request to the Anthropic API. Thus the Agent never holds the key
([ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)).

To use a gateway or a different hosted provider, read
[Use a hosted provider or a gateway](../guides/use-a-hosted-provider.md).

== Local

`harness.provider` adds a custom provider to the [Harness](../reference/glossary.md#harness). The Harness speaks to it
over the OpenAI chat completions API
([ADR-0018](../reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)). When an Agent
names a `local/` model, `jr2 up` checks the endpoint from a pod in the cluster before it converges. It asks for the list
of models, and then for one tool call. If the check fails, `jr2 up` stops and says why.

This endpoint has no key, so jr2 permits plain `http://`. To add TLS and a key, read
[Use a local model](../guides/use-a-local-model.md).

:::

[Secrets and trust](../concepts/secrets-and-trust.md) explains where each secret goes, and who can use it.

## Next

[A model decides](a-model-decides.md).
