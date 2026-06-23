# A Sandbox's workspace is a private local clone of a read-only `default/`, not a shared worktree

Each Sandbox gets its **own** `.git` by running a local `git clone` from a canonical `default/` checkout that is mounted
**read-only**, rather than a `git worktree add` against a single shared `default/.git`. The clone borrows objects from
`default/` (via `--shared`/`--reference` alternates) for fast, disk-cheap setup but owns its refs, index, HEAD, config,
and — critically — its **lock files**, so a Sandbox contends only with itself.

## Why

jr gave every feature a `git worktree`, but all worktrees resolved through **one** `default/.git`. Git serializes access
to that shared state with lock files, so concurrent commit/fetch/rebase/ref updates across worktrees blocked each other
_through the filesystem_. That contention is the bottleneck the whole per-pod isolation design exists to kill — so the
worktree model had to change, not just move into pods. A private `.git` removes the shared lock surface **by
construction**; that is the load-bearing claim, and it does not depend on a measurement. A PoC corroborated it directly
(same concurrent churn: lock-retries present with a shared `.git`, zero with private clones; the absolute retry count is
a synthetic worst-case and varies run to run, so it is illustrative, not a measurement of jr's real contention) and
confirmed setup stays worktree-cheap (`--shared` `.git` ~7M vs a worktree's ~7M, vs a full cross-filesystem copy ~33M).

We keep jr's worktree _ergonomics_ — fast spin-up, a working dir that looks like a totally normal checkout, one
canonical `default/` everything branches from — because borrowing objects from `default/` sets up about as cheaply as a
worktree while giving an independent `.git`.

## Default to `--shared`, accept the "no-`gc`" invariant

Borrowing objects (cheap setup) and owning objects (durability) pull in opposite directions:

- **`--shared` / `--reference`** (alternates): no object copy — cheapest/fastest setup, smallest disk. The clone reads
  `default/`'s object store via `objects/info/alternates`; if `default/` `gc`s/prunes an object the clone still needs,
  the clone corrupts (a PoC reproduced this by `gc`-ing a _writable_ `default/` under a live `--shared` clone).
- **`--reference --dissociate`**: borrows during clone, then copies the objects in — fully independent (survives a
  `default/` `gc`), at full disk + slowest setup.

**The default is `--shared`.** We control the volume that hosts the canonical repositories, so we can _enforce_ the only
invariant `--shared` needs — that the volume never `gc`s objects an in-use clone borrows — and in exchange we get the
big setup/disk win on every Sandbox. `--dissociate` is the **fallback**, used only where that invariant can't be
guaranteed (e.g. a future source we don't control).

## Invariants this model depends on

1. **The repo-hosting volume must never `gc`/prune objects that in-use clones borrow.** Enforced two ways: (a) the
   volume is mounted **read-only** into Sandboxes, so nothing inside a Sandbox can `gc` it; (b) the canonical `default/`
   is refreshed by **generation-swap** — a refresh writes a _new_ generation that new Sandboxes clone from; in-use
   generations are never mutated or `gc`'d, and old generations are retained until their Sandboxes drain. Never mutate
   or `gc` an in-use generation in place.
2. **One Agent runs at a time per Workspace.** The per-Sandbox `.git` (and the branch worktrees taken off it) is safe to
   share _within_ a Sandbox only because the coder and reviewer Agents take sequential turns — that `.git` is accessed
   serially by a single process, so there is no lock surface to contend on. This is a **required invariant on any
   Machine**, not a free property: a Machine that runs concurrent Agents in one Sandbox, or an Agent that spawns
   parallel git-touching subagents, reintroduces contention (pod-scoped, not fleet-wide, but still a regression).
   Machines must preserve single-active-Agent-per-Workspace, or opt into separate Sandboxes.

## Storage shape on kind

kind's default `local-path` provisioner is **ReadWriteOnce**, so a shared _writable_ PVC across pods is not available
out of the box. The shape that works (validated):

- **`default/` shared read-only** as the clone/reference source. On single-node kind the node is one Docker container,
  so all pods share the node filesystem and a **hostPath** mounted read-only exposes `default/` to every Sandbox.
- **The writable clone on pod-local disk** (an `emptyDir`) — writable + private per Sandbox, which is exactly the goal.

Read-only-ness is load-bearing twice over: nobody can write the shared thing (no write contention), and nobody can `gc`
it (makes the `--shared` path safe — invariant 1a). Shell-in (`kubectl exec`) needs none of this — it works regardless
of volume type; the shared volume exists purely for fast setup.

## Where setup runs

Worktree provisioning is a post-`Ready` **provider step** (per ADR-0001 the Sandbox CRD stays git-agnostic), not the
operator and not baked into the CRD. It can run as the worktree-setup actor/provider, or as an initContainer when it
must complete before the Harness serves.

## In-Sandbox layout: worktrees off the per-Sandbox clone (gwtmux convention)

"Not a shared worktree" above means _not a worktree off a fleet-shared `.git`_. **Inside** a Sandbox, worktrees are the
intended ergonomic — taken off the Sandbox's **own** clone. The per-Sandbox clone _is_ the `default/`, and branch
working trees are its siblings, matching the layout [gwtmux](https://github.com/snapwich/gwtmux) already expects:

```
<repo>/default/        the per-Sandbox `git clone --shared` (holds the pod-local .git)
<repo>/<branch>/        `git worktree add` siblings, one per branch worked
```

Because the layout is identical to the one used outside the cluster, existing worktree tooling (gwtmux et al.) works
**unchanged** when you `kubectl exec` into a Sandbox. Object resolution falls through: a branch worktree shares the
per-Sandbox `default/.git`, whose `alternates` points at the read-only `default/` volume — existing objects are read
from the volume, new commits land in the pod-local `default/.git`. This does **not** reintroduce jr's contention: the
shared `.git` here is _per-Sandbox_, and under invariant 2 it is accessed serially by one Agent at a time.

Refinement: clone `default/` with `--no-checkout` (or bare). Work happens in the branch worktrees, not in `default/`
itself, so there is no reason to materialize `default/`'s working tree — `git worktree add` works fine from a
`--no-checkout` repo. Each branch worktree still materializes its own files (the unavoidable, intended cost); only the
redundant `default/` checkout is skipped.

## Open items

- **Multi-node clusters.** hostPath only shares within a node. Multi-node needs a read-only RWX snapshot (NFS/CSI),
  per-node snapshot replicas, or an in-cluster git remote (network clone — simplest, but loses the local object-borrow
  speed and may force the `--dissociate` fallback). Undecided; revisit when the deployment target is more than
  single-node kind. This is where the cloud/production-parity goal lands.
- **`default/` refresh cadence + generation GC.** How often the canonical snapshot is rebuilt from upstream, and how old
  generations are reclaimed once their Sandboxes drain (the machinery invariant 1b requires).
- **Branch/push-back flow.** This model covers _provisioning_ a private worktree; how a Sandbox's commits return to the
  Work Source (push to a remote, PR, etc.) is out of scope here and is its own PoC.
