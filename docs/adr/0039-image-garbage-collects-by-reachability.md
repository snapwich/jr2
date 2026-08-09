# Image garbage collects by reachability

[ADR-0038](0038-j2-up-builds-every-image-it-deploys.md) made every tag a content address, which made garbage a
by-product of normal work: ten Dockerfile iterations leave ten full images, and the prune it added collects only some of
them — kind nodes only (the host daemon that built every image is never touched), at `j2 down` only (the accumulation
comes from iterating _while up_, which end-of-life pruning never sees), and scoped by tag **grammar**, which is
ambiguous: `j2-sandbox-<instance>-<name>` has no reserved delimiter, so instance `my` + image `extra-default` and
instance `my-extra` + image `default` collide on one repo, and deleting `images/<x>/` orphans that image's tags because
nothing derives their names any more. Each of those is a patch on the same wrong primitive: deciding ownership by
parsing names.

## Decision

- **Ownership is a label, not a naming convention.** Every image `j2 up` builds is stamped at build time — `j2.dev/kind`
  (`instance` | `sandbox` | `kit`) plus `j2.dev/instance=<name>` on instance-owned ones — via `docker build --label`,
  never in a Dockerfile (the user's file keeps zero j2 knowledge, ADR-0037; the committed kit Dockerfiles stay plain).
  Labels ride the image config through `kind load` into containerd, so both sides of the transport can read provenance
  back. **The sweep touches labeled images and nothing else.** Name grammar stops being load-bearing: the
  `my`/`my-extra` collision class and the orphaned-tags consequence in ADR-0038 both dissolve, because deletion no
  longer needs to reconstruct a name — the image says who built it.
- **Garbage is defined by reachability, not age or naming.** An image is needed iff a live root names it:
  1. the `j2-images` ConfigMap of **every** j2 instance on the cluster (namespaces labeled `j2.dev/instance`) — what
     future Sandboxes will run;
  2. every Sandbox CR's `spec.image` in those namespaces — a parked Workspace must survive a pod restart (`IfNotPresent`
     cannot re-pull a local tag);
  3. every pod's container images in those namespaces plus `j2-system` — the orchestrator, Instance Harness, Adapter,
     and operator actually running, mid-roll pods included, without naming Deployments one by one. The keep set is the
     union, matched by whole ref after the one containerd normalization ADR-0038 already fixed (strip
     `docker.io/library/`). A labeled image none of it names is garbage — user Sandbox Images and `j2-*` kit images by
     the same rule. **"Kit images are never pruned" dissolves into reachability**: a kit ref is kept because some
     instance's map names it, and when the last instance leaves the cluster, kit images collect like everything else
     instead of being permanent by fiat.
- **`j2 up` sweeps after a successful converge** — the moment the root set moves, which is where the iteration garbage
  comes from. Nodes get a **one-generation grace**: refs named by the map this converge replaced stay one more round, so
  the ConfigMap's kubelet propagation window cannot provision a just-swept ref. The **host daemon is swept
  aggressively** (labeled ∧ not in the keep set ∪ this converge's refs): nothing runs from the host, its images are
  scratch awaiting delivery, and BuildKit's cache — a separate store `docker rmi` does not touch — makes regenerating a
  swept tag cost seconds. A failed converge sweeps nothing.
- **`j2 down` sweeps host and nodes after the namespace delete.** This instance's roots are gone, so its images are
  unreachable by construction; another instance's roots still protect everything it shares, kit refs included. The
  operator's image stays a root through its running pod unless `--all` takes the operator too. The exact-prefix matching
  this replaces (`prunePlan`, the derived `j2-sandbox-<name>-<x>:` list) is deleted, not kept as a fallback.
- **Node policy is unchanged from ADR-0038's fix**: `crictl` cannot untag, so a node image id is removed (once) only
  when **every** tag on it is unreachable; a mixed id is kept whole and reported. `docker rmi` on the host does untag,
  so the host sweeps per tag with no id grouping. Both sides are delete-if-present, and a failed removal is reported and
  skipped, never allowed to abandon the rest. The node **mechanics** are not unchanged: a `kind load`ed image is also
  held under an `import-<date>@<digest>` ref CRI does not know, so `crictl rmi` alone exits 0 having reclaimed nothing —
  removal reaches through to `ctr -n k8s.io images rm` for those names, and the report is confirmed by a re-list of the
  node rather than by an exit code.
- **The sweep narrates bytes, not counts** — `swept 4 image(s) (2.1 GB)` — because disk is the quantity the user feels,
  and a silent GC plus one visible number is the entire intended interface. **`j2 gc [--dry-run]`** is the same sweep
  run off-cycle: an escape hatch for "disk is full now", not a step in any workflow; `--dry-run` prints the plan and
  removes nothing. It never needs confirmation, because by construction it removes only what j2 built and nothing
  running or provisionable names.
- **Registry-delivered copies are cache and sweep like everything else.** A pulled tag on a node (or the host's
  just-pushed copy) is re-pullable from the registry, so unreachable copies go; the registry's own retention stays the
  registry's business, as ADR-0038 drew the line.

## Considered options

- **Keep name-prefix pruning and extend it to the host** (the shape ADR-0038 grew fix by fix). Rejected: every fix
  patched the same wrong primitive. Exact prefixes still collide (`my`+`extra-default` ≡ `my-extra`+`default`), deleting
  an image folder still orphans tags, the kit exemption stays a fiat rule, and `up`-time iteration garbage stays
  invisible. Reachability plus labels answers all four with one mechanism.
- **A kind-local registry** so images live in one place and GC becomes registry retention. Rejected for now: real infra
  (a registry container, containerd config on every node) bought mostly to avoid a sweep the CLI can do in a few
  subprocess calls; the two-store shape (host builds, nodes hold copies) is a kind artifact this ADR manages rather than
  rebuilds. Revisitable if a real registry becomes the default transport anyway.
- **Age- or count-based GC** (`keep last N`, `older than 30d`). Rejected: wrong axis. Old is not unneeded (a parked
  Workspace can hold a month-old ref alive) and new is not needed (a failed converge's tag is garbage at minutes old).
  Reachability is the fact the others approximate.
- **Sweeping at `down` only** (the ADR-0038 status quo). Rejected: the accumulation the prune exists for is produced by
  iterating while up, so the collector must run where the garbage is made — after each converge.

## Consequences

- **Images built before this ADR carry no labels and are invisible to the sweep** — deliberately, since sweeping
  unlabeled images means guessing by name again. The pre-existing strays (`j2-workspace-*`, `:local` kit tags, old e2e
  iterations) are cleaned once by hand or with the cluster; `j2 up --force` re-tags current images with labels.
- **The sweep reads cluster-wide** (namespaces labeled `j2.dev/instance`, their ConfigMaps, Sandboxes, and pods), so the
  CLI needs list access beyond its own namespace — true of the admin kubeconfig `j2 up` already requires.
- **A second checkout converging to a different cluster can lose its host kit generation** to this one's sweep (the host
  keep set only sees the current context's roots). Accepted: the rebuild is BuildKit-cached seconds.
- **CRI's image list can outlive containerd's refs**, because a removal that goes through `ctr` does not resync the CRI
  image store: `crictl images` keeps answering for ids whose refs and content are gone. So the node read is filtered
  against `ctr -n k8s.io images ls` — containerd's refs decide what is present, CRI's list only mirrors them — and
  without that filter every id the sweep took would come back on the next plan, forever. The residual rows are cosmetic
  (nothing can run from them, nothing is reclaimed by taking them again) and clear on a containerd restart; j2 ignores
  them by construction rather than reporting them.
- The wrapped Sandbox Image inherits its base's labels through the image config — harmless (same owner), noted so nobody
  "fixes" the duplication.
- **A converge in flight is not a root.** An image is needed iff a LIVE root names it — and a converge that has resolved
  its refs but not yet applied them names them nowhere the cluster can see, so a sweep finishing in another namespace
  can take a ref between its build and its delivery. It does not reach the `@kind` tier under `--parallel`: every
  scenario converges the same checkout, so each worker's own `extraKeep` already holds the identical refs the others are
  building. It bites two instances on one cluster, or one instance converged twice across a source edit. Recorded as a
  known limit; the fix — a claim the converge publishes BEFORE it builds, making an in-flight ref a root like any other
  — is not taken here.
- ADR-0038's `j2 down` prune clause is **superseded by this ADR**; its `imagePullPolicy`/content-address reasoning
  stands untouched, and ADR-0038's seal is what finally makes it true of the instance image.
