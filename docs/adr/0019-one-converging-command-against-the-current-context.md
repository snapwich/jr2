# The operational surface is one converging command against the current kube context

Bringing the first real workflow to a cluster (2026-07-18) took four command surfaces (`jr2`, `just`, `kind`,
`kubectl`), three long-running shells, and a runbook of ordered steps whose footguns the CLI absorbed none of: kind
cluster names were host-global and instance-bound, images had to be re-`kind load`-ed after every cluster recreate, a
missing `.jr2/cluster.json` surfaced as a provision-time routing error, and a missing Secret parked pods in
`CreateContainerConfigError`. Root cause: the **local/remote split**. `jr2 dev` ran the Orchestrator on the host while
Sandboxes ran in the cluster, which forced two host↔cluster seams (the pod→host callback route and the `repos/` hostPath
baked at cluster creation) — and every footgun above is one of those seams leaking. If a runbook is needed to use `jr2`,
the interface has failed.

## Decision

**The Orchestrator always runs in-cluster.** There is no host dev mode. `jr2` targets whatever cluster the current
`kubectl` context points at (the argo/cilium model) — which may be a local kind cluster, but nothing is kind-special: no
baked mounts, no recorded pod→host route, no `.jr2/dev.json` / `.jr2/cluster.json`. `jr2 dev`, `jr2 cluster up|down`,
and `jr2 harness build` are removed.

**`jr2 up` is the one command.** It idempotently converges the target namespace to match the instance — every layer,
loudly narrated, safe to re-run:

- **Operator** (per-cluster, shared): CRD + Deployment applied from manifests shipped _inside the installed npm
  package_. The image ref follows [ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md): in a kit checkout, `up`
  builds the operator image and content-addresses it; installed from npm, the ref is the published `<kitversion>` tag at
  the canonical home, re-homed by `kitRegistry`
  ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)). `up` upgrades an older deployed
  operator and **never downgrades** — if another instance upgraded it past this kit's pin, warn and leave it (CRD
  versioning is the skew contract). `operator.manage: false` skips the layer to run the controller loop in the
  foreground (kit development).
- **Orchestrator** (per-instance): the one image an instance produces — engine + its `workflows/` baked (ADR-0008) —
  built by `up` and **content-addressed by its deploy bundle**: the tag is a hash of the materialized bundle, which is
  the actual image input. The kit is in there as resolved source, so a kit edit in a workspace checkout and a kit
  upgrade from the registry both move the tag, by one rule that knows nothing about which of the two it is looking at.
  Hashing the instance _folder_ instead — where the kit appears only as a version range — is what let `up` skip builds
  it needed. `--force` rebuilds against an unchanged hash. Delivery keys off config: no `registry` → `docker build` +
  `kind load`; `registry` set → build + push. Targeting a non-kind cluster without a registry fails loudly.
- **Harness**: no per-instance Harness image (ADR-0018). Harness and Adapter are Kit images, resolved like the
  operator's (checkout-built or published, ADR-0038/0044); the Harness reaches each Sandbox as an `/opt/jr2` volume
  injected at pod time, over a Sandbox Image the instance builds or brings
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). Each Turn carries its Agent's
  definition to the Harness in the admission (ADR-0049); `up` delivers no roster.
- **Secrets**: values declared in config (which may read `process.env`, populated from the uncommitted `.env`) are
  materialized into an instance-owned Secret. Referenced-but-unmanaged Secrets (`envFrom` refs, git credentials) are
  **preflighted**: `up` fails naming the missing Secret with the exact creation hint — converting the
  `CreateContainerConfigError` hang into an immediate error. Sealed Secrets/External Secrets ride this seam untouched:
  jr2's contract is "a Secret named X exists", however it got there.
- **Repos**: `up`'s walk of the registered Machines collects every bound Repo Slot (ADR-0049, ADR-0051) — to refuse an
  open slot nobody bound, and to see which urls need a key. The Orchestrator creates one `Repo` resource per url at
  boot, and the operator's cache agent clones each onto the nodes that need it (ADR-0004). There is no `repos` config
  list and no host `repos/` directory. Private repos: `git.credentials` matches each url to a token env var or an ssh
  Secret by longest prefix (ADR-0051); the scaffold's wildcard entry makes `JR2_GIT_TOKEN` from `.env` the default path
  for https; for ssh URLs whose entry names a Secret that does not exist, `up` asks where the key comes from — a fresh
  in-cluster deploy keypair (the recommended default, public key printed to register), a local key, or one pasted on
  stdin ([ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)) — declining bails. A personal key never enters
  a cluster silently: only by that explicit, warned choice.
- **Provider preflight**: when a custom model provider is configured (ADR-0018's `harness` section), `up` probes the
  `baseUrl` _from inside the cluster_ — including one trivial tool-call completion — so an unreachable endpoint or a
  vLLM missing `--enable-auto-tool-choice` fails at converge time, not as `agent.fault` mid-run. Reachability itself is
  the user's concern (`localhost` never works from a pod; a LAN address does on kind).

**`jr2 down`** removes the instance from the cluster (always confirms; `--all` takes the operator too).

## Addressing: cluster is address, namespace is identity, the cluster is the record

- **Cluster = address**: always the current kube context (`--context` to override), never recorded in the repo. The
  instance repo must stay deployable anywhere.
- **Namespace = identity**: set in `jr2.config.ts` (default: the instance `name`), `-n` overrides. The same namespace on
  kind and prod is what makes switching painless.
- **Convergence is claimed only of observed state.** Every layer `up` rolls out is checked against the pod actually
  serving — the running image must be the intended one before `up` says `converged`. The staleness labels `up` stamps
  decide whether to spend a build; they are never evidence that the cluster is correct, because a run that reports
  success off its own bookkeeping can deploy nothing and still congratulate itself. Tag equality is the whole check, and
  is only sound because the tag is a content address: on the `kind load` path a pod's `imageID` is containerd's manifest
  digest under a rewritten repo name, comparable to nothing the host holds.
- **No local target state.** Whether this cluster hosts the instance is derived from the cluster: `up` finds the
  instance's labeled objects → converge silently (it's home); finds nothing → confirm first-time setup interactively
  (`--yes` for CI); finds objects labeled as a _different_ instance → refuse. Run-verbs against a cluster with no
  instance error with "not deployed here — right context?". This is the guardrail against silently pointing at the wrong
  cluster, without a state file that can itself go stale.
- **CLI transport**: run-verbs port-forward the Orchestrator Service via the kube API for the duration of the command
  and read the Instance token from its Secret — kube RBAC is the real gate. `--url`/`JR2_URL` (+ token env) is the
  escape hatch for ingress-exposed instances and callers without cluster creds.
- **A dead ADDRESS and an absent IDENTITY are two faults, and resolution names which.** They share a verb and a context
  but not a fix: one is the network, the other is `jr2 up`. A cluster that answered and holds no instance Secret is "not
  deployed here — right context?"; a cluster that could not answer at all is "cannot reach the cluster — context X: …",
  carrying kubectl's own reason. Merging them — which is the easy shape, since both end in no token — sends a user whose
  VPN is down to go and check a context that was right all along. They are told apart by EXIT CODE, not by matching on
  kubectl's English: the Secret read passes `--ignore-not-found`, so an absent Secret exits 0 with empty output and
  everything else (no route, no credentials, RBAC refusing the read) exits non-zero and is reported.
- **Resolution is bounded; converge is not.** A run-verb waits **10s** to find out whether the cluster is there — the
  same bound the Harness client puts on its own dial, so the two seats that cross a network agree on what "too long"
  means — and then fails with the reason above. Unbounded, it does not fail at all: a cluster whose API server accepts
  the connection and says nothing (a dropped SYN, a sleeping VPN) makes `jr2 runs` hang with no ceiling, which is the
  one outcome a CLI must never have. The bound is spent twice over, because `--request-timeout` bounds a single server
  request while kubectl retries API discovery behind it — measured, a 5s flag bought a 25s command — so the flag makes
  each attempt give up promptly and a process deadline is what bounds the command. It covers the resolution path only:
  `jr2 up` legitimately waits on rollouts for minutes and says so with its own `--timeout`.

## Sharing is npm; the instance repo is a deployment assembly

Nothing in `jr2.config.ts` is useful to others _by design_ — it is the boundary where shared code meets your repos and
your cluster. Reusable work is published as npm packages, and a package exports a **Machine**, nothing beside it: its
Agents are its own actor slots and its Sandbox Image is a `workspace()` option, so a workflow file imports the Machine
and the parts ride along (ADR-0049). Nobody clones an instance repo to reuse it — `jr2 init` + a dependency is the path.
`up` typechecks the instance before it builds anything and refuses on errors (ADR-0050): a wrong Agent slot or a
`customize()` of a part the Machine does not carry is a compile error at the door, not a mid-run failure.
`jr2.config.ts` stays committed (the instance repo is the GitOps unit, ADR-0008); everything deployment-varying resolves
from env.

## Considered options

- **Keep host dev mode as an accelerator** (hot reload, in-process debugging) beside a context-targeted everything else.
  Rejected: the two-worlds split _is_ the footgun factory, and "same folder runs locally and deployed" (ADR-0008) is
  only actually delivered when there is one world. Inner-loop cost is absorbed by staleness-checked builds; a `--watch`
  rebuild-redeploy loop can come later.
- **Split setup from run** (`jr2 install` + `jr2 up`). Rejected: a two-step runbook reintroduces "you forgot step 1",
  which `up` would have to detect anyway — at which point it may as well fix it.
- **A committed or locally-cached deployment target.** Rejected twice: committed addresses break repo reuse; a local
  cache (`.jr2/target.json`) is derived state that can lie. The cluster itself is the record.
- **`jr2` creating clusters** (`jr2 cluster up`, or an interactive offer). Rejected: with no baked mounts, any vanilla
  cluster works; creating one is infrastructure provisioning, like installing docker. The no-context error message says
  `kind create cluster` and that is the whole story.

## Consequences

- The everyday story is two commands ever: `jr2 init`, `jr2 up`. The full CLI: `init`, `up`, `down`, `gc` (ADR-0039),
  `run`, `runs`, `status`, `logs`, `send`, `kit push` (ADR-0044), plus the workspace verbs `ls`, `ssh`, `rm` (ADR-0009;
  decided, not yet in the binary).
- **Simplification must not surprise**: `up` prompts exactly when meeting a cluster that isn't yet home, and run-verbs
  print the context they're talking to — the ambient-context magic stays visible.
- The snapshot store (sqlite) moves onto a PVC in the instance's namespace; `.jr2/` shrinks to scratch.
- `jr2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is planned but deferred; `up` in CI
  covers the interim.
- The e2e tier (ADR-0010) loses `jr2 dev` as its per-scenario fixture; the fixture boots the instance image's server
  entrypoint as a host process instead — the same real server the cluster runs, no cluster, no user-facing verb.
- The justfile returns to kit-repo development only; no instance operation appears in it.
