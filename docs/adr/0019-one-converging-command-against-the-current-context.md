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
`kubectl` context points at (the argo/cilium model) — which may be a local kind cluster. No baked mounts, no recorded
pod→host route, no `.jr2/dev.json` / `.jr2/cluster.json`. A kind cluster is special in one way only, because its nodes
are containers on the user's own host that jr2 reaches through docker: `up` delivers images with `kind load`
([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)). The Fence's prerequisites are installed in the same way on
each cluster (below). `jr2 dev`, `jr2 cluster up|down`, and `jr2 harness build` are removed.

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
  (checkout-built or published, ADR-0038/0044), and the Custodian, one for the Instance outside every Harness pod, runs
  a Pinned image ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)); the Harness reaches
  each Sandbox as an `/opt/jr2` volume injected at pod time, over a Sandbox Image the instance builds or brings
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). Each Turn carries its Agent's
  definition to the Harness in the admission (ADR-0049); `up` delivers no roster.
- **Secrets**: values declared in config (which may read `process.env`, populated from the uncommitted `.env`) are
  materialized into an instance-owned Secret, by server-side apply, so that no value is in a
  `last-applied-configuration` annotation
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). Referenced-but-unmanaged Secrets
  (`envFrom` refs, git credentials) are **preflighted**: `up` fails naming the missing Secret with the exact creation
  hint — converting the `CreateContainerConfigError` hang into an immediate error. Sealed Secrets/External Secrets ride
  this seam untouched: jr2's contract is "a Secret named X exists", however it got there. `up` also refuses a held
  secret's name that is a key of an `envFrom` Secret, and names the Secret, the key and the held secret (ADR-0059, R14).
  A credential the Harness uses is a held secret
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)): `up` writes a literal value into
  `jr2-held-secrets-<pod>` for each pod that names it, which only the Custodian reads, and checks that a referenced
  Secret and key exist. Like the signing key, the held-secret CA that `up` mints (`jr2-held-ca`) is kept across
  converges — minted on first need, never rotated by `up` — because a live pod trusts it. A Sandbox has a CA of its own
  (ADR-0059).
- **Repos**: `up`'s walk of the registered Machines collects every bound Repo Slot (ADR-0049, ADR-0051) — to refuse an
  open slot nobody bound, and to see which urls need a key. The Orchestrator creates one `Repo` resource per url at
  boot, and the operator's cache agent clones each onto the nodes that need it (ADR-0004). There is no `repos` config
  list and no host `repos/` directory. Private repos: `git.credentials` matches each url to a token env var or an ssh
  Secret by longest prefix (ADR-0051); the scaffold's wildcard entry makes `JR2_GIT_TOKEN` from `.env` the default path
  for https; for ssh URLs whose entry names a Secret that does not exist, `up` asks where the key comes from — a fresh
  in-cluster deploy keypair (the recommended default, public key printed to register), a local key, or one pasted on
  stdin ([ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)) — declining bails. A personal key never enters
  a cluster silently: only by that explicit, warned choice.
- **The Fence**: `up` installs the Custodian's uplink, the Custodian and its resolver
  ([ADR-0084](0084-a-sandboxs-only-network-leads-to-the-custodian.md)). It also installs the Fence's two node
  prerequisites when the cluster lacks one, on any cluster, with kubectl: Multus, from the manifest that the CLI ships,
  and the DaemonSet `jr2-fence-node`, which runs as root on each node's network, puts the stock CNI plugins `bridge`,
  `static` and `tuning` on each node that has no file of that name, and loads the Fence's rule table into the node with
  the capability `NET_ADMIN` at each start of its pod. The first time it installs something, it writes a list of each
  part (the namespace `jr2-system`; the DaemonSet and what its pod does on a node; Multus and its cluster-wide and
  privileged objects), and asks under the first-contact confirmation (`--yes` answers it); a converge that finds both
  asks nothing. A later converge of a newer Kit changes the DaemonSet with no question, as it does the operator, and
  asks before it changes Multus. Where an install is not safe, it refuses. Before it applies anything, for what it reads
  in the API: a Multus that jr2 did not install with other settings or with settings that it cannot read, Multus's
  definition with no Multus that jr2 can find, a Cilium with `cni-exclusive: "true"`, or a Multus that mounts CNI
  folders that are not the default ones. After it applies the namespace `jr2-system` and the DaemonSet, and before
  Multus, for what the DaemonSet's pod finds on a node: CNI folders that are not the default ones, a `bridge` plugin
  older than v1.8.0 or that prints no version, a folder that it cannot write, a Multus configuration that the API does
  not show, a rule table that does not load, or no pod. Those refusals keep what was applied, and say so. It still
  creates no cluster. Then it probes the Fence: it refuses to converge while a Sandbox node fails, and names the node,
  the part and the likely causes. It reads Multus from the API before it applies the Custodian, and probes the bridge
  and the rule table after the Custodian is Ready, with a one-shot pod on each Sandbox node that has no privilege; a
  node with no rule table is a refusal too. ADR-0084 states what it checks and what it cannot see. `jr2 down --all`
  removes the rule table and the bridge `jr2fence0` from each node, the DaemonSet and a Multus that jr2 installed, with
  its definition, unless the cluster has a NetworkAttachmentDefinition of another owner; the plugin files and the kernel
  module `8021q` stay.
- **Landlock**: `up` refuses to converge while a Sandbox node lacks Landlock. It reads the pods of the Repo cache
  agent's DaemonSet, which probe Landlock on each Sandbox node, within the rollout wait it already makes for the cache.
  It is an ordinary converge failure: it names each node whose agent reports none, the probe's reason, and the fix (keep
  the node out with `sandbox.nodeSelector` or a taint, ADR-0052, or enable Landlock); a run after the fix converges
  ([ADR-0077](0077-jr2-requires-landlock-on-every-sandbox-node.md)).
- **Provider preflight**: `up` checks each provider that a carried model names, and the tool list of each remote MCP
  server that an Agent names (below). It checks from inside the cluster, with one trivial tool-call completion for a
  model. An endpoint that the pods cannot reach, a wrong or missing key, or a vLLM without `--enable-auto-tool-choice`
  then fails at converge time, not as `agent.fault` in a run. Reachability is the user's concern (`localhost` never
  works from a pod). A Harness pod reaches an endpoint only when a Held secret is bound to its host or its Egress list
  permits it: by its name, or by an exact address with a port that the author wrote as an entry (ADR-0084). A host with
  no secret needs an entry, also when jr2 itself uses it, such as a model endpoint with no key or a remote MCP server
  with no token: `up` refuses to converge while such a host has no entry, and prints the entry to add. The check must
  take the path that the Harness takes. If it does not, a pass means nothing.
  - **One path for every provider.** `up` checks the custom provider (`harness.provider`, ADR-0018) and a provider of
    pi's catalog (for example `anthropic/…`) in the same way. A key of either is a held secret, and only the Custodian
    can use it ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). So no key enters a pod
    spec, an argv or a script. The check calls the custom provider as a Turn calls it: it does not force the tool,
    because a vLLM without a tool parser answers a forced tool and then fails every Turn. When the custom provider
    answers twice with no tool call, the check fails. `up` refuses a `harness.provider.api` that the Harness does not
    speak before it builds or applies anything: the list is the Harness's own (`CUSTOM_APIS`, held equal to
    `CUSTOM_PROVIDER_APIS` in `@jr2/orchestrator` by a test). When the check container cannot build its registry from
    the config, each model's result says why, in words.
  - **The check pod.** It is a Harness pod with no Harness in it. It has the stock Harness image's
    `provider-preflight.ts`, and it reaches the Instance's Custodian as a pod of its class does: it is behind a Fence,
    as each Harness pod is (ADR-0084). The function that gives the Custodian the rules of every Harness pod gives it the
    check pod's too. Its token is a value that the Orchestrator never signed. Its Stand-ins are secret and its own:
    `jr2 up` mints them with the signing key, as it does for the Instance Harness
    ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). The check pod runs no Workspace
    code, so it may hold them in env. `provider-preflight.ts` gets the env of the Harness container of its class, with
    the Stand-ins in it: the harness config, `harness.env`, `harness.envFrom`, the Stand-ins, and the rest of that
    container's env, the trust included. pi resolves each model and uses its api, as in a Turn. The `harness.catalog`
    gateway applies. The key never enters the check container, its argv or its log.
  - **Its own objects.** The check pod reads no object of the Instance. `up` writes copies from the values on the host:
    - a ConfigMap with the harness config;
    - a ConfigMap with the trust bundles;
    - a Secret with the check pod's Stand-ins;
    - a Secret with the literal `harness.env` values.

    The Custodian gets the check pod's rules, its token, the literal values of its held secrets and its leaves of the
    Instance's CA in the Secret of slot 1 of the Instance's range, as it gets a Sandbox's in the Sandbox's slot
    (ADR-0059, ADR-0084). `up` writes it before the pod, and starts the pod only after each Custodian pod says that the
    slot's rules are live. A held secret from `valueFrom` stays a reference to the user's Secret. A literal value is
    thus held twice while the check pod lives. `up` deletes slot 1's Secret after the check.

  - **What it checks.** It checks every carried model that a Harness pod runs, in one check pod. A typo, a retired model
    and a model that the key cannot use are each per model. Every Harness pod, a Sandbox or the Instance Harness, is on
    a Sandbox node (`config.sandbox`, ADR-0052) behind the Fence, and reaches a provider through the Custodian
    (ADR-0084). So one check pod with the Sandbox placement stands for all of them. For each provider, it holds the keys
    that the first pod that runs one of its models holds, with that pod's binding, and it holds the secret of each MCP
    server that an Agent names. Its Egress list is each rule of each Harness pod.

    When no pod holds a key of the provider, the check pod holds none. Then pi refuses the call (`not configured`), and
    the converge fails. A signing credential in `harness.env` reaches the check pod, as it reaches a Turn. An id that pi
    does not know (a typo) fails, because pi resolves no model for it. An id that pi knows, and for which jr2 knows no
    key name, is checked with no held key, as a Turn runs it. The check pod has the priority class of the Sandbox tier,
    as the Harness pods have (ADR-0060).

  - **MCP servers.** The check pod also checks each remote MCP server that an Agent names
    ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)). It
    reads the server's `tools/list` through the Custodian, with the Stand-in of the server's secret, as a Turn reads it.
    An allowlisted tool name that the list does not have fails the converge, and the result names the server and the
    tool. A server that refuses the request (a 401 or a 403: a wrong or expired token) fails the converge, as a model
    key that the provider refuses does. A server that does not answer is a warning: the first Turn of a conversation
    fails with a named error when the server does not answer then. A stdio server is not checked: it runs as Workspace
    code in the Sandbox, and the check pod runs none. Each server has 60 s for its whole listing, after the models. Two
    literals set it, `PREFLIGHT_MCP_BUDGET_SECONDS` in `preflight-line.ts` and `CHECK_MCP_SECONDS` in `up.ts`, and a
    test holds them equal. The pod writes the list, and `up` compares it with the allowlists.
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
    before them, because the check pod needs them: the namespace and its label, the PriorityClasses, the images that
    `up` builds and delivers, the Fence's prerequisites (the namespace `jr2-system`, the DaemonSet `jr2-fence-node` and
    Multus, ADR-0084), and the Custodian, its uplink and its resolver, which the check pod's calls cross. The operator
    (its CRDs, RBAC and Deployment, its label and its rollout), a deploy key and the wait for its registration
    (ADR-0047), the trust bundles, the held objects and the instance List come after every check passes.
  - **When a check fails.** The converge stops. `up` applied only the items above and the check pod with its own
    objects, and it deleted the check pod and its objects. It also deleted the leftovers of earlier runs (below). The
    Fence's prerequisites stay, as when the DaemonSet refuses a node (above). The operator, the Orchestrator, its
    Assembly and every pod of the Instance continue to run as before. Nothing else is deleted, and no Assembly is
    published.
  - **The pod.** `up` reports every failure of the check pod in one error. When the cluster refuses the check pod (a
    quota, a Pod Security level, a webhook), the check of each of its models fails. In a new namespace, `up` waits up to
    10 s for the `default` ServiceAccount before it calls a refusal a refusal. The check container writes a start line
    and a result line for each model. `up` reads its log while it runs, and writes each result as it comes. When the pod
    stops before the end, the error names the model that the check was on, and each model that it never reached. The
    name of the pod is unique to the run (`jr2-provider-preflight-<run>-<n>`), so two runs in one namespace do not touch
    each other's pods; they share slot 1, so two runs at once in one namespace are not supported. `up` deletes the
    objects of the check after it. `up` waits up to 300 s for the check container to start (two cold image pulls), and
    it writes each new reason that the pod gives for the wait. Then it waits 360 s for each model (the model's own
    budget in the check), and 30 s more for the Node.js process, which runs under tini as the Harness does, to start. It
    stops at once in these cases:
    - A container cannot start: a crash loop, a missing Secret or key in the env (`CreateContainerConfigError`), or a
      pull that the registry refuses (not found, manifest unknown, unauthorized, denied). A slow or limited pull, and a
      `CreateContainerError`, can pass by themselves, so the wait goes on.
    - A volume cannot mount: the trust ConfigMap or the Stand-in Secret of the check pod is missing. This is a jr2
      defect, and the error says to run `up` again. The kubelet says so in a `FailedMount` event. It counts when the
      kubelet says it again (its count or its last time goes up), because the first can be a race with the objects of
      the same apply.
  - **Leftovers.** `up` has no signal handler. If `up` stops (Ctrl-C), the kubelet stops a running pod at its
    `activeDeadlineSeconds`. A pod that no node took has no start time, and that deadline never applies to it. So a
    later `up` of the same Instance deletes these objects:
    - each check pod that ended more than 10 minutes before: in that time, the run that made the pod can still read its
      log;
    - each check pod, in any phase, that is older than its `activeDeadlineSeconds` and 10 minutes;
    - the objects of those pods, and each object of a check that is more than one hour old and whose pod is gone.

    It never deletes the objects of another Instance.

  - **Skipping it.** `jr2 up --skip-provider-preflight` runs no check pod, so it checks no model and no MCP server's
    tool list. A check can fail when the model works, for example when a model loads for longer than the check waits.
    That fault must not stop every converge until jr2 is fixed. The skip is never silent: `up` writes one warning line,
    which names each model and each MCP server that it did not check. `up` still deletes the leftovers of earlier runs,
    because their Secrets can hold a key. The flag has no config key, because no flag of `up` has one (CI gives `--yes`
    as a flag). A model that does not work then fails in a run, as `agent.fault`.
  - **Its labels.** The check pod has labels of its own, which no Harness pod has. No NetworkPolicy applies to a check
    pod or to a Harness pod, because each is behind a Fence (ADR-0084). So no policy that selects a Harness pod by label
    can let a check pass while a Turn of that pod fails.

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
  and read the Instance token from its Secret — kube RBAC is the real gate. `--url`/`JR2_URL` (+ token env, any Caller's
  credential, [ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)) is the escape
  hatch for ingress-exposed instances and callers without cluster creds.
- **A dead ADDRESS and an absent IDENTITY are two faults, and resolution names which.** They share a verb and a context
  but not a fix: one is the network, the other is `jr2 up`. A cluster that answered and holds no instance Secret is "not
  deployed here — right context?"; a cluster that could not answer at all is "cannot reach the cluster — context X: …",
  carrying kubectl's own reason. Merging them — which is the easy shape, since both end in no token — sends a user whose
  VPN is down to go and check a context that was right all along. They are told apart by EXIT CODE, not by matching on
  kubectl's English: the Secret read passes `--ignore-not-found`, so an absent Secret exits 0 with empty output and
  everything else (no route, no credentials, RBAC refusing the read) exits non-zero and is reported.
- **Resolution is bounded; converge is not.** A run-verb waits **10s** to find out whether the cluster is there, and
  then fails with the reason above. Unbounded, it does not fail at all: a cluster whose API server accepts the
  connection and says nothing (a dropped SYN, a sleeping VPN) makes `jr2 runs` hang with no ceiling, which is the one
  outcome a CLI must never have. The bound is spent twice over, because `--request-timeout` bounds a single server
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
- **`jr2` creating clusters** (`jr2 cluster up`, or an interactive offer). Rejected: with no baked mounts, a cluster
  needs nothing of jr2 beyond the Fence's prerequisites, which `jr2 up` installs on any cluster after it asks
  ([ADR-0084](0084-a-sandboxs-only-network-leads-to-the-custodian.md)); creating a cluster is infrastructure
  provisioning, like installing docker.

## Consequences

- The everyday story is two commands ever: `jr2 init`, `jr2 up`. The rest of the CLI is in ADR-0009's table, and the
  workspace verbs `workspace ls|shell|forward|rm` are among them.
- **The workspace verbs are not run-verbs.** They address the Sandbox CRs of the current context with its kube
  credentials alone: no port-forward to the Orchestrator, no Instance token and no Caller scope. So they work when the
  Orchestrator is down, and kube RBAC on the Sandbox CRs and their pods is the whole gate.
- **Simplification must not surprise**: `up` prompts exactly when meeting a cluster that isn't yet home, and run-verbs
  print the context they're talking to — the ambient-context magic stays visible.
- The snapshot store (sqlite) moves onto a PVC in the instance's namespace; `.jr2/` shrinks to scratch.
- `jr2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is planned but deferred; `up` in CI
  covers the interim.
- The e2e tier (ADR-0010) loses `jr2 dev` as its per-scenario fixture; the fixture boots the Orchestrator's server
  entrypoint as a host process instead — the same real server the cluster runs, no cluster, no user-facing verb.
- The justfile returns to kit-repo development only; no instance operation appears in it.
