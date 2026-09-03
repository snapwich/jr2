#!/usr/bin/env bash
#
# `just kit-push <registry> [platforms]` (ADR-0044): the three Kit images, built from THIS checkout
# and pushed at their PUBLISHED names — `<registry>/j2-<x>:<kitversion>`.
#
#   kit-push.sh ghcr.io/snapwich              the canonical home, at release
#   kit-push.sh zot.cluster.example.net       a self-host the home has not reached yet
#   kit-push.sh localhost:5001 linux/amd64    the dev loop's stand-in home (scripts/dist-publish.sh)
#
# The CHECKOUT arm of ADR-0044's split, and the only arm that can build anything: `j2 kit push` — the
# arm an installed self-hoster holds — is a registry-to-registry mirror, because the npm packages
# carry no Harness or Adapter source and a binary that could build them would be exactly the
# patched-Harness eject hatch ADR-0027/ADR-0038 welded shut. This script has the source, so it is
# what fills a registry the home has never held: the release train's push, and the dev loop's.
#
# MULTI-ARCH by default, and that is a decision rather than a nicety: the mirror copies whatever
# manifest it finds, so a single-arch push here is faithfully copied into every self-host, and an
# arm64 cluster pulling an amd64-only image fails at the pod with nothing to point at. A caller who
# knows its target's architecture (the @dist loop, whose registry serves one kind cluster) passes a
# single native platform and pays no qemu.
#
# Nothing here is a `j2 up`, and nothing here is per-instance (ADR-0044): Kit images are shared by
# every instance on a cluster, so putting them somewhere is a deliberate act with no instance in it.
set -euo pipefail

registry="${1:-}"
# The platforms the kit RELEASES for — both of the architectures a j2 cluster runs on today (the home
# cluster's nodes are arm64, this checkout's dev box is amd64); see docs/adr/0044, docs/adr/0045.
#
# MIRRORS `SUPPORTED_PLATFORMS` in packages/cli/src/build.ts, the set a checkout `j2 up` intersects
# its cluster's node architectures with. Two lists, one truth — packages/cli/test/kit-push.test.ts
# reads this default and fails the unit gate if the two ever disagree: a published set narrower than
# the supported one is a cluster that resolves a Kit image it cannot run.
platforms="${2:-linux/amd64,linux/arm64}"
if [[ -z "$registry" ]]; then
  echo "usage: $(basename "$0") <registry> [platforms]   e.g. $(basename "$0") ghcr.io/snapwich" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One release train (ADR-0019): the image tag IS the npm version. `@j2/cli`'s manifest, because the
# INSTALLED binary is what will ask for these tags. Read, never hardcoded — a release bumps the
# manifests and this follows them.
#
# The cross-check is not ceremony: `KIT_VERSION` — the constant `publishedKitRefs()` actually builds
# its refs from — is read out of `@j2/orchestrator`'s manifest (packages/orchestrator/src/config.ts),
# and `@j2/cli` depends on it by `workspace:*`, so the two are one number in every published kit. If
# they ever disagree, this script would push tags nobody resolves and the failure would surface as a
# pull error on somebody's cluster. Refuse instead.
version="$(node -p "require('$root/packages/cli/package.json').version")"
kit_version="$(node -p "require('$root/packages/orchestrator/package.json').version")"
if [[ "$version" != "$kit_version" ]]; then
  echo "@j2/cli is v$version but @j2/orchestrator (KIT_VERSION, the tag an installed kit resolves) is" >&2
  echo "v$kit_version — one release train (ADR-0019); publish them at one version before pushing images" >&2
  exit 1
fi

# The three Kit images: repo, Dockerfile, build context (contexts are relative to the kit root).
#
# MIRRORS `KIT_IMAGES` in packages/cli/src/build.ts, which is what a CHECKOUT `j2 up` builds from
# the same sources at content-addressed tags. Two lists, one truth — packages/cli/test/kit-push.test.ts
# reads this block and fails the unit gate if the two ever disagree, so the drift cannot be silent.
images=(
  "j2-harness|deploy/harness/Dockerfile|."
  "j2-adapter|deploy/adapter/Dockerfile|."
  "j2-operator|operator/Dockerfile|operator"
)

# A named docker-container builder, created once: the default `docker` driver cannot build more than
# the host's own platform and cannot push a manifest list at all. `network=host` is what makes
# `localhost:<port>` mean the HOST's registry — buildkit runs in a container of its own, where
# `localhost` would otherwise be that container.
builder="j2-kit"
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container --driver-opt network=host >/dev/null
fi

# A LOCAL registry is served over plain HTTP, and only a local one may be: `registry.insecure` also
# waives TLS verification, so it is scoped to the address that could not have TLS in the first place
# rather than applied to every push. Everything else takes `--push`, which is the same output with
# the registry's own trust intact.
output=(--push)
case "$registry" in
  localhost:* | localhost/* | 127.0.0.1:* | 127.0.0.1/*)
    output=(--output "type=image,push=true,registry.insecure=true")
    ;;
esac

# A foreign platform is emulated, and the emulator is not this repo's to install — so say so before
# minutes of build, rather than leaving `exec format error` to be interpreted.
native="linux/$(docker version -f '{{.Server.Arch}}' 2>/dev/null || echo unknown)"
if [[ ",$platforms," != ",$native," ]]; then
  echo "kit-push: building $platforms on a $native host — a foreign arch needs qemu binfmt:" >&2
  echo "  docker run --privileged --rm tonistiigi/binfmt --install all" >&2
fi

for row in "${images[@]}"; do
  IFS='|' read -r repo dockerfile context <<<"$row"
  tag="$registry/$repo:$version"
  echo "kit-push: $tag ($platforms)" >&2
  # `--label` on the command line, never in the committed Dockerfile: the ownership stamp is the
  # kit's business and the Dockerfiles stay plain (ADR-0039, `kitImageLabels()` in build.ts). It
  # rides the image config into whatever containerd pulls it, so a pulled Kit image sweeps like the
  # built one — a registry-delivered copy is cache, and cache collects (ADR-0039).
  #
  # `--provenance=false` keeps the pushed index to the platforms asked for. Attestation manifests
  # ride an index as extra `unknown/unknown` entries, and the mirror (`docker buildx imagetools
  # create`) copies an index whole — so they would be carried into every self-host to be read by
  # nothing.
  docker buildx build \
    --builder "$builder" \
    --platform "$platforms" \
    --provenance=false \
    -f "$root/$dockerfile" \
    -t "$tag" \
    --label "j2.dev/kind=kit" \
    "${output[@]}" \
    "$root/$context"
done

echo "kit-push: pushed j2-harness, j2-adapter, j2-operator at v$version to $registry" >&2
