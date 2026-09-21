#!/usr/bin/env bash
#
# `just publish [platforms]` (ADR-0055): the irreversible half of the release train — the Kit
# images to their home, THEN the packages to npm — run from the pushed tag.
#
#   publish.sh                      by hand: both arches, `npm publish` with a 2FA prompt per package
#   publish.sh linux/arm64          by hand, one arch (the home cluster's) — a quick 0.x release
#                                   that the job's multi-arch push overwrites when it lands
#   publish.sh --stage              the release job: the same walk, `npm stage publish`
#
# The job (.github/workflows/release.yml) and a maintainer at a shell are two EXECUTORS of one
# train; the tag is the release either way. The job proves every tier on the tree that ships and
# takes the better part of an hour; the maintainer proved what they chose to and pays the docker.
# The two converge on the same result: a version already live on npm is skipped, not failed, and
# a Kit image pushed twice from one source is one image.
#
# What makes a hand run safe is what makes the job safe — the credential (ADR-0055). By hand it is
# a 2FA prompt per package: under npm's write-2FA an `npm login` alone publishes nothing, and a box
# with no login fails ENEEDAUTH here, before an image moves. Nothing in the tree can be edited into
# a publish.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

die() {
  echo "publish: $*" >&2
  exit 1
}

stage=0
platforms=""
for arg in "$@"; do
  case "$arg" in
    --stage) stage=1 ;;
    -*) echo "usage: $(basename "$0") [--stage] [platforms]" >&2 && exit 2 ;;
    *) platforms="$arg" ;;
  esac
done

# LOCKSTEP (scripts/release.sh owns the walk): every manifest at one number, or nothing moves.
version="$(node -p "require('./packages/orchestrator/package.json').version")"
scripts/release.sh --check "$version"
tag="v$version"

# The PUSHED tag is the release. HEAD must be the tag's commit, clean, and the tag must be at
# origin — by hand, asked of origin; in the job, the tag is the very ref the run was made for.
git diff --quiet && git diff --cached --quiet || die "the tree is dirty — a release is a tag, not a working tree"
head="$(git rev-parse HEAD)"
[[ "$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null || true)" == "$head" ]] ||
  die "HEAD is not $tag — \`just release\` makes the tag; publish from it"
if [[ "$stage" == 1 ]]; then
  [[ "${GITHUB_REF_NAME:-}" == "$tag" ]] || die "--stage runs in the release job, on the $tag ref"
else
  remote="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" | awk 'END { print $1 }')"
  [[ "$remote" == "$head" ]] || die "$tag is not at origin at this commit — the pushed tag is the release; \`git push origin $tag\` first"
  npm whoami >/dev/null 2>&1 || die "no npm login on this box — \`npm login\`; the credential is the guard (ADR-0055)"
fi

# Images FIRST (ADR-0044): a package whose images are not at the home fails at pull on the user's
# first `jr2 up`; images with no package are inert. The canonical home is BAKED into the binary
# (`KIT_IMAGE_HOME`, packages/cli/src/build.ts), so it is spelled here to match, not derived from
# the repository owner: a fork that pushed to its own GHCR would ship a CLI that still pulls from
# this one.
if [[ -n "$platforms" ]]; then
  scripts/kit-push.sh ghcr.io/snapwich "$platforms"
else
  scripts/kit-push.sh ghcr.io/snapwich
fi

# Packed with pnpm (which rewrites `workspace:*` to the exact version, ADR-0043) and published with
# npm (the client that speaks staged publishing). The SET is what the manifests say — every
# `packages/*` member that is not `private` (the same rule publish.test.ts asserts) — and the ORDER
# is pnpm's own topological walk, dependencies first, so a publish that fails half way leaves
# packages whose own dependencies resolve; approve staged packages in that same order, for the same
# reason. `--provenance=false` because npm signs provenance only for a PUBLIC source repository
# (E422 "Unsupported GitHub Actions source repository visibility" otherwise) and this one is
# private; the job's identity is still its own. Drop the flag the day the repository goes public.
#
# A version already LIVE on npm is SKIPPED, not failed: published versions never move, so present
# means done — the job after a hand publish, or a re-run after a failure past this point,
# converges instead of dying on the first 403.
out="$(mktemp -d)"
for dir in $(pnpm -r --workspace-concurrency=1 --filter './packages/*' exec pwd); do
  name="$(node -p "const m = require('$dir/package.json'); m.private ? '' : m.name")"
  [[ -n "$name" ]] || continue
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "publish: $name@$version is already live on npm — skipped"
    continue
  fi
  tarball="$(pnpm -C "$dir" pack --pack-destination "$out" | tail -1)"
  if [[ "$stage" == 1 ]]; then
    npm stage publish "$tarball" --provenance=false --access public
  else
    npm publish "$tarball" --access public
  fi
done
