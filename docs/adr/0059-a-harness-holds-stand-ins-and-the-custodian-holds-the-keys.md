# A Harness holds stand-ins; the Custodian holds the keys

[ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md) recorded an open gap: model API keys were in the Harness
container. `JR2_PROVIDER_API_KEY` and literal `harness.env` values (for example `ANTHROPIC_API_KEY`) came from the
`jr2-harness-env` Secret by `envFrom`. Working tools give the Agent code execution in that container, and every tool
child inherits the env. So the Agent could read a key and send it out of the pod. Dropping pi's catalog was not an
option: the user's real setup is Bedrock through a LiteLLM gateway, with a fixed `ANTHROPIC_API_KEY` and `anthropic/…`
models, and the catalog holds the limits, costs and thinking levels of those models.

The same problem had one solution already, for one credential. The Adapter held the Sandbox token in a container the
Agent executes nothing in ([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)). This
decision generalizes that container. The Custodian holds every credential that a Harness uses, outside every Sandbox,
and it replaces the Adapter.

## Decision

- **A held secret is a credential the Harness uses and never holds.** The Harness process holds its **Stand-in**. It
  means something only to the Custodian, and only toward a host the secret is bound to. It is unique per name, it is a
  valid header and env value, and it never contains `sk-ant-oat` (pi reads such a key as an Anthropic OAuth token). The
  word is not "placeholder", because that is the word of an Open part.
- **Every Stand-in is secret, except the fetch Stand-in.** The pod's maker mints each Stand-in for its pod with the
  signing key, and no process can guess it: the Orchestrator for a Sandbox, and `jr2 up` for the Instance Harness, as it
  writes that pod's other Secrets (the Instance Effector's key too), and for a check pod
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). Only the Harness process holds the
  Stand-ins. It holds each one, the control Stand-in included, as a file under `/run/jr2/` that no process it confines
  can read, and never in the Harness container's env. It gives a model key's Stand-in to the engine in-process. A
  process that the Harness confines gets in its env only the Stand-ins of the secrets that its `workspace()`'s `secrets`
  list grants ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). So the
  Stand-in of a model key is in reach of the Harness process alone, unless the author grants that key. Secrecy matters
  because confinement makes it hold: a Stand-in that Workspace code can guess lets that code spend the secret. A call
  that code in `/work` makes to the model directly is outside the Turn's Settlement, so it escapes the usage that jr2
  records ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)) and each
  ceiling on spend. A project whose own code needs a model gets a key that the author grants on purpose. The fetch
  Stand-in stays public (below): it can only ask for a fetch, for its own Sandbox.
- **The Custodian holds them, outside every Sandbox.** There is one Custodian for each Instance
  ([ADR-0084](0084-a-sandboxs-only-network-leads-to-the-custodian.md)). It holds the held secrets of each Harness pod
  (below), and for a Sandbox Effector the value of each bearer, Basic or header secret and of its HTTPS push token
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). So the real value of a held secret is
  never in a Sandbox, unless an Effect of that Sandbox's Effector also names it as a value that it keeps (a signing key,
  a credentialed command's secret). Each Harness pod is behind a Fence — a Sandbox, the Instance Harness
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)) and each check pod
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)) — so each of its connections arrives at the
  Custodian, whatever address a process dials, and no tool needs a setting to use it. No Agent executes code in the
  Custodian, so no Agent can read its env, its files or its memory. Its engine is Envoy: the upstream distroless image,
  pinned by digest (`CUSTODIAN_IMAGE` in `@jr2/orchestrator`). It has one set of rules for each Harness pod, and the
  pod's maker writes them from the manifest that `jr2 up` declares (see "Objects, per pod"): the Orchestrator a
  Sandbox's at provision, and `jr2 up` those of the Instance Harness and of a check pod. No Harness pod reaches an admin
  listener or a configuration source of the Custodian, so nothing in a Harness pod can change its configuration or read
  it back.
- **The Custodian replaces the Adapter.** The `@jr2/adapter` package and the `jr2-adapter` image are deleted. A
  Sandbox's two tokens are held secrets of the kit's own (ADR-0013). The Custodian holds the control token and the fetch
  token of each Sandbox, and the control token of the Instance Harness, which `jr2 up` mints as that pod's maker (it
  serves no fetch). No container of a Harness pod mounts a token, and the real tokens never leave the Custodian. A pod's
  Stand-ins are in a Secret of its own, `<sandbox>-token` (the Instance Harness: `jr2-instance-harness-token`), which
  the Harness container mounts as files; so it is never `jr2-instance`, which holds the Instance token and the signing
  key.
  - The **control Stand-in** is secret, as every Stand-in but one. The Harness process alone holds it, as a file under
    `/run/jr2/` that no process it confines can read, and no `secrets` list can grant it: it is in no child's env
    (ADR-0076). The Custodian puts the control token in its place on the agent routes. There is one control Stand-in for
    each Sandbox, whatever the count of its Agents.
  - The **fetch Stand-in** is public, `jr2-held-JR2_SANDBOX_TOKEN`. `jr2-upload-pack` holds it as a constant. The
    Custodian puts the fetch token in its place on the fetch route alone, and refuses it on every agent route.
- **The Harness reads its Menu itself.** No MCP carries the Menu. For each Submission, `menu.ts` reads
  `GET /agents/<iid>/surface` and delivers a pick with `POST /agents/<iid>/events`, both to the Custodian at a name of
  jr2's own (below), with the control Stand-in as the bearer and the slot it states for the conversation (ADR-0076).
  `menu-tools.ts` gives pi each accepted event as a tool. The tool names stay `mcp__jr2__<event>`, because shipped
  instructions and the printer depend on them; the name is not a transport. `menu-tools.ts` adds the prefix, and
  `menu.ts` keeps the bare name, because an MCP client adds `mcp__<server>__` itself. The Harness keeps what the Adapter
  did: a turn that is over is never prompted ([ADR-0026](0026-a-turn-that-is-over-is-never-prompted.md)), a receipt is
  prose ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md),
  [ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)), the surface read retries
  on the ladder with the `jr2.routability` line
  ([ADR-0042](0042-ready-is-not-routable-an-admission-retries-its-connection.md)), and a `poll` event refuses the turn
  (`deferred` is retired, ADR-0006). The event's own JSON Schema is the tool's parameters, so the model sees the
  contract the Orchestrator validates against.
- **The Custodian forwards six routes to the Orchestrator, and no other.** Plain HTTP, to the Orchestrator's Service
  (`jr2-orchestrator.<ns>.svc:4000`, in the Custodian's configuration):

  ```
  GET  /agents/<iid>/surface          → the same path     the Menu
  POST /agents/<iid>/events           → the same path     a pick
  GET  /agents/<iid>/deliveries/<id>  → the same path     an outstanding pick's answer (ADR-0024)
  POST /agents/<iid>/notices          → the same path     a step boundary's notices heard (ADR-0062, ADR-0076)
  POST /agents/<iid>/conversation     → the same path     a batch of the conversation's entries (ADR-0023)
  POST /fetch                         → /sandboxes/<the calling Sandbox>/fetch    the ask (ADR-0053)
  anything else                       → 404, from the Custodian
  ```

  The five agent routes are HTTPS to a name of jr2's own, which the Harness gets as `JR2_CUSTODIAN_URL`. In each Harness
  pod, the Custodian's resolver answers that name (ADR-0084), and it is an Intercepted host: the Custodian ends its TLS
  with a leaf of the pod's CA (see "Certificates"; a Sandbox's CA key is deleted before the pod starts). So the Harness
  sends the control Stand-in only to a peer that holds that leaf, and no process in the pod can take the Custodian's
  place. The fetch route also reaches the Custodian through the Fence, at a name of jr2's own; `jr2-upload-pack` asks
  there, from the domain and from the User Container. Each process of the Sandbox reaches the Custodian by the same path
  as the Harness. A process that the Harness confines holds no control Stand-in, so the Custodian refuses each agent
  route that it asks for, with the fetch Stand-in or with none.

  A read — the surface, a delivery's poll — an acknowledgment of notices, which marks them heard however often it lands,
  and a batch of the conversation's entries, whose `seq`s make a second send add nothing (ADR-0023), are retried on any
  reset; a pick and the ask only on a reset before they were sent, so one the Orchestrator may have read is not sent
  twice. A poll holds up to about 25 s, far below the listener's 3600 s idle limit, so an outstanding pick never rides
  one long request (ADR-0002).

  On each forwarded request, the Custodian swaps `Authorization: Bearer <Stand-in>` for the token of that route — the
  control token on an agent route, the fetch token on the fetch route — and removes every other credential header. A
  request without the Stand-in of its route gets 403. The ask's path comes from the pod's rules, because the Custodian
  knows which Harness pod sent each connection (ADR-0084); the Instance Harness has no fetch token, and the ask gets 404
  there. The route list is the second layer. The control stays in the Orchestrator: the token's scope, the live
  registration, and the event's name and payload are judged there, as before (ADR-0013). The Orchestrator also accepts
  each token on its own routes only, and checks the slot that the Harness states against the registration's (ADR-0076).

- **Model keys go the same way, over HTTPS.** In each Harness pod, the Fence brings each connection to the Custodian
  (ADR-0084), so jr2 sets no proxy variable. A host that a held secret is bound to is an Intercepted host, so the
  Harness container gets the trust variables (see "Trust"):

  ```sh
  NODE_EXTRA_CA_CERTS=/etc/jr2/ca/extra.crt
  SSL_CERT_FILE / REQUESTS_CA_BUNDLE / GIT_SSL_CAINFO=/etc/jr2/ca/bundle.crt
  ```

  Each Harness container gets them, the Instance Harness's too, because the name of the agent routes is an Intercepted
  host of every Harness pod (above). They ride `env`, after `harness.env` and before the wire's digest. This is the
  Harness container's env, and it holds no Stand-in: the Stand-ins are files (above). A process that the Harness
  confines gets an explicit env instead, which holds only the Stand-ins that its `workspace()` grants (ADR-0076).

- **The name decides, and the Custodian dials it.** The Custodian takes a connection's target from the placeholder
  address that the Sandbox dialed, and from its port: the name that the address stands for in that Sandbox, lowercased
  and without a trailing dot (ADR-0084). The TLS name or the `Host` header must agree with it, else the connection is
  refused. The Egress list of ADR-0084 decides which targets the Sandbox may reach, and the Custodian refuses all
  others. It never dials the address that the Sandbox dialed. An Intercepted host goes to a chain of that Sandbox for
  that host alone. The chain ends TLS with that host's leaf of the Sandbox's CA (ALPN `http/1.1` only) and, per request:
  - The method must be GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS, else 405. A server that answers TRACE echoes the
    request, the value among it, back to the Agent. A header name with `_` gives 400: `x_api_key` is not `x-api-key` to
    the strip, but some servers read it as one.
  - `Host` must name the target, else 421. An encoded `/`, `.` or `\` in the path gives 400. A path outside the secret's
    `paths` gives 403. It is checked after Envoy removes dot segments and reads `\` as `/` and `..;` as `..`, and the
    upstream gets that path. So IIS and Tomcat cannot read a different path. A credential header sent twice gives 400.
  - The swap: in each header the secret names, the Stand-in alone, or one auth scheme and the Stand-in
    (`Bearer <Stand-in>`), becomes the value. Nothing else is rewritten. The Stand-in chooses the secret: when several
    secrets are bound to one target and one header, the header gets the value of the secret whose Stand-in it carries.
    So two MCP servers of one service, with two tokens, can be in one pod
    ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)).
  - Every credential header that is not the product of a swap is removed, also on a host that the Egress list marks
    `intercept: true` and that no secret is bound to. A request to a host that a held secret is bound to gets 403 when
    it has no swap, and it never leaves the Custodian:
    `jr2 custodian: <target> needs the stand-in of <NAME> in <headers>`.
  - Envoy opens its own TLS to the target, verifies the chain against `upstream.crt` and the name against the target's
    SAN (DNS or IP), and adds no header either way (`server`, `x-envoy-*`, `x-request-id` and `x-forwarded-*` are off).
    A failure gives 502 and a body that names the target and the reason. Redirects pass back unchanged.
  - When the target gives no answer, the Custodian answers 502 with a body that names the target, says what jr2 knows
    about the request, and ends with Envoy's reason. It replaces Envoy's own answer for ten Envoy response flags, in two
    mappers. One reply can carry several flags, and Envoy uses the first mapper that matches, in order. The first mapper
    is for `UF`, `UH` and `DF`, so a reply with one of them gets the first text whatever else it carries:
    - `UF` (the connection to the target failed), `UH` (no healthy host) and `DF` (the DNS lookup failed) say that Envoy
      did not send the request. The body is `jr2 custodian: <target> could not be reached: <details> <reason>`.
    - `UC` (the target closed the connection), `DPE` (a downstream protocol error, which a body framing error can cause
      after the headers went), `UPE` (an upstream protocol error), `UR` (the target reset the stream) and `LR` (Envoy
      reset it) can come after the request went to the target. The body is
      `jr2 custodian: <target> did not answer; the request may have reached it: <details> <reason>`. `UMSDR` (the
      maximum stream duration) is in this mapper: it ends a stream that was sent. `URX` (the retry limit) is in it too:
      Envoy sets it with the last attempt's own flag, so `UF,URX` gets the first text and `UC,URX` the second.
    - Envoy does not set `URX` or `UMSDR` on these routes, because they set no retry policy and no
      `max_stream_duration`. The two flags are in the mappers only to keep their union equal to the Orchestrator route's
      list.

    The second text is there because the first would be false after those flags. The target may have the request, so a
    `curl -X POST` or a `gh api` call to a bound host can write twice when the Agent sends it again. "Could not be
    reached" would tell the Agent that the first call went nowhere. The status stays 502 for both, HTTP's status when
    the target gave no valid answer. No code reads the words. The Harness's provider adapter reads the status, and no
    model reads its own provider's 502. The Agent's own tools show the body to the model.

    Without the mappers, Envoy answers each of the ten flags itself: 503 for most of them, and 502 for `UPE`. That body
    names no target, so a caller can read it as the target's own answer. With them, every caller sees that the Custodian
    gave the answer, and for which target. A reset after the target's answer started is not replaced: the caller sees
    its stream end.

    The Orchestrator route is different ([ADR-0002](0002-duplex-streaming-actor.md)). Its mapper adds the header
    `x-jr2-custodian: unreachable` and the flags, and the Harness reads them to decide whether a pick may be sent again
    (`menu.ts`). It says "never reached" only when each flag of the reply is `UF`, `UH`, `DF` or `URX`, and "not known"
    when any other flag is there.

  - Bodies stream both ways. A route has no total timeout; an idle stream has an hour; a client that goes away resets
    the upstream request.

  Each other target that the Egress list permits is a Tunneled host: the Custodian carries its bytes unchanged, after
  the dial guard (below).

- **The engine choices.** The values and every credential decision are in a Lua filter. Its program is fixed
  (`program.lua`); each Harness pod's own `custodian.lua` is a generated `HELD` table — names, headers, paths and
  targets, never a value — that ends with `dofile` of the program, so the program runs after the table it reads. The
  program reads each value of a pod's table from that pod's folder of values, takes off one trailing `\n` or `\r\n`, and
  refuses it, with a line that names the secret, when it is missing, empty, or has a byte outside `0x20`–`0x7E`. Each
  Stand-in but the fetch Stand-in is a value too: the Custodian reads it from its values, never from the table. Envoy's
  `credential_injector` is not used: it is alpha, it breaks on a secret file that ends in a newline (1.39.1), and it
  replaces a whole header, where the swap must see the Stand-in. Values never enter a ConfigMap. Envoy runs one worker,
  with hot restart off, and flushes its access log twice a second.
- **The log is a contract.** One line per decision on stdout, with the prefix `jr2.custodian` and `key=value` pairs:
  `ready secrets=… hosts=N` (when a pod's rules are live), `action=intercept target=… secret=… method=… status=…`,
  `action=tunnel target=…`, `action=refuse target=… reason=…`. Each line also names the Sandbox, or the other Harness
  pod, that it is for (ADR-0084). Never a header value, a body, a path, a query, a value or a Stand-in.
- **The dial guard, in two halves.** The Custodian never dials a loopback, link-local (the cloud metadata address
  included, and AWS's `fd00:ec2::254`) or unspecified address, or an IPv4-mapped form of one; the connection is refused
  with a `reason=guard` line. The script refuses a target that SPELLS one, and `localhost` or a `.localhost` name,
  before anything is resolved. The Custodian then refuses a name that resolves to an address in `GUARDED_RANGES`, so a
  name that resolves to one is refused like the literal. The address judged is the address dialed: both come from the
  one lookup.
- **Health.** `0.0.0.0:15021`, `GET /healthz`. The kubelet cannot reach a loopback listener, and a distroless image has
  no shell for an exec probe. The Custodian's readiness probe is on it. A provision waits until the Custodian says that
  the Sandbox's rules are live (ADR-0084), so no Turn is admitted in a Sandbox before the Custodian serves it. A peer on
  the cluster's network can reach this listener. So it is outside Envoy's global connection limit, holds 16 connections
  at most, and closes a connection idle for 5 seconds: a peer's idle connections cannot stop the Menu or the egress.
- **The config surface** (`jr2.config.ts`,
  [ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)): the top-level `secrets` list, whose
  entry is
  `{ name; value | valueFrom.secretKeyRef; hosts?; headers?, default `authorization`, `x-api-key`, `x-goog-api-key`, `api-key`; paths? }`,
  and `harness.catalog` (a catalog provider id → `{ baseUrl }`). The list serves both sides
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). `harness.provider.apiKey` is an entry
  too, implicitly: `JR2_PROVIDER_API_KEY`, bound to its `baseUrl`'s host. `loadConfig` checks the shape in both worlds.
- **Naming is placement: a pod gets the held secrets something in it names, and the Custodian holds for each pod what
  that pod's Agents name.** Placement is read, never declared (`secretPlacementsOf`), and an entry's `hosts`, `headers`
  and `paths` are its binding — where the Custodian may put the value — never its placement:

  | Pod                   | The held secrets the Custodian holds for it                                                                                          |
  | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | A Workspace's Sandbox | the names its `workspace()` lists under `secrets: [...]`, the model keys of its Agents, and the secrets of the MCP servers they name |
  | The Instance Harness  | the model keys of the `"none"` Agents it hosts, and the secrets of the MCP servers they name                                         |

  A model key is claimed by the PROVIDER: an Agent names its model, and jr2 knows which keys that provider reads
  (`MODEL_KEYS`; the custom provider's id for `JR2_PROVIDER_API_KEY`). An Agent's Turns run in the Workspace below which
  it is declared, down to the next `workspace()`, unless it is `"none"`, whose Turns run at the Instance Harness
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)). An MCP server's secret is claimed by the Agent
  that names the server in its `mcp` list (ADR-0079), and held in the pod where that Agent's Turns run. The rule is the
  same for every pod: a `"none"` Agent cannot execute code, so the Custodian holds for the Instance Harness only what
  its Agents name, and only the Harness process spends it. Listing a model key under a `workspace()`'s `secrets` is
  allowed, and `jr2 up` reports it as redundant. A name a `workspace()` lists that the list does not hold is refused,
  with the line to add. An entry nothing names — no `workspace()`, no provider, no Effect, no MCP server that an Agent
  or an Effect names — goes nowhere, and `jr2 up` warns. `jr2 up` reports per pod:
  `Workspace of workflow "coding": Custodian holds ANTHROPIC_API_KEY (provider), JIRA_TOKEN`.

  `jr2 up` alone checks the claimed entries (`heldSecretsOf`), host-side, because `.env` values are absent in-cluster.
  An entry no pod claims is not checked as a held secret:

  | #   | Refused                                                                                                                                                                                                                                                                                                                                                                                             |
  | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | R1  | A known model key (`MODEL_KEYS`) in `harness.env`, or as a key of a Secret or ConfigMap `harness.envFrom` names.                                                                                                                                                                                                                                                                                    |
  | R2  | A held-secret name that is `JR2_*` or a proxy or trust variable.                                                                                                                                                                                                                                                                                                                                    |
  | R3  | One name held twice, or held and set by `harness.env`.                                                                                                                                                                                                                                                                                                                                              |
  | R4  | Not exactly one of `value`/`valueFrom`; an empty value; a byte outside `0x20`–`0x7E`; leading or trailing space.                                                                                                                                                                                                                                                                                    |
  | R5  | A claimed entry with no `hosts` where no default exists; a wildcard, userinfo, a non-`https` scheme, a bare-host path, a bad port.                                                                                                                                                                                                                                                                  |
  | R6  | A `headers` entry that is not a lowercase token, or that frames or routes the request; a duplicate; explicit `headers` on an MCP server's secret that leave out `authorization`, where the Harness sends its Stand-in.                                                                                                                                                                              |
  | R7  | `provider.apiKey` with a non-`https` `baseUrl`; a non-`https` catalog `baseUrl`; an MCP server with a `secret` and a non-`https` `url`.                                                                                                                                                                                                                                                             |
  | R8  | A catalog key that is not a known provider, or that is the custom provider's id.                                                                                                                                                                                                                                                                                                                    |
  | R9  | Explicit `hosts` on a known model key that leave out where a carried Agent's provider sends its calls, or on an MCP server's secret that leave out the host of the `url` of a server that names it.                                                                                                                                                                                                 |
  | R10 | A `secretKeyRef` whose Secret or key does not exist.                                                                                                                                                                                                                                                                                                                                                |
  | R11 | `harness.env` sets a proxy or trust variable.                                                                                                                                                                                                                                                                                                                                                       |
  | R12 | A `paths` entry that does not start with `/`, or holds `..`, `;`, `\`, `%2e`, `%2f` or `%5c`; explicit `paths` on an MCP server's secret that do not cover the path of the server's `url`.                                                                                                                                                                                                          |
  | R13 | A held value that also reaches the Harness: its Secret loaded by `harness.envFrom`, its key read by a `harness.env` `secretKeyRef`, or its literal set by `harness.env`. A kit Secret (`jr2-instance`, `jr2-held-*`, `jr2-instance-effector`, `jr2-effector-*`, `<sandbox>-effector`, `jr2-git-*`, and each pod's credentials, `jr2-instance-harness-token` and `<sandbox>-token`) named by either. |
  | R14 | A held secret's name that is also a key of a Secret that `harness.envFrom` names. The message names the Secret, the key and the held secret.                                                                                                                                                                                                                                                        |

  R14 exists because the Stand-ins are files, not env: no Stand-in hides such a key, so its real value would reach the
  Harness's env, and the Harness uses a held secret but never holds it. `up` already reads each `envFrom` Secret to
  check that it exists (ADR-0019).

  Each message names the config path, never a value, and says what to write instead. A SigV4 or ADC credential in
  `harness.env` is warned about, not refused. A known model key with no `hosts` is bound to the host its provider's
  calls go to: the host of `harness.catalog.<id>.baseUrl` when set, else pi's catalog host. The key and the calls then
  read one config and cannot drift. An MCP server's secret with no `hosts` is bound to the host of the `url` of each
  server that names it, in the header `authorization`, in the same way. `MODEL_KEYS` is pi's data at the pin, written as
  plain data by `just model-keys` (a script in `@jr2/harness`) at each pi bump, so the Orchestrator has no pi
  dependency. A test in `@jr2/harness` checks the table against pi, and checks that the file is the script's exact text.
  So a pi bump that moves a provider, or a hand edit of the file, fails the default gate until the recipe runs.

- **A catalog provider can move to a gateway.** pi has no env var for a catalog provider's base URL. It hands the
  provider the model it is given. So `resolveModel` returns a copy of the catalog model with `baseUrl` replaced, for
  every model of that provider. The catalog's other facts ride along. The model id sent upstream is the catalog id, so
  the gateway must serve that name (a LiteLLM `model_name` alias).
- **Certificates: one CA for each Sandbox.** The Orchestrator makes a Sandbox's CA at provision, with name constraints
  for the Sandbox's Intercepted hosts: each host that a held secret of the pod is bound to, each host to which the
  Custodian puts a value for its Sandbox Effector (ADR-0068), each host that its Egress list marks `intercept: true`,
  and the name of its agent routes. Before the pod starts, it issues one leaf for each of them, gives the leaves to the
  Custodian, and deletes the CA's key. The pod gets the CA's certificate only. So no key that can sign a leaf for a
  Sandbox exists while its Agents run, and the CA cannot vouch for a host outside its constraints. The Instance Harness
  and the check pods are not Sandboxes and run no Workspace code. `jr2 up` keeps the Instance's CA for them in the
  `jr2-held-ca` Secret, which no pod mounts, and issues their leaves from it before the pod starts. It never rotates
  that CA; a human deletes the Secret to rotate it. Such a leaf is reused while its SAN is the same, it chains to the
  current CA, and more than 30 days remain. Keys are ECDSA P-256, written by jr2's own small DER writer over
  `node:crypto`: no dependency, and no `openssl`.
- **Trust is in variables only.** jr2 mounts no file over the image's own CA bundle, so the bundle of a brought image
  stays as its owner made it. The `jr2-ca` ConfigMap carries `ca.crt` (the user's `caBundle`) and `upstream.crt` (the
  roots + `caBundle`, and never a jr2 CA, for the Custodian). "Roots" are the Mozilla roots of the Node that runs
  `jr2 up`. The ConfigMap is applied server-side, so client-side apply's annotation does not limit its size. Each
  Harness pod that gets the trust variables (above) also gets two files of its own from its maker, never in `jr2-ca`,
  which its Harness container mounts at `/etc/jr2/ca` beside `ca.crt`: `extra.crt` (`caBundle` + the pod's CA, for
  `NODE_EXTRA_CA_CERTS`) and `bundle.crt` (the roots, `caBundle` and the pod's CA, for the tools whose variable replaces
  their store).
- **Every Secret is applied server-side.** A client-side apply copies the whole object into its
  `kubectl.kubernetes.io/last-applied-configuration` annotation, so the values of a Secret are then in plaintext for
  each reader of its metadata. So `jr2 up` applies each Secret that it writes server-side: `jr2-instance`,
  `jr2-harness-env`, `jr2-held-ca`, `jr2-held-secrets-<pod>`, the Effector Secrets, the git Secrets, the deploy key and
  the check pod's Secrets. The field manager is `jr2`, with `--force-conflicts`, because jr2 is the only writer of these
  Secrets. A `stringData` goes as `data`, because a server-side apply owns the fields that it names, and `stringData` is
  write-only. On a Secret that an older `jr2 up` applied client-side, the first server-side apply migrates it: kubectl
  (1.26 and later) moves the fields of the client-side manager to `jr2`, so that apply removes the annotation and each
  key that it does not name, and `jr2` is then the only manager (measured on kind with kubectl 1.35.9). When that
  migration fails, kubectl only writes a warning on stderr. So after each apply of Secrets, a fallback removes the
  annotation (`kubectl annotate … last-applied-configuration-`). The removal of an annotation that is not there changes
  nothing, so the fallback needs no record of what was removed. When the fallback fails, `jr2 up` writes one warning
  that names the Secrets, and the converge goes on. The rule is in the apply seam (`kubectlAdmin.apply`), so a Secret
  that a later change adds is applied in the same way. The values go on stdin, never in argv. No ConfigMap holds a
  value.
- **Objects, per pod.** The held manifest, the Custodian's rules and the literal values are each a pod's own, from the
  one derivation that places Effect secrets. A pod is keyed `instance` for the Instance Harness, and `ws-<digest>` for a
  Workspace, the digest of its registered workflow and the placement route to its `workspace()` (the pod key below) —
  the route the walk reads statically and the run host reads off the live actor at provision, so both name one pod
  alike. `jr2 up` declares, and the pod's maker renders: the Orchestrator renders a Sandbox's rules at provision, from
  the manifest it reads, and writes them to the Custodian (ADR-0084); `jr2 up` renders those of the Instance Harness and
  of each check pod. `jr2-held` (always) holds `held-<pod>.json` for each pod (what it holds: names, bindings, headers,
  never a value) and `program.lua` once per Instance, so it grows by one manifest per Workspace, and it holds no
  rendered file. The reason: every Kubernetes object stops at 1 MiB, and client-side apply's annotation at 256 KiB; one
  copy of Envoy's files per pod in `jr2-held` passed that limit at nine Workspaces, and a dedupe or a server-side apply
  only moves the ceiling. `jr2-held-secrets-<pod>` holds one pod's literal values, labeled `jr2.dev/held-pod`, and
  `jr2 up` deletes the one a pod no longer needs. No container of a Harness pod mounts it. The Orchestrator mounts
  `jr2-held` at `/etc/jr2/held` and reads the manifest of the Workspace it provisions, per provision — the `jr2-images`
  pattern ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)); a Workspace `jr2 up` never walked has none, and
  its provision is refused, naming `jr2 up`. A pod key is the workflow and the Workspace's placement route: the `actors`
  slot keys down to its `workspace()`, a wrapper's body skipped, where a plain Machine invoked inline adds xstate's
  generated invoke src for that hop (`xstate.invoke.<index>.<state id>`), held so it can never equal a slot key.
  `jr2 up` computes it from the state node, and the provision reads it off the live actor tree, so both derive one key.
  A key reached by slot keys alone is what it was. A wrapper's body adds no hop, so a `workspace()` reached through
  another `workspace()`'s body (`workspace(workspace(...))`, `workspace(pool(workspace(...)))`) has the outer one's key:
  `jr2 up` refuses that Machine, with or without a secret, since the two pods' secrets could not be kept apart, and
  names the fix (the inner `workspace()` under a key of a plain Machine's `actors`, which has a route of its own); every
  other Workspace has a key of its own. A Workspace reached through a Machine object handed to `spawnChild`, which no
  walk can see, fails at provision with the slot form. One function builds, from a pod's manifest, what the pod gains
  and what the Custodian holds for it. Each pod shape calls it, so the shapes cannot drift. The Custodian takes a
  changed value of a held secret live: no Harness pod restarts for it.

## Considered options

- **jr2's own proxy in Node, in a second container of the Adapter's image** (branch `held-secrets/node`). No new image
  and no second language; jr2 then owns TLS-parsing code at the trust boundary, and needs its own tests for every edge
  Envoy already handles. It keeps the Adapter.
- **Envoy beside the Adapter** (branch `held-secrets/envoy-sidecar`). The same Envoy configuration, and a second holder.
  Two holders keep two credentials apart, so a fault in one engine does not reach the other's credential. This decision
  trades that split for one component fewer: the Custodian holds both.
- **The Orchestrator serves MCP, and Envoy forwards `/mcp/<iid>`.** Rejected. It reverses ADR-0013's "the Orchestrator
  hosts no MCP", puts a transport and session handling back in the control plane, and keeps the MCP SDK on both ends —
  to carry two plain HTTP calls. What ADR-0013 rejected about translation inside the Harness was the credential in that
  container. The Custodian holds it, so that reason is gone.
- **The Adapter relays model calls** (ADR-0058's first direction). Rejected: every provider needs its `baseUrl`
  rewritten to the relay, and pi's catalog has no env var for a base URL, so the catalog could not follow.
- **Drop pi's catalog and name every model as a custom provider.** Rejected by the user: the catalog holds the model
  facts the user would have to copy by hand.
- **iron-proxy.** It intercepts every host and cannot pass one through, and it makes leaves at runtime, so a CA's key
  would exist while the Agent runs. The Sandbox Image is the user's, and its tools may not trust a jr2 CA.
- **mitmproxy, Squid.** mitmproxy streams SSE only if the addon asks, and its swap is code jr2 writes anyway; Squid
  brings the GPL and a poor CVE record. Both would be a fourth image.
- **Envoy's `credential_injector`, or the value in a bootstrap Secret with `request_headers_to_add`.** Rejected: the
  first is alpha and fails on a trailing newline; both replace a header without seeing the Stand-in, and the second
  cannot hold a `secretKeyRef` value, which `jr2 up` never copies.
- **Intercept every host.** Rejected for the iron-proxy reason: a tool that does not trust the jr2 CA would then fail on
  every host, not only on the Intercepted ones.
- **A CONNECT listener, where the CONNECT target decides.** A client reaches it through `HTTPS_PROXY`, and the target is
  where the tunnel goes, so it decides, never the SNI or the `Host` header. Rejected: the placeholder address gives the
  Custodian the name with no setting in the client, and the TLS name or the `Host` header must agree with it.
- **The Instance's CA for every Harness pod, with no name constraints.** Rejected for a Sandbox: its key lives as long
  as the Instance, and it can sign a leaf for any name. Constraints do not fit it, because they force a new CA whenever
  the bound hosts change, and that breaks a live pod. A Sandbox's Intercepted hosts are fixed at its provision, so a CA
  of its own can carry constraints, and its key can go before the pod starts. The Instance Harness and the check pods
  run no Workspace code, so they keep the Instance's CA.
- **A bundle mounted over the image's system bundle path.** Each tool that reads the system store then trusts the
  Sandbox's CA with no variable. Rejected: it replaces the bundle of a brought image, which can hold a CA that the
  image's owner put there.

## Consequences

- **What this closes, and what it does not.** No Agent can take a model key or a Sandbox token: the Custodian holds
  them, outside every Sandbox. The Harness spends the model keys for the Turns. Workspace code can still **spend** a key
  through the Custodian while its Sandbox lives, on any path `paths` allows, when the `workspace()` grants that key. A
  key with admin rights can mint a new key, and a minted key is one the Agent can take away: use a key with no admin
  rights, and narrow `paths`. The User Container is in the same Sandbox, and a human in it cannot read a key either.
- **Response echo.** Responses pass unchanged. An upstream that echoes the full credential in a response hands it to the
  Agent. Providers mask keys in errors; jr2 does not scrub responses.
- **A Stand-in is worth nothing away from the Custodian.** Sent to a Tunneled host, it arrives as it left. A caller that
  sends a Stand-in to the Orchestrator itself gets 401 on every route (`auth.test.ts`).
- **Clients that do not trust the Sandbox's CA** (Java, a client with its own store or a pinned certificate) fail TLS to
  an Intercepted host. They fail closed and send nothing. A client that must show a client certificate to the host fails
  there too. Tunneled hosts still work for both.
- **`SSL_CERT_FILE` replaces an OpenSSL tool's store.** A private CA baked into the Sandbox Image, and not put in
  `caBundle`, stops being trusted by curl, git and Python in every Sandbox. The fix is `caBundle`. The gain: `caBundle`
  reaches curl, git and Python as well ([ADR-0020](0020-private-ca-trust-is-a-named-concept.md)).
- **Signing credentials cannot be held.** A SigV4 or ADC credential signs the request with the secret, and a Stand-in
  cannot be swapped into a signature. `jr2 up` warns. The fix is the Effector
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)): a signing credential is a real value
  there, in a container the Agent executes nothing in. The credentialed `command`
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)) runs the signing tool
  there (`terraform`, `aws`, `gcloud`), its child confined with Landlock from the Effector's key and every secret it
  does not name. `ANTHROPIC_OAUTH_TOKEN` is held like a key, but pi sends a Stand-in as `x-api-key`, which an OAuth
  token cannot ride; hold it as `ANTHROPIC_AUTH_TOKEN` (`Authorization: Bearer`) instead.
- **A Sandbox's Intercepted hosts are fixed at its provision.** Its CA's key is gone before the pod starts, so no leaf
  can be added while the Sandbox lives. A new Intercepted host applies to the next Sandbox. A Tunneled host can be added
  while the Sandbox lives (ADR-0084).
- **The walk reads definitions, not Turns.** A pod's model keys come from the models its Agents' definitions name. A
  Turn whose invocation overrides the model with another provider's (`AgentTurnInput.model`) finds no key for that
  provider in its pod: the Harness process holds a Stand-in only for the names in its own pod's manifest, so that
  provider's key variable is not set at all. The call then has no key (a catalog provider) or sends the custom
  provider's placeholder `unused`, and it fails. This holds in a Workspace and in the Instance Harness alike. The fix is
  a definition that names the provider; in a Workspace, the key under the `workspace()`'s `secrets` also works. The
  Instance Harness has no such list: its pod holds only what the `"none"` Agents it hosts name.
- **TLS-only bindings.** A key for a plain-HTTP endpoint is refused (R7). A LAN `llama-server --api-key` needs TLS and
  its CA in `caBundle`, or no key.
- **No proxy chaining.** The Custodian cannot forward to a corporate proxy. R11 says so rather than fail silently.
- **The dial guard is a control.** The Custodian is a pod of the cluster, and it dials the names that a Sandbox may
  reach. Without the guard, a name that resolves to the metadata address would give a Sandbox the node's metadata
  service.
- **One part holds every credential of the Instance's Harness pods.** A fault in Envoy's TLS or HTTP parsing is a fault
  in the part that holds the tokens of each Sandbox and each model key of the Instance. The branch with a separate
  Adapter keeps the tokens apart from the keys.
- **The Harness process speaks the Orchestrator's agent routes itself.** Nothing is judged in the pod. No process that
  the Harness confines holds the control Stand-in, so none can make those calls (ADR-0076).
- **`jr2-upload-pack` carries the fetch Stand-in as a constant.** The User Container gets no env (ADR-0005), and asks
  like any other seat. A test pins the Go literal to `standIn("JR2_SANDBOX_TOKEN")`. The Custodian swaps it on the fetch
  route alone, so the constant reaches no agent route.
- **The Custodian's image is a Pinned image.** It is deployed and never built, which
  [ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md) states. `kitRegistry` re-homes it and `jr2 kit push` mirrors
  it ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)). The image sweep never takes it,
  because jr2 never stamped it ([ADR-0039](0039-image-garbage-collects-by-reachability.md)). A kind node pulls it from
  its registry, so the `@kind` tier needs network to `docker.io`. `just kit-push` does not seed it.
- **Where the Custodian suite runs.** `just custodian-test`: node's test runner against the pinned image under docker,
  on the host network with free ports, with local HTTPS upstreams under their own CA. It is opt-in, like `@kind`,
  because it needs docker ([ADR-0010](0010-bdd-acceptance-tests.md)), and the release job runs it on every tag
  ([ADR-0055](0055-a-release-is-a-pushed-tag-and-the-publish-guard-is-the-credential.md)): the image moves only with its
  pin, but the configuration jr2 renders moves with any release. About 35 seconds. It checks the swap, the strip, 403
  with no Stand-in, 405 on a method, 400 on an underscore header, a header `Connection` names, two `Host` headers, idle
  connections on the health listener, 421, 400 and 403 on paths, the tunnel, the dial guard by every spelling and by
  resolved name, 502 on an untrusted upstream, SSE timing, abort, a 302, the refusal of a bad value, the log, a TLS name
  or a `Host` header that does not agree with the name of the address, and the Anthropic SDK with no proxy setting. The
  first SSE event arrives through the Custodian about half a millisecond later than direct.
- **The `@kind` tier's model wants a key.** Its fake provider serves HTTPS under the tier's CA and refuses a request
  without the key, which is `harness.provider.apiKey` — so every turn in the tier crosses the Custodian, in both
  placements. A Rule proves the key is in no env and no file of either Harness container.
- **The provider preflight crosses the Custodian.** A provider's key is held. So `jr2 up` checks the provider from a
  check pod that reaches the Custodian as a pod of its class does, with the stock Harness's `provider-preflight.ts`
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). The check has its own copies of the held
  objects, and the check pod holds Stand-ins only, as a Harness pod does. The check runs before `jr2 up` writes an
  object that the Instance or the operator reads. A wrong or missing key, no egress to the bound host, and a gateway
  that does not answer fail the converge, not a Turn.
