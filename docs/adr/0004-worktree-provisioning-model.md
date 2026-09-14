# A Sandbox's workspace is a private local clone of a read-only cache, not a shared worktree

Each Sandbox gets its **own** `.git` by running a local `git clone --shared` from a canonical bare checkout that is
mounted **read-only**, rather than a `git worktree add` against a single shared `.git`. The clone borrows objects from
the checkout (via alternates) for fast, disk-cheap setup but owns its refs, index, HEAD, config, and — critically — its
**lock files**, so a Sandbox contends only with itself. The checkout it borrows from is a **node-local cache** the
operator keeps (ADR-0051), one per repository per node, so a Sandbox can be scheduled on any node.

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
canonical checkout everything branches from — because borrowing objects sets up about as cheaply as a worktree while
giving an independent `.git`.

## The `--shared` invariant, and how it is enforced

A `--shared` clone reads the cache's object store via `objects/info/alternates`; if an object it borrows is ever deleted
from the cache, the clone corrupts (a PoC reproduced this by `gc`-ing a writable checkout under a live clone). So the
one invariant: **objects in a cache are never deleted while clones borrow them.** Deletion only happens via
`git gc`/`prune` — including the `gc --auto` that porcelain commands (`fetch` among them) run past a loose-object
threshold, which prunes unreachable objects (e.g. commits a force-push orphaned that a long-lived clone still borrows).
Enforcement, by side:

- **Sandboxes cannot violate it**: the cache is mounted read-only, and gc is a write. Structural.
- **The cache agent is the one writer per node, and it is config-pinned**: it sets `gc.auto=0`, `gc.pruneExpire=never`,
  and `maintenance.auto=false` on every checkout it clones **or adopts**, before any fetch — so neither its own fetches
  nor a human running git inside the checkout can trigger object deletion. Only a deliberate `git gc --prune=now`
  defeats it, which is `rm -rf` territory.
- **Eviction is deletion of the whole checkout**, never of objects inside one, and only once no pod on the node mounts
  it (ADR-0051). A live clone never loses what it borrows.

The fallback where borrowing can't be made safe (a source j2 doesn't control) is a **full copy** — fully independent,
gc-proof, at full disk and the slowest setup. An immutable generation-swap scheme (refresh = a new snapshot, old
generations released as their Sandboxes drain) was considered again as OCI image volumes in ADR-0051 and rejected there:
it buys nothing gc pinning does not, and a repack costs a full re-upload.

## Refresh is fetch-in-place; the `Repo` resource is the catalog

The catalog is the set of `Repo` custom resources in the Instance's namespace (ADR-0051): the Orchestrator creates one
per repository its Machines bind, at boot from the walk and at first attach for a per-run url, and the operator
reconciles each onto the nodes that need it. A cache is cloned when missing and fetched when present — on the resource's
interval, on demand before every attach, so a Workspace starts from the remote's now, and on demand for every fetch run
inside a pod — the worktrees' `origin` asks the cache, and the cache asks the remote (ADR-0053). `fetch` only **adds**
objects — safe under the invariant by nature. A repository that fails to sync degrades that repository, never the
Instance: a cold clone that fails fails the one provision that needed it, pointedly; a fetch that fails on a warm cache
lets the attach proceed on what the cache holds, announced as stale
([ADR-0048](0048-the-orchestrator-boots-without-its-repos.md)). The cache agent runs in-cluster, so every repository
must be **fetchable from the cluster** (an HTTPS token or deploy-key Secret for private ones — ADR-0019, ADR-0047); a
working copy that exists only on someone's host is not a valid source. Local-path urls are cloned like any other url,
never used in place. A checkout found in a node's cache directory with no `Repo` resource is adopted and pinned but not
refreshed, and is evicted like any other once nothing mounts it.

A repository is identified by its url — host plus path, with scheme, user, a trailing `/` and `.git` dropped — so every
spelling a Machine writes for one repository lands on ONE cache per node, and the expensive clone happens once per
repository per node. The directory name is derived from that identity, printed beside the url by `j2 status`, and never
chosen by a human; there is no name to derive twice or to orphan.

## Storage shape: a cache per node

The contract every Sandbox needs is narrow — _a read-only directory per repository it attaches, on the node it runs on_
— and the writable side is always pod-local (`emptyDir`), which scales with agent count by construction. The backing is
a **hostPath directory per node** that the Instance's cache agent (a DaemonSet) populates and the operator mounts
read-only into Sandboxes, with a soft affinity toward nodes already holding the repositories a Sandbox names. A node
that lacks one clones it on first need — the image-pull model, and the reason the cluster's node count is not a limit on
Sandbox placement. A single-node cluster (kind) is the one-node case of the same model; there is no separate volume path
to keep.

Read-only-ness is load-bearing twice over: nobody can write the shared thing (no write contention), and nobody can `gc`
it (the structural half of the invariant). Shell-in (`kubectl exec`) needs none of this — the cache exists purely for
fast setup.

## Where setup runs

Worktree provisioning is a post-`Ready` step owned by the Orchestrator: the Sandbox CRD names repositories by identity
so the operator can place and mount them, but it knows nothing about clones or worktrees (ADR-0001, ADR-0051).
`workspace()`'s attach runs one idempotent in-pod script over `kubectl exec` (ADR-0012, `attachScript` in
`sandbox-kubectl.ts`), once `Ready` says every cache is present and fetched.

## In-Sandbox layout: worktrees off the per-Sandbox clone (gwtmux convention)

"Not a shared worktree" above means _not a worktree off a fleet-shared `.git`_. **Inside** a Sandbox, worktrees are the
intended ergonomic — taken off the Sandbox's **own** clone. The per-Sandbox clone _is_ the `default/`, and branch
working trees are its siblings, matching the layout [gwtmux](https://github.com/snapwich/gwtmux) already expects, under
the slot the Machine gave the repository (ADR-0051):

```
/work/<slot>/default/        the per-Sandbox `git clone --shared` (holds the pod-local .git; the default branch checked out)
/work/<slot>/<branch>/        `git worktree add` siblings, one per branch worked
```

Because the layout is identical to the one used outside the cluster, existing worktree tooling works **unchanged** when
you exec into a Sandbox. Object resolution falls through: a branch worktree shares the per-Sandbox `default/.git`, whose
alternates point at the read-only cache — existing objects are read from the cache, new commits land in the pod-local
`.git`. `default/` is a checkout of the Repo's default branch, as gwtmux's `default/` is outside the cluster: work
happens in the branch worktrees, and `default/` is the reference tree a human or a tool finds where it expects one. Not
`--no-checkout`: an empty working tree reads as every tracked file deleted to `git status`, which misleads an Agent that
looks. The branch name `default` is refused by the spec guard: the branch Worktree is a sibling of that directory, never
it. `origin`'s push url is the binding's own spelling, so a Machine that bound over ssh pushes over ssh even when the
cache was cloned over https.

This does **not** reintroduce jr's contention: the shared `.git` here is _per-Sandbox_, and it is accessed serially
under the standing invariant that **one Agent runs at a time per Workspace** — structural since ADR-0012 (one sequential
body per workspace). A Machine that runs concurrent Agents in one Sandbox, or an Agent that spawns parallel git-touching
subagents, reintroduces contention (pod-scoped, not fleet-wide) and must opt into separate Sandboxes instead.
