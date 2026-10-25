---
title: Secrets and trust
description: Where jr2 keeps each credential, which tokens it makes, and what a caller can see and do without one.
---

jr2 keeps each credential of the `secrets` list, the key of `harness.provider.apiKey`, and each token of its own, out of
the containers in which an [Agent](../reference/glossary.md#agent) executes code. A
[Held secret](../reference/glossary.md#held-secret) is a credential that the [Harness](../reference/glossary.md#harness)
uses through its pod's [Custodian](../reference/glossary.md#custodian), and the Harness container holds only its
[Stand-in](../reference/glossary.md#stand-in). An [Effect secret](../reference/glossary.md#effect-secret) is a
credential that an [Effect](../reference/glossary.md#effect) uses, and only an
[Effector](../reference/glossary.md#effector) holds its value. jr2 also makes its own tokens, for each caller of the
[Orchestrator](../reference/glossary.md#orchestrator) and of each Harness. Without a token, a caller can see each
[Machine](../reference/glossary.md#machine) and where each live run is in it, but it cannot control a run.

## Why it exists

An Agent's [Working tools](../reference/glossary.md#working-tools) give it a shell in the Harness container. Thus the
Agent can read each variable and each file of that container, and it can send them out of the pod. If a model API key
were in that container, the Agent could take it away. If the credential of the Orchestrator's API were there, the Agent
could answer its own review [Gate](../reference/glossary.md#gate).

jr2 does not try to hide the API from the Agent. Instead, it keeps the credentials out of that container. The Instance
token enters no Harness pod. Each credential of the `secrets` list, and the key of `harness.provider.apiKey`, goes to a
container in which the Agent executes nothing. [Architecture](architecture.md) tells where those containers run.

## One list, and the name decides

[`jr2.config.ts`](../reference/config.md) has one [`secrets`](../reference/config.md#secrets) list. An entry goes to
each place that names it, and to no other place:

<<< @/examples/concepts/secrets-and-trust/jr2.config.ts

- A pod claims a Held secret when its [`workspace()`](../reference/authoring-surface/workspace.md) lists the name under
  `secrets`. A pod also claims the key of each provider that an Agent in that pod uses.
- The [Instance Harness](../reference/glossary.md#instance-harness) claims only the model keys of the Menu-only Agents
  that it hosts.
- An Effect claims an Effect secret when it names it with [`secret()`](../reference/authoring-surface/secret.md).
- One entry can be a Held secret and an Effect secret at the same time. The placement is a fact of each place that names
  it, not of the entry.
- An entry that nothing names goes nowhere, and [`jr2 up`](../reference/cli.md#up) warns about it.

[`harness.provider.apiKey`](../reference/config.md#harness-provider-apikey) is a Held secret too. Each pod whose Agents
use the custom provider claims it, and it goes only to the host of `harness.provider.baseUrl`.

`jr2 up` reads the values on your computer, from your shell or `.env`. It writes each value only into the Secrets of the
containers that hold it. An entry can also name a key of a Secret that you manage, with `valueFrom`.

## Held secrets

The Harness container of a pod gets one variable for each Held secret of the pod. Its value is the Stand-in,
`jr2-held-<NAME>`. The Stand-in is the same in each pod, and it is not secret. It has a meaning only to the Custodian of
that pod.

When a pod holds a Held secret other than the Sandbox token, the Harness container sends its HTTPS traffic through the
Custodian (`HTTPS_PROXY`). For each request to a host that a Held secret is bound to, the Custodian does these things:

1. It ends the TLS connection with a certificate that `jr2 up` issued from the CA of the
   [Instance](../reference/glossary.md#instance).
2. It replaces the Stand-in with the value, in the headers that the entry names.
3. It opens its own TLS connection to the host, and verifies the certificate of the host.

The Custodian sends the traffic to each other host with no change. It refuses a loopback, link-local or unspecified
address. A request to a bound host that has no Stand-in in its headers does not leave the pod.

These fields of an entry bind a Held secret. They do not place it:

- [`hosts`](../reference/config.md#secrets-hosts): the hosts that the value can go to. A known model key with one
  default host, such as `ANTHROPIC_API_KEY`, can leave it out. It then goes only to the host of its provider.
- [`headers`](../reference/config.md#secrets-headers): the headers in which the Custodian replaces the Stand-in.
- [`paths`](../reference/config.md#secrets-paths): the path prefixes that the value can go to.

The Custodian also holds the Sandbox token of its pod, and the Harness container holds only its Stand-in. Each
[Sandbox](../reference/glossary.md#sandbox) and the Instance Harness has a Sandbox token. The Harness reads the
[Menu](../reference/glossary.md#menu) and sends each pick with the Stand-in of that token, and the Custodian replaces
it.

### What a Held secret does not stop

- **The Agent can spend the key.** While the pod lives, the Agent can send requests through the Custodian to a bound
  host. A key that can make new keys gives the Agent a key that it can take away. Use a key with no admin rights. Set
  narrow `paths`.
- **A response passes with no change.** If a host puts the full key in a response, the Agent reads it.
- **jr2 does not control egress.** A client that does not use the Custodian sends only the Stand-in, which is worth
  nothing outside the pod. The cluster decides which hosts a pod can reach.
- **A key that signs the request cannot be a Held secret.** A SigV4 or ADC credential signs the request, and the
  Custodian cannot put a value into a signature. Use an Effect secret for such a credential. For a model provider, use a
  gateway that holds the credential, and make the key of the gateway a Held secret.
- **A tool must trust the CA of the Instance.** When a pod holds a Held secret other than the Sandbox token, jr2 sets
  the trust variables of Node.js, OpenSSL, Python and git in its Harness container. A client that does not trust the CA,
  such as a Java client, cannot connect to a bound host. It sends nothing.

## Effect secrets

An Effect secret is the real value, in an Effector. The Effector reads the value and puts it into the call, or into the
environment of a `command`. The Agent executes nothing in the Effector, and the Orchestrator never holds the value.
[Effects](effects.md) tells which Effects run in which Effector.

A `command` that names an Effect secret can run the Agent's code, such as `npm run deploy`. It runs on a copy of one
commit of the Agent's branch, in its scratch folder. Because the command can run the Agent's code, the Effector confines
the process of the command with Landlock. The process can read and run the system files of the image. It can use its own
scratch folder, and read the Effect secrets that the command names. It cannot read the Effector's key, the other Effect
secrets, the push credentials or the [Worktree](../reference/glossary.md#worktree).

The Effector removes each Effect secret that it holds from what it returns, in the forms that it sent and in common
encodings. It does not find a changed form of an Effect secret, such as a hash or a part of it.

## Git credentials

The [`git.credentials`](../reference/config.md#git-credentials) entries give the cluster its git credentials. The
Orchestrator matches a [Repo](../reference/glossary.md#repo) to an entry, and names the Secret of that entry. It never
reads a git credential:

- The clone credential goes into a Secret that only the Repo cache reads.
- The push credential and the signing key go to the [Sandbox Effector](../reference/glossary.md#sandbox-effector) of the
  Sandbox whose `push` Effect uses them.

The list is also a fence. A Repo url that comes from the run input must match an entry, or the Orchestrator refuses to
make the Sandbox. [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md) gives the fields.

## The tokens

jr2 makes its own tokens. `jr2 up` makes the Instance token and the signing key the first time, and keeps them in the
`jr2-instance` Secret. Each other token comes from the signing key, so the Orchestrator stores no token for each pod.

| Token          | Who holds it                                                                                         | What it lets the holder do                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance token | You, the CLI, the [Console](../reference/glossary.md#console) when you type it, and a webhook client | Everything: start a run, read its full state, answer a Gate, cancel a run.                                                                   |
| Sandbox token  | The Custodian of one pod, as a file                                                                  | Read the Menu and send the picks of the Agents in that pod. Ask for a fetch of a Repo that the Sandbox mounts.                               |
| Harness bearer | The Orchestrator. The Harness holds only its SHA-256 digest.                                         | Call the Harness in one pod: start a [Turn](../reference/glossary.md#turn), read it, stop it, set up a Worktree, and run a `command` Effect. |
| Effector key   | The Orchestrator, and the Effector of one placement                                                  | Sign a request to that Effector, and sign its answer.                                                                                        |

- The Instance token enters no Harness pod. The CLI reads it from the `jr2-instance` Secret over the Kubernetes API.
  Thus Kubernetes RBAC decides who holds it.
- A Sandbox token cannot answer a Gate and cannot speak for a different pod. Thus an Agent cannot approve its own work,
  and a Sandbox cannot send a pick for an Agent in a different Sandbox.
- A Harness can check its bearer, but it cannot make a bearer. Thus an Agent cannot drive a conversation in a different
  pod.

## Open observation, guarded control

Each route of the [HTTP API](../reference/http-api.md) is in one of three access bands:

- [**Open**](../reference/http-api.md#band-open), with no token: the [Workflows](../reference/glossary.md#workflow), the
  structure of each Machine, and the live runs of a Workflow with their states. An open route shows no context of a run,
  and an [Emit](../reference/glossary.md#emit) shows only its type.
- [**Authenticated**](../reference/http-api.md#band-authenticated), with the Instance token or a Sandbox token: the
  routes of the Agent's Menu and the fetch. A Sandbox token reaches only what its own pod owns.
- [**Instance token only**](../reference/http-api.md#band-instanceonly): the start of a run, the full state of a run,
  the Gates, and cancel.

Thus the Console shows the Machines and the runs without a token. When you type the Instance token in the Console, it
can also start runs and answer Gates. The Console keeps the token in the session storage of the browser tab, and forgets
it when you close the tab.

"Open" means open to each caller that can reach the Service of the Orchestrator: a port forward, a pod in the cluster,
or an ingress. The names of the states and the types of the Emits are open.

The Harness writes each Agent's conversation to its container log. The log has the prompts, the model's text and
thinking, its tool calls and the answers to its picks. It does not write the results of the Working tools. Each person
who can read the pod logs of the namespace can read these conversations.

## Rules

- A model key goes in the `secrets` list. `jr2 up` refuses a known model key in `harness.env`, or in a Secret or a
  ConfigMap that `harness.envFrom` names.
- A Held secret goes only over `https://`. `jr2 up` refuses `harness.provider.apiKey` when `harness.provider.baseUrl` is
  not `https://`. A local model over plain `http://` has no key.
- [`harness.env`](../reference/config.md#harness-env) and `harness.envFrom` put each value into the Harness container,
  and the Agent can read it. Put a credential in the `secrets` list.
- A Held secret must name its `hosts`, unless it is a known model key with one default host.
- A name that a `workspace()` lists must be in the `secrets` list. A name that an Effect gives to `secret()` must be in
  it too.
- An Effect secret has 8 characters or more.
- The name of a Held secret is an env var name. It cannot start with `JR2_`, and it cannot be a proxy or trust variable.
- The Orchestrator can make and change a Secret, but it cannot get or list one.
- A changed value does not reach a live Sandbox. A new Sandbox gets it. When a Menu-only Agent uses the value, the next
  `jr2 up` restarts the Instance Harness with it.
- A `command` that names an Effect secret needs Landlock in the kernel of the node. On a node without it, the Effector
  does not start, and the provision of the Sandbox fails.
- When a pod holds a Held secret other than the Sandbox token, `SSL_CERT_FILE` and the other trust variables replace the
  trust store of the image. They hold the public roots, `harness.caBundle` and the CA of the Instance. Thus a private CA
  goes in [`harness.caBundle`](../reference/config.md#harness-cabundle), not in the image.
- `jr2 up` makes the CA of the Instance one time, in the `jr2-held-ca` Secret, and never changes it. No pod mounts that
  Secret. When you delete it, the next `jr2 up` makes a new CA.

## Read next

- [Use a local model](../guides/use-a-local-model.md)
- [Use a hosted provider or a gateway](../guides/use-a-hosted-provider.md)
- [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md)
- [Run a command or call a URL with an Effect](../guides/run-a-command-or-call-a-url.md)
- [Open the Console](../guides/open-the-console.md)
- [Architecture](architecture.md) and [Effects](effects.md)
- The [`secrets`](../reference/config.md#secrets), [`git`](../reference/config.md#git) and
  [`harness`](../reference/config.md#harness) fields of `jr2.config.ts`,
  [`secret()`](../reference/authoring-surface/secret.md), and the [HTTP API](../reference/http-api.md)
- [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md),
  [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md),
  [ADR-0023](../reference/decisions/0023-the-harness-prints-the-conversation.md),
  [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-the-instance-token.md),
  [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md),
  [ADR-0058](../reference/decisions/0058-a-harness-answers-the-orchestrator-alone.md),
  [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md) and
  [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)
