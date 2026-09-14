# A Repo is a slot on the `workspace()` and a cache on the node

ADR-0049 moved Agents and the Sandbox Image into the Machine and left one dependency outside it: the Repo, catalogued in
`j2.config.ts` and named by string from a `workspace()` spec, with the name typed back through a `Register` interface
(ADR-0050). The grill of 2026-09-13 found two faults. A packaged Machine still could not say which repository it works
on, nor could a consumer bind one, except by the consumer's config holding the right NAME and the door threading it —
the same encapsulation gap ADR-0049 closed for Agents. And the catalog's shape was dictated by storage: one read-only
volume of `default/` checkouts, which on a multi-node cluster pins every Sandbox to the node holding it. The two are one
decision: **what a Machine says about a repository, and what the cluster does with that.**

## Decision

- **A Repo is a slot on the `workspace()`**, beside `image` and `user`, keyed by the Machine's own word for it:

  ```ts
  export const codeReview = workspace(body, {
    input,
    image: import.meta.resolve("./image"),
    repos: {
      target: open, // the consumer's — must be bound
      docs: { url: "https://github.com/acme/handbook.git", ref: "v3" }, // the package's own
    },
    spec: ({ input }) => ({ branch: input.branch }),
  });
  ```

  A slot is in one of three states, and the walk tells them apart without evaluating anything: **bound** (a url, or
  `{ url, ref? }`), **open** (the `open` sentinel — someone downstream binds it), or **per-run** (a mapper over the
  wrapper's door: `feature: ({ input }) => ({ url: input.feature.repo, ref: input.feature.baseRef })`). `ref` is the
  base the branch worktree is cut from; absent, the repository's own default branch. The spec no longer carries repos —
  it is `{ branch, workGroup?, reviewSha? }`. The body's handles are keyed by slot (`workspace.repos.target`), and so
  are the in-pod paths (`/work/<slot>/<branch>`): a slot key is collision-free by construction and the same in every
  Instance that consumes the package, so a prompt can name a path and be right everywhere.

- **The consumer binds with `customize`**, in the same call as Agents and the image, nested through `actors` like every
  other part: `customize(codeReview, { repos: { target: "git@github.com:ourorg/app.git" } })`. Any of the three forms is
  accepted, so a consumer can also bind a mapper over the child's door. A slot the Machine does not declare is a compile
  error (a phantom on the wrapper type, read through `pool()`'s `worker` and `workspace()`'s `body` as the image is). A
  registered Machine with an open slot nobody bound is refused by `j2 up`'s walk, before it builds anything, naming the
  Machine, the slot, and the `customize` line that fixes it. That is the one check that is converge-time and not
  compile-time: a `workflows/` export has no type to hang it on (ADR-0050).
- **The url is the identity.** There is no repo name. `j2.config.ts` loses `repos`; `Register`, `RepoName`,
  `repoNames()`, and the `const` on `defineConfig` retire. ADR-0050's rule holds vacuously: the string a Machine writes
  is the thing, not a reference into someone else's file. Two spellings of one repository (`https://`, `git@…:`,
  `ssh://`, with or without `.git`) resolve to one identity — host plus path, scheme and user dropped — and therefore
  one cache. A door that offers a menu of repositories is the Instance's own `z.enum` of urls.
- **The cluster keeps a bare cache per node, not a volume.** Each repository is a `Repo` custom resource the operator
  reconciles (spec: url, refresh interval; status: per node — synced, generation, last error). A cache agent runs as a
  DaemonSet per Instance over its Sandbox nodes (ADR-0052) with a hostPath directory: it clones a repository onto its
  node the first time a Sandbox there needs it, fetches in place on the interval and on demand before an attach, and
  pins gc exactly as ADR-0004 requires. The Sandbox CR names the repositories it needs by identity; the operator mounts
  each node cache read-only, sets a soft node affinity toward nodes whose status holds them, and reports `Ready` only
  once every one is present and has been fetched since the CR asked. The Orchestrator's attach then runs unchanged:
  `git clone --shared` off the mount, worktree beside it. A Sandbox that lands on a cold node pays one clone there, once
  — the same economics as an image pull, and the reason a Sandbox can run on any node.
- **The Orchestrator creates `Repo` CRs; it does not sync them.** At boot it walks its registered Machines and creates
  one CR per bound identity, so a statically known repository is KNOWN before a run can ask: the cache agent on every
  node probes it (`git ls-remote`) as soon as the CR exists, so a wrong url or a credential that does not reach shows in
  `j2 status` right after converge, not at the first run. Known is not warm: the clone happens on a node the first time
  a Sandbox there needs the repository, never on every node at boot — cloning a large repository onto every node that
  may never run a Sandbox for it is the cost the image-pull economics above exist to avoid. A per-run url creates its CR
  at first attach, and every later attach anywhere finds it. The boot restates a bound CR's url and `secretRef` at every
  deploy; an attach restates the `secretRef` of a CR nothing binds, since no boot will — so a `git.credentials` entry
  fixed after a failed clone reaches the cache at the next run either way. Only an attach moves the eviction clock: a
  boot is not an attach.
- **Credentials are matched by prefix and carried by the CR, the Argo and Flux shape.** `j2.config.ts` holds
  `git.credentials`, a list of `{ match, token?, sshKey? }`: `match` is a prefix on the identity (`github.com/ourorg/`,
  or `*`), `token` names an env var `j2 up` materializes into the Instance Secret, `sshKey` names a Secret holding a
  deploy key; the url's scheme picks which field applies, and the longest match wins. When the Orchestrator creates a
  `Repo` CR it resolves the entry and writes a `secretRef`; the cache agent reads only that, and the operator matches
  nothing. The Secret uses Flux's key names (`username`/`password`; `identity`, `identity.pub`, `known_hosts`), so a
  Flux or Argo user reuses the Secret they have. **The list is also the fence.** A per-run url — a run input, a ticket
  field — is otherwise a way to spend the cluster's credential against any host: one that matches no entry is refused at
  attach, naming the list. A static binding is code the Instance typechecked and deployed, so it is admitted without a
  match and cloned anonymously; a private one then fails at the cache with git's error. `j2 init` scaffolds one wildcard
  entry — `{ match: "*", token: "J2_GIT_TOKEN", sshKey: "j2-git-ssh" }`, today's two implicit defaults made visible,
  with a comment saying to narrow it before anything untrusted can start a run — so the open fence is in the user's file
  and commit, never implied.
- **Freshness degrades, absence does not.** A fetch that fails on a warm cache lets the attach proceed on the objects it
  has, announced as stale with git's own error. A stale attach is stale until the next fetch anyone inside the pod runs:
  the worktree's `origin` asks the cache, and the cache asks the remote (ADR-0053) — the pod still holds no credential
  (ADR-0005), and the same failure lets that fetch fall through to the cache's objects with a warning on stderr. A clone
  that fails on a cold node fails that provision pointedly, naming the repository and the error, and the CR status
  carries it for `j2 status` (ADR-0048's pattern).
- **Eviction is reachability plus age.** `j2 gc` deletes a `Repo` CR that no registered Machine binds and no run has
  attached within its TTL; the cache agent removes the node copy on CR deletion, once no pod on that node mounts it.

## Considered options

- **Image volumes** (each repository generation packed as an OCI artifact, mounted by kubelet): gives per-node cache,
  scheduling, and GC for free, and immutability makes the gc invariant structural. Rejected: a refresh is a new layer
  per fetch, so packs accumulate until a repack, and a repack is a full re-upload and a full re-pull on every node — the
  re-clone cost a mutable bare repo never pays. Immutability bought only what gc pinning already buys.
- **A per-repo PersistentVolume.** Rejected: an RWO volume still binds to one node at a time; it changes nothing about
  pinning, only the number of volumes.
- **Keep the shared PVC, require RWX storage for multi-node.** Rejected: scales the storage, not the fetch, and makes
  the kit's first cluster requirement a storage class most small clusters lack.
- **A Flux-style `GitRepository` serving an artifact over HTTP.** Rejected: an artifact download is a clone per Sandbox
  — the cost the cache exists to avoid.
- **Urls kept in the spec, not the slot** (the shape before this decision, with a url in place of a name). Rejected: the
  walk cannot see inside the spec, so a bound repository would be invisible to `j2 up` and to prewarm, and `customize`
  would have nothing to bind.

## Consequences

- The operator becomes git-aware, which ADR-0001 kept it from being: the `Repo` CRD and the cache agent are its. The
  Sandbox CRD stays free of git semantics beyond a list of identities; clone and worktree remain the Orchestrator's
  post-`Ready` step (ADR-0004).
- `workspace()`'s `repos` is required with at least one slot; a Machine that composes no Sandbox has no repos to
  customize, and the data-plane switch ("does this Instance need Sandboxes") is "a registered Machine composes a
  Sandbox", read off the walk, not "config has repos".
- The Console's start form loses the catalog dropdown: a per-run repository is a url field unless the Machine's door
  enumerates its own.
- The volume paths change: the in-pod source mount is `/repos/<key>` where `<key>` is derived from the identity, and the
  pod-local layout is `/work/<slot>/{default,<branch>}`. Existing checkouts on a pre-0051 PVC are not migrated.
- ADR-0047's deploy-key prompt reads ssh urls off the walk. A per-run ssh url first seen at attach was never prompted
  for; its first attach fails with the key hint, as any unregistered key does.
- A `customize` of a per-run slot with a static url is legal and makes it bound; a Machine that wants a slot to stay the
  run's declares it per-run and the consumer leaves it alone. Which slots a consumer may fix is the package author's
  call, expressed by the slot's state.
