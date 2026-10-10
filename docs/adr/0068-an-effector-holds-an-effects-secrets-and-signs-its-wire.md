# An Effector holds an Effect's secrets and signs its wire

An Effect that holds a secret cannot run where the Agent executes code: the Agent could read the secret, or spend it on
another host. A Held secret ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)) cannot do
it either, because the Agent can spend it through the Custodian. And the Orchestrator holds no Effect secret in its
process or its env: it runs every Machine's code, and a secret it held would be one fault away from all of them. So jr2
runs such an Effect in a container of its own, the **Effector**, where the Agent executes nothing and the Orchestrator
only asks. (The Orchestrator's Role can still read the Secrets that hold them; see Consequences.)

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
  it is already pulled, and `http` needs no tool. The Sandbox Effector runs the author's image: the Sandbox Image by
  default — ADR-0037's floor already holds `git`, so a `push` owes the author no Dockerfile; `ssh-keygen` signs, and
  `gpg` only when a key is GPG — or the image a `workspace()` names as `effector: { image }`, for the tools and
  credentials an author keeps out of the Agent's image. Rejected: a published `jr2-effector` tool image (git, ssh, gpg)
  — author-built images would deprecate it, as `jr2-adapter` was.
- **Two placements, one binary.** The Instance Effector runs `http` with no Worktree file. A Sandbox Effector — the
  binary with `JR2_EFFECTOR_WORK` set, a read-only view of the Agent's `/work` — runs every kind: `http`, `upload`,
  `push` and a credentialed `command` (ADR-0067); the Instance Effector refuses the last three, and a file body, as a
  defect. Its env names where its mount holds the rest: `JR2_EFFECTOR_REPOS` (the node's Repo caches, read-only),
  `JR2_EFFECTOR_GIT` (the push credentials, a directory each: `identity` and `known_hosts` for an ssh key, `token` for a
  token, `private.asc` for a GPG key), `JR2_EFFECTOR_SCRATCH` (its own writable scratch). What jr2 guarantees is stated
  per kind: for `push`, git never takes config or hooks from the Agent's repository and no program the Agent's files
  name runs — the clean-repository procedure of ADR-0067; for a credentialed `command`, the Agent's files are the
  author's choice to run, and the claims are three: the Agent never reads or spends the secret, the tool sees a pinned
  commit and not the live Worktree, and the output is scrubbed. A credentialed command's child gets the Effector
  container's own `PATH`, as its image set it.
- **The wire.** `POST /effects/<id>` starts an Effect and answers at once (202, `state: running`). A second `POST` with
  the same id starts nothing and attaches (200). The answer to a `push` or a credentialed `command` start names the
  commit it runs against (`pinned`), read before the answer, so the Orchestrator writes it to the ledger's intent row.
  `GET /effects/<id>` long-polls: it holds up to 25 s and answers `running`, or `settled` with the output. A malformed
  request starts nothing and gets 400 with the reason; a request that names a secret the Effector does not hold is
  malformed. `/healthz` is the kubelet's probe, unsigned, and says only whether the replica takes new Effects. A replica
  reads at most 4 MiB of a request; it cannot verify a longer one, so it refuses it as unsigned. The Orchestrator never
  sends one: a start whose body is longer settles `refused`, with nothing sent and no intent row, because a body built
  from context or a pick's param can reach the bound.
- **Hand-written types, and golden fixtures.** There is no code generator. The types are Go structs in
  `effector/internal/wire` and zod schemas in `@jr2/orchestrator`, the one definition each TypeScript type is inferred
  from. Go decodes with unknown fields disallowed. The golden fixtures in `effector/testdata/wire/` keep the two equal:
  one JSON file per request shape (`request.*`), per answer and outcome (`response.*`), per shape its decoder must
  refuse (`reject.*`), and the two signatures (`signature.*`). Go decodes each request and encodes each response; the
  TypeScript tests read the same files by a relative path, encode the requests and decode the responses.
- **Signed requests and signed answers, and no bearer.** The key is the placement's,
  `HMAC(signing key, "effector:" + placement)`, as ADR-0058 derives the Harness bearer: the Orchestrator stores nothing.
  The Effector reads it from a file in its own mount. A request carries `X-Jr2-Time` (Unix milliseconds), `X-Jr2-Nonce`,
  and `X-Jr2-Signature`: base64url HMAC-SHA256 over `jr2-effector-request`, the method, the address the request is sent
  to (the replica's `POD_IP:port`), the path, the time, the nonce and the hex sha-256 of the body, one per line. The
  address is signed and not sent: the Effector verifies with its own. An answer carries an HMAC over
  `jr2-effector-response`, its status, the request's method, path and nonce, and the sha-256 of its body. So an answer
  is bound to the one request it answers. The Effector refuses a request with no signature, a wrong one (one signed for
  another replica's address is one), a time before its process started or more than 5 minutes from its clock, or a nonce
  it saw inside that window: 401, an empty body, no signature, before any route is read. A replica keeps the nonces it
  saw in its process memory; the address and the start time cover what that memory cannot. So a start sent again — to
  another replica of the placement (a rollout runs two), or to the same replica after its process restarted — starts
  nothing. A refused caller learns nothing, not even whether an Effect exists. Reason: a process that takes the
  Effector's port while the Effector is down learns no secret from a request and can forge neither a request nor an
  answer. It can read a request's input, which is not secret, and it can make the call fail, which is output. A start it
  took, sent to the Effector once it is back, was signed before that process started.
- **The Orchestrator's side.** `@jr2/orchestrator` speaks the wire through an injected transport (the unit tests' seam,
  [ADR-0010](0010-bdd-acceptance-tests.md)). The Instance Effector's address is derived from the namespace,
  `jr2-instance-effector.<namespace>.svc:8082`, and its key from the signing key (`effectorKey`): the Orchestrator
  stores neither (a Sandbox Effector's key is derived from its Sandbox's name; its address is open, ADR-0067). The real
  transport resolves that name to every replica's address; a start goes to one of them, and to the next only when a
  replica was never reached or answered that it is stopping. An answer without the Effector's signature is not the
  Effector's, and never an outcome. To a start it is an answer lost and to a poll a replica gone (its address may be
  stale): every replica is asked. When asking every replica gets one too, the Effect settles `unknown`, with that
  reason, and is not sent again, `idempotent` or not: no retry changes the key the answer is checked with. So a key that
  is not the Effector's, or another process on its address, makes the call fail and never holds the run in its state. A
  signed answer that is not the wire's shape is a jr2 defect: the Effect errors.
- **Replica-aware.** Every answer names the replica that holds the Effect — its pod name and its address
  (`POD_IP:port`). A poll to a replica that does not hold the Effect gets 404 with `state: unknown` and that replica's
  name. A replica that gets SIGTERM refuses a new Effect (503, `error: stopping`, which starts nothing), finishes the
  Effects in flight, and stays until each outcome was read or `JR2_EFFECTOR_DRAIN_SECONDS` is spent. An outcome nobody
  reads is dropped 10 minutes after it settled: there is no cancel route.
- **Scrubbing, last, before the answer is signed.** Every string that leaves goes through it: an http body, its headers'
  values and names (a name reaches the Effector case-folded, so it is matched with case folded), error text — and then
  the whole encoded answer. It matches every secret the Effector holds, not only the ones the current Effect names, in
  three kinds of form: the exact value; its usual encodings (base64 in both alphabets, padded and not, alone or inside a
  longer encoded string — a server that base64-encodes a dump of the request's headers puts the value at any byte
  offset, so the characters that hold only the value's own bits are a form at each of the three offsets;
  percent-encoding; JSON-escaping); and what the Effector built from it for this Effect (the `Authorization` value it
  sent, `base64(user:password)`, a definition header it filled from the secret, the url with the secret in its path, and
  that url as the server sees it, its path and query), each with the same encodings. An encoding has more than one
  spelling, and a server echoes in its own encoder's, so each common spelling is a form: percent-encoding that leaves
  only the unreserved characters, or also `/` (Python's `quote`), or `!'()*` (`encodeURIComponent`), or the reserved
  ones (`encodeURI`), or a path's characters, a form's `+` for a space, Go's query and path escapes, each in upper and
  lower hex; JSON with or without `\/`, with or without `<`, `>`, `&` as `\u003c`, `\u003e`, `\u0026`, with or without
  every non-ASCII character as `\uXXXX`, `\b` and `\f` or their `\u` forms, U+2028 and U+2029 as `\u2028` and `\u2029`
  or as they are, and `\u` hex in either case. A match becomes `[secret:<name>]`. A body, and a credentialed command's
  stream, is scrubbed as it streams, across chunk borders, with a window one byte shorter than the longest form — and
  before it is bounded: a secret that straddles the cut to the tail was replaced whole before the cut. The Effector
  refuses to start with a secret shorter than 8 characters, and names it: a shorter one would match ordinary text.
  `jr2 up` refuses a short one earlier, a literal and a value in the user's own Secret alike (see the secrets list
  below); the Effector's refusal is for a Secret edited after the converge.
- **Every Effect secret is a file in the Effector's own mount**, `/run/jr2/secrets/<name>`, read once at start. One
  trailing `\n` or `\r\n` is taken off, as the Custodian does. A credentialed command names what it needs under `env`,
  in two forms: `secret("x")` gives the value, `secret("x").path` the file's path; there is no `files:` option. A push
  credential's secret files (`identity`, `token`, `private.asc`) are held and scrubbed like every Effect secret. A value
  changed after the start reaches the Effector when its pod rolls; the template digest below makes the next `jr2 up`
  roll it.
- **The `http` kind.** The request is built in the Effector from the definition's parts: the method (GET, HEAD, POST,
  PUT, PATCH, DELETE, OPTIONS); a url, as `text` parts where a secret is a part and never a value on the wire, a secret
  in it percent-encoded as a path segment — so a secret sits only in the url's path, after the host: one after a `?` or
  a `#` is refused by `http()` when the Machine loads, and by the Effector, because a query would read the path's
  encoding as a different value; `path` segments, each percent-encoded and appended after the definition's path, whose
  one trailing `/` is the joint — with no segment the definition's url is sent as it is written; the definition's
  headers (one that frames or routes the request is refused: `host`, `content-length`, `transfer-encoding`,
  `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, and every `proxy-*`; `http()` refuses it when the Machine
  loads, and the start's zod shape and the Effector refuse it on the wire, with one reject fixture per name); auth —
  `bearer` (`Bearer <value>`), `basic` (`Basic base64(user:password)`), or `text` (the whole header) — from the secret
  files; a JSON or text body; a timeout. Outcomes:
  - `response`: the status, every header, the content type, the size, and the body when it is text (a `text/*` type,
    JSON, XML, a form, JavaScript; with no type, what its first bytes sniff as), bounded to a byte limit and marked
    `truncated` past it. A body that is not text is never returned: its size and type are.
  - `unreachable`: nothing was sent — the name did not resolve, the connection or TLS failed.
  - `refused`: the Effector refused it and sent nothing — a path segment that is `.`, `..` or empty (an Agent's param
    can cause it, so it is output, not a fault), or a host and secrets that no Effect placed there names. The
    Orchestrator settles a start longer than 4 MiB `refused` the same way, before it sends anything.
  - `unknown`: the connection was made and no answer came (the timeout, a reset): the host may have acted.

  Each outcome other than `response` carries a `reason` in words. A pick that runs an `http` Effect is answered, by
  default, with that output whole, as the kit renders an Effect's output
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): the Agent reads
  ``Its answer: the output of `<slot>`: <the output's JSON>.``, already scrubbed. An `answer` action shapes it instead
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)).

- **The host is fixed, in the Effector.** The Effector's config (`effector.json`, written by `jr2 up` from the Effects'
  plain data) lists each scheme, host and port an Effect placed there names, with the secrets that Effect names. A
  request to another target, or with another secret, is `refused`. A redirect is the response and is never followed: it
  would send the request, and its `Authorization`, to a host the definition did not fix. No proxy is read from the
  environment. The trust is the system roots and the instance's `caBundle`
  ([ADR-0020](0020-private-ca-trust-is-a-named-concept.md)).
- **One list of secrets; placement is read, never declared, and naming is placement on both sides.** The top-level
  `secrets` list replaces `harness.heldSecrets`; its entry is ADR-0059's
  (`{ name, value | valueFrom.secretKeyRef, hosts?, headers?, paths? }`). A pod gets the secrets something in it names:
  a Workspace's pod the Held secrets its `workspace()` lists under `secrets: [...]` and the model keys its Agents'
  providers read; the Instance Harness the model keys of its `"none"` Agents only; an Effector what its Effects name
  with `secret("name")` (an `http` Effect: the Instance Effector; an `upload` and a credentialed `command`: the Sandbox
  Effector of the Workspace whose body invokes it, B5.1). `hosts`, `headers` and `paths` are a Held secret's binding,
  never its placement (ADR-0059). One derivation (`secretPlacementsOf`) places both kinds, and the held manifest, the
  Custodian config and the held values' Secret of each Harness pod come from it. Both is both, and `jr2 up` reports it
  per pod. An entry nothing names goes nowhere, and `jr2 up` warns:
  `secrets[i] (<name>) is named by nothing; goes nowhere`. There is no `placement:` key: naming is the placement.
  `jr2 up` prints one line per secret with its placements, and one per pod with what it holds
  (`Workspace of workflow "coding": Custodian holds ANTHROPIC_API_KEY (provider), JIRA_TOKEN`,
  `the Instance Effector: holds jira`,
  `Workspace of workflow "coding": Sandbox Effector (image the Sandbox Image) holds aws; pushes with git.credentials "*"`).
  Right after the walk, before anything is built or applied, it refuses an Effect of any kind or a `workspace()` that
  names a secret the list does not hold (with the line to add) and a literal Effect secret shorter than 8 characters,
  saying why. A `valueFrom` names a key of the user's Secret, which `jr2 up` checks once it reaches the cluster: the key
  exists, and its value is 8 characters or more, measured as the Effector reads the file (bytes, one trailing newline
  off). `jr2 up` keeps that length and a keyed digest of the value, never the value, and refuses a short one with the
  same line. The digest rolls each long-lived pod that reads the value once at start: the Instance Effector (its
  Deployment, below) and the Instance Harness (its Custodian, ADR-0059). The Effector refuses to start with an empty or
  short value, for a Secret edited after the converge. A secret reaches only the pods where something names it: a
  literal is written into the placement's own Secret, and a `valueFrom` is projected from the user's Secret by
  reference, never copied. `git.credentials` stays its own list: a fence keyed by url prefix, not a named value.
- **The Instance Effector's objects.** `jr2 up` converges them when a registered Machine places an Effect there, and
  deletes them otherwise; it reports either (`instance effector: converging (<workflow>/<slot>; secrets …; grace …)` or
  `instance effector: none`). All four are named `jr2-instance-effector`:
  - A **Deployment**, one replica, rolling with surge and no gap, so a rollout runs the old pod beside the new one: the
    `jr2-harness` image, command `/opt/jr2/bin/effector`, non-root, no privilege escalation, every capability dropped, a
    read-only root filesystem, an emptyDir scratch as `$HOME`, no ServiceAccount token, the control tier's PriorityClass
    ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)). Its pod template carries
    `jr2.dev/effector-digest`, an HMAC over every secret input keyed with the signing key, so an edit rolls it at the
    next `jr2 up`: a literal's value, a `valueFrom`'s reference, and a digest of the value in the user's Secret, keyed
    with the signing key, which `jr2 up` takes when it measures the value and keeps in place of it.
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
- **A Workspace's Sandbox Effector's objects** (B5.1, B8). `jr2 up` reads, for each `workspace()`, the Effects placed
  there below it, down to the next `workspace()` — every `push`, `upload` and credentialed `command`, from their plain
  data, statically — and writes two objects for a Workspace with one, none for one without:
  - the **Secret** `jr2-effector-<pod>` (labelled with its pod key, deleted when its Workspace no longer places an
    Effect there): each literal Effect secret those Effects name, each push token, and `effector.json` — the targets its
    uploads call, and the `git.credentials` entries its pushes spend, each credential named by a directory under the git
    mount;
  - the **manifest** `effector-<pod>.json` in `jr2-held` beside the pod's Held manifest: names only — the projected
    sources of the Effector's `/run/jr2/secrets`: that Secret's keys, each `valueFrom` key of the user's own Secret and
    each key of a deploy or signing key a push spends (`identity`, `known_hosts`, `private.asc`), all by reference, at
    `git/<dir>/<file>` for a credential.

  The provision reads the pod's manifest, as it reads its Held one, and adds the `effector` container when one is there
  (ADR-0005): its image is the `workspace()`'s `effector: { image }`, resolved like the User Container's, or the Sandbox
  Image; its per-pod key is `effectorKey(signing key, <Sandbox name>)`, derived like the Sandbox token and written into
  `<sandbox>-effector`, a Secret the CR owns, which only that container mounts, beside `effector.json`. Each pod's key
  is its own: a request signed for one Sandbox is refused by every other.

- **The log is a contract.** `jr2.effector` lines: `ready placement=… replica=… secrets=<names> targets=N`,
  `action=start effect=… kind=… method=… host=…` (a push and a command log `host=-`),
  `action=settle effect=… outcome=… status=…`, `action=drop`, `action=drain`. Never a value, a path, a query, a header
  or a body.

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
  `idempotent` ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)).
- The `@kind` tier carries the proofs a unit test cannot: an echo server in the seed namespace answers each header and
  the url in every encoding, and the run's snapshot, its feed and the answer the model reads must hold no form of the
  value — the step decodes every base64 and percent-encoded run it reads, so a leak of what the Effector built
  (`Bearer <value>`, a Basic pair, the url, a header) cannot pass as clean; two replicas and an Orchestrator restart
  during a call, and a rollout during a call, must give one send.
- **Open gap: the Orchestrator's Role reads Effect secrets.** Its Role can get and list every Secret in its namespace
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)), `jr2-instance-effector` and every user Secret a
  `valueFrom` names among them. So a fault that gives code execution in the Orchestrator reaches the Effect secrets
  through the API, though the Orchestrator never holds one. Narrowing the Role is a separate decision.
- **The start time asks the clocks to agree.** A replica refuses a request signed before its process started, by the
  Orchestrator's clock against its own. If the Orchestrator's clock is behind by more than the time between a replica's
  start and the first request it gets, that request is refused as unsigned: to the Orchestrator an answer lost, so every
  replica is asked, and a call not marked `idempotent` settles `unknown` with nothing sent. The clocks of a cluster's
  nodes agree far closer than that.
