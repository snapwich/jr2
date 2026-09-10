# The operational surface is one converging command against the current kube context

Bringing the first real workflow to a cluster (2026-07-18) took four command surfaces (`j2`, `just`, `kind`, `kubectl`),
three long-running shells, and a runbook of ordered steps whose footguns the CLI absorbed none of: kind cluster names
were host-global and instance-bound, images had to be re-`kind load`-ed after every cluster recreate, a missing
`.j2/cluster.json` surfaced as a provision-time routing error, and a missing Secret parked pods in
`CreateContainerConfigError`. Root cause: the **local/remote split**. `j2 dev` ran the Orchestrator on the host while
Sandboxes ran in the cluster, which forced two host↔cluster seams (the pod→host callback route and the `repos/` hostPath
baked at cluster creation) — and every footgun above is one of those seams leaking. If a runbook is needed to use `j2`,
the interface has failed.

## Decision

**The Orchestrator always runs in-cluster.** There is no host dev mode. `j2` targets whatever cluster the current
`kubectl` context points at (the argo/cilium model) — which may be a local kind cluster, but nothing is kind-special: no
baked mounts, no recorded pod→host route, no `.j2/dev.json` / `.j2/cluster.json`. `j2 dev`, `j2 cluster up|down`, and
`j2 harness build` are removed.

**`j2 up` is the one command.** It idempotently converges the target namespace to match the instance — every layer,
loudly narrated, safe to re-run:

- **Operator** (per-cluster, shared): CRD + Deployment applied from manifests shipped _inside the installed npm
  package_. The image ref follows [ADR-0038](0038-j2-up-builds-every-image-it-deploys.md): in a kit checkout, `up`
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
  operator's (checkout-built or published, ADR-0038/0044); the Harness reaches each Sandbox as an `/opt/j2` volume
  injected at pod time, over a Sandbox Image the instance builds or brings
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)). Each Turn carries its Agent's
  definition to the Harness in the admission (ADR-0049); `up` delivers no roster.
- **Secrets**: values declared in config (which may read `process.env`, populated from the uncommitted `.env`) are
  materialized into an instance-owned Secret. Referenced-but-unmanaged Secrets (`envFrom` refs, git credentials) are
  **preflighted**: `up` fails naming the missing Secret with the exact creation hint — converting the
  `CreateContainerConfigError` hang into an immediate error. Sealed Secrets/External Secrets ride this seam untouched:
  j2's contract is "a Secret named X exists", however it got there.
- **Repos**: the boot reconcile (ADR-0004) clones `repos[]` from config into the in-cluster source volume. The host
  `repos/` catalog directory is gone. Private repos: an HTTPS token from `.env` is the default path; for ssh URLs with
  no `j2-git-ssh` Secret, `up` asks where the key comes from — a fresh in-cluster deploy keypair (the recommended
  default, public key printed to register), a local key, or one pasted on stdin
  ([ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)) — declining bails. A personal key never enters a
  cluster silently: only by that explicit, warned choice.
- **Provider preflight**: when a custom model provider is configured (ADR-0018's `harness` section), `up` probes the
  `baseUrl` _from inside the cluster_ — including one trivial tool-call completion — so an unreachable endpoint or a
  vLLM missing `--enable-auto-tool-choice` fails at converge time, not as `agent.fault` mid-run. Reachability itself is
  the user's concern (`localhost` never works from a pod; a LAN address does on kind).

**`j2 down`** removes the instance from the cluster (always confirms; `--all` takes the operator too).

## Addressing: cluster is address, namespace is identity, the cluster is the record

- **Cluster = address**: always the current kube context (`--context` to override), never recorded in the repo. The
  instance repo must stay deployable anywhere.
- **Namespace = identity**: set in `j2.config.ts` (default: the instance `name`), `-n` overrides. The same namespace on
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
  and read the Instance token from its Secret — kube RBAC is the real gate. `--url`/`J2_URL` (+ token env) is the escape
  hatch for ingress-exposed instances and callers without cluster creds.

## Sharing is npm; the instance repo is a deployment assembly

Nothing in `j2.config.ts` is useful to others _by design_ — it is the boundary where shared code meets your repos,
models, and cluster. Reusable workflows/agents are published as npm packages — a Machine is imported by a workflow file
(ADR-0049), an Agent is used by value in `j2.config.ts` (ADR-0050); nobody clones an instance repo to reuse it —
`j2 init` + a dependency is the path. `up` typechecks the instance before it builds anything and refuses on errors
(ADR-0050): a wrong Agent, image, or repo name is a compile error at the door, not a mid-run failure. `j2.config.ts`
stays committed (the instance repo is the GitOps unit, ADR-0008); everything deployment-varying resolves from env.

## Considered options

- **Keep host dev mode as an accelerator** (hot reload, in-process debugging) beside a context-targeted everything else.
  Rejected: the two-worlds split _is_ the footgun factory, and "same folder runs locally and deployed" (ADR-0008) is
  only actually delivered when there is one world. Inner-loop cost is absorbed by staleness-checked builds; a `--watch`
  rebuild-redeploy loop can come later.
- **Split setup from run** (`j2 install` + `j2 up`). Rejected: a two-step runbook reintroduces "you forgot step 1",
  which `up` would have to detect anyway — at which point it may as well fix it.
- **A committed or locally-cached deployment target.** Rejected twice: committed addresses break repo reuse; a local
  cache (`.j2/target.json`) is derived state that can lie. The cluster itself is the record.
- **`j2` creating clusters** (`j2 cluster up`, or an interactive offer). Rejected: with no baked mounts, any vanilla
  cluster works; creating one is infrastructure provisioning, like installing docker. The no-context error message says
  `kind create cluster` and that is the whole story.

## Consequences

- The everyday story is two commands ever: `j2 init`, `j2 up`. The full CLI: `init`, `up`, `down`, `gc` (ADR-0039),
  `run`, `runs`, `status`, `logs`, `send`, `kit push` (ADR-0044), plus the workspace verbs `ls`, `ssh`, `rm` (ADR-0009;
  decided, not yet in the binary).
- **Simplification must not surprise**: `up` prompts exactly when meeting a cluster that isn't yet home, and run-verbs
  print the context they're talking to — the ambient-context magic stays visible.
- The snapshot store (sqlite) moves onto a PVC in the instance's namespace; `.j2/` shrinks to scratch.
- `j2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is planned but deferred; `up` in CI
  covers the interim.
- The e2e tier (ADR-0010) loses `j2 dev` as its per-scenario fixture; the fixture boots the instance image's server
  entrypoint as a host process instead — the same real server the cluster runs, no cluster, no user-facing verb.
- The justfile returns to kit-repo development only; no instance operation appears in it.
