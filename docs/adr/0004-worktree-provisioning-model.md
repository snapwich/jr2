# A Sandbox's workspace is a private local clone of a read-only `default/`, not a shared worktree

Each Sandbox gets its **own** `.git` by running a local `git clone --shared` from a canonical `default/` checkout that
is mounted **read-only**, rather than a `git worktree add` against a single shared `default/.git`. The clone borrows
objects from `default/` (via alternates) for fast, disk-cheap setup but owns its refs, index, HEAD, config, and —
critically — its **lock files**, so a Sandbox contends only with itself.

## Why

jr gave every feature a `git worktree`, but all worktrees resolved through **one** `default/.git`. Git serializes access
to that shared state with lock files, so concurrent commit/fetch/rebase/ref updates across worktrees blocked each other
_through the filesystem_. That contention is the bottleneck the whole per-pod isolation design exists to kill — so the
worktree model had to change, not just move into pods. A private `.git` removes the shared lock surface **by
construction**; that is the load-bearing claim, and it does not depend on a measurement. A PoC corroborated it directly
(same concurrent churn: lock-retries present with a shared `.git`, zero with private clones) and confirmed setup stays
worktree-cheap (`--shared` `.git` ~7M vs a worktree's ~7M, vs a full copy ~33M).

The isolation is the point, not the speed: the read-only source plus a private pod-local clone is what confines an
Agent's blast radius to its own pod (it physically cannot write — or `gc` — the canonical source or any sibling's work),
which is the Sandbox thesis (CONTEXT.md) applied to git.

We keep jr's worktree _ergonomics_ — fast spin-up, a working dir that looks like a totally normal checkout, one
canonical `default/` everything branches from — because borrowing objects from `default/` sets up about as cheaply as a
worktree while giving an independent `.git`.

## The `--shared` invariant, and how it is enforced

A `--shared` clone reads `default/`'s object store via `objects/info/alternates`; if an object it borrows is ever
deleted from `default/`, the clone corrupts (a PoC reproduced this by `gc`-ing a writable `default/` under a live
clone). So the one invariant: **objects in `default/` are never deleted while clones borrow them.** Deletion only
happens via `git gc`/`prune` — including the `gc --auto` that porcelain commands (`fetch` among them) run past a
loose-object threshold, which prunes unreachable objects (e.g. commits a force-push orphaned that a long-lived clone
still borrows). Enforcement, by side:

- **Sandboxes cannot violate it**: the volume is mounted read-only, and gc is a write. Structural.
- **The reconcile side is the one writer, and it is config-pinned**: `ensureRepos` sets `gc.auto=0`,
  `gc.pruneExpire=never`, and `maintenance.auto=false` on every `default/` it clones **or adopts**, before any fetch —
  so neither its own fetches nor a human running git inside the checkout can trigger object deletion. Only a deliberate
  `git gc --prune=now` defeats it, which is `rm -rf` territory.

The fallback where borrowing can't be made safe (a source j2 doesn't control) is a **full copy** — fully independent,
gc-proof, at full disk and the slowest setup. An immutable generation-swap scheme (refresh = write a new snapshot, GC
old generations as their Sandboxes drain) remains an option if force-push bloat under fetch-in-place ever becomes a real
cost; it buys nothing else and costs real machinery, so it is not built.

## Refresh is fetch-in-place; the config is the catalog

`ensureRepos` reconciles the source volume at every Orchestrator boot: `config.repos[]` entries are cloned when missing
and fetched when present (`fetch` only **adds** objects — safe under the invariant by nature). A repo that fails to sync
degrades that repo, never the boot — the server serves and the reconcile retries
([ADR-0048](0048-the-orchestrator-boots-without-its-repos.md)). The Orchestrator runs in-cluster (ADR-0019), so the
reconcile does too: every catalogued repo must be **fetchable from the cluster** (an HTTPS token or deploy-key Secret
for private ones — ADR-0019); a working copy that exists only on someone's host is not a valid source. A checkout found
on the volume without a config entry is left alone but not refreshed — the config is the single catalog.

A catalog entry is a url, or `{ name, url, ref }`. **The name defaults to the repository's own name** — the url's last
path segment, minus a trailing `.git` — and two entries that derive the same name fail the load by naming both urls,
since the explicit form exists for exactly that case. The default is recorded here rather than left to taste because the
name is the directory on the volume (`repos/<name>/default`) and the handle every `workspace()` uses: a different
derivation later orphans every checkout the old one made. The derivation is stated TWICE, once per side — `repoName()`
at load and its type-level twin behind `RepoName` — because the Register makes the same rule a compile-time answer
(ADR-0050), which is also why an entry whose url is not a literal must carry a literal `name`: there is no last path
segment for the types to read. Resolution happens once, where the config is loaded, and is the one place the entries'
shape is validated at runtime — `j2 up` typechecks the instance first (ADR-0050), but a runtime import can still see a
shape the types did not, and a mis-shaped entry must fail there rather than silently read as `url: undefined`.

## Storage shape: one model, two backings

The contract every Sandbox needs is narrow — _a read-only directory at `/repos` containing `<name>/default`_ — and the
writable side is always pod-local (`emptyDir`), which scales with agent count by construction. The backing is an
**in-cluster volume** the boot reconcile populates (there is no host-side catalog — ADR-0019), mounted read-only into
Sandboxes; only its storage class differs by cluster:

- **Single node (kind)**: any plain PVC works.
- **Multi-node**: a **ReadOnlyMany/RWX volume** (NFS, CephFS, EFS, Filestore) mounted read-only on every node — the easy
  case of shared storage, since pods never write it. Where no such storage class exists, the fallback is an in-cluster
  git mirror the Sandboxes clone from over the network (losing the object-borrow cheapness).

Read-only-ness is load-bearing twice over: nobody can write the shared thing (no write contention), and nobody can `gc`
it (the structural half of the invariant). Shell-in (`kubectl exec`) needs none of this — the shared volume exists
purely for fast setup.

## Where setup runs

Worktree provisioning is a post-`Ready` step owned by the Orchestrator (per ADR-0001 the Sandbox CRD stays
git-agnostic): `workspace()`'s attach runs one idempotent in-pod script over `kubectl exec` (ADR-0012, `attachScript` in
`sandbox-kubectl.ts`).

## In-Sandbox layout: worktrees off the per-Sandbox clone (gwtmux convention)

"Not a shared worktree" above means _not a worktree off a fleet-shared `.git`_. **Inside** a Sandbox, worktrees are the
intended ergonomic — taken off the Sandbox's **own** clone. The per-Sandbox clone _is_ the `default/`, and branch
working trees are its siblings, matching the layout [gwtmux](https://github.com/snapwich/gwtmux) already expects:

```
<repo>/default/        the per-Sandbox `git clone --shared --no-checkout` (holds the pod-local .git)
<repo>/<branch>/        `git worktree add` siblings, one per branch worked
```

Because the layout is identical to the one used outside the cluster, existing worktree tooling works **unchanged** when
you exec into a Sandbox. Object resolution falls through: a branch worktree shares the per-Sandbox `default/.git`, whose
alternates point at the read-only volume — existing objects are read from the volume, new commits land in the pod-local
`.git`. `default/` is cloned `--no-checkout`: work happens in the branch worktrees, so its working tree is never
materialized.

This does **not** reintroduce jr's contention: the shared `.git` here is _per-Sandbox_, and it is accessed serially
under the standing invariant that **one Agent runs at a time per Workspace** — structural since ADR-0012 (one sequential
body per workspace). A Machine that runs concurrent Agents in one Sandbox, or an Agent that spawns parallel git-touching
subagents, reintroduces contention (pod-scoped, not fleet-wide) and must opt into separate Sandboxes instead.
