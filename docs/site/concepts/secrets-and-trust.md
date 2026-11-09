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
Agent can run each program of the image, and it can send what it reads out of the pod. If a model API key were in its
reach, the Agent could take it away. If the credential of the Orchestrator's API were in its reach, the Agent could
answer its own review [Gate](../reference/glossary.md#gate), or send a pick for a different Agent.

jr2 does not try to hide the API from the Agent. Instead, it keeps the credentials out of the Agent's reach. The
Instance token enters no Harness pod. Each credential of the `secrets` list, and the key of `harness.provider.apiKey`,
goes to a container in which the Agent executes nothing. [Architecture](architecture.md) tells where those containers
run. The Harness itself holds one secret value, and [Confined programs](#confined-programs) tells how jr2 keeps it from
the Agent's code.

## One list, and the name decides

[`jr2.config.ts`](../reference/config.md) has one [`secrets`](../reference/config.md#secrets) list. An entry goes to
each place that names it, and to no other place:

<<< @/examples/concepts/secrets-and-trust/jr2.config.ts

- A pod claims a Held secret when its [`workspace()`](../reference/authoring-surface/workspace.md) lists the name under
  `secrets`. A pod also claims the key of each provider that an Agent in that pod uses, and the `secret` of each MCP
  server that an Agent in that pod names.
- The [Instance Harness](../reference/glossary.md#instance-harness) claims only the model keys of the Menu-only Agents
  that it hosts, and the secrets of the MCP servers that they name.
- An Effect claims an Effect secret when it names it with [`secret()`](../reference/authoring-surface/secret.md). An
  `mcp` Effect claims the `secret` of its server for the
  [Instance Effector](../reference/glossary.md#instance-effector).
- A [Hook](../reference/glossary.md#hook) that checks a signature with a shared secret (`mac`) claims that secret for
  the Instance Effector, as an Effect does.
- One entry can be a Held secret and an Effect secret at the same time. The placement is a fact of each place that names
  it, not of the entry.
- An entry that nothing names goes nowhere, and [`jr2 up`](../reference/cli.md#up) warns about it.

[`harness.provider.apiKey`](../reference/config.md#harness-provider-apikey) is a Held secret too. Each pod whose Agents
use the custom provider claims it, and it goes only to the host of `harness.provider.baseUrl`.

`jr2 up` reads the values on your computer, from your shell or `.env`. It writes each value only into the Secrets of the
containers that hold it. An entry can also name a key of a Secret that you manage, with `valueFrom`.

## Held secrets

The Harness of a pod holds one Stand-in for each Held secret of the pod, in a file that only the Harness reads. jr2
makes a new Stand-in for each pod, and it is secret. It has a meaning only to the Custodian of that pod. A program of an
Agent gets the Stand-in of a Held secret only when the `workspace()` lists that secret under `secrets`. The fetch
Stand-in is the one public Stand-in (see below).

When a pod holds a Held secret other than the tokens of its Sandbox, the Harness container sends its HTTPS traffic
through the Custodian (`HTTPS_PROXY`). For each request to a host that a Held secret is bound to, the Custodian does
these things:

1. It ends the TLS connection with a certificate that `jr2 up` issued from the CA of the
   [Instance](../reference/glossary.md#instance).
2. It replaces the Stand-in with the value, in the headers that the entry names.
3. It opens its own TLS connection to the host, and verifies the certificate of the host.

Two Held secrets can go to one host in one header, such as the tokens of two MCP servers of one service. The Custodian
chooses the value by the Stand-in that the header holds. The Custodian sends the traffic to each other host with no
change. It refuses a loopback, link-local or unspecified address. A request to a bound host that has no Stand-in in its
headers does not leave the pod.

These fields of an entry bind a Held secret. They do not place it:

- [`hosts`](../reference/config.md#secrets-hosts): the hosts that the value can go to. A known model key with one
  default host, such as `ANTHROPIC_API_KEY`, can leave it out. It then goes only to the host of its provider. The
  `secret` of an MCP server can leave it out too. It then goes only to the host of the server's URL, in the header
  `authorization`.
- [`headers`](../reference/config.md#secrets-headers): the headers in which the Custodian replaces the Stand-in.
- [`paths`](../reference/config.md#secrets-paths): the path prefixes that the value can go to.

The Custodian also holds the two tokens of its [Sandbox](../reference/glossary.md#sandbox): the control token and the
fetch token.

- The Harness reads the [Menu](../reference/glossary.md#menu) and sends each pick with the control Stand-in, and the
  Custodian replaces it with the control token. The control Stand-in is secret. Only the Harness holds it, in a file
  that no program of an Agent can read. With each request, the Harness also tells which Agent the conversation is for,
  and the Orchestrator checks it.
- A `git fetch` in the Sandbox sends the fetch Stand-in, which is public. The Custodian replaces it with the fetch token
  only for a fetch. It refuses the fetch Stand-in for the Menu and for a pick.

The Instance Harness has a token of its own for the Menu. It runs no program of an Agent.

### What a Held secret does not stop

- **The Agent's code can spend a key that the `workspace()` lists.** While the pod lives, a program of the Agent can
  send requests through the Custodian to the bound host of that key. A key that can make new keys gives the Agent a key
  that it can take away. Use a key with no admin rights. Set narrow `paths`.
- **A response passes with no change.** If a host puts the full key in a response, the Agent reads it.
- **jr2 controls egress only at the cloud metadata addresses.** A client that does not use the Custodian sends only the
  Stand-in, which is worth nothing outside the pod. The cluster decides which hosts a pod can reach. One exception: a
  NetworkPolicy of jr2 stops each Harness pod at the metadata addresses of the large cloud providers (`169.254.169.254`,
  `fd00:ec2::254`, `169.254.170.2`, `169.254.170.23` and `100.100.100.200`). There, the metadata service of a node can
  give the node's cloud credential to a pod. The list is not complete for every provider, and only a CNI that enforces
  NetworkPolicy applies it. See
  [Move from kind to a shared cluster](../guides/move-from-kind-to-a-shared-cluster.md#check-the-cluster).
- **A key that signs the request cannot be a Held secret.** A SigV4 or ADC credential signs the request, and the
  Custodian cannot put a value into a signature. Use an Effect secret for such a credential. For a model provider, use a
  gateway that holds the credential, and make the key of the gateway a Held secret.
- **A tool must trust the CA of the Instance.** When a pod holds a Held secret other than the tokens of its Sandbox, jr2
  sets the trust variables of Node.js, OpenSSL, Python and git in its Harness container. A client that does not trust
  the CA, such as a Java client, cannot connect to a bound host. It sends nothing.

## Confined programs

The Harness runs the [Turns](../reference/glossary.md#turn) of each Agent of the Sandbox. The Harness process itself
runs only jr2's code. Each other process in the Harness container runs confined with Landlock: each command of the
Agent's shell, and so the tests, the builds, git and its hooks; the search tools; the I/O of the read, write and edit
tools; jr2's own git; each stdio MCP server; and each `command` Effect that names no Effect secret. Code that one Agent
writes in `/work` can run in a program of a different Agent, for example when a reviewer runs the tests of a coder. Thus
jr2 confines each such program, and not only the programs of one Agent.

All these programs are in one Landlock domain. They can see, signal and trace each other, as the programs of one user on
a computer can. Thus a later shell command can find and stop a server that an earlier command started. When the process
that starts these programs stops, the Harness starts it again, in a new domain. The programs of the old domain continue,
and a program of the new domain cannot trace them.

A confined program can do all that the user of the container can do, with these exceptions:

- It cannot read, write, make, remove, move or link a file in `/run/jr2`. That folder holds the control Stand-in, the
  Stand-in of each Held secret, the socket of the Custodian for the picks, and the conversations of the Harness. A
  program can list the names in `/run/jr2`, as it can list each folder: `ls /` and `find /` work. The names are not
  secrets. Two folders there it can read and not change. `/run/jr2/output`: when the output of a `bash` call is too
  long, the Harness writes all of it to a file there, and the result gives the path of that file.
  `/run/jr2/user-context`: the image user's `~/.pi/agent`, when the image has one, which jr2 reads for the
  [project context](agents-and-turns.md#the-project-context).
- It cannot make a socket in `/run/jr2`. It can connect to the socket of the Custodian, but the Custodian refuses each
  request on the socket that does not have the control Stand-in, and the program cannot read that Stand-in.
- It cannot trace the Harness process, or read its environment or its memory.
- When the kernel has Landlock ABI 6 or later, it cannot send a signal to the Harness process, or connect to an abstract
  Unix socket that the Harness or the Custodian made.

Thus a program can write in a folder of the image that its user owns, move a file from one folder to another, and run
the tools of the image. The kernel keeps the shared parts safe: the caches of each [Repo](../reference/glossary.md#repo)
at `/repos`, the runtime of jr2 at `/opt/jr2` and the CA bundles are read-only. The pod has no ServiceAccount token. A
program can connect to each address that the pod can reach.

The environment of a confined program is the environment with which the container started: the `ENV` of the image,
`harness.env`, `harness.envFrom`, and the proxy and trust variables. jr2 removes its own `JR2_` names from it, except
`JR2_CUSTODIAN_URL`. jr2 adds `HOME`, `TMPDIR` and the Stand-in of each Held secret that the `workspace()` lists, under
the name of that secret. jr2 also adds `safe.bareRepository=explicit` for git, in `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, after the image's own entries (see
[What the image must have](../guides/add-tools-to-the-sandbox.md#what-the-image-must-have)). The environment holds no
control Stand-in. It holds the Stand-in of a model key only when the `workspace()` lists that key. Thus code in `/work`
cannot call the model with your key unless you allow it. jr2 records the use of each Turn, and a call that you did not
allow cannot go around that record.

The read, write and edit tools reach the same paths as the shell. A path in `/run/jr2`, or a link to one, gives the
error of a file that the user cannot read. In a path, `~` is the `HOME` of the confined programs.

The [project context](agents-and-turns.md#the-project-context) (`AGENTS.md`, `CLAUDE.md` and the skills of a Worktree,
or of `/work`) is read by a confined program too. Thus an `AGENTS.md` that links to a file in `/run/jr2` gives no text
to the model. In the image user's `~/.pi/agent`, which the pod mounts read-only from the image, that program reads only
the context file and the skills, and not `auth.json`. It reads them in `/run/jr2/user-context`, a second mount of that
directory, which a confined program cannot move.

The Harness process has its own `HOME`, in `/run/jr2`, from before Node starts. Thus a file that a program writes in its
`HOME`, such as `~/.aws/config` or a module in `~/.node_modules`, does not change what the Harness process does. The
Harness does not start when Node would look for a module outside `/opt/jr2` and `/run/jr2`.

The Harness process gets only the env that jr2 composes: `harness.env`, `harness.envFrom`, the proxy and trust
variables, and jr2's own names. It does not get the `ENV` of the image. It also does not get a name that loads code from
a path, such as `NODE_OPTIONS`, `LD_PRELOAD` or `OPENSSL_CONF`, from any of them. Thus an image with
`NODE_OPTIONS=--require /app/hook.js` changes the Agent's programs, as you expect, and not the Harness process. In
`kubectl exec`, each key of `harness.envFrom` has the prefix `JR2_ENVFROM_`. The programs of the Agent see each key
under its own name. A name that starts with `JR2_` is jr2's own: `jr2 up` refuses one in `harness.env` or in a Secret or
a ConfigMap that `harness.envFrom` loads, and the Harness does not start with one from `harness.envFrom`.

Thus code in `/work` cannot send a pick for an Agent, also when a different Agent runs it. An Agent can still try to
change what a different Agent does with the text that it writes, such as a comment in a file. The other Agent's model
decides each of its own picks.

jr2 needs Landlock in the kernel of each node. See [Rules](#rules).

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
Orchestrator matches a Repo to an entry, and names the Secret of that entry. It never reads a git credential:

- The clone credential goes into a Secret that only the Repo cache reads. The Repo cache also gets the Git LFS files
  with it, and sends it only to the origin of the Repo ([Architecture](architecture.md#large-files-in-the-repo-cache)).
- The push credential and the signing key go to the [Sandbox Effector](../reference/glossary.md#sandbox-effector) of the
  Sandbox whose `push` Effect uses them.

The list is also a fence. A Repo url that comes from the run input must match an entry, or the Orchestrator refuses to
make the Sandbox. [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md) gives the fields.

## The tokens

jr2 makes its own tokens. `jr2 up` makes the Instance token and the signing key the first time, and keeps them in the
`jr2-instance` Secret. Each token of a pod comes from the signing key, so the Orchestrator stores no token for each pod.

| Token              | Who holds it                                                                                    | What it lets the holder do                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance token     | You and the CLI, through the Kubernetes API                                                     | Everything: start a run, read its full state, answer a Gate, cancel a run, and the routes that no scope opens.                                                                                                                                              |
| Named Caller token | A [Caller](../reference/glossary.md#caller) that has no access to the cluster, such as a CI job | The scopes that `callers.tokens` gives its name, for the Workflows that each scope names.                                                                                                                                                                   |
| Control token      | The Custodian of one Sandbox, as a file                                                         | Read the Menu and send the picks of the Agents in that Sandbox, for the Agent that the Harness names.                                                                                                                                                       |
| Fetch token        | The Custodian of one Sandbox, as a file                                                         | Ask for a fetch, or for the large files, of a Repo that the Sandbox mounts.                                                                                                                                                                                 |
| Harness bearer     | The Orchestrator. The Harness holds only its SHA-256 digest.                                    | Call the Harness in one pod: start a Turn, read it, stop it, set up a Worktree, run a `command` Effect, and carry a Handoff's files from one Harness to another ([ADR-0080](../reference/decisions/0080-a-nested-workspace-takes-a-handoff-at-its-cut.md)). |
| Effector key       | The Orchestrator, and the Effector of one placement                                             | Sign a request to that Effector, and sign its answer.                                                                                                                                                                                                       |

- The Instance token enters no Harness pod. The CLI reads it from the `jr2-instance` Secret over the Kubernetes API.
  Thus Kubernetes RBAC decides who holds it. The CLI is the Caller `token/instance`. It also sends the name of your
  Kubernetes user, and the run records it as the party that the Caller acts for.
- [`callers.tokens`](../reference/config.md#callers-tokens) declares each named Caller token. `jr2 up` makes its value
  one time, in a Secret of its own, `jr2-caller-<name>`. The Orchestrator holds only the SHA-256 digest of each value,
  in the `jr2-caller-digests` Secret, which it mounts. `jr2 caller token <name>` prints the value, which it reads over
  the Kubernetes API.
- `jr2 caller rotate <name>` makes a new value. The Orchestrator reads the digests again when the mount changes. The
  kubelet updates the mount in about one minute, and `jr2 caller rotate` waits for it. When it returns, the old value no
  longer works. No pod restarts.
- When `callers.tokens` no longer declares a name, the next `jr2 up` deletes its Secret, and its value stops working.
- A control token or a fetch token cannot answer a Gate, and cannot speak for a different pod. The Orchestrator accepts
  each one only on its own routes. Thus an Agent cannot approve its own work, and a Sandbox cannot send a pick for an
  Agent in a different Sandbox. No token of a pod is a Caller.
- A Harness can check its bearer, but it cannot make a bearer. Thus an Agent cannot drive a conversation in a different
  pod.

[Callers and Hooks](callers-and-hooks.md) tells how jr2 knows a Caller, and what each scope opens.
[Give a Caller a scope](../guides/give-a-caller-a-scope.md) declares a named Caller token and uses it.

## Open observation, guarded control

Each route of the [HTTP API](../reference/http-api.md) is in one of these access bands:

- [**Open**](../reference/http-api.md#band-open), with no token: the [Workflows](../reference/glossary.md#workflow), the
  structure of each Machine, and the live runs of a Workflow with their states. An open route shows no context of a run,
  and an [Emit](../reference/glossary.md#emit) shows only its type.
- [**Authenticated**](../reference/http-api.md#band-authenticated), with the Instance token or a token of a Sandbox: the
  routes of the Agent's Menu and the fetch. A token of a Sandbox reaches only its own routes, in its own pod.
- [**A Caller with a scope**](../reference/http-api.md#band-guarded): the start of a run, the full state of a run, the
  Gates, and cancel. Each route needs one scope of a Caller (`start`, `read`, `answer`, `cancel` or `steer`) for the
  Workflow of the run. The Instance token has each scope for each Workflow. A named Caller token has the scopes that its
  entry gives it. A token of a Sandbox is not a Caller.
- [**Instance token only**](../reference/http-api.md#band-instanceonly): the routes that no scope opens, such as a
  runtime Chart, the report of the Repos and the log of a Hook (`GET /hooks/:name`).
- [**A Hook's verifier**](../reference/http-api.md#band-hook), with no bearer token: `POST /hooks/:name`. The verifier
  of the Hook checks each delivery.

Thus the Console shows the Machines and the runs without a token. When you type a Caller's token in the Console, or log
in at an issuer that the Instance declares, the Console also shows the controls that the Caller's scopes open: start,
the Gates, cancel and steer. The Console keeps the credential in the session storage of the browser tab, and forgets it
when you close the tab. [Open the Console](../guides/open-the-console.md) tells how.

"Open" means open to each caller that can reach the Service of the Orchestrator: a port forward, a pod in the cluster,
or an ingress. The names of the states and the types of the Emits are open.

The Harness writes each Agent's conversation to its container log. The log has the prompts, the model's text and
thinking, its tool calls and the answers to its picks. It does not write the results of the Working tools or of the MCP
tools. Each person who can read the pod logs of the namespace can read these conversations.

The Orchestrator also keeps each conversation, with the same cut, for `runs.retain` (30 days by default). Thus the kept
copy has the same residual as the log: an answer to a pick can carry a held value that an upstream wrote into a
`command` output, or a secret in a form that the scrub does not catch. A Caller with `read` on the Workflow can read the
kept copy with `GET /runs/:runId/conversations`.

## Rules

- A model key goes in the `secrets` list. `jr2 up` refuses a known model key in `harness.env`, or in a Secret or a
  ConfigMap that `harness.envFrom` names.
- A Held secret goes only over `https://`. `jr2 up` refuses `harness.provider.apiKey` when `harness.provider.baseUrl` is
  not `https://`. A local model over plain `http://` has no key.
- [`harness.env`](../reference/config.md#harness-env) and `harness.envFrom` put each value into the Harness container,
  and the Agent can read it. Put a credential in the `secrets` list.
- A file that the Harness process reads, such as the one that `AWS_CONFIG_FILE` or `GOOGLE_APPLICATION_CREDENTIALS`
  names in `harness.env`, cannot be in `/work`, `/tmp`, `/dev/shm` or `/home/jr2`: `jr2 up` refuses it. In another
  folder, `jr2 up` gives a warning: make sure that the user of the Sandbox cannot write the file.
- A Held secret must name its `hosts`, unless it is a known model key with one default host, or the `secret` of an MCP
  server.
- An MCP server with a `secret` has an `https://` URL. When an entry sets `hosts`, `headers` or `paths`, they must let
  the Stand-in through to the URL of each server that names the entry.
- A name that a `workspace()` lists must be in the `secrets` list. A name that an Effect gives to `secret()` must be in
  it too.
- An Effect secret has 8 characters or more.
- The name of a Held secret is an env var name. It cannot start with `JR2_`, and it cannot be a proxy or trust variable.
- The Orchestrator can make and change a Secret, but it cannot get or list one.
- A changed value does not reach a live Sandbox. A new Sandbox gets it. When a Menu-only Agent uses the value, the next
  `jr2 up` restarts the Instance Harness with it.
- jr2 needs Landlock ABI 3 or later in the kernel of each Sandbox node: Linux 6.2 or later, or a kernel with a backport,
  with `landlock` in its list of security modules. `jr2 up` refuses to converge while a Sandbox node has no Landlock, or
  only ABI 1 or 2. On a node without it, a Harness or a Sandbox Effector does not start, and the provision of the
  Sandbox fails.
- A name in `harness.env`, or a key that `harness.envFrom` loads, cannot start with `JR2_`.
- When a pod holds a Held secret other than the tokens of its Sandbox, `SSL_CERT_FILE` and the other trust variables
  replace the trust store of the image. They hold the public roots, `harness.caBundle` and the CA of the Instance. Thus
  a private CA goes in [`harness.caBundle`](../reference/config.md#harness-cabundle), not in the image.
- `jr2 up` makes the CA of the Instance one time, in the `jr2-held-ca` Secret, and never changes it. No pod mounts that
  Secret. When you delete it, the next `jr2 up` makes a new CA.

## Read next

- [Give a Caller a scope](../guides/give-a-caller-a-scope.md)
- [Use a local model](../guides/use-a-local-model.md)
- [Use a hosted provider or a gateway](../guides/use-a-hosted-provider.md)
- [Give the cluster git credentials](../guides/give-the-cluster-git-credentials.md)
- [Run a command or call a URL with an Effect](../guides/run-a-command-or-call-a-url.md)
- [Give an Agent MCP tools](../guides/give-an-agent-mcp-tools.md)
- [Open the Console](../guides/open-the-console.md)
- [Callers and Hooks](callers-and-hooks.md), [Architecture](architecture.md) and [Effects](effects.md)
- The [`secrets`](../reference/config.md#secrets), [`git`](../reference/config.md#git) and
  [`harness`](../reference/config.md#harness) fields of `jr2.config.ts`,
  [`secret()`](../reference/authoring-surface/secret.md), and the [HTTP API](../reference/http-api.md)
- [ADR-0013](../reference/decisions/0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md),
  [ADR-0014](../reference/decisions/0014-observation-is-open-run-state-is-not.md),
  [ADR-0023](../reference/decisions/0023-the-harness-prints-the-conversation.md),
  [ADR-0032](../reference/decisions/0032-the-console-unlocks-with-a-callers-credential.md),
  [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md),
  [ADR-0058](../reference/decisions/0058-a-harness-answers-the-orchestrator-alone.md),
  [ADR-0059](../reference/decisions/0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md),
  [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md),
  [ADR-0076](../reference/decisions/0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md),
  [ADR-0077](../reference/decisions/0077-jr2-requires-landlock-on-every-sandbox-node.md) and
  [ADR-0079](../reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)
