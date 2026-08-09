# The wrap's intermediate is scratch; a converge names its own

[ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)'s last consequence left one decision
open: the wrap's intermediate `-base` tag is named by content hash, so every concurrent converge of one checkout builds,
and then untags, the _same_ `j2-sandbox-<instance>-<name>-base:<hash>`. One of the two failures that follow was absorbed
(the second untag finds the tag gone — delete-if-present); the other cannot be: an untag that lands while another
converge's wrap is resolving `FROM <baseTag>` fails that build outright. That shared name is the whole reason the
`@kind` tier ran serially — [ADR-0010](0010-bdd-acceptance-tests.md) carries the measurements showing capacity was never
the bound.

## Decision

- **The base tag gains a per-converge nonce**: `j2-sandbox-<instance>-<name>-base:<hash>-<nonce>`, the nonce random
  bytes the converge draws when it builds. Two concurrent converges of one checkout now hold two tags — on the same
  image id, since the content is the same — and each untags only its own, so neither can pull the image out from under
  the other's `FROM`.
- **This is not the nondeterminism the seal deleted** ([ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)), and the
  distinction is worth stating because it looks like it: the seal disciplines what a tag **names** — an address that is
  recorded, diffed, delivered, and relied on for "present implies current". The base tag is none of that. It is never
  delivered, never registry-prefixed, never recorded in any map, and untagged on success; its only job is to carry one
  build's result to the very next build's `FROM`. It is **scratch**, and the house already names scratch uniquely:
  `mkdtemp` for the staging bundle — where ADR-0038 explicitly _rejected_ a stable scratch path because "it collides
  when one Instance folder is converged concurrently". Same reasoning, same store physics, different medium.
- **Uniqueness cannot leak into the image or its address.** Verified, not assumed: two wraps built `FROM` two different
  tags of one base image produce byte-identical image ids — the `FROM` string resolves to content and is recorded
  nowhere in the result. The hash salt was already immune by construction: `sandboxImageHash` salts with the wrap text
  at the `<base>` stand-in (`WRAP_SALT_BASE`), never the real tag.
- **The untag stays, on success only.** With unique names the converge's own end-of-run sweep would collect the base
  seconds later anyway (labeled, reachable by no root) — but then every converge would narrate its own scratch as
  reclaimed disk, and the byte count would claim the base's full size for layers the wrapped image still holds. The
  explicit untag keeps scratch out of the sweep's story. A converge that **fails** before its untag leaves the base
  tagged: labeled, unreachable, and named for a human reading `docker image ls` — any later sweep collects it, which is
  exactly the division of labor (the sweep exists to collect what failed runs leave).
- **`--parallel` becomes usable for the `@kind` tier.** Verified on this change: sixteen parallel runs across degrees
  2–4 produced zero converge or image failures, where every pre-0040 parallel run lost two or more scenarios to the
  shared intermediate; degree 4 runs the tier in ~1m45s against ~5m serial. The wired _default_ stays serial for now —
  the parallel runs surfaced a distinct, degree-independent, undiagnosed flake (one scenario's first turn missing its
  provider budget in roughly a third of runs, converge clean) that is ADR-0010's to track, and a gate that flakes is a
  gate that gets ignored. ADR-0010's `@kind` paragraph carries the measurements and the bar for raising the default.

## Considered options

- **No name at all — wrap `FROM <image-id>`.** Docker accepts an id in `FROM`, and an unnamed intermediate cannot be
  untagged out from under anyone. Rejected: `BuildPort.build` would have to start returning ids (a port change every
  fake pays), a failed converge would leave _anonymous_ dangling garbage where a tag names its owner, and it closes no
  race the nonce does not — the id is shared across concurrent converges of one checkout regardless, because the content
  is.
- **Pid or timestamp as the nonce.** Rejected: pids collide across containers sharing one daemon (two converges in two
  containers see two pid namespaces), and a timestamp is a clock's false precision where only uniqueness is wanted.
- **Absorbing the loss instead — retry the wrap once when its base vanished.** Rejected as the primary fix: it patches
  the collision instead of deleting the shared name that causes it, and every other race in this seam was closed by
  making the colliding thing not shared (the seal, the labels) rather than by retrying.

## Consequences

- **One residual race survives, and it is not this decision's to close**: a _sweep_ is still free to take an in-flight
  base between its build and its wrap, because a converge in flight is not a root —
  [ADR-0039](0039-image-garbage-collects-by-reachability.md)'s recorded limit, which no choice of name affects (the
  shared-name failures were builder-vs-builder; this one is sweeper-vs-builder). The window is sub-second per Sandbox
  Image, and [ADR-0041](0041-a-build-the-host-already-holds-is-not-spent-again.md) shrinks it to nearly nothing in
  practice: a warm converge skips the build entirely, so no base exists to take. The principled fix stays the one
  ADR-0039 names — a claim published before building — and stays untaken.
- ADR-0039's "it does not reach the `@kind` tier under `--parallel`" consequence was written about delivered refs and
  over-claimed: each worker's `extraKeep` holds the identical _delivered_ refs the others are building, but never the
  intermediate. Amended there.
- `sandboxBaseTag` takes the nonce as a parameter; the converge draws it. Tests pass a fixed one — determinism belongs
  to the caller that wants it.
