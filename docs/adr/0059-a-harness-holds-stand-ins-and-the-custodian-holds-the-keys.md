# A Harness holds stand-ins; the Custodian holds the keys

[ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md) recorded an open gap: model API keys were in the Harness
container. `JR2_PROVIDER_API_KEY` and literal `harness.env` values (for example `ANTHROPIC_API_KEY`) came from the
`jr2-harness-env` Secret by `envFrom`. Working tools give the Agent code execution in that container, and every tool
child inherits the env. So the Agent could read a key and send it out of the pod. Dropping pi's catalog was not an
option: the user's real setup is Bedrock through a LiteLLM gateway, with a fixed `ANTHROPIC_API_KEY` and `anthropic/…`
models, and the catalog holds the limits, costs and thinking levels of those models.

The same problem had one solution already, for one credential. The Adapter held the Sandbox token in a container the
Agent executes nothing in ([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)). This
decision generalizes that container. It holds every credential the Harness uses, and it replaces the Adapter.

## Decision

- **A held secret is a credential the Harness uses and never holds.** The Harness container's env holds its
  **Stand-in**, `jr2-held-<NAME>`. The Stand-in is deterministic and public. It means something only to the Custodian,
  and only toward a host the secret is bound to. It is unique per name, it is a valid header and env value, and it never
  contains `sk-ant-oat` (pi reads such a key as an Anthropic OAuth token). The word is not "placeholder", because that
  is the word of an Open part.
- **The Custodian holds them.** It is a container in every Harness pod — every Sandbox and the Instance Harness — beside
  the Harness. The Agent executes no code in it, and `shareProcessNamespace` stays off
  ([ADR-0005](0005-sandbox-pod-composition.md)). So the Agent cannot read its env, its files or its `/proc`. Its engine
  is Envoy: the upstream distroless image, pinned by digest (`CUSTODIAN_IMAGE` in `@jr2/orchestrator`). `jr2 up` writes
  Envoy's whole configuration. There is no admin listener and no xDS, so nothing in the pod can change the configuration
  or read it back.
- **The Custodian replaces the Adapter.** The `@jr2/adapter` package and the `jr2-adapter` image are deleted. The
  Sandbox token is a held secret of the kit's own: the Harness container holds
  `JR2_SANDBOX_TOKEN=jr2-held-JR2_SANDBOX_TOKEN`, and the Custodian holds the token as a file from the `<sandbox>-token`
  Secret (the Instance Harness: the `JR2_INSTANCE_HARNESS_TOKEN` key of `jr2-instance`). No other container mounts it.
- **The Harness reads its Menu itself.** There is no MCP. For each Submission, `menu.ts` reads
  `GET /agents/<iid>/surface` and delivers a pick with `POST /agents/<iid>/events`, both to the Custodian on
  `127.0.0.1:8081`, with the Stand-in as the bearer. `menu-tools.ts` gives pi each accepted event as a tool. The tool
  names stay `mcp__jr2__<event>`, because shipped instructions and the printer depend on them; the name is no longer a
  transport. `menu-tools.ts` adds the prefix, and `menu.ts` keeps the bare name, because an MCP client adds
  `mcp__<server>__` itself. The Harness keeps what the Adapter did: a turn that is over has an empty Menu
  ([ADR-0026](0026-a-turn-that-is-over-has-an-empty-menu.md)), a receipt is prose
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md),
  [ADR-0029](0029-a-menu-offers-what-the-machine-will-accept-and-a-pick-that-moves-nothing-says-so.md)), the surface
  read retries on the ladder with the `jr2.routability` line
  ([ADR-0042](0042-ready-is-not-routable-an-admission-retries-its-connection.md)), and a `deferred` or `poll` event
  refuses the turn. The event's own JSON Schema is the tool's parameters, so the model sees the contract the
  Orchestrator validates against.
- **The control listener forwards three routes and no other.** `127.0.0.1:8081`, plain HTTP, to the Orchestrator's
  Service (`jr2-orchestrator.<ns>.svc:4000`, written into the bootstrap by `jr2 up`):

  ```
  GET  /agents/<iid>/surface   → the same path     the Menu
  POST /agents/<iid>/events    → the same path     a pick
  POST /fetch                  → /sandboxes/<this pod's Sandbox>/fetch     the ask (ADR-0053)
  anything else                → 404, from the Custodian
  ```

  On each forwarded request, the Custodian swaps `Authorization: Bearer <Stand-in>` for the token and removes every
  other credential header. A request without the Stand-in gets 403. The ask's path comes from the Custodian
  (`JR2_SANDBOX` in its env, set per pod); on the Instance Harness there is none, and the ask gets 404. The route
  allowlist is the second layer. The control stays in the Orchestrator: the token's scope, the live registration, and
  the event's name and payload are judged there, as before (ADR-0013).

- **Model keys go the same way, over HTTPS.** When a held secret exists, the Harness container also gets:

  ```sh
  <NAME>=jr2-held-<NAME>                         one per held secret
  HTTPS_PROXY / https_proxy=http://127.0.0.1:15001
  NO_PROXY / no_proxy=localhost,127.0.0.1,::1
  NODE_USE_ENV_PROXY=1
  NODE_EXTRA_CA_CERTS=/etc/jr2/ca/extra.crt
  SSL_CERT_FILE / REQUESTS_CA_BUNDLE / GIT_SSL_CAINFO=/etc/jr2/ca/bundle.crt
  ```

  These ride `env`, after `harness.env` and before the wire's digest. In Kubernetes `env` wins over `envFrom`, so a
  Stand-in overrides a same-named key of an `envFrom` Secret, even one that changes later. There is no `HTTP_PROXY`: the
  Custodian carries TLS only, and plain HTTP (the Custodian's control listener, an in-cluster seed repository) goes
  direct. `NO_PROXY` is loopback only, so an in-cluster gateway that a secret is bound to still goes through the
  Custodian.

- **The egress listener: CONNECT only.** `127.0.0.1:15001`. The CONNECT target decides everything (lowercased, without a
  trailing dot) — never the SNI, never the `Host` header. A target that a held secret is bound to goes to an internal
  listener for that target alone. That listener ends TLS with a leaf `jr2 up` issued (ALPN `http/1.1` only) and, per
  request:
  - The method must be GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS, else 405. A server that answers TRACE echoes the
    request, the value among it, back to the Agent. A header name with `_` gives 400: `x_api_key` is not `x-api-key` to
    the strip, but some servers read it as one.
  - `Host` must name the target, else 421. An encoded `/`, `.` or `\` in the path gives 400. A path outside the secret's
    `paths` gives 403. It is checked after Envoy removes dot segments and reads `\` as `/` and `..;` as `..`, and the
    upstream gets that path. So IIS and Tomcat cannot read a different path. A credential header sent twice gives 400.
  - The swap: in each header the secret names, the Stand-in alone, or one auth scheme and the Stand-in
    (`Bearer <Stand-in>`), becomes the value. Nothing else is rewritten.
  - Every credential header that is not the product of a swap is removed. A request with no swap gets 403 and never
    leaves the pod: `jr2 custodian: <target> needs the stand-in of <NAME> in <headers>`.
  - Envoy opens its own TLS to the target, verifies the chain against `upstream.crt` and the name against the target's
    SAN (DNS or IP), and adds no header either way (`server`, `x-envoy-*`, `x-request-id` and `x-forwarded-*` are off).
    A failure gives 502 and a body that names the target and the reason. Redirects pass back unchanged.
  - Bodies stream both ways. A route has no total timeout; an idle stream has an hour; a client that goes away resets
    the upstream request.

  Every other target is tunneled, byte for byte, after the dial guard (below).

- **The engine choices.** The values and every credential decision are in a Lua filter (`custodian.lua`), with a table
  that `jr2 up` generates in front of it: names, headers, paths and targets, never a value. At start the script reads
  each value from `/etc/jr2/custodian/values/<NAME>`, takes off one trailing `\n` or `\r\n`, and stops the start-up with
  a line that names the secret when a value is missing, empty, or has a byte outside `0x20`–`0x7E`. Envoy's
  `credential_injector` is not used: it is alpha, it breaks on a secret file that ends in a newline (1.39.1), and it
  replaces a whole header, where the swap must see the Stand-in. Values never enter a ConfigMap. Envoy runs one worker,
  with hot restart off, and flushes its access log twice a second.
- **The log is a contract.** One line per decision on stdout, with the prefix `jr2.custodian` and `key=value` pairs:
  `ready secrets=… hosts=N` (at the first probe), `action=intercept target=… secret=… method=… status=…`,
  `action=tunnel target=…`, `action=refuse target=… reason=…`. Never a header value, a body, a path, a query, a value or
  a Stand-in.
- **The dial guard, in two halves.** A tunnel never reaches a loopback, link-local (the cloud metadata address included,
  and AWS's `fd00:ec2::254`) or unspecified address, or an IPv4-mapped form of one; it gets 403 and a `reason=guard`
  line. The script refuses a target that SPELLS one, and `localhost` or a `.localhost` name, before anything is
  resolved. The dynamic forward proxy filter saves the address it resolved a name to (`save_upstream_address`), and an
  RBAC filter after it refuses that address when it is in `GUARDED_RANGES` — so a name that resolves to one is refused
  like the literal. The address judged is the address dialed: both come from the one DNS cache entry.
- **Health.** `0.0.0.0:15021`, `GET /healthz`. The kubelet cannot reach a loopback listener, and a distroless image has
  no shell for an exec probe. The Custodian's readiness probe is on it. Pod Ready needs every container ready, and the
  operator holds a Sandbox's Ready on pod Ready, so no Turn is admitted before the Custodian serves. The Instance
  Harness's rollout wait covers it the same way. It is the one listener a peer can reach, where the ADR-0058
  NetworkPolicy is not enforced. So it is outside Envoy's global connection limit, holds 16 connections at most, and
  closes a connection idle for 5 seconds: a peer's idle connections cannot stop the Menu or the egress.
- **The config surface** (`jr2.config.ts`,
  [ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)): `harness.heldSecrets` (a `name`; a
  `value` or a `valueFrom.secretKeyRef`; `hosts`; `headers`, default `authorization`, `x-api-key`, `x-goog-api-key`,
  `api-key`; `paths`), and `harness.catalog` (a catalog provider id → `{ baseUrl }`). `harness.provider.apiKey` is a
  held secret too, `JR2_PROVIDER_API_KEY`, bound to its `baseUrl`'s host. `loadConfig` checks the shape in both worlds.
  `jr2 up` alone checks the rest (`heldSecretsOf`), host-side, because `.env` values are absent in-cluster:

  | #   | Refused                                                                                                                                                                                                                               |
  | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | R1  | A known model key (`MODEL_KEYS`) in `harness.env`, or as a key of a Secret or ConfigMap `harness.envFrom` names.                                                                                                                      |
  | R2  | A held-secret name that is `JR2_*` or a proxy or trust variable.                                                                                                                                                                      |
  | R3  | One name held twice, or held and set by `harness.env`.                                                                                                                                                                                |
  | R4  | Not exactly one of `value`/`valueFrom`; an empty value; a byte outside `0x20`–`0x7E`; leading or trailing space.                                                                                                                      |
  | R5  | No `hosts` where no default exists; a wildcard, userinfo, a non-`https` scheme, a bare-host path, a bad port; two secrets on one host in one header.                                                                                  |
  | R6  | A `headers` entry that is not a lowercase token, or that frames or routes the request; a duplicate.                                                                                                                                   |
  | R7  | `provider.apiKey` with a non-`https` `baseUrl`; a non-`https` catalog `baseUrl`.                                                                                                                                                      |
  | R8  | A catalog key that is not a known provider, or that is the custom provider's id.                                                                                                                                                      |
  | R9  | Explicit `hosts` on a known model key that leave out where a carried Agent's provider sends its calls.                                                                                                                                |
  | R10 | A `secretKeyRef` whose Secret or key does not exist.                                                                                                                                                                                  |
  | R11 | While a secret is held: `harness.env` sets a proxy or trust variable.                                                                                                                                                                 |
  | R12 | A `paths` entry that does not start with `/`, or holds `..`, `;`, `\`, `%2e`, `%2f` or `%5c`.                                                                                                                                         |
  | R13 | A held value that also reaches the Harness: its Secret loaded by `harness.envFrom`, its key read by a `harness.env` `secretKeyRef`, or its literal set by `harness.env`. A kit Secret (`jr2-instance`, `jr2-held-*`) named by either. |

  Each message names the config path, never a value, and says what to write instead. A SigV4 or ADC credential in
  `harness.env` is warned about, not refused. A known model key with no `hosts` is bound to the host its provider's
  calls go to: the host of `harness.catalog.<id>.baseUrl` when set, else pi's catalog host. The key and the calls then
  read one config and cannot drift. `MODEL_KEYS` is a copy of pi's data at the pin; a test in `@jr2/harness` checks it
  against pi, so a pi bump that moves a provider fails the default gate.

- **A catalog provider can move to a gateway.** pi has no env var for a catalog provider's base URL. It hands the
  provider the model it is given. So `resolveModel` returns a copy of the catalog model with `baseUrl` replaced, for
  every model of that provider. The catalog's other facts ride along. The model id sent upstream is the catalog id, so
  the gateway must serve that name (a LiteLLM `model_name` alias).
- **Certificates.** `jr2 up` keeps a per-Instance CA in the `jr2-held-ca` Secret, which no pod mounts; it reads the CA
  over the kube API. It issues one leaf per bound `host:port` into `jr2-held-tls` before a pod starts, so the CA's key
  never enters a Harness pod. Keys are ECDSA P-256, written by a small DER writer in `@jr2/cli` over `node:crypto`: no
  dependency, and no `openssl` on the host. `jr2 up` never rotates the CA; a human deletes the Secret to rotate it. A
  leaf is reused while its SAN is the same, it chains to the current CA, and more than 30 days remain.
- **Trust.** The `jr2-ca` ConfigMap carries `ca.crt` (the user's `caBundle`), and while a secret is held: `extra.crt`
  (`caBundle` + the jr2 CA, for `NODE_EXTRA_CA_CERTS`), `bundle.crt` (the roots + both, for the tools whose variable
  replaces their store), and `upstream.crt` (the roots + `caBundle`, and never the jr2 CA, for the Custodian). "Roots"
  are the Mozilla roots of the Node that runs `jr2 up`. The ConfigMap is applied server-side, because two copies of the
  roots are more than client-side apply's annotation can hold.
- **Objects.** `jr2-held` (always: `held.json`, `envoy.json`, `custodian.lua`), `jr2-held-secrets` (the literal values),
  `jr2-held-tls`, `jr2-held-ca`. The Orchestrator mounts only `held.json`, at `/etc/jr2/held`, and reads it per
  provision — the `jr2-images` pattern ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)). One function,
  `custodianComposition`, builds what a pod gains; `kubectlSandbox` and `instanceHarnessObjects` both call it, so the
  two pod shapes cannot drift. The Instance Harness's pod template carries `jr2.dev/held-digest`, an HMAC over every
  held-secret input keyed with the signing key, so a held-secret edit rolls it. A live Sandbox keeps what its Custodian
  read at start.

## Considered options

- **jr2's own proxy in Node, in a second container of the Adapter's image** (branch `held-secrets/node`). No new image
  and no second language; jr2 then owns TLS-parsing code at the trust boundary, and needs its own tests for every edge
  Envoy already handles. It keeps the Adapter.
- **Envoy in a container beside the Adapter** (branch `held-secrets/envoy-sidecar`). The same Envoy configuration, and
  three containers per pod. Two containers hold two credentials, so a fault in one engine does not reach the other's
  credential. This branch trades that split for one container fewer and one component fewer: the Custodian holds both.
- **The Orchestrator serves MCP, and Envoy forwards `/mcp/<iid>`.** Rejected. It reverses ADR-0013's "the Orchestrator
  hosts no MCP", puts a transport and session handling back in the control plane, and keeps the MCP SDK on both ends —
  to carry two plain HTTP calls. What ADR-0013 rejected about translation inside the Harness was the credential in that
  container. The Custodian now holds it, so that reason is gone.
- **The Adapter relays model calls** (ADR-0058's first direction). Rejected: every provider needs its `baseUrl`
  rewritten to the relay, and pi's catalog has no env var for a base URL, so the catalog could not follow.
- **Drop pi's catalog and name every model as a custom provider.** Rejected by the user: the catalog holds the model
  facts the user would have to copy by hand.
- **iron-proxy.** It intercepts every host and cannot pass one through, and it makes leaves at runtime, so the CA's key
  would be in the pod. The Sandbox Image is the user's, and its tools may not trust a jr2 CA.
- **mitmproxy, Squid.** mitmproxy streams SSE only if the addon asks, and its swap is code jr2 writes anyway; Squid
  brings the GPL and a poor CVE record. Both would be a fourth image.
- **Envoy's `credential_injector`, or the value in a bootstrap Secret with `request_headers_to_add`.** Rejected: the
  first is alpha and fails on a trailing newline; both replace a header without seeing the Stand-in, and the second
  cannot hold a `secretKeyRef` value, which `jr2 up` never reads.
- **Intercept every host.** Rejected for the iron-proxy reason: a tool that does not trust the jr2 CA would then fail on
  every host, not only on bound ones.

## Consequences

- **What this closes, and what it does not.** The Agent cannot take a model key or the Sandbox token out of the pod. It
  can still **spend** a key through the Custodian while its pod lives, on any path `paths` allows. A key with admin
  rights can mint a new key, and a minted key is one the Agent can take away: use a key with no admin rights, and narrow
  `paths`. The User Container shares the pod's loopback, so a human in it can spend a key the same way. That human
  cannot read one either.
- **Response echo.** Responses pass unchanged. An upstream that echoes the full credential in a response hands it to the
  Agent. Providers mask keys in errors; jr2 does not scrub responses.
- **Bypass.** A client that ignores `HTTPS_PROXY` goes direct and sends the Stand-in, which is worth nothing. It is not
  blocked: egress control stays the cluster's decision (ADR-0058's open egress gap). The same holds for the control
  plane: a caller that skips the Custodian and sends the Stand-in to the Orchestrator gets 401 on every route
  (`auth.test.ts`).
- **Clients that do not trust the jr2 CA** (Java, a pinned client) fail TLS to a bound host. They fail closed and send
  nothing. Unbound hosts still work for them.
- **`SSL_CERT_FILE` replaces an OpenSSL tool's store.** A private CA baked into the Sandbox Image, and not put in
  `caBundle`, stops being trusted by curl, git and Python in a pod with a held secret. The fix is `caBundle`. The gain:
  `caBundle` now reaches curl, git and Python, which [ADR-0020](0020-private-ca-trust-is-a-named-concept.md) recorded as
  missing.
- **Signing credentials cannot be held.** A SigV4 or ADC credential signs the request with the secret, and a Stand-in
  cannot be swapped into a signature. `jr2 up` warns. The fix is a gateway that holds them, and a held key for the
  gateway. `ANTHROPIC_OAUTH_TOKEN` is held like a key, but pi sends a Stand-in as `x-api-key`, which an OAuth token
  cannot ride; hold it as `ANTHROPIC_AUTH_TOKEN` (`Authorization: Bearer`) instead.
- **Rotation of a value** reaches a live Sandbox only when its pod is replaced.
- **TLS-only bindings.** A key for a plain-HTTP endpoint is refused (R7). A LAN `llama-server --api-key` needs TLS and
  its CA in `caBundle`, or no key.
- **No proxy chaining.** The Custodian cannot forward to a corporate proxy. R11 says so rather than fail silently.
- **Two Harness env shapes.** With no held secret, a pod gets the Custodian's address and the token's Stand-in and no
  proxy, and its HTTPS goes direct. The Custodian runs in both shapes, because it carries the Menu.
- **The dial guard adds no confinement while egress is open.** The Agent can dial those addresses itself. The guard
  matters when a cluster closes egress to everything but the Custodian: then the Custodian is not a way around it.
- **One container holds two kinds of credential.** A fault in Envoy's TLS or HTTP parsing is a fault in the container
  that holds both the Sandbox token and the model keys. The branch with a separate Adapter keeps them apart.
- **The Harness container now speaks the Orchestrator's two agent routes.** The Agent could always make those calls (the
  Adapter would forward any MCP call it asked for); now the Harness makes them itself. Nothing is judged in the pod.
- **`jr2-upload-pack` carries the Stand-in as a constant.** The User Container gets no env (ADR-0005), and asks like any
  other seat. A test pins the Go literal to `standIn("JR2_SANDBOX_TOKEN")`.
- **The Custodian's image is a Pinned image.** It is deployed and never built, which
  [ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md) now states. `kitRegistry` re-homes it and `jr2 kit push`
  mirrors it ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)). The image sweep never
  takes it, because jr2 never stamped it ([ADR-0039](0039-image-garbage-collects-by-reachability.md)). A kind node pulls
  it from its registry, so the `@kind` tier needs network to `docker.io`. `just kit-push` does not seed it.
- **Where the Custodian suite runs.** `just custodian-test`: node's test runner against the pinned image under docker,
  on the host network with free ports, with local HTTPS upstreams under their own CA. It is opt-in, like `@kind`,
  because it needs docker ([ADR-0010](0010-bdd-acceptance-tests.md)). About 35 seconds. It checks the swap, the strip,
  403 with no Stand-in, 405 on a method, 400 on an underscore header, a header `Connection` names, two `Host` headers,
  idle connections on the health listener, 421, 400 and 403 on paths, the tunnel, the dial guard by every spelling and
  by resolved name, 502 on an untrusted upstream, SSE timing, abort, a 302, the start-up refusal, the log, and the
  Anthropic SDK through `HTTPS_PROXY`. The first SSE event arrives through the Custodian about half a millisecond later
  than direct.
- **The `@kind` tier's model wants a key.** Its fake provider serves HTTPS under the tier's CA and refuses a request
  without the key, which is `harness.provider.apiKey` — so every turn in the tier crosses a Custodian, in both
  placements. A Rule proves the key is in no env and no file of either Harness container.
- **The CA has no name constraints.** Constraints would force a new CA whenever the bound hosts change, and that breaks
  a live pod whose Custodian restarts.
