# A Caller comes from one authenticator seam and acts within its scopes

The Instance token is the operator's credential for everything that acts on an Instance from outside its Machines. The
CLI reads it from its Secret over the kube API, so kube RBAC is the gate
([ADR-0019](0019-one-converging-command-against-the-current-context.md)). That serves the person who runs `jr2 up`. It
does not serve the other Callers of the v1 target user: a CI job that starts runs, a bridge to a chat service that
answers Gates, a forge that sends deliveries, and a teammate with a browser and no cluster access. Each needs less than
the Instance token, and with one token each holds all of it. A run must also record who acted on it. So this decision
gives jr2 a way to know a Caller with no kube credentials, a scope for each act, and a record of each act.

## Decision

- **One seam: an ordered list of authenticators.** Each authenticator takes the credential of a request and gives one of
  two answers: a **Caller** `{ via, name, may, onBehalfOf? }`, or "not mine". The first authenticator that claims the
  credential decides. A credential that an authenticator claims and then finds bad is 401; it never falls through to the
  next one. A credential that no authenticator claims is 401. `via` names the authenticator (`token`, `jwt`, `hook`),
  `name` is the Caller's name for that authenticator, `may` is its scopes (below), and `onBehalfOf` is the Caller's
  claim about the party it acts for. The principals inside the Orchestrator stay outside the seam: an Agent's control
  token, a Sandbox's fetch token and the publish token
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)) are not Callers, and no
  authenticator makes a Caller from one. So a Sandbox token still reaches no Gate (ADR-0013).
- **The Instance token is one authenticator.** It gives the Caller `{ via: "token", name: "instance" }`, with every
  scope for every Workflow. Its meaning does not change: it is the operator's credential.
- **Named Caller tokens.** The Instance declares them in the `callers` block of `jr2.config.ts`, each with a name and
  its scopes (`callers.tokens.<name>.may`). A name is a DNS label of at most 40 characters, because it is part of the
  name of its Secret, and `instance` is the Instance token's name, so the config load refuses it. `jr2 up` makes the
  value of each one, once, in a Secret of its own, and gives the Orchestrator only the sha-256 of each value, in hex. A
  value is `jr2c_` and 32 random bytes in base64url. The prefix lets the seam say "not mine" with no lookup, and lets a
  secret scanner find a value that leaked. The digests go in one Secret, `jr2-caller-digests`, as one JSON object from
  name to digest, and the Orchestrator reads it through a mount. It reads the file again when it changes, so a new token
  or a rotation needs no restart. The kubelet updates a mounted Secret on its own period, about a minute, so the old
  value works until then. The scopes come from the config of the current Assembly: a name that has a digest and no entry
  in the config opens nothing, and a file that does not parse keeps the digests that the Orchestrator read last.
  `jr2 caller token <name>` prints the value, which it reads from the Secret over the kube API (RBAC is the gate, as for
  the Instance token), so it takes `-n` and `--context` and never `--url`. `jr2 caller rotate <name>` makes a new value,
  and the old value stops working. It writes the value's Secret first and the digests after, from every token Secret of
  the namespace, so a rotate that fails between the two runs again and loses no value. A name that the config no longer
  declares stops working at the next `jr2 up`, which deletes its Secret. Each token Secret carries its name in the label
  `jr2.dev/caller-token`, which is how `jr2 up` finds the undeclared ones.
- **JWTs from an identity provider.** The `callers` block also declares issuers
  (`callers.issuers: [{ issuer, audience, jwks?, claims?, groups, login? }]`). The JWT authenticator claims a bearer
  that is a JWT whose `iss` is the `issuer` of an entry; a JWT of another issuer is not its. For each issuer, jr2 checks
  a JWT's signature against the issuer's published keys, and its issuer, audience and expiry, with 30 seconds for the
  clocks to differ. It takes only asymmetric signatures, because a published key must not be able to sign. The keys come
  from `jwks`, or else from the `jwks_uri` of the issuer's `/.well-known/openid-configuration`. The Orchestrator keeps
  them for 10 minutes, and for a JWT with a key that it does not know it fetches them again at once, at most once in 30
  seconds, so a key that the issuer rotated works with no restart. When the fetch of the discovery document fails, the
  Orchestrator keeps the failure for 30 seconds, so many JWTs of that issuer cause at most one fetch in 30 seconds. It
  keeps keys only for the issuers that the current config names. The Caller's `name` is the `sub` claim and the name
  that jr2 shows is the `email` claim; `claims` names other claims for each. The scopes come from the values of one
  claim (a list of groups or roles, `groups` by default), through the map `groups` from a value to scopes; a JWT with
  more than one value gets the scopes of each, joined. A JWT that gets no scope from the map is 403 on every route that
  needs a scope. jr2 never treats it as read-only. `GET /whoami` answers it, with no scope, so that a person can see why
  the other routes refuse it.
- **Login in the Console's browser.** The Console logs a person in against a JWT issuer with `login: true`, with OIDC
  (the authorization code flow with PKCE, as a public client whose client id is the issuer's `audience`), and sends the
  ID token that it gets as the bearer. So login adds no authenticator: it is a way to get a JWT credential. The Console
  keeps the JWT as it keeps a typed token ([ADR-0032](0032-the-console-unlocks-with-a-callers-credential.md)). A login
  that jr2 hosts on the server side, with a session, comes later through the seam.
- **Five scopes, each one for every Workflow or for named Workflows.** `start` starts a run, `answer` answers a Gate,
  `cancel` cancels a run, `read` reads a run's state, and `steer` sends a Steering message
  ([ADR-0002](0002-duplex-streaming-actor.md)). A scope's value is `"all"` or a list of Workflow names. A Chart
  wrapper's name in the list also opens each named Chart of that wrapper (`plan` opens `plan/weekly`), because a named
  Chart runs its wrapper's Machine ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)); the name `plan/weekly`
  opens that Chart alone. For a route that addresses a run, jr2 checks the scope against that run's Workflow. Which
  scope opens which route is [ADR-0014](0014-observation-is-open-run-state-is-not.md)'s table. A 403 names the scope and
  the Workflow that the request needed. A Caller with the scope for no Workflow at all is refused before the Workflow is
  read, and the 403 names the scope.
- **`answer` can name single Gates.** Its list takes an item `{ workflow, gates: [<name>] }` beside a bare Workflow
  name, which still means every Gate of that Workflow: `answer: ["triage", { workflow: "deploy", gates: ["approve"] }]`.
  The same form is a value of the `groups` map, so a team's group answers its own Gate of a Workflow and not the others.
  A Hook's `may.answer` stays per Workflow: the Gate slot's handlers already say which Gates hear its kind. A Gate's
  name is its invoke id, its static name in the Machine that invokes it ([ADR-0011](0011-workflow-defined-events.md)).
  One name covers every Gate of the Workflow with that id, and `jr2 up` refuses a name that the Workflow's Machines do
  not have, so a typo fails at the door and not at the first answer, and a name that matches Gates in more than one
  Machine of the Workflow, so one name never opens two Gates without the author's word. An item for a Chart wrapper,
  `{ workflow: "plan", gates }`, opens those Gates in each named Chart of `plan` too, and `jr2 up` checks its names
  against the wrapper's Machine and each named Chart of the Assembly; an item for `plan/weekly` opens and checks that
  Chart alone. A runtime Chart's Gates do not exist at `jr2 up`, so `jr2 up` cannot check them: a name that no Machine
  and no Chart file of the wrapper has, and an item for a Chart that is no Chart file, are warnings and not refusals,
  and at run time the item opens the Gates of that name in the runtime Charts too. `GET /gates`, `GET /runs/:id` and the
  404 of a gate POST list only the Gates that the Caller may answer. A gate POST to an open Gate that the Caller may not
  answer is a 403 that names the scope, the Workflow and the Gate. The check and the delivery are one step, so a Gate
  that opens while the request is in flight is checked too. So a 403 and a 404 tell a Caller which Gate is open. That is
  not a secret: which state a run is in is observation, and the open run projections show it
  ([ADR-0014](0014-observation-is-open-run-state-is-not.md)). The other four scopes stay per Workflow: each of them acts
  on a whole run.
- **The CLI is the Caller `token/instance`.** It reads the Instance token as before, and it sends `onBehalfOf`: the user
  name that a kube `SelfSubjectReview` gives for the current context. It asks for the name beside the port-forward, and
  a server that does not answer gives no claim and no failure. A name that is not printable ASCII is not sent, because a
  header cannot carry it, and a longer name is cut to the bound. A Caller sends `onBehalfOf` in the header
  `jr2-on-behalf-of`, at most 256 characters. A Hook's `onBehalfOf` comes from its signed payload, and the door ignores
  the header for a Hook. With `--url` and `JR2_TOKEN`, the CLI sends any Caller's credential, and it is that Caller.
- **`GET /whoami` and `jr2 whoami` give the request's Caller record**: `via`, `name`, the name that jr2 shows, `may` and
  `onBehalfOf`. A person uses it to see what a credential may do before it fails.
- **`cors` is an allowlist of origins in `jr2.config.ts`, empty by default.** The Console is served from the
  Orchestrator's own origin and needs no entry. A browser app on another origin needs its origin in the list. Each entry
  is an origin alone (`https://ops.example.com`, no path, no pattern), and the config load refuses any other text. The
  Orchestrator reads the list of the current Assembly on each request.
- **The run records the Caller of each act on a guarded route.** A Caller in a record is
  `{ via, name, shown?, onBehalfOf? }`: never its scopes. The run's record holds `startedBy`, which is
  `{ kind: "caller", via, name, shown?, onBehalfOf? }`; `{ kind: "run", run, slot }` for a run that a local `dispatch`
  started (ADR-0071); or `{ kind: "jr2", why }` for a standing run, which has no Caller because jr2 starts it, at
  `boot`, at a `publish`, at a `hand-over` or at a `resume` ([ADR-0017](0017-pool-over-a-source-port.md)). A resume also
  records the Caller of the `jr2 run` that resumed the run, as `resumedBy`. A run that a foreign `dispatch` started
  records the Caller whose credential the other Instance sent. The record also holds `cancelledBy`, and `answers`: the
  last 100 answers to the run's Gates, each `{ gate, type, at, answeredBy }`. It keeps the last 100 because a standing
  run's Gate can take an answer for each delivery, and the record is saved on each transition. A gate event's Sender
  carries the Caller too (`via`, `name`, `onBehalfOf`), and `checked` names which of its fields jr2 checked
  ([ADR-0011](0011-workflow-defined-events.md)). `jr2 status` walks the `startedBy` chain to the first Caller and prints
  it, and the Console shows it. The walk reads one run at a time, as the Caller that asks, and names the runs between; a
  run it may not read, or that is no longer known, ends the walk, and the line says so. It reads at most 16 runs. The
  record is on the guarded routes only, never on the open observation projection (ADR-0014).
- **`onBehalfOf` is a claim.** jr2 records it and shows it, and it never checks it. The one exception is a Hook (below):
  there the signature covers the payload that `onBehalfOf` comes from.
- **A Caller's scope does not limit what its run dispatches.** A Caller with `start` on `triage` starts a run whose
  Machine can dispatch `deploy`. The Machine is the author's, and it is the boundary of what its run does, as it is for
  every Effect. The docs say this where they describe scopes.
- **A Hook is a Caller with `via: "hook"`.** The `hooks` block of `jr2.config.ts` declares each Hook by its name (the
  last segment of its address) and its Hook kind, which the config imports. A Hook's name has the form of a Caller
  token's name. The config load refuses another name, a value that no kind's constructor made, and two kinds with one
  id. The kind's constructor takes only the credential and the Workflows whose Gates the Hook may answer (`may.answer`,
  every Workflow by default): `github({ secret: secret("GH_HOOK"), may })`,
  `slack({ secret: secret("SLACK_SIGNING"), may })`, `discord({ publicKey: "…", may })`. A Hook has the `answer` scope
  only. A Hook never starts a run. To bring items to a Pool, it needs `answer` on the Pool's Workflow, because it
  reaches the Pool's `source` Gate ([ADR-0017](0017-pool-over-a-source-port.md)). The Hook's route has its own
  authenticator, its verifier, which gives `{ via: "hook", name, may: { answer }, onBehalfOf }`.
- **A Hook kind owns the service's protocol.** The kind gives what the service signed, the handshake, the decoding of
  the body (Slack sends a form), a zod schema for each event key, the event key, the delivery id, `onBehalfOf` and the
  envelope of a text that a person reads. The author writes none of them. Each is a fact of the service, the same for
  every Instance. jr2 ships a kind for each service that has a handshake, an envelope or a scheme of its own:
  - `github`: the event key is the event name and its action (`pull_request_review.submitted`), the id is
    `X-GitHub-Delivery`, and `onBehalfOf` is `sender.login`.
  - `gitlab`: the `token` verifier on `X-Gitlab-Token`. The event key is `object_kind` and the noteable type for a
    `note`, else the action or the status (`merge_request.approved`, `note.MergeRequest`, `pipeline.success`), the id is
    `Idempotency-Key` (else `X-Gitlab-Event-UUID`), and `onBehalfOf` is `user.username`.
  - `slack`: the event keys are `slash_command./jr2` (the command is in the key, so a Source for `/jr2` never hears
    `/deploy`), `block_actions.<action_id>` and `event_callback.<event type>`. The id is `event_id` for an event and
    `trigger_id` for a command or a click. `onBehalfOf` is the Slack user id, never a display name. The handshake
    answers `url_verification` with its `challenge`.
  - `discord`: the event keys are `application_command.<name>` and `message_component`, the id is the interaction's
    `id`, and `onBehalfOf` is `member.user.id`, or `user.id` in a direct message. The handshake answers `PING` with
    `PONG`. Another type of interaction (an autocomplete, a modal) gets the key `interaction.<type>`, which has no
    schema, so it reaches nothing.

  `onBehalfOf` comes from the verified body, so the signature covers it. The handshake, the parse and the envelope are
  [ADR-0011](0011-workflow-defined-events.md)'s door.

- **`webhook()` makes a kind from config data, for a service that has no kind.** Its config gives the verifier (`mac`
  over the raw body, with the header, its prefix and the algorithm; or `token` in a header), the event name, the
  delivery id and `onBehalfOf` (each by a header or a JSON path), and a zod schema for each event name. It has no
  handshake, and its answer is the outcome JSON. It makes a kind, not a Hook: the Instance writes it in a module of its
  own, which the config imports for its Hooks and the Workflows import for their handlers. A service that needs a
  handshake, a body that is not JSON, a signature over more than the body, a signed timestamp or an answer that a person
  reads needs a kind module. Sentry, the alert service of the standing Pool
  ([ADR-0017](0017-pool-over-a-source-port.md)), fits `webhook()` or a kind from another package.

- **A Hook kind is a module of the `@jr2/orchestrator/hooks` interface, from any package or a local file.**
  `jr2.config.ts` declares it by `import`, and `jr2 up` bundles it into the Assembly
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)). jr2 loads no kind at run
  time and discovers none from a folder. jr2's own kinds (`@jr2/orchestrator/hooks/github` and the others) use the same
  interface, and nothing more. The interface and the kinds are subpath exports of `@jr2/orchestrator`, so the
  Orchestrator Kit image holds their one copy, and each kind in an Assembly uses that copy. The door reads a Hook and a
  kind through a module that the package does not export, because it is not part of a kind's interface. It sits beside
  the module that makes a Hook, because that module decides the shape of a Hook.
  - **A kind never gets the credential.** jr2 makes the kind's constructor, so the credential goes from the config to
    the door and never through code that the kind wrote. For `token`, the door removes the header before any code of the
    kind runs.
  - **A kind is pure and synchronous**: no I/O, no Promise, no clock. It is trusted code in the Orchestrator, as is
    every package that a Workflow imports. Its types refuse a Promise, but they cannot stop I/O. The firm guarantee is
    that no kind holds a `mac` secret, because the Orchestrator holds none
    ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).
  - **A kind's id is short** (`sentry`): lowercase letters, digits and `-`, and it starts with a letter. One id is one
    kind in an Assembly. Two kinds with one id fail the typecheck and `jr2 up`. `defineHookKind` refuses an id of
    another form, an `api` that it does not know, and a `posts` entry that is not an `https://` url that ends in `/`. A
    kind's constructor refuses a credential of the wrong form: a `publicKey` that is not 64 hex characters, or a
    `secret` that is not a named secret.
  - **A follow-up is data.** A kind's answer to a person can give one POST for the door to make after the answer, with
    its url and its JSON (the reply to a Slack click). The kind declares the hosts of its posts, and `jr2 up` adds them
    to the Instance Effector's fence (ADR-0068).
  - **The interface is a public surface of v1.** A kind states `api: 1`, and a kind's package has a peer dependency on
    `@jr2/orchestrator`. The `api` is the contract, not the package version: the door refuses a kind whose `api` it does
    not know. Within `api: 1`, a new field of the interface is optional. A change that breaks a kind is `api: 2`.

- **Three verifiers, a closed set, and the Effector knows no Hook kind.** A kind chooses one, and gives the door what to
  verify: the bytes that the service signed, the signature, and the signed timestamp `at` when the signature covers one.
  The door runs the verifier:
  - `mac`: the kind gives the bytes (GitHub: the raw body; Slack: `v0:{timestamp}:{body}`), and the door makes every
    check that needs no secret, such as the window on `at`. Then the Instance Effector computes an HMAC over those bytes
    with the named secret and algorithm, compares it with the signature in constant time, and answers only "match" or
    "no match" ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). A secret that verifies a
    delivery can also forge one, so the Orchestrator never holds it.
  - `token`: the service sends a shared token in a header (GitLab). The door, in the Orchestrator, compares its sha-256
    with the digest that `jr2 up` gave it, and then removes the header. The digests go in one Secret,
    `jr2-hook-digests`, as one JSON object from the secret's name to its digest. It is not `jr2-caller-digests`, because
    `jr2 caller rotate` writes that Secret whole. The Orchestrator reads it through a mount, and again when it changes,
    as it reads the Caller digests. `jr2 up` applies it at each converge, empty when no Hook is `token`. It computes
    each digest on the host, from the entry of the `secrets` list: a literal, or the key of the user's Secret with one
    trailing newline removed, as the Effector reads a value. The value goes into no object that `jr2 up` writes.
  - `ed25519`: the door, in the Orchestrator, checks the signature over the timestamp and the body (Discord) against the
    application's public key. A public key can verify a signature and cannot make one, so it is not a secret, and the
    config holds it as a literal.

  **One window: 300 seconds, for every signed timestamp.** The door refuses a delivery whose `at` is more than 300
  seconds from its clock. A kind gives the timestamp and never the window, and no config changes it. Slack asks for 5
  minutes. Discord states no window, and its signature covers its timestamp, so the same window applies. The window
  closes a replay after the hook log forgets the delivery, `runs.retain` later
  ([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md)). A failed check, or a timestamp
  out of the window, is 401 (Discord sends bad signatures on purpose and expects 401). A new scheme is a change to the
  set. What a delivery does after the verifier is ADR-0011's: the handshake, the parse, the route, the repeat check, the
  fan-in and the answer.

- **Tests.** The unit tier checks the JWT authenticator against an in-process issuer made with `jose`: a good token, a
  wrong issuer or audience, an expired token, a key that rotated, and a token with no scope. The `@console` tier checks
  the browser login against Dex in a container. Before each release, a person checks one login against a real provider
  by hand. The default tier checks the `token` and `ed25519` verifiers end to end, with a key pair that the test makes,
  and the window, the handshakes, the decoding, the parse and the envelopes of each kind. It has no Instance Effector,
  so a `mac` check runs there only through the injected transport (the bytes the Orchestrator builds, and its window);
  the Effector's Go tests check the comparison, and the `@kind` tier checks a `mac` Hook end to end through the Instance
  Effector ([ADR-0011](0011-workflow-defined-events.md)). The build must check what the services' docs do not settle:
  whether Slack signs `url_verification` (the design verifies it first), whether `trigger_id` is unique for each request
  (the body's digest catches a repeat anyway), whether Discord sends an interaction again, whether a Discord follow-up
  needs a bot token (the design does not use one), and Slack's limit on the length of a text. The `slack` kind gives the
  door a limit of 4000 characters, the length that Slack's docs advise for a message's `text`; no one checked the limit
  of the answer to a command or of a post to a `response_url`. GitLab's `Idempotency-Key` is from GitLab's docs, and no
  one checked it against a real delivery.

## Considered options

- **One Instance token for every Caller**, the state before this decision. Rejected: a CI job or a bridge holds every
  act on every run, and the run cannot say who acted.
- **Headers from an authenticating proxy** (`X-Forwarded-User` from a proxy in front of the Orchestrator). Not refused:
  it adds later as an authenticator. Not now, because jr2 can trust the header only when nothing but the proxy reaches
  the Orchestrator, and the v1 target user has no such proxy.
- **A kube TokenReview of the bearer.** Not refused: it adds later as an authenticator. Not now, because a Caller with
  kube credentials already has the CLI, and kube RBAC gives jr2 no scope to map.
- **A login that jr2 hosts on the server side**, with a session cookie. Not refused: it adds later through the seam. Not
  now, because it brings a cookie, CSRF and a session store. Browser login with a JWT gives the Console a login without
  them.
- **Other ways to read a JWT.** The `email` claim as the Caller's name: rejected, because a provider can change or
  reassign an email, and `sub` is stable for each issuer. Scopes from several claims, or from an expression over claims:
  rejected, because the groups or roles claim of a provider is one list. A JWT with no scope as `read`: rejected,
  because a default grant opens run state to every account of the provider. Opaque tokens with introspection: rejected,
  because each request then calls the provider, in a way that is different for each provider.
- **The token's value in the Orchestrator.** Rejected: the Orchestrator keeps only a digest, as it does for a Harness
  token ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). A digest that leaks starts nothing.
- **A Caller's scope as a limit on its run's dispatches.** Rejected: a run's Effects are the author's Machine, not the
  Caller's. A limit there makes the same Machine do different things for different Callers.
- **`answer` for whole Workflows only.** Rejected: one Workflow can wait on Gates that different people answer (a team's
  review, a release manager's approval), and a scope for the whole Workflow lets each of them answer the other's Gate.
- **A scope for each route.** Rejected: the five scopes are the five acts of a Caller. A finer scope names a route,
  which can change, and not an act.
- **`may.start` on a Hook**, so that a Hook can start runs of a Workflow. Rejected: a Hook never starts a run
  (ADR-0017). The authority to start is the `dispatch` slot in the author's code, as for any dispatch, and the Hook only
  answers the Pool's Gate.
- **The protocol in the author's config, for a service that jr2 ships a kind for**: the config says where a delivery
  holds its id, its event name and `onBehalfOf`, and which header holds the signature. Rejected: each of these is a fact
  of the service, the same for every Instance, so each author writes the service's protocol again; and a handshake or an
  envelope is not a field. For a service with no kind, this is `webhook()` (above).
- **A verifier for each service in the Instance Effector** (a `slack` scheme that knows `v0:`, the header names and the
  window). Rejected: every new service is then a change to the Go binary that is the trust boundary, and nothing in the
  bytes to check or in the window is secret. The Effector needs only the one operation that needs the secret: an HMAC
  over given bytes.
- **A package of its own for the interface and the kinds** (`@jr2/hooks`). Rejected: the Kit releases every package at
  one version, so a separate package gives the interface no version line of its own, and `api` already is its contract.
  A kind's package has a peer dependency on the kit either way, because every Instance that loads a kind has
  `@jr2/orchestrator`. A separate package only adds a public package to publish, pin and stage at each release.

## Consequences

- ADR-0013's open question, the authentication of a Caller without kube credentials, is closed: a named token, a JWT, or
  a browser login.
- [ADR-0014](0014-observation-is-open-run-state-is-not.md)'s guarded band becomes a scope check for each route.
  [ADR-0032](0032-the-console-unlocks-with-a-callers-credential.md)'s Console takes any Caller's credential, and shows
  only what its scopes allow. ADR-0071's foreign dispatch takes any token with `start` for that Workflow.
- `@jr2/orchestrator` gains the subpath exports `@jr2/orchestrator/hooks` (the interface of a Hook kind) and
  `@jr2/orchestrator/hooks/github`, `/gitlab`, `/slack`, `/discord` and `/webhook` (jr2's kinds and `webhook()`).
- `jr2.config.ts` gains `callers`, `hooks` and `cors`. The CLI gains `jr2 caller token|rotate <name>` and `jr2 whoami`
  ([ADR-0009](0009-cli-and-instance-interface.md)).
- GLOSSARY.md: **Caller** names the Steering message and the Hook. **Hook** and **Hook kind** are new terms.
