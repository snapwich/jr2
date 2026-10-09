# An Effector holds an Effect's secrets and signs its wire

An Effect that holds a secret cannot run where the Agent executes code: the Agent could read the secret, or spend it on
another host. A Held secret ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)) cannot do
it either, because the Agent can spend it through the Custodian. And the Orchestrator holds no Effect secret: it runs
every Machine, so one fault there would reach every secret. So jr2 runs such an Effect in a container of its own, the
**Effector**, where the Agent executes nothing and the Orchestrator only asks.

## Decision

- **One static Go binary, `effector`.** A top-level Go module, `effector/`, beside `operator/`: the same toolchain and
  lint, `make test` and `make lint`, the standard library only. Go because the Effector is the trust boundary, and the
  safe file opener the experiments proved (`os.Root`, `openat2`) is Go's. It is configured by its env, which names where
  its own mount holds things and never a value: `JR2_EFFECTOR_PORT` (default 8082), `JR2_EFFECTOR_KEY`,
  `JR2_EFFECTOR_CONFIG`, `JR2_EFFECTOR_SECRETS`, `JR2_CA_FILE`, `JR2_EFFECTOR_DRAIN_SECONDS`, `POD_NAME`, `POD_IP`.
- **The binary rides `/opt/jr2`; no Effector image is published.** The `jr2-harness` image builds it in a Go stage and
  carries it at `/opt/jr2/bin/effector`, beside `rg` and `jr2-upload-pack`
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). A container becomes an Effector
  by running it as its command, so the image around it is whatever that container runs: the tools are the author's, the
  trust boundary is jr2's binary. The Instance Effector runs the `jr2-harness` Kit image itself — it carries the binary,
  it is already pulled, and `http` needs no tool. Rejected: a published `jr2-effector` tool image (git, ssh, gpg) —
  author-built images would deprecate it, as `jr2-adapter` was. The Sandbox Effector, the second placement, is built
  next.
- **The wire.** `POST /effects/<id>` starts an Effect and answers at once (202, `state: running`). A second `POST` with
  the same id starts nothing and attaches (200). `GET /effects/<id>` long-polls: it holds up to 25 s and answers
  `running`, or `settled` with the output. A malformed request starts nothing and gets 400 with the reason; a request
  that names a secret the Effector does not hold is malformed. `/healthz` is the kubelet's probe, unsigned, and says
  only whether the replica takes new Effects.
- **Hand-written types, and golden fixtures.** There is no code generator. The types are Go structs in
  `effector/internal/wire` and zod schemas in `@jr2/orchestrator`. Go decodes with unknown fields disallowed. The golden
  fixtures in `effector/testdata/wire/` keep the two equal: one JSON file per request shape (`request.*`), per answer
  and outcome (`response.*`), per shape both sides must refuse (`reject.*`), and the two signatures (`signature.*`). Go
  decodes each request and encodes each response; the TypeScript tests read the same files by a relative path, encode
  the requests and decode the responses.
- **Signed requests and signed answers, and no bearer.** The key is the placement's,
  `HMAC(signing key, "effector:" + placement)`, as ADR-0058 derives the Harness bearer: the Orchestrator stores nothing.
  The Effector reads it from a file in its own mount. A request carries `X-Jr2-Time` (Unix milliseconds), `X-Jr2-Nonce`,
  and `X-Jr2-Signature`: base64url HMAC-SHA256 over `jr2-effector-request`, the method, the path, the time, the nonce
  and the hex sha-256 of the body, one per line. An answer carries an HMAC over `jr2-effector-response`, its status, the
  request's method, path and nonce, and the sha-256 of its body. So an answer is bound to the one request it answers.
  The Effector refuses a request with no signature, a wrong one, a time more than 5 minutes from its clock, or a nonce
  it saw inside that window: 401, an empty body, no signature, before any route is read. A refused caller learns
  nothing, not even whether an Effect exists. Reason: a process that takes the Effector's port while the Effector is
  down learns no secret from a request and can forge neither a request nor an answer. It can read a request's input,
  which is not secret, and it can make the call fail, which is output.
- **The Orchestrator's side.** `@jr2/orchestrator` speaks the wire through an injected transport (the unit tests' seam,
  [ADR-0010](0010-bdd-acceptance-tests.md)). The Instance Effector's address is derived from the namespace,
  `jr2-instance-effector.<namespace>.svc:8082`, and its key from the signing key (`effectorKey`): the Orchestrator
  stores neither. The real transport resolves that name to every replica's address; a start goes to one of them, and to
  the next only when a replica was never reached or answered that it is stopping. An answer without the Effector's
  signature is not the Effector's: it is treated as a transport failure, never as an outcome.
- **Replica-aware.** Every answer names the replica that holds the Effect — its pod name and its address
  (`POD_IP:port`). A poll to a replica that does not hold the Effect gets 404 with `state: unknown` and that replica's
  name. A replica that gets SIGTERM refuses a new Effect (503, `error: stopping`, which starts nothing), finishes the
  Effects in flight, and stays until each outcome was read or `JR2_EFFECTOR_DRAIN_SECONDS` is spent. An outcome nobody
  reads is dropped 10 minutes after it settled: there is no cancel route.
- **Scrubbing, last, before the answer is signed.** Every string that leaves goes through it: an http body, its headers,
  error text — and then the whole encoded answer. It matches every secret the Effector holds, not only the ones the
  current Effect names, in three kinds of form: the exact value; its usual encodings (base64 in both alphabets, padded
  and not; percent-encoding as a query and as a path segment; JSON-escaped); and what the Effector built from it for
  this Effect (the `Authorization` value it sent, `base64(user:password)`, the url with the secret in its path). A match
  becomes `[secret:<name>]`. A body is scrubbed as it streams, across chunk borders, with a window one byte shorter than
  the longest form. The Effector refuses to start with a secret shorter than 8 characters, and names it: a shorter one
  would match ordinary text. A literal is refused earlier, by `jr2 up`; a value from the user's own Secret is first seen
  here.
- **Every Effect secret is a file in the Effector's own mount**, `/run/jr2/secrets/<name>`, read once at start. One
  trailing `\n` or `\r\n` is taken off, as the Custodian does.
- **The `http` kind.** The request is built in the Effector from the definition's parts: the method (GET, HEAD, POST,
  PUT, PATCH, DELETE, OPTIONS); a url, as `text` parts where a secret is a part and never a value on the wire, a secret
  in it percent-encoded; `path` segments, each percent-encoded and appended; the definition's headers (a header that
  frames or routes the request is refused); auth — `bearer` (`Bearer <value>`), `basic` (`Basic base64(user:password)`),
  or `text` (the whole header) — from the secret files; a JSON or text body; a timeout. Outcomes:
  - `response`: the status, every header, the content type, the size, and the body when it is text (a `text/*` type,
    JSON, XML, a form, JavaScript; with no type, what its first bytes sniff as), bounded to a byte limit and marked
    `truncated` past it. A body that is not text is never returned: its size and type are.
  - `unreachable`: nothing was sent — the name did not resolve, the connection or TLS failed.
  - `refused`: the Effector refused it and sent nothing — a path segment that is `.`, `..` or empty (an Agent's param
    can cause it, so it is output, not a fault), or a host and secrets that no Effect placed there names.
  - `unknown`: the connection was made and no answer came (the timeout, a reset): the host may have acted.
- **The host is fixed, in the Effector.** The Effector's config (`effector.json`, written by `jr2 up` from the Effects'
  plain data) lists each scheme, host and port an Effect placed there names, with the secrets that Effect names. A
  request to another target, or with another secret, is `refused`. A redirect is the response and is never followed: it
  would send the request, and its `Authorization`, to a host the definition did not fix. No proxy is read from the
  environment. The trust is the system roots and the instance's `caBundle`
  ([ADR-0020](0020-private-ca-trust-is-a-named-concept.md)).
- **One list of secrets; placement is read, never declared.** The top-level `secrets` list replaces
  `harness.heldSecrets`; its entry is ADR-0059's (`{ name, value | valueFrom.secretKeyRef, hosts?, headers?, paths? }`).
  An entry with `hosts` — or a known model key, whose hosts default — is a Held secret (every Custodian, ADR-0059). An
  entry an Effect names with `secret("name")` is an Effect secret in that Effect's placement (an `http` Effect: the
  Instance Effector). Both is both. Neither goes nowhere, and `jr2 up` warns:
  `secrets[i] (<name>) is named by nothing; goes nowhere`. There is no `placement:` key: naming is the placement.
  `jr2 up` prints one line per secret with its placements, refuses an Effect that names a secret the list does not hold
  (with the line to add), and refuses an Effect secret shorter than 8 characters, saying why. A secret reaches only the
  pods where something names it: a literal is written into the placement's own Secret, and a `valueFrom` is projected
  from the user's Secret by reference, never copied. `git.credentials` stays its own list: a fence keyed by url prefix,
  not a named value.
- **The Instance Effector's objects.** `jr2 up` converges them when a registered Machine places an Effect there, and
  deletes them otherwise; it reports either (`instance effector: converging (<workflow>/<slot>; secrets …; grace …)` or
  `instance effector: none`). All four are named `jr2-instance-effector`:
  - A **Deployment**, one replica, rolling with surge and no gap, so a rollout runs the old pod beside the new one: the
    `jr2-harness` image, command `/opt/jr2/bin/effector`, non-root, no privilege escalation, every capability dropped, a
    read-only root filesystem, an emptyDir scratch as `$HOME`, no ServiceAccount token, the control tier's PriorityClass
    ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)). Its pod template carries
    `jr2.dev/effector-digest`, an HMAC over every secret input keyed with the signing key, so an edit rolls it.
    `terminationGracePeriodSeconds` is the longest timeout among the Effects placed there plus 30 s for the outcome to
    be read; the drain ends 5 s before it.
  - A **headless Service** that publishes addresses that are not ready: "ask every replica" is its name's addresses, a
    stopping replica among them.
  - A **NetworkPolicy** of `jr2-sandbox-ingress`'s form ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)):
    ingress from this Instance's Orchestrator only. Egress stays open: the pod calls the hosts its Effects name, and
    holds no Custodian.
  - The **Secret**: each literal Effect secret placed there, `effector.json` (the targets), and the placement's key,
    `effectorKey(signing key, "instance")`, which `jr2 up` derives from the kept signing key. "Nothing stored" means
    nothing stored by the Orchestrator: the Kubernetes Secret is the store, as for every credential. The secrets are
    files under `/run/jr2/secrets`, mode 0400; the kubelet makes them readable by the pod's `fsGroup`, and the pod has
    one container. `harness.env` and `harness.envFrom` may not name this Secret (ADR-0059's R13).
- **The log is a contract.** `jr2.effector` lines: `ready placement=… replica=… secrets=<names> targets=N`,
  `action=start effect=… kind=… method=… host=…`, `action=settle effect=… outcome=… status=…`, `action=drop`,
  `action=drain`. Never a value, a path, a query, a header or a body.

## Considered options

- **A bearer on the Effector's port.** Rejected: a Sandbox pod's containers share one network namespace, so a process
  the Agent starts can bind the Effector's port while it is down, and a bearer would be sent to it.
- **A code generator for the wire types.** Rejected for now: the wire is small. Later, zod 4 emits JSON Schema and Go
  types can be generated from it; the fixtures stay either way.
- **Follow redirects.** Rejected: the host is the definition's, and a redirect names another.
- **A StatefulSet for the Instance Effector**, as the Instance Harness is. Rejected: a one-replica StatefulSet deletes
  the old pod before it creates the new one, so a rollout would cut an Effect in flight; the Effector keeps nothing a
  stable name or volume would hold.
- **A `placement:` key on a secret.** Rejected: naming a secret in an Effect is what places it, and a key would be a
  second statement that can disagree with the first.

## Consequences

- **Not a goal of scrubbing:** a transformed secret (a hash, a truncation, an encoding not listed above), a partial
  echo, a side channel. The claim is that an Effector does not return a secret it holds, in the forms it sent or in
  common encodings.
- An `unknown` outcome is the Machine's to route. jr2 sends an `http` call again only when the author marked it
  `idempotent` ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once.md)).
