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
- **Orchestrator** (per-instance): a Kit image at the Kit version, resolved like the operator's, plus the instance's
  **Assembly** — its `workflows/`, config and deps, with the kit's packages stripped — staged, sealed, and
  **content-addressed by the staged tree**, then published to the running Orchestrator over its API
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)). A kit upgrade rolls the
  image; a Machine edit publishes an Assembly and rolls nothing. Hashing the instance _folder_ instead — where deps
  appear only as version ranges — is what let `up` skip work it needed. `--force` publishes against an unchanged hash.
- **Harness**: no per-instance Harness image (ADR-0018). The Harness is a Kit image, resolved like the operator's
  (checkout-built or published, ADR-0038/0044), and the Custodian beside it in every Harness pod runs a Pinned image
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)); the Harness reaches each Sandbox as
  an `/opt/jr2` volume injected at pod time, over a Sandbox Image the instance builds or brings
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). Each Turn carries its Agent's
  definition to the Harness in the admission (ADR-0049); `up` delivers no roster.
- **Secrets**: values declared in config (which may read `process.env`, populated from the uncommitted `.env`) are
  materialized into an instance-owned Secret, by server-side apply, so that no value is in a
  `last-applied-configuration` annotation
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). Referenced-but-unmanaged Secrets
  (`envFrom` refs, git credentials) are **preflighted**: `up` fails naming the missing Secret with the exact creation
  hint — converting the `CreateContainerConfigError` hang into an immediate error. Sealed Secrets/External Secrets ride
  this seam untouched: jr2's contract is "a Secret named X exists", however it got there. A credential the Harness uses
  is a held secret ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)): `up` writes a
  literal value into `jr2-held-secrets-<pod>` for each pod that names it, which only that pod's Custodian mounts, and
  checks that a referenced Secret and key exist. Like the signing key, the held-secret CA (`jr2-held-ca`) is kept across
  converges — minted on first need, never rotated by `up` — because a live pod trusts it.
- **Repos**: `up`'s walk of the registered Machines collects every bound Repo Slot (ADR-0049, ADR-0051) — to refuse an
  open slot nobody bound, and to see which urls need a key. The Orchestrator creates one `Repo` resource per url at
  boot, and the operator's cache agent clones each onto the nodes that need it (ADR-0004). There is no `repos` config
  list and no host `repos/` directory. Private repos: `git.credentials` matches each url to a token env var or an ssh
  Secret by longest prefix (ADR-0051); the scaffold's wildcard entry makes `JR2_GIT_TOKEN` from `.env` the default path
  for https; for ssh URLs whose entry names a Secret that does not exist, `up` asks where the key comes from — a fresh
  in-cluster deploy keypair (the recommended default, public key printed to register), a local key, or one pasted on
  stdin ([ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)) — declining bails. A personal key never enters
  a cluster silently: only by that explicit, warned choice.
- **Provider preflight**: `up` checks each provider that a carried model names. It checks from inside the cluster, with
  one trivial tool-call completion. An endpoint that the pods cannot reach, a wrong or missing key, or a vLLM without
  `--enable-auto-tool-choice` then fails at converge time, not as `agent.fault` in a run. Reachability is the user's
  concern (`localhost` never works from a pod; a LAN address does on kind). The check must take the path that the
  Harness takes. If it does not, a pass means nothing.
  - **One path for every provider.** `up` checks the custom provider (`harness.provider`, ADR-0018) and a provider of
    pi's catalog (for example `anthropic/…`) in the same way. A key of either is a held secret, and only a Custodian can
    use it ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). So no key enters a pod
    spec, an argv or a script. The check calls the custom provider as a Turn calls it: it does not force the tool,
    because a vLLM without a tool parser answers a forced tool and then fails every Turn. When the custom provider
    answers twice with no tool call, the check fails. `up` refuses a `harness.provider.api` that the Harness does not
    speak before it builds or applies anything: the list is the Harness's own (`CUSTOM_APIS`, held equal to
    `CUSTOM_PROVIDER_APIS` in `@jr2/orchestrator` by a test). When the check container cannot build its registry from
    the config, each model's result says why, in words.
  - **The check pod.** It is a Harness pod with no Harness in it. It has a Custodian and the stock Harness image's
    `provider-preflight.ts`. The function that composes the Custodian of every Harness pod composes this Custodian too.
    Its token is a value that the Orchestrator never signed. `provider-preflight.ts` gets the env of the Harness
    container: the harness config, `harness.env`, `harness.envFrom`, the Stand-ins, the proxy and the trust. pi resolves
    each model and uses its api, as in a Turn. The `harness.catalog` gateway applies. The key never enters the check
    container, its argv or its log.
  - **Its own objects.** The check pod reads no object of the Instance. `up` writes copies from the values on the host:
    - a ConfigMap with the Custodian's files, the program and the harness config;
    - a ConfigMap with the trust bundles;
    - a Secret with the token and the literal values of the held secrets;
    - a Secret with the leaves;
    - a Secret with the literal `harness.env` values.

    A held secret from `valueFrom` stays a reference to the user's Secret. A literal value is thus in a second Secret
    while the check pod lives. `up` deletes that Secret after the check.

  - **What it checks.** It checks every carried model that a Harness pod runs. A typo, a retired model and a model that
    the key cannot use are each per model. One check pod stands for one class of Harness pod. A class is a placement and
    a held set:
    - The placement: a Workspace's model runs on the Sandbox nodes (`config.sandbox`, ADR-0052). A `"none"` Agent's
      model runs where the Instance Harness runs.
    - The held set: a pod that holds a secret sends its HTTPS through its Custodian, and a tunnel carries a host that no
      secret is bound to. A pod that holds no secret sends its HTTPS direct. So the check pod holds the held set of the
      first pod of its class, and the keys that the other pods of the class hold. A class that holds nothing gets a
      check pod that holds nothing.

    When no pod of the class holds a key of the provider, the check pod holds none. Then pi refuses the call
    (`not configured`), and the converge fails. A signing credential in `harness.env` reaches the check pod, as it
    reaches a Turn. An id that pi does not know (a typo) fails, because pi resolves no model for it. An id that pi
    knows, and for which jr2 knows no key name, is checked with no held key, as a Turn runs it. The check pod has the
    priority class of the Sandbox tier, as the Harness pods have (ADR-0060).

  - **The request.** The check's request shares these with a Turn's: the model, its api, its endpoint and key, the
    completion limit (what pi-ai sends for a Turn), the retries, no forced tool, and the level of a definition with no
    `thinkingLevel` (`off`: no `reasoning` is sent). It does not share these: it has no system prompt, one tool, no
    session id, and a one-line prompt (one text part, as a Turn's user message has parts). These are limits of the
    check:
    - An endpoint whose context is too small for a Turn's prompt can pass the check.
    - A definition with a `thinkingLevel` is checked at the default level, because `up` knows the models of the
      definitions and not their levels.
  - **The call.** The first call is the request that a Turn sends. So a pass always means that the Turn's request works.
    Its answer decides:
    - A tool call: the check passes.
    - An error: the check fails, or it is busy (below). A forced tool could pass where a Turn fails: a vLLM behind a
      `harness.catalog` gateway, with no `--enable-auto-tool-choice`, answers a named tool by guided decoding and
      refuses the Turn's request.
    - Text from the custom provider: a Turn there gets a nudge after text, so the check sends the same call once more. A
      tool call then passes, an error decides as above, and text again fails, because that is how a vLLM with no tool
      parser answers.
    - Text from any other model: a warning. When the model is of pi's catalog, has `off`, is not moved to a gateway, and
      its api has a form for a forced tool, a second call forces the tool. It does not change the verdict, only the
      words of the warning: with a tool call, the model answered in text when the tool was not forced; with text or an
      error, the model gave no tool call either way. Anthropic refuses a forced tool while the model thinks, so a model
      with no `off` gets no second call.
  - **Busy.** A provider that is busy after the retries of a Turn ([ADR-0064](0064-a-workspace-waits-for-capacity.md))
    is a warning: it answered, and it took the key. Busy is a 429, a 529, an overload, a rate limit or
    `ResourceExhausted`. A 503 alone is a failure, because a gateway with no backend and a server that still loads its
    model answer 503, and a Turn there fails. The check waits at most 20 s for one `retry-after`. When a provider asks
    for more, the call stops with its 429, and that is busy.
  - **Time.** A call waits 120 s for its first event (text, thinking, a tool call or the end), and then 60 s for each
    gap between two events. An Ollama endpoint loads the model on the first request, and a llama.cpp on a CPU reads the
    prompt before it writes: both are slow to start, and then they stream. An endpoint that stops for a minute in the
    middle of an answer is one that a Turn cannot use either. Each model has 360 s for all its calls: two calls, each
    with 120 s to its first event and 60 s of the gaps that follow. Each model has its own 360 s, so one slow model does
    not use the time of the others. Two literals set it, `PREFLIGHT_MODEL_BUDGET_SECONDS` in `preflight-line.ts` for the
    check and `CHECK_MODEL_SECONDS` in `up.ts` for the pod, and a test holds them equal. A call or a model that runs out
    fails. For the custom provider and a gateway, the error adds that a model that loads on first use can take longer.
  - **Busy, when a call runs out.** The rule: the last status that any try of the call got was a 429 or a 529, and then
    the call ran out. A later 200 or 503 clears it. pi-ai sends each retry as a new request. The check sees each try
    through a `fetch` wrapper of its own. It sees Bedrock's tries through `onResponse`, because Bedrock's retries are
    the AWS SDK's own (pi-ai's `maxRetries` does not reach them). Google's and Vertex's adapters refuse a `fetch` that
    is not `globalThis.fetch`, so the check passes them none and does not replace the global one. For them only the
    final error counts: a 429 followed by a retry that never answers fails the check, where for the other apis it is
    busy. A second call that runs out does not change the verdict of the first.
  - **The order.** The checks run before `up` writes an object that the Instance or the operator reads. Only these come
    before them, because the check pod needs them: the namespace and its label, the PriorityClasses, and the images that
    `up` builds and delivers. The operator (its CRDs, RBAC and Deployment, its label and its rollout), a deploy key and
    the wait for its registration (ADR-0047), the trust bundles, the held objects and the instance List come after every
    check passes.
  - **When a check fails.** The converge stops. `up` applied only the items above and the check pods with their own
    objects, and it deleted the check pods and their objects. It also deleted the leftovers of earlier runs (below). The
    operator, the Orchestrator, its Assembly and every pod of the Instance continue to run as before. Nothing else is
    deleted, and no Assembly is published.
  - **The pods.** `up` runs the check pods in series, one at a time, and reports every failure in one error. When the
    cluster refuses a check pod (a quota, a Pod Security level, a webhook), that check fails, and the other checks still
    run. In a new namespace, `up` waits up to 10 s for the `default` ServiceAccount before it calls a refusal a refusal.
    The check container writes a start line and a result line for each model. `up` reads its log while it runs, and
    writes each result as it comes. When the pod stops before the end, the error names the model that the check was on,
    and each model that it never reached. The name of each pod is unique to the run
    (`jr2-provider-preflight-<run>-<n>`), so two runs in one namespace do not touch each other's pods. `up` deletes the
    objects of each check after it. `up` waits up to 300 s for the check container to start (two cold image pulls), and
    it writes each new reason that the pod gives for the wait. Then it waits 360 s for each model (the model's own
    budget in the check), and 30 s more for the Node.js process, which runs under tini as the Harness does, to start. It
    stops at once in these cases:
    - A container cannot start: a crash loop, a missing Secret or key in the env (`CreateContainerConfigError`), or a
      pull that the registry refuses (not found, manifest unknown, unauthorized, denied). A slow or limited pull, and a
      `CreateContainerError`, can pass by themselves, so the wait goes on.
    - A volume cannot mount: the Secret or the key of a held secret's `valueFrom` is missing. The kubelet says so in a
      `FailedMount` event. It counts when the kubelet says it again (its count or its last time goes up), because the
      first can be a race with the objects of the same apply.
    - The Custodian restarts. The error then quotes the Custodian's refusal line, or the reason of its last end
      (`OOMKilled`).
  - **Leftovers.** `up` has no signal handler. If `up` stops (Ctrl-C), the kubelet stops a running pod at its
    `activeDeadlineSeconds`. A pod that no node took has no start time, and that deadline never applies to it. So a
    later `up` of the same Instance deletes these objects:
    - each check pod that ended more than 10 minutes before: in that time, the run that made the pod can still read its
      log;
    - each check pod, in any phase, that is older than its `activeDeadlineSeconds` and 10 minutes;
    - the objects of those pods, and each object of a check that is more than one hour old and whose pod is gone.

    It never deletes the objects of another Instance.

  - **Skipping it.** `jr2 up --skip-provider-preflight` runs no check pod. A check can fail when the model works, for
    example when a model loads for longer than the check waits. That fault must not stop every converge until jr2 is
    fixed. The skip is never silent: `up` writes one warning line, which names each model that it did not check. `up`
    still deletes the leftovers of earlier runs, because their Secrets can hold a key. The flag has no config key,
    because no flag of `up` has one (CI gives `--yes` as a flag). A model that does not work then fails in a run, as
    `agent.fault`.
  - **A limit.** The check pod has labels of its own. It does not get the labels of a Harness pod: the Instance Harness
    Service selects its pods by label, and would send Turns to the check pod. So a NetworkPolicy that selects Harness
    pods by label does not select the check pod. When such a policy closes the egress of the Harness pods, the check can
    pass while a Turn fails.

**`jr2 down`** removes the instance from the cluster. It asks for confirmation unless `--yes` is given (for CI). `--all`
takes the operator too.

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
- The e2e tier (ADR-0010) loses `jr2 dev` as its per-scenario fixture; the fixture boots the Orchestrator's server
  entrypoint as a host process instead — the same real server the cluster runs, no cluster, no user-facing verb.
- The justfile returns to kit-repo development only; no instance operation appears in it.
