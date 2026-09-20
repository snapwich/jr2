# The platform joins the image address, and the cluster chooses it

[ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)'s invariant — every tag is a content address, so "present
implies current" — hashed the build's **inputs** and nothing else. But the bytes are a function of (inputs × platform),
and no build passed `--platform`: the daemon default (or a remembered `DOCKER_DEFAULT_PLATFORM`) decided silently. So
one tag named an amd64 or an arm64 image depending on who built it last, and both skips that rest on tag equality — the
cluster record and [ADR-0041](0041-a-build-the-host-already-holds-is-not-spent-again.md)'s host-held listing — delivered
an amd64 instance image to an arm64-only cluster, surfacing as an opaque rollout timeout (`exec format error`, found
only by hand). The hole is in ADR-0038's core invariant, and it covers every image `jr2 up` builds — instance, Sandbox,
and the checkout-mode kit three. Published Kit images were already immune
([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md): multi-arch manifest lists, mirrored
whole).

## Decision

- **A tag names (inputs × platform set), and says so visibly**: `<repo>:<hash>-<arch>` — `jr2-instance-x:4a77b1-arm64`,
  and `…:4a77b1-amd64-arm64` for a multi-platform build (sorted, joined). In the tag, not the salt: the triggering
  failure was invisible precisely because the tag did not say, and a self-describing tag is diagnosability applied at
  the naming layer. Every `docker build` passes `--platform` explicitly — the daemon default and
  `DOCKER_DEFAULT_PLATFORM` stop being steering, which deletes the manual step whose forgetting was the failure.
- **The cluster's nodes choose the platform set.** `jr2 up` reads the schedulable nodes' `.status.nodeInfo.architecture`
  — the union of the nodes an ordinary pod lands on (the Orchestrator's placement) and the Instance's Sandbox nodes
  (ADR-0052), so a tainted pool no Sandbox reaches is never built for — and intersects with the **supported set** — the
  platforms the kit releases for (`linux/amd64`, `linux/arm64`), one constant beside `KIT_IMAGES` that `just kit-push`
  builds from too, so the two cannot drift. A node arch outside the supported set is reported and skipped, never built
  for: an instance image for `s390x` is dead weight, since no kit image could sit beside it in the pod. An empty
  intersection is a loud error. Reading a singleton set is not an assumption; only a non-singleton set involves
  judgement, and that case builds rather than guesses (next bullet).
- **A multi-arch node set gets a multi-arch build**: `docker buildx build --platform <set> --push`, the `just kit-push`
  mechanism. This path only ever runs where it can deliver, **by construction**: a mixed-arch cluster is never kind
  (kind nodes are containers on one host, one arch), and the non-kind transport branch already requires `registry` — so
  buildx pushes to the registry that must exist, and `kind load` never meets a manifest list. The singleton set keeps
  the plain single-`docker build` and the existing transport branch.
- **`platforms` is the one escape hatch** — a deployment-varying config key (env-carried, like `registry`) holding
  docker platform strings. **Absolute**: when set, derivation is skipped and the list is the build set — still
  intersected with the supported set, so `s390x` gets the same named error. It exists for the two cases derivation
  cannot see: autoscale-from-zero (the target pool has no nodes yet) and set pollution (an UNTAINTED amd64 pool beside
  arm64 workers costs a needless qemu build; the key trims it — a tainted one is already outside the set, ADR-0052). Not
  additive/subtractive — cleverness the rare case does not earn.
- **Foreign-arch builds are preflighted.** When the build set contains a platform the host cannot run natively, `RUN`
  steps need binfmt emulation; without it docker fails mid-build with the same cryptic `exec format error` this ADR
  exists to delete. So the converge checks emulation is available before spending any build, and the error names the fix
  (`docker run --privileged --rm tonistiigi/binfmt --install <arch>`).
- **The host-held skip is honest again — where it can answer at all.** For singleton builds the tag now names the
  platform and jr2 always built with an explicit `--platform`, so tag-equality on the daemon once more means "present
  implies current". A multi-arch ref never lands in the daemon (buildx `--push` goes straight to the registry), so the
  host skip cannot answer for it and a record-silent mixed-arch converge rebuilds — the accepted cost; ADR-0041's
  rejection of registry-truth HEAD checks stands.
- **`imageUser` follows the artifact**: `docker inspect` on the daemon-held singleton build;
  `docker buildx imagetools inspect` against the registry for a manifest list.

## Considered options

- **Multi-arch by default** (every converge, like `just kit-push`). Rejected: nodes in one cluster are almost always one
  arch, so every everyday converge would pay a qemu cross-build to serve the rare mixed case — and `kind load` cannot
  deliver a manifest list from the daemon, so the no-registry path would die or fork the transport branch. Multi-arch
  survives as the _derived_ answer for the set that actually needs it.
- **Preflight the mismatch only** (compare built image arch to node arch, then say so). Rejected as the whole fix: it
  diagnoses instead of prevents, and the tag stays a lie — the ADR-0038 invariant keeps its hole and the stale host-held
  image still needs `--force` folklore. The comparison survives inside the converge-failure diagnosis (ADR-0046) as
  belt-and-braces messaging.
- **Platform in the hash salt, not the tag.** Rejected: honest but invisible — two tags would differ inexplicably, and
  the class of failure this ADR closes was an invisibility failure.
- **Explicit-only** (`platforms` required, no derivation). Rejected: taxes every single-arch user — the overwhelming
  case — with a key they should not need, inverting "the CLI does all the work".
- **Keep `DOCKER_DEFAULT_PLATFORM` as the steering mechanism.** Rejected: an env var the user must remember is the class
  of manual step jr2 deletes, and forgetting it was the failure.

## Consequences

- ADR-0038's "every tag is a content address" is **amended**: the address covers (inputs × platform set). All five built
  image kinds take the suffix — one mechanism, no exceptions.
- ADR-0041 is **amended**: tag-equality on the host daemon is sound again because the tag names the platform; a
  multi-arch ref is invisible to the host skip by construction.
- ADR-0044's consequence — "the cross-build workaround of exporting `DOCKER_DEFAULT_PLATFORM` for checkout-mode
  converges against a foreign-arch cluster is unaffected" — is **superseded**: the workaround is deleted, `--platform`
  is derived and explicit.
- A converge gains one cheap read (`kubectl get nodes`) it mostly already pays in spirit; steady-state skips still spend
  directory walks and no docker.
- Old un-suffixed tags never collide with new ones (the suffix is always present), so pre-0045 images age out through
  ADR-0039's sweep — no migration.
