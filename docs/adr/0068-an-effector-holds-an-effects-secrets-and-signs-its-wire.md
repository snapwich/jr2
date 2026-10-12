# An Effector holds an Effect's secrets and signs its wire

An Effect that holds a secret cannot run where the Agent executes code: the Agent could read the secret, or spend it on
another host. A Held secret ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)) cannot do
it either, because the Agent can spend it through the Custodian. And the Orchestrator holds no Effect secret in its
process or its env: it runs every Machine's code, and a secret it held would be one fault away from all of them. So jr2
runs such an Effect in a container of its own, the **Effector**, where the Agent executes nothing and the Orchestrator
only asks. Its Role reads no Secret either: it may create and patch one, never get or list one (see Consequences).

## Decision

- **One static Go binary, `effector`.** A top-level Go module, `effector/`, beside `operator/`: the same toolchain and
  lint, `make test` and `make lint`, the standard library only. Go because the Effector is the trust boundary, and the
  safe file opener (`os.Root`, `openat2`) is Go's. It is configured by its env, which names where its own mount holds
  things and never a value: `JR2_EFFECTOR_PORT` (default 8082), `JR2_EFFECTOR_KEY`, `JR2_EFFECTOR_CONFIG`,
  `JR2_EFFECTOR_SECRETS`, `JR2_CA_FILE`, `JR2_EFFECTOR_DRAIN_SECONDS`, `POD_NAME`, `POD_IP`, `NODE_NAME`.
- **The binary rides `/opt/jr2`; no Effector image is published.** The `jr2-harness` image builds it in a Go stage and
  carries it at `/opt/jr2/bin/effector`, beside `rg` and `jr2-upload-pack`
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). A container becomes an Effector
  by running it as its command, so the image around it is whatever that container runs: the tools are the author's, the
  trust boundary is jr2's binary. The Instance Effector runs the `jr2-harness` Kit image itself — it carries the binary,
  it is already pulled, and `http` needs no tool. The Sandbox Effector runs the author's image: the Sandbox Image by
  default, or the image a `workspace()` names as `effector: { image }`, for the tools and credentials an author keeps
  out of the Agent's image. Rejected: a published `jr2-effector` tool image (git, ssh, gpg) — author-built images would
  deprecate it, as `jr2-adapter` was.
- **What a push owes the author's image.** ADR-0037's floor holds `git`; the rest is per push form, and `jr2 up` reads
  the Effector's image it built — files off a container it creates and never starts, and the `USER` it already records —
  or, for the stock Harness image (the fallback Sandbox Image, when the Workspace names no image and the instance has no
  `images/default`), knows what the kit built into it: `git` alone, and `USER 1000`, which its passwd holds. It refuses,
  with the fix for the case found, an image that lacks what a form the Workspace holds needs. Each program must be in
  `/usr/local/bin`, `/usr/bin` or `/bin`, where the Effector looks:
  - ssh transport (`ssh://`, `git@`): `ssh`, and a passwd entry for the uid the Effector runs as — the image's `USER` by
    name or number, else 1000. OpenSSH's client calls `getpwuid(getuid())` before any option and exits "No user exists
    for uid N" without one. The fix named is a `USER` line naming a user the image holds, or
    `adduser -D -u <uid> <name>` for a numeric or absent `USER`;
  - ssh signing (`sign: { sshKey }`): `ssh-keygen` (`-Y sign` does no passwd lookup);
  - GPG signing (`sign: { gpgKey }`): `gpg` and `gpg-agent`, and no `gpgconf`: the agent makes its socket before its
    launcher exits, so the launcher's exit 0 is its readiness, and the push stops it with a signal;
  - a token over https: nothing beyond `git` — the helper is the Effector's own binary.

  `http` — a Worktree file body included — and the credentialed command owe nothing: the first is Go, the last is the
  author's argv. In the stock Harness image only a token over https passes; for the others the fix named is an image of
  the author's that holds the program — an `images/default` Sandbox Image, the `workspace()`'s image, or its
  `effector: { image }`. A form `jr2 up` cannot see — a slot the run or a `customize()` binds — is not checked, nor an
  author's image `jr2 up` did not build (a registry ref), whose `USER` it does not read either. Rejected: a mounted
  passwd file, `nss_wrapper`, an `LD_PRELOAD` shim — jr2 taking an opinion on the author's image, against ADR-0037's
  zero-opinion seat. A push keeps ssh's own stderr apart from git's and names ssh's last line in its reason
  (`the remote could not be reached: ssh: …`), with both in the detail: git's own words for an ssh failure name no
  cause.

- **Two placements, one binary.** The Instance Effector runs `http` with no Worktree file. A Sandbox Effector — the
  binary with `JR2_EFFECTOR_WORK` set, a read-only view of the Agent's `/work` — runs an `http` whose body is a Worktree
  file, `push` and a credentialed `command` (ADR-0067); the Instance Effector refuses the last two, and a file body, as
  a defect. Its env names where its mount holds the rest: `JR2_EFFECTOR_REPOS` (the node's Repo caches, read-only),
  `JR2_EFFECTOR_GIT` (the push credentials: one directory per `git.credentials` entry the Sandbox's pushes spend, the
  entry's own Secret as the operator projects it — `entry.json`, what the entry is; `identity` and `known_hosts` for an
  ssh key; `password` for a token; `sign.identity` or `sign.private.asc` for the signing key; see the Sandbox Effector's
  objects below), `JR2_EFFECTOR_SCRATCH` (its own writable scratch). What jr2 guarantees is stated per kind: for `push`
  and a file body, git never takes config or hooks from the Agent's repository and no program the Agent's files name
  runs — the clean-repository procedure of ADR-0067 and the opener below. jr2's own programs (`git`, `ssh`,
  `ssh-keygen`, `gpg`, `gpg-agent`) run by an absolute path found in one fixed PATH, `/usr/local/bin:/usr/bin:/bin`,
  never by the PATH the image set: an image that puts a directory of its own first does not choose which `git` runs. For
  a credentialed `command` the Agent's files are the author's choice to run, and the claims are the next bullet's.
- **A credentialed `command`'s child is confined with Landlock.** The child runs as the Effector's own uid in the
  Effector's container, where the placement key, every placed secret and the push and signing keys are files that uid
  can read, and its program is often the Agent's code (`npm run deploy`, `make`, `./scripts/release.sh`, a tool's
  plugins). Unconfined, it could print a secret in a form the scrubber does not know, or sign a start on loopback with
  the key. So the Effector does not exec argv itself. It runs its own binary as the confiner, under the Effect's keeper
  (rule 1 of "One child cannot reach another", below), `effector confine <rules> -- <path> <argv...>`, which sets
  `PR_SET_NO_NEW_PRIVS`, makes a Landlock ruleset, adds one rule per allowed path, calls `landlock_restrict_self`, and
  only then `execve(argv)`: three raw syscalls (444, 445, 446, the same on amd64 and arm64), the standard library only.
  The thread is locked from the probe to the `execve`, so the domain is the one `execve` keeps. Landlock is an
  allow-list the kernel enforces and every descendant inherits, and a confined process cannot ptrace a process outside
  its domain, so `/proc/<effector>/mem` and `/proc/<effector>/environ` are closed too. The ruleset handles every
  filesystem right of ABI 1, and `REFER` and `TRUNCATE` when the kernel offers ABI 2 and 3. It allows: read and execute
  on the image's system paths — every top-level directory the image holds that is not a denied name, whole, so the rules
  follow the image and break on no layout (the usual `/usr`, `/bin`, `/etc`, `/opt`, and a tool tree of the image's own
  such as `/google-cloud-sdk` or `/nix` alike; a link such as `/lib -> usr/lib` is followed when what it names holds
  none of the Effector's own paths); read and write on the devices (`/dev/null`, `/dev/zero`, `/dev/full`,
  `/dev/random`, `/dev/urandom`, `/dev/tty`) and the Effect's own scratch, one per Effect (the checkout, `$HOME` and
  `$TMPDIR`); read on each secret file the command names, by `secret("x")` and `.path` alike. The denied names — the
  kernel and process pseudo-filesystems (`/proc`, `/sys`, the rest of `/dev`), the runtime tree where jr2 mounts the
  Effector's own files (`/run`, the key and config under `/run/jr2/effector`), and the volatile and per-user trees that
  hold no tool an image ships (`/home`, `/root`, `/var`, `/srv`, `/mnt`, `/media`, `/lost+found`) — are denied, and so
  is every path named in the Effector's own deny list: the secrets the command does not name, the push credentials
  (`@git`), the Worktree (`/work`), the node caches (`/repos`), the rest of its scratch (another Effect's, and a push's
  copied keys). Every jr2 mount in the Effector's container that holds a secret or the Agent's files is under a denied
  name (`/run`: the key, the config, the secrets, `@git`) or in that deny list (`/work`, `/repos`, the scratch). The two
  others hold only public data and the child may read them: the runtime volume at `/opt/jr2`, which holds the programs
  jr2 ships, and the instance's caBundle ConfigMap at `/etc/jr2/effector-ca` (ADR-0020). So a jr2 mount that holds a
  secret goes under `/run/jr2`; one under `/etc`, `/opt` or a new top-level name is readable by the child. A top-level
  directory that holds one of the Effector's own paths is allowed one level down at a time around it, so a mount placed
  inside one stays denied. Network is not restricted. Any failure before `execve` ends the confiner with exit 126 and
  its reason on stderr: nothing runs unconfined. The design needs ABI 1; measured from a hardened non-root pod (every
  capability dropped, `RuntimeDefault` seccomp): kind on WSL2 6.6 — ABI 3; the home cluster's arm64 nodes (6.8) — ABI 4;
  spark (6.11, arm64) — ABI 5.
- **One child cannot reach another.** Three rules, in the Effector:
  1. **The subreaper.** The Effector sets `PR_SET_CHILD_SUBREAPER` when it starts, so a descendant whose parent ends is
     reparented to the Effector, never to the container's init. Every child an Effect starts runs in its own session and
     process group (`setsid`), registered with that Effect: a descendant can then move only to a new group, or to
     another group of its child's session, never into the Effector's own. When the Effect settles, its groups are killed
     (`kill(-pgid, SIGKILL)`), then the Effector scans `/proc` for processes whose parent is the Effector and whose
     group belongs to no live Effect, kills and reaps them, and repeats until none remain. An Effect is settled only
     after that loop, so a descendant that called `setsid` or double-forked is dead once its Effect's outcome exists. A
     descendant the Effector adopts belongs to no live Effect, because an Effect whose program can start a daemon — a
     credentialed command, whose program is the author's or the Agent's code — runs under a keeper of its own
     (`effector keep`), between the Effector and the confiner. The keeper sets `PR_SET_CHILD_SUBREAPER`, starts the
     confiner in the keeper's own process group and waits; it runs unconfined, outside the child's Landlock domain. A
     descendant that leaves the group while its Effect is live (an `ssh-agent` from `eval $(ssh-agent)`, any daemon) is
     then the keeper's, never the Effector's, and the settle of another Effect beside it does not see it. When the child
     ends, the keeper kills and reaps every process it is the parent of, until none remains, and then reports the
     child's own end (its exit code, or the signal that killed it) on a pipe of its own, which the child does not hold.
     When the keeper is killed (the Effect's timeout, a stop), what it held is the Effector's, and its own Effect's
     settle ends it. A descendant that keeps the command's output open does not hold the outcome: one second after the
     top process ends, the output is closed. jr2's own kinds start no daemon that leaves its group (the push's
     `gpg-agent` keeps its group, rule 2), so they need no keeper. The child shares the keeper's uid, so it can kill its
     own keeper, as it can the Effector (the residual under Consequences): its daemon is then the Effector's, and the
     settle of another Effect can end it — a fault of its own run, not a leak.
  2. **Two classes, one lock per Sandbox Effector.** `gpg` is a push that signs with `sign.gpgKey`; `command` is a
     credentialed command. Effects of one class run together (commands with commands, GPG pushes with GPG pushes: both
     are jr2's code); a `gpg` Effect waits while any `command` Effect is live, and a `command` waits while any `gpg`
     Effect is live. "Live" ends after rule 1's loop, so no descendant of a command exists when a `gpg-agent` starts.
     The push starts its `gpg-agent` itself (`--daemon --no-detach`: it forks once and keeps the push's process group)
     and runs `gpg` with `--no-autostart`, so no agent detaches behind it; the agent is ready when its launcher exits 0.
     At its end the push sends SIGTERM to the agent's process group, then SIGKILL if it still runs after a while, and
     waits for it to exit before it releases the class. A waiter has its Effect's own timeout, which the wait counts
     against: past it, it settles as a timed-out Effect of its kind — a command `timeout`, a push `rejected` at stage
     `sign` — and never runs late. Why: Landlock governs files, not `connect()`, and a confined child can list the pod's
     Unix sockets (`ss -xl` over netlink `sock_diag`, which Landlock does not restrict either), so a credentialed
     command's child alive beside a `gpg-agent` that holds the signing key could sign without reading the key. The two
     never overlap. An `http` (a file body included), an ssh-signed push and a token push hold no class: they start no
     agent and serve no socket (the ssh key is a file the ruleset denies; the clean repository clears `SSH_AUTH_SOCK`).
     The lock is in the Effector's process: restore and an Orchestrator restart are untouched, and an Effector restart
     kills every child.
  3. **A private TMPDIR.** Each credentialed child gets `TMPDIR` set to a directory of its Effect's own scratch, which
     goes when the outcome is read, and `/tmp` is not in the ruleset: a child neither reads nor writes it, so what one
     child writes no other child reads.
- **Fail-closed at the pod, not at `jr2 up`.** A Sandbox Effector probes Landlock when it starts
  (`landlock_create_ruleset` with `LANDLOCK_CREATE_RULESET_VERSION`). When its Workspace holds a credentialed command
  (`effector.json`'s `commands`, which `jr2 up` writes) and the probe fails, it does not become ready: it ends, and its
  termination message — written to `/dev/termination-log`, the container's `FallbackToLogsOnError` the fallback — says
  `landlock: unavailable on node <node> (<why>)`, with the node from the downward API (`NODE_NAME`). The operator copies
  the Effector container's restarts and last end onto the Sandbox's status (`status.effector`), and the provision fails
  on an Effector that ended before the pod was Ready, in those words, before any Turn. A Workspace that holds no
  credentialed command starts on such a node and refuses a command start (400, with the same reason). No `jr2 up` probe:
  one probe Job reports one node, which says nothing in a mixed cluster, and in a uniform one the provision says the
  same one step later; a Node's `kernelVersion` does not say whether `landlock` is in its LSM list.
- **The wire.** `POST /effects/<id>` starts an Effect and answers at once (202, `state: running`). A second `POST` with
  the same id starts nothing and attaches (200). The answer to a `push` start names the commit it runs against
  (`pinned`), read before the answer, so the Orchestrator writes it to the ledger's intent row. `GET /effects/<id>`
  long-polls: it holds up to 25 s and answers `running`, or `settled` with the output. A malformed request starts
  nothing and gets 400 with the reason; a request that names a secret the Effector does not hold is malformed.
  `/healthz` is the kubelet's probe, unsigned, and says only whether the replica takes new Effects. A replica reads at
  most 4 MiB of a request; it cannot verify a longer one, so it refuses it as unsigned. The Orchestrator never sends
  one: a start whose body is longer settles with nothing sent and no intent row, as its kind's own outcome (ADR-0067) —
  an `http` `refused`, a `push` `rejected` at stage `start`, a credentialed `command` `exited` 127 — because a body
  built from context or a pick's param can reach the bound.
- **The Orchestrator holds no git credential and no Effect secret.** `jr2 up` declares and writes every Secret that
  holds a git credential or an Effect secret: the placements' (`jr2-instance-effector`, `jr2-effector-<pod>`) and, for
  each `git.credentials` entry, its clone Secret (`jr2-git-<hash>`, Flux's `username`/`password`, the token from `.env`)
  and its push Secret (`jr2-git-push-<hash>`, ADR-0051). The Orchestrator matches, names and renders: it matches a url
  against the fence and names the entry's Secret — a Repo CR's `secretRef`, from `git-clone.json`; a Sandbox CR's
  `gitCredentials`, from `git-push.json` — and renders a pod's files at provision. No git token, no push key, no
  commit-signing key and no Effect secret is in its process, its env or its own Secret. What it does hold is jr2's own:
  its Secret `jr2-instance` (its env) carries the signing key, the Instance token and the Instance Harness's token
  (ADR-0013, ADR-0058), and from the signing key it derives, at provision, each Sandbox's token and each Sandbox
  Effector's per-pod key, which it writes into that Sandbox's own `<sandbox>-token` and `<sandbox>-effector` (below; the
  Role section). A trusted jr2 component beside the Agent spends: the operator's cache agent for a fetch (ADR-0051,
  ADR-0053: at provision and on a pod's `git fetch`), the Sandbox Effector for a push, a file-body `http` and a
  credentialed command, on a pick. The Agent's container holds nothing on either side. A clone is not an Effect: nothing
  in the Machine picks it, and the cache is per node, made before the pod exists, so the cache agent stays its spender.
  A rotated token reaches the cache at the next `jr2 up`.
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
  another replica's address is one), a time before its process started — on its wall clock as it reads now: when that
  clock stepped back since the start (a host's clock sync), the start is now less how long the process has run, read on
  the monotonic clock — or more than 5 minutes from its clock, or a nonce it saw inside that window: 401, an empty body,
  no signature, before any route is read. A replica keeps the nonces it saw in its process memory; the address and the
  start time cover what that memory cannot. So a start sent again — to another replica of the placement (a rollout runs
  two), or to the same replica after its process restarted — starts nothing. A refused caller learns nothing, not even
  whether an Effect exists. Reason: a process that takes the Effector's port while the Effector is down learns no secret
  from a request and can forge neither a request nor an answer. It can read a request's input, which is not secret, and
  it can make the call fail, which is output. A start it took, sent to the Effector once it is back, was signed before
  that process started.
- **The Orchestrator's side.** `@jr2/orchestrator` speaks the wire through an injected transport (the unit tests' seam,
  [ADR-0010](0010-bdd-acceptance-tests.md)). The Instance Effector's address is derived from the namespace,
  `jr2-instance-effector.<namespace>.svc:8082`, and its key from the signing key (`effectorKey`): the Orchestrator
  stores neither. A Sandbox Effector's key is derived from its Sandbox's name, and its address is the headless Service
  the provision writes beside its key, `fx-<…>.<namespace>.svc:8082` (`fx-` in place of the Sandbox name's `ws-`). The
  real transport resolves that name to every replica's address; a start goes to one of them, and to the next only when a
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
  the whole encoded answer. It matches every secret the Effector holds, not only the ones the current Effect names — and
  the placement key, as `[secret:effector-key]`: a key that reached the Agent would sign a start from bash — in three
  kinds of form: the exact value; its usual encodings (base64 in both alphabets, padded and not, alone or inside a
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
  or as they are, and `\u` hex in either case. A match becomes `[secret:<name>]`. A body is scrubbed as it streams,
  across chunk borders, with a window one byte shorter than the longest form — and before it is bounded: a secret that
  straddles the cut to the tail was replaced whole before the cut. The Effector refuses to start with a secret shorter
  than 8 characters, and names it: a shorter one would match ordinary text. `jr2 up` refuses a short one earlier, a
  literal and a value in the user's own Secret alike (see the secrets list below); the Effector's refusal is for a
  Secret edited after the converge.
- **Every Effect secret is a file in the Effector's own mount**, `/run/jr2/secrets/<name>`, read once at start. One
  trailing `\n` or `\r\n` is taken off, as the Custodian does. A push credential's secret files (`identity`, `password`,
  `sign.identity`, `sign.private.asc`) are held and scrubbed like every Effect secret. A value changed after the start
  reaches the Effector when its pod rolls; the template digest below makes the next `jr2 up` roll it.
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
    Orchestrator settles an `http` start longer than 4 MiB `refused` the same way, before it sends anything; `refused`
    is an `http` outcome only.
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
  with `secret("name")` (an `http` Effect: the Instance Effector; an `http` whose body is a Worktree file: the Sandbox
  Effector of the Workspace whose body invokes it). `hosts`, `headers` and `paths` are a Held secret's binding, never
  its placement (ADR-0059). One derivation (`secretPlacementsOf`) places both kinds, and the held manifest, the
  Custodian config and the held values' Secret of each Harness pod come from it. Both is both, and `jr2 up` reports it
  per pod. An entry nothing names goes nowhere, and `jr2 up` warns:
  `secrets[i] (<name>) is named by nothing; goes nowhere`. There is no `placement:` key: naming is the placement.
  `jr2 up` prints one line per secret with its placements, and one per pod with what it holds
  (`Workspace of workflow "coding": Custodian holds ANTHROPIC_API_KEY (provider), JIRA_TOKEN`,
  `the Instance Effector: holds jira`,
  `Workspace of workflow "coding": Sandbox Effector (image the Sandbox Image) holds aws; pushes Repo Slot "app" with git.credentials "*"`
  — for a slot the run or a `customize()` binds, `with the git.credentials entry its url matches at provision`). Right
  after the walk, before anything is built or applied, it refuses an Effect of any kind or a `workspace()` that names a
  secret the list does not hold (with the line to add) and a literal Effect secret shorter than 8 characters, saying
  why. A `valueFrom` names a key of the user's Secret, which `jr2 up` checks once it reaches the cluster: the key
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
    one container. `harness.env` and `harness.envFrom` may not name this Secret, nor a Workspace's `jr2-effector-<pod>`,
    a Sandbox's `<sandbox>-effector`, or a `git.credentials` entry's `jr2-git-*` (ADR-0059's R13).
- **A Workspace's Sandbox Effector's objects** (ADR-0059). `jr2 up` reads, for each `workspace()`, the Effects placed
  there below it, down to the next `workspace()` — every `push`, `http` whose body is a Worktree file and credentialed
  `command`, from their plain data, statically — and writes two objects for a Workspace with one, none for one without:
  - the **Secret** `jr2-effector-<pod>` (labelled with its pod key, deleted when its Workspace no longer places an
    Effect there): each literal Effect secret those Effects name, and `effector.json` — the targets its file-body
    `http`s call, and `commands: true` when it holds a credentialed command;
  - the **manifest** `effector-<pod>.json` in `jr2-held` beside the pod's Held manifest: names only — the projected
    sources of the Effector's `/run/jr2/secrets` (that Secret's keys, and each `valueFrom` key of the user's own Secret
    by reference) and its pushes by Repo Slot (`pushes: [{ slot, sign }]`).

  No push credential is placed per Workspace (ADR-0051). `jr2 up` writes each `git.credentials` entry's push and sign
  credentials into that entry's own Secret (ADR-0051), and at provision the Orchestrator matches each pushed slot's url
  — static, per-run or `customize()`-bound, one path — to its entry and names that entry's Secret on the Sandbox CR
  (`gitCredentials`). The operator projects it into the Effector's `/run/jr2/secrets` at `@git/<name>/` — a directory no
  secret's file can take, since `@` is no character of a secret's name — and into no other container. The Orchestrator
  reads no value.

  The provision reads the pod's manifest, as it reads its Held one, and adds the `effector` container when one is there
  (ADR-0005): its image is the `workspace()`'s `effector: { image }`, resolved like the User Container's, or the Sandbox
  Image; its per-pod key is `effectorKey(signing key, <Sandbox name>)`, derived like the Sandbox token and written into
  `<sandbox>-effector`, a Secret the CR owns, which only that container mounts, beside `effector.json`. Each pod's key
  is its own: a request signed for one Sandbox is refused by every other. Beside the key the provision writes a headless
  Service the CR owns, selecting the pod by the operator's label, port 8082, publishing its address while the pod is not
  ready: its name resolves to the pod's own `POD_IP`, which each request is signed for. Ingress to it is
  `jr2-sandbox-ingress`'s: the Orchestrator's alone. The Orchestrator's Role may create and patch Services for it, and
  may not read, list or delete one.

- **The log is a contract.** `jr2.effector` lines: `ready placement=… replica=… secrets=<names> targets=N`,
  `action=start effect=… kind=… method=… host=…` (a push logs `host=-`), `action=settle effect=… outcome=… status=…`,
  `action=drop`, `action=drain`. Never a value, a path, a query, a header or a body.

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
- **What a credentialed command's child can still do.** It reads the secret the command names — the author put it there,
  and a file the Agent wrote that the argv runs reads it too — and egress is open, so the claim is the three of
  ADR-0067: the Agent never reads or spends the secret from its own container, the tool sees a pinned commit and not the
  live Worktree, and the output is scrubbed. It shares the Effector's uid, so it can signal the Effector (a fault of its
  own run, not a leak) and connect to its port, where nothing without the key is accepted. It cannot outlive its Effect
  (rule 1), share a temporary tree with another child (rule 3), or be alive beside a `gpg-agent` (rule 2).
- **A long GPG push delays a concurrent credentialed command** by its duration, against that command's timeout, and the
  reverse. Rejected: refusing a credentialed command beside a GPG-signing push at `jr2 up` — the hole is open only while
  a GPG push signs, so the rule is that the two never overlap; and a second container per credentialed placement — its
  child would still share a uid with that container's Effector and could spend that container's key, so it would need
  Landlock anyway, plus a key, a Secret, a port and a NetworkPolicy per placement.
- **A node with no Landlock runs no credentialed command.** Its Sandboxes that hold one fail at provision, naming the
  node; the fix is a kernel with `landlock` in its LSM list. The home cluster's nodes are arm64, so the Effector binary
  and the Kit images need `linux/arm64` builds there.
- An `unknown` outcome is the Machine's to route. jr2 sends an `http` call again only when the author marked it
  `idempotent` ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)).
- The Effector's Go tests run Landlock for real on the host's kernel: a child that reads the key, an unnamed secret or
  `@git`, or writes the Worktree, ends with a permission error and an answer with no secret in it; one that reads its
  named secret from env and from its file succeeds; a child of the child is confined too; a failing probe stops the
  start of a Workspace that holds a credentialed command, with the node in the reason. And the three rules of "One child
  cannot reach another" run with real processes: a `setsid` escapee, and an escapee of that escapee, is dead once its
  command has settled; a live command's daemon, under its keeper, lives through the settle of another Effect beside it;
  the keeper ends what its child left and answers the child's own end; a command started during a GPG push runs only
  after the agent is gone, and the reverse, with no sample of that Effector's processes (its agent, its command's child,
  both matched to its scratch) seeing both alive; a waiter past its timeout settles timed out and never runs late; a
  child's `TMPDIR` write is invisible to the next child, and `/tmp` refuses both.
- The `@kind` tier carries the proofs a unit test cannot: an echo server in the seed namespace answers each header and
  the url in every encoding, and the run's snapshot, its feed and the answer the model reads must hold no form of the
  value — the step decodes every base64 and percent-encoded run it reads, so a leak of what the Effector built
  (`Bearer <value>`, a Basic pair, the url, a header) cannot pass as clean; two replicas and an Orchestrator restart
  during a call, and a rollout during a call, must give one send; and the port takeover — a process in the Harness
  container binds a stopped Sandbox Effector's port — must get a signed start that names a secret and holds no value of
  it, and the Effect must settle `unknown`; and a credentialed command reads its secret from env and from its file,
  scrubbed, says `dirty` over an uncommitted edit, and a child of its child cannot read the Effector's key.
- **The Orchestrator's Role reads no Secret.** On Secrets it has `create` and `patch` only — it server-side applies its
  own per-Sandbox `<sandbox>-token` and `<sandbox>-effector` — and no `get` and no `list`; on ConfigMaps `create` and
  `patch` (a Sandbox's Custodian files, ADR-0059). A test holds the Role to that list. RBAC cannot pin `create` to a
  name and `resourceNames` has no prefix form, so the per-Sandbox names cannot be enumerated. What it closes: the
  enumeration of Secrets and the plain read, so a fault that gives code execution in the Orchestrator does not reach the
  Effect secrets, the clone and push Secrets or a user's Secret through `get`
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). Two residuals stay: a PATCH answers with the object,
  so a caller that knows a Secret's name can still read it; and a Role that creates pods (the operator makes the
  Sandbox's pod from the CR it writes) can mount a Secret into one — the shape every Kubernetes operator shares. Closing
  the first fully means the operator makes the per-Sandbox Secrets instead of the Orchestrator, a later decision.
- **The start time asks the clocks to agree.** A replica refuses a request signed before its process started, by the
  Orchestrator's clock against its own. If the Orchestrator's clock is behind by more than the time between a replica's
  start and the first request it gets, that request is refused as unsigned: to the Orchestrator an answer lost, so every
  replica is asked, and a call not marked `idempotent` settles `unknown` with nothing sent. The clocks of a cluster's
  nodes agree far closer than that.
