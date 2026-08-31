#!/usr/bin/env bash
#
# The release loop's publish (ADR-0043): the kit, delivered the way a user receives it.
#
#   1. the three instance-facing packages → the local registry
#   2. the three Kit images at their PUBLISHED tags → the cluster
#   3. the `j2` binary → a throwaway global npm prefix
#
# The registry must already be up (scripts/dist-registry.sh up). This is a script rather than lines
# inside `just dist-up` because the @dist e2e tier runs the same bring-up unattended: one loop with
# two faces (ADR-0043), not two loops that drift.
#
# Step 2 is not redundant with `j2 up`. An INSTALLED kit builds no Kit image at all — it deploys the
# published `<repo>:<kitversion>` refs (ADR-0038) — so something has to play the release that would
# have pushed them. On kind that needs no registry: build from the checkout, tag with the published
# name, `kind load`, which is the delivery checkout mode already uses.
#
# `--packages-only` stops after step 1, because steps 2 and 3 are the INSTALLED kit's half and only
# its half: they exist so a binary that builds no image and resolves no source can still find both.
# A CHECKOUT CLI needs neither — it builds every image it deploys (ADR-0038) and runs from the
# checkout — but it cannot conjure `@j2/*` for a STANDALONE instance, whose bundle is a frozen
# install from its own lockfile (ADR-0043). That instance is a real shape a developer drives (the
# `/tmp` folder ADR-0043 names), and on a cluster where installed mode cannot yet reach — its kit
# refs carry no registry prefix (ADR-0038, deferred) — step 1 alone is the whole of what the kit
# owes it. The guard below still runs: publishing locally is exactly what must stay guarded.
#
# Env: J2_DIST_DIR (runtime state, default <tmp>/j2-dist — outside the checkout, see the guard
# below), J2_DIST_PORT (default 4873 — the port the packages' publishConfig names).
set -euo pipefail

packages_only=""
case "${1:-}" in
  --packages-only) packages_only=yes ;;
  "") ;;
  *)
    echo "usage: $(basename "$0") [--packages-only]" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${J2_DIST_DIR:-${TMPDIR:-/tmp}/j2-dist}"
port="${J2_DIST_PORT:-4873}"
registry="http://localhost:$port"

# The global prefix must live OUTSIDE the checkout, and this is the same failure `npm link` was
# rejected for (ADR-0043): the CLI resolves its mode by walking up from its own real path, so a
# prefix under the kit root finds that root and `j2 up` takes CHECKOUT mode — building Kit images
# from source instead of deploying the published tags, which is the one branch this loop exists to
# run. It fails silently otherwise: the converge succeeds and tests the wrong mode.
case "$dir/" in
  "$root/"*)
    echo "J2_DIST_DIR ($dir) is inside the kit checkout — the installed CLI would find it and run checkout mode" >&2
    exit 1
    ;;
esac

# The loop's own npmrc carries the fake publish token; the user's ~/.npmrc — and any real
# credential in it — stays out of the loop entirely.
export NPM_CONFIG_USERCONFIG="$dir/npmrc"

cd "$root"

# `publishConfig` OUTRANKS the `--registry` flag below (ADR-0043), so the flag is not the guarantee
# — the manifests are, and this script must not be the thing that finds that out. Read them back
# first: the day the "we are ready" commit points them at npmjs, this local dev-loop command has to
# refuse rather than push the working tree to the world.
for pkg in cli orchestrator agent-protocol; do
  named="$(node -p "require('./packages/$pkg/package.json').publishConfig?.registry ?? ''")"
  if [[ "$named" != "$registry" ]]; then
    echo "packages/$pkg publishes to '${named:-<none>}', not $registry — this loop publishes locally only" >&2
    exit 1
  fi
done

# Only the three instance-facing packages are public (ADR-0043), so `-r` skips the rest.
#
# `--force` is what makes the WIPE hold. Without it `pnpm publish -r` asks whether each version is
# already published and answers from pnpm's own metadata cache (~/.cache/pnpm/metadata-v1.3/
# localhost+4873), which outlives the registry it describes: one previous run of this loop teaches
# that cache that @j2/cli@0.0.0 exists, and every run after it publishes NOTHING — reporting "there
# are no new packages that should be published" and exiting 0, so the failure lands minutes later
# as an E404 on an install, pointing at everything except the publish that did not happen. The
# ephemeral registry is precisely the mechanism that deletes version bookkeeping (ADR-0043), so a
# cached answer about the last registry's contents is not stale data here — it is an answer to a
# question this loop does not ask. A version that really is present still fails loudly, on the
# registry's own 409.
pnpm -r publish --registry "$registry" --no-git-checks --force

if [[ -n "$packages_only" ]]; then
  echo "published to $registry (packages only — no Kit images, no global install)"
  exit 0
fi

# One release train (ADR-0019): the image tag IS the npm version.
ver="$(node -p 'require("./packages/orchestrator/package.json").version')"
docker build -f deploy/harness/Dockerfile -t "j2-harness:$ver" .
docker build -f deploy/adapter/Dockerfile -t "j2-adapter:$ver" .
docker build -t "j2-operator:$ver" operator

# The cluster is whatever the CURRENT kube context names — the same address `j2 up` resolves moments
# later (ADR-0019), never a name written down here.
context="$(kubectl config current-context 2>/dev/null || true)"
case "$context" in
  kind-*)
    kind load docker-image "j2-harness:$ver" "j2-adapter:$ver" "j2-operator:$ver" --name "${context#kind-}"
    ;;
  *)
    echo "warning: kube context ${context:-<none>} is not a kind cluster — images built, not loaded" >&2
    ;;
esac

# A prefix of its own, never the real global one: a loop that installs into the developer's npm owes
# them an uninstall, and this one should owe nothing.
npm i -g @j2/cli --registry "$registry" --prefix "$dir/npm-global"
