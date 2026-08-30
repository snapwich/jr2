# A build the host already holds is not spent again

[ADR-0038](0038-j2-up-builds-every-image-it-deploys.md) keyed the build skip on the cluster's record — the
`j2.dev/images` annotation the previous converge stamped — deliberately: _"a claim about the CLUSTER'S RECORD, not the
node's disk"_, because when tags were mutable, an image being present said nothing about it being current. A fresh
namespace has no record, so it re-runs every `docker build` even when the host daemon holds every ref byte-for-byte —
pure waste on a real cluster whenever a namespace is recreated, and ~7.4s per scenario across the `@kind` tier. The
premise expired with ADR-0038's own seal: every tag is now an honest content address, so on the host that built it,
**present implies current** is true rather than aspirational — asking the daemon is no longer trusting a guess, it is
reading the fact the record only ever approximated.

## Decision

- **Two records, each answering the question it can vouch for.** The cluster's annotation answers for the _cluster_: a
  ref it names was built, preflighted, and delivered by a converge that fully succeeded — skip the build **and** the
  delivery, exactly as before. When the record is silent, the host daemon answers for the _host_: a labeled image whose
  tag equals the resolved ref IS the build (the tag is a content address of the same inputs) — skip the build, **run the
  delivery**. Only when both are silent is docker spent. `--force` overrides both, unchanged in meaning: rebuild and
  redeliver regardless of what anything claims.
- **The disk answers the build question only, never the delivery one.** Delivery is already cheap-idempotent on both
  transports — `kind load` skips a node holding the image id, and a push of layers the registry holds is a no-op per
  layer — so the skip that would need _node_ or _registry_ observation buys seconds at the cost of a second stale-state
  channel. The record keeps that job.
- **A disk-skipped Sandbox Image is still preflighted.** The record could skip the preflight because recorded implies a
  successful converge ran it; the disk cannot: a converge that _failed at preflight_ leaves the ref on the host, and an
  unchanged re-run that trusted the disk without preflighting would deliver the exact image the previous converge
  refused. So the disk path re-proves the contracts (one `docker run`, sub-second) and the invariant holds: **every ref
  a converge records passed the preflight on some converge.**
- **One read, lazy, and advisory.** The daemon is asked once per converge at most (`hostImages()` — the same labeled
  listing the sweep reads, ~13ms against the ~7.4s it saves), and only when some record check missed. A steady-state
  converge still spends directory walks and no docker at all; ADR-0038's bullet stands. A listing that _fails_ reads as
  "holds nothing": the check may only ever save a build, never fail a converge the build itself could survive — a truly
  dead daemon fails at the build that follows, with docker's own error naming it.
- **An unlabeled image never answers.** The listing is label-filtered, so a hand-built image that happens to wear the
  right name is invisible and the build proceeds — the safe direction, and the same rule the sweep lives by
  ([ADR-0039](0039-image-garbage-collects-by-reachability.md)): what j2 did not stamp, j2 does not trust or touch.

## Considered options

- **Replace the record with disk truth outright.** Rejected: the record answers a question disk cannot — what the
  cluster was _delivered_ — and it is free (one kube read the converge already makes). Disk truth alone would re-run
  every delivery every converge.
- **Node-disk truth too** (`nodeImages()` before each `kind load`). Rejected: it duplicates the check `kind load`
  already performs, at a `crictl` round trip per node, to skip a step measured fast.
- **Registry-truth for the push path** (HEAD the manifest before pushing). Rejected for now: the push is idempotent, the
  registry path has the record for steady state, and a registry API client is a new dependency for a case nothing
  measured as slow.

## Consequences

- **The `@kind` tier's per-scenario converge stops paying the build tax.** A fresh namespace on a warm host skips all
  five builds; the measured savings ride ADR-0010's numbers. It also narrows ADR-0039's sweeper-vs-builder window: a
  converge that skips its builds holds nothing in flight for a sweep to take.
- **The ADR-0039 hole is not widened.** The vulnerable window — a ref present on the host that no live root names,
  between the skip decision and delivery — is the same window that already existed between a _build_ and its delivery,
  and it fails the same way (the delivery fails loudly; re-run). In the `@kind` tier the delivered refs are identical
  across scenarios and ride every sweeper's `extraKeep`. The two-instance case stays ADR-0039's recorded limit, and the
  claim-published-before-building fix stays untaken.
- **Recorded-but-absent is unchanged**: a record hit still skips everything, so a ref someone `docker rmi`'d _and_
  removed from the nodes still surfaces as `ImagePullBackOff`, and `--force` is still the way back. The disk is
  consulted only where the record was silent, never to audit it.
- ADR-0038's skip bullet is **amended by this ADR**, not superseded: the record remains the first and cheapest answer;
  what changes is that its silence stops being read as "the build never happened".
