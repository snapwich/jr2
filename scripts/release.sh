#!/usr/bin/env bash
#
# `just release patch|minor|major|<x.y.z>` (ADR-0055): the release commit and its tag, made here;
# pushing the tag is the release.
#
#   release.sh minor            0.1.0 → 0.2.0: bump every manifest, gate, commit, tag v0.2.0
#   release.sh 1.0.0            an explicit version, same steps
#   release.sh --check 0.2.0    exit non-zero unless every manifest already reads 0.2.0 — the
#                               release job's first step, and scripts/kit-push.sh's refusal
#
# LOCKSTEP: the kit is one version across every `packages/*` manifest, and the exact `@jr2/*` pins
# the scaffold writes (`templates/default`, and any workspace member that carries them) move with
# it — `KIT_VERSION` is read from one manifest, `workspace:*` packs to an exact inter-dependency,
# and the scaffold pins exact (ADR-0019/0043), so two numbers would be a kit that cannot resolve
# itself. `main` carries the NEXT version: nothing rewrites a version at publish time, because a
# loop that edits manifests tests edited manifests (ADR-0043), and a checkout's `KIT_VERSION` must
# read the number the checkout will ship.
#
# The number is computed the way `npm version <bump>` computes it, from `@jr2/orchestrator` — the
# manifest `KIT_VERSION` reads — and written to the rest, because `npm version` moves one manifest
# and the kit has six plus the pins.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  echo "usage: $(basename "$0") patch|minor|major|<x.y.z>  |  --check <x.y.z>" >&2
  exit 2
}

# Release versions are plain `x.y.z`: a prerelease `current` would make the bump arithmetic NaN,
# and an explicit `1.2.3x` would ride every step below — manifests, lockfile, gate, commit, TAG —
# and be refused by npm alone, after the images were pushed.
semver='^[0-9]+\.[0-9]+\.[0-9]+$'

# ONE list of the manifests the version lives in, in one place: `version` in packages/*, and the
# exact `@jr2/*` pins in the other workspace members (the scaffold's model and the tiers'
# instances, ADR-0043). `check` and `bump` are the same walk, so the checker and the writer cannot
# disagree about which files carry the number.
lockstep() {
  node - "$@" <<'JS'
const fs = require("node:fs");
const [mode, want, next] = process.argv.slice(2);
const dirs = (parent) =>
  fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`) : [];
const manifest = (dir) => `${dir}/package.json`;
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const write = (path, m) => fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
const versioned = dirs("packages").map(manifest).filter(fs.existsSync);
const pinned = [...dirs("templates"), "features", ...dirs("features")].map(manifest).filter(fs.existsSync);
const blocks = ["dependencies", "devDependencies", "peerDependencies"];
let bad = 0;
for (const path of versioned) {
  const m = read(path);
  if (mode === "bump") { m.version = next; write(path, m); continue; }
  if (m.version !== want) { console.error(`${path} is v${m.version}, not v${want}`); bad++; }
}
for (const path of pinned) {
  const m = read(path);
  for (const block of blocks) {
    for (const [k, v] of Object.entries(m[block] ?? {})) {
      if (!k.startsWith("@jr2/") || !/^\d/.test(v)) continue;
      if (mode === "bump") { if (v === want) m[block][k] = next; continue; }
      if (v !== want) { console.error(`${path} pins ${k}@${v}, not ${want}`); bad++; }
    }
  }
  if (mode === "bump") write(path, m);
}
process.exit(bad ? 1 : 0);
JS
}

current="$(node -p "require('./packages/orchestrator/package.json').version")"

case "${1:-}" in
  --check)
    [[ "${2:-}" =~ $semver ]] || usage
    lockstep check "$2" && echo "every manifest reads v$2"
    exit
    ;;
  patch | minor | major)
    [[ "$current" =~ $semver ]] || {
      echo "@jr2/orchestrator is v$current, which is not x.y.z — name the next version explicitly" >&2
      exit 1
    }
    next="$(node -p "
      const [M, m, p] = '$current'.split('.').map(Number);
      ({ major: \`\${M + 1}.0.0\`, minor: \`\${M}.\${m + 1}.0\`, patch: \`\${M}.\${m}.\${p + 1}\` })['$1']")"
    ;;
  *)
    [[ "${1:-}" =~ $semver ]] || usage
    next="$1"
    ;;
esac

# A release is a commit of its own on a clean tree: the gate below must run on exactly what the
# tag will name — and a clean tree is what lets a FAILED gate put everything back (below).
if [[ -n "$(git status --porcelain)" ]]; then
  echo "the working tree is not clean — commit or stash first; a release commit carries only the bump" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
  echo "v$next already exists" >&2
  exit 1
fi

echo "release: $current → $next" >&2

# From here to the commit, every edit is to a tracked file on a tree that was clean, so a failure
# anywhere restores the tree to what it was: the maintainer fixes the cause and runs the same
# command again, rather than finding a half-bumped tree that this script's own clean check refuses.
undo() {
  echo "release: $next not made — restoring the tree" >&2
  git checkout -q -- .
  pnpm install --lockfile-only --silent
}
trap undo ERR

lockstep bump "$current" "$next"
# The lockfile records the template's exact `@jr2/*` specifier, so a bump without this fails the
# next `--frozen-lockfile` install (CI's first step).
pnpm install --lockfile-only
pnpm exec prettier --write --log-level warn "packages/*/package.json" "templates/*/package.json" "features/package.json" "features/*/package.json"
lockstep check "$next"

# The unit gate, on the bumped tree: `init.test.ts` is the tripwire that the scaffold and its
# model moved together (ADR-0043). The heavy tiers run on the tag (.github/workflows/release.yml).
pnpm -r typecheck
pnpm -r --if-present test

trap - ERR
git add -A
git commit -q -m "release: $next"
git tag -a "v$next" -m "jr2 $next"

cat >&2 <<MSG

tagged v$next. The tag push is the release (ADR-0055): the job checks the tag against the manifests,
runs every tier, pushes the Kit images to their home, then publishes to npm.

  git push origin main v$next

MSG
