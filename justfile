# jr2 dev loop. Run `just --list` to see recipes.
set shell := ["bash", "-uc"]

cluster := "jr2"

# install JS deps
install:
    pnpm install

# build all TS packages
build:
    pnpm -r build

# typecheck all TS packages
typecheck:
    pnpm -r typecheck

# run unit tests (node --test; mocks only, no infra)
test:
    pnpm -r --if-present test

# format the repo
format:
    pnpm format

# check formatting without writing (the pre-commit hook formats staged files for you)
format-check:
    pnpm format:check

# --- local cluster (requires kind) ---

# create the local kind cluster
kind-up:
    kind create cluster --config deploy/kind.yaml

# delete the local kind cluster
kind-down:
    kind delete cluster --name {{ cluster }}

# --- kit images (docker) — SHORTCUTS for building one image by hand (ADR-0038) ---
#
# None of these is a prerequisite of anything. `jr2 up` run from this checkout builds every image it
# deploys, at content-addressed tags, and delivers them itself; the `:local` tags below exist only
# for poking at an image by hand, and nothing resolves them.

adapter_image := "jr2-adapter:local"

# build the Adapter image: the Agent's MCP surface, hosted in the Sandbox (ADR-0013)
adapter-image:
    docker build -f deploy/adapter/Dockerfile -t {{ adapter_image }} .

# ADR-0018: definitions are injected at pod start, so no per-instance Harness image exists.
# build the STOCK Harness image (what a real instance runs) and load it into kind
harness-image:
    docker build -f deploy/harness/Dockerfile -t jr2-harness:local .
    kind load docker-image jr2-harness:local --name {{ cluster }}

# --- kind e2e tier (ADR-0010; requires docker + kind) ---

# A VANILLA cluster, and nothing else (ADR-0038): `jr2 up` from this checkout builds and `kind load`s
# every image it deploys — Harness, Adapter, operator, instance, and the instance's Sandbox Images.
# Pre-loading a `:local` tag here would be exactly the invisible-stale-image bug that deletes.
# Nothing is instance-bound to the cluster (ADR-0019): each @kind scenario `jr2 up`s into a fresh
# namespace, operator included.
e2e-kind-up:
    kind get clusters | grep -qxF {{ cluster }} || kind create cluster --config deploy/kind.yaml
    @echo "now: \`just e2e-kind\`"

# run the kind e2e tier (needs `just e2e-kind-up`). The tier addresses the kind cluster by its own
# exported kubeconfig, never the shell's current context: `jr2 up` converges whatever `kubectl`
# points at (ADR-0019), and a shell pointed at a real cluster would otherwise fail every scenario
# at "is serving" — or worse, converge into it.
e2e-kind:
    mkdir -p features/.tmp && kind export kubeconfig --name {{ cluster }} --kubeconfig features/.tmp/kubeconfig
    KUBECONFIG={{ justfile_directory() }}/features/.tmp/kubeconfig pnpm --filter @jr2/e2e test:e2e:kind

# A COLD host builds every image the tier deploys four times over: the tier runs four workers, and
# the first scenario of each converges its own namespace from nothing — Harness, Adapter, operator,
# instance, Sandbox Image — with no cross-process lock on a build, so four identical cold builds
# contend for the same cores and the first step of all four scenarios can pass its 10 minute bound
# (measured on a 4-core hosted runner: every worker's first scenario timed out, everything after
# passed on the warm cache). A maintainer's box is warm from the last run; a runner never is. So
# ONE scenario first, serially: it spends every build once (ADR-0041 — a build the host holds is
# not spent again), and the parallel tier that follows finds them. Any scenario that converges
# and provisions a Sandbox would do; the first Rule's is the one that changes least.
#
# Not folded into `e2e-kind`: a warm box pays a scenario's run time for nothing, and this recipe
# names the cold case — the release job calls it, a cold box may.
e2e-kind-warm:
    mkdir -p features/.tmp && kind export kubeconfig --name {{ cluster }} --kubeconfig features/.tmp/kubeconfig
    KUBECONFIG={{ justfile_directory() }}/features/.tmp/kubeconfig pnpm --filter @jr2/e2e exec cucumber-js --profile kind --parallel 1 kind.feature:28

# render the operator install manifest shipped inside the npm package (ADR-0019; check in the result)
operator-manifest:
    kubectl kustomize operator/config/default > packages/cli/manifests/operator.yaml

# build the operator controller image by hand and load it into kind (a shortcut, not a prerequisite)
operator-image:
    docker build -t jr2-operator:local operator
    kind load docker-image jr2-operator:local --name {{ cluster }}

# --- the Kit images at their PUBLISHED names (ADR-0044; requires docker + buildx) ---
#
# The checkout arm of ADR-0044, and NOT a `jr2 up` shortcut like the recipes above: these are the
# real published tags (`<registry>/jr2-<x>:<kitversion>`), the ones an INSTALLED kit deploys and
# never builds. This is how the canonical home gets its images at release —
#
#     just kit-push ghcr.io/snapwich
#
# — and how a self-host or a dev-loop registry gets images the home does not have yet. Multi-arch by
# default because a mirror (`jr2 kit push`) copies whatever it finds, deficiencies included; a caller
# who knows its target's architecture passes one platform and skips qemu.

# build the three Kit images multi-arch and push them at their published names
kit-push registry platforms="linux/amd64,linux/arm64":
    scripts/kit-push.sh {{ registry }} {{ platforms }}

# --- operator (requires kubebuilder; see operator/README.md) ---

# install the Sandbox CRD into the current kube context
operator-install:
    cd operator && make install

# run the operator against the current kube context (foreground)
operator-run:
    cd operator && make run

# run the operator test suite (envtest + fake-client unit tests)
operator-test:
    cd operator && make test

# apply the sample Sandbox CR
sandbox-sample:
    kubectl apply -f operator/config/samples/core_v1alpha1_sandbox.yaml

# --- the manual release loop (ADR-0043/0044; requires docker + kind, and network every run) ---
#
# EVERY run, not just the first: the npm registry's storage is wiped on each `up` — that wipe is what
# lets the version `main` carries republish without stamping another — so verdaccio's uplink cache
# is cold again and the whole dependency tree resolves through npmjs.
#
# The kit as a USER gets it: packages resolved from a registry, Kit images PULLED from a registry,
# the `jr2` binary installed globally, an instance folder that lives nowhere near this checkout. Only
# the two registries are local — the same rule ADR-0038 applies to the model provider — so installed
# mode, the branch every other tier skips, is the branch that runs. `dist-up` leaves both registries
# and the throwaway global install standing so a developer can play; `dist-down` puts both ports
# back. The @dist e2e tier drives this same loop unattended.

# Outside the checkout, and that is load-bearing: the installed CLI decides checkout vs installed
# mode by walking up from its own real path, so a global prefix under the kit root would run the
# very mode this loop exists to skip (ADR-0043; scripts/dist-publish.sh refuses it outright).
dist_dir := env_var_or_default("TMPDIR", "/tmp") / "jr2-dist"

# publish the kit locally, push its images at the published tags, install the CLI globally
dist-up:
    #!/usr/bin/env bash
    set -euo pipefail
    scripts/dist-registry.sh up
    # The stand-in Kit image home (ADR-0044). Up BEFORE the publish, which pushes into it.
    scripts/dist-image-registry.sh up
    # The publish, the Kit images, and the global install are a SCRIPT because the @dist e2e tier
    # runs the identical bring-up unattended — the two faces of one loop cannot drift.
    scripts/dist-publish.sh
    ver="$(node -p 'require("./packages/orchestrator/package.json").version')"
    # Both addresses ASKED of their scripts: each port has one owner (ADR-0055 retired the manifest
    # line that used to fix the npm one).
    registry="$(scripts/dist-registry.sh address)"
    kit_registry="$(scripts/dist-image-registry.sh address)"

    cat <<MSG

    @jr2/cli v$ver is installed. Put it on PATH:

      export PATH="{{ dist_dir }}/npm-global/bin:\$PATH"

    Then live like a user — outside this checkout, outside any git repo:

      jr2 init /tmp/demo && cd /tmp/demo
      npm install --registry $registry
      # an installed kit BUILDS no Kit image — it pulls the published tags, so point the cluster at
      # the loop's stand-in home instead of ghcr.io/snapwich (ADR-0044):
      #   kitRegistry: process.env.JR2_KIT_REGISTRY  →  jr2.config.ts
      #   JR2_KIT_REGISTRY=$kit_registry             →  .env
      jr2 up

    \`just dist-down\` stops both registries.
    MSG

# The loop's third face, and the only one that reaches a real (non-kind) cluster today: installed
# mode deploys kit refs that carry no registry prefix (ADR-0038, deferred), so a real cluster cannot
# pull them — but a checkout `jr2` builds every image it deploys and prefixes it. What that binary
# cannot do is conjure `@jr2/*` for an instance outside this workspace, whose bundle is a frozen
# install from its own lockfile (ADR-0043). So: publish, and let the checkout do the rest. No Kit
# images and no global install — those are the installed kit's half, and this face has no installed
# kit in it.
#
# The registry STAYS UP for the whole loop, not just the install: the lockfile `npm install` writes
# resolves every package — not only `@jr2/*` — to this registry, and the bundle's `npm ci` reads
# those URLs back on every `jr2 up`.

# publish the kit locally and stop — for a CHECKOUT `jr2` driving a STANDALONE instance
dist-packages:
    #!/usr/bin/env bash
    set -euo pipefail
    scripts/dist-registry.sh up
    scripts/dist-publish.sh --packages-only
    registry="$(scripts/dist-registry.sh address)"

    cat <<MSG

    Live like a user, outside this checkout, with the CHECKOUT binary:

      node {{ justfile_directory() }}/packages/cli/bin/jr2.js init /tmp/demo && cd /tmp/demo
      npm install --registry $registry
      # a non-kind cluster needs a registry it can pull from — the scaffold names none:
      #   registry: "registry.example.com"  →  jr2.config.ts
      node {{ justfile_directory() }}/packages/cli/bin/jr2.js up --context <ctx>

    Re-running this recipe WIPES the registry and republishes, so an instance installed against
    the previous run must \`npm install\` again — its lockfile records the old tarballs' integrity.

    \`just dist-down\` stops the registry — after the last \`jr2 up\`, not after the install.
    MSG

# stop the loop's registries (the throwaway global install stays; it is inert without them)
dist-down:
    #!/usr/bin/env bash
    # Not `set -e`: a registry that refuses to stop must not leave the OTHER one standing — each
    # port is freed independently, and the recipe still fails if either did.
    set -uo pipefail
    rc=0
    scripts/dist-registry.sh down || rc=$?
    scripts/dist-image-registry.sh down || rc=$?
    exit $rc

# --- the @dist e2e tier (ADR-0043/0044; the same loop, unattended) ---
#
# The only setup a human owes it is a cluster: the tier's own suite fixture stands up both
# registries, publishes the kit, pushes the Kit images at their published tags, and installs the
# `jr2` binary into a throwaway prefix — once per suite run, in a temp dir of its own, so it borrows
# no state from `dist-up` and leaves none behind. The PORTS are the exception, because both faces
# default to the same two: the tier refuses to start while a manual loop holds them
# (`just dist-down`).
#
# The cluster is vanilla but not featureless since ADR-0044 — deploy/kind.yaml tells containerd that
# per-registry config exists, which is what lets the fixture point the nodes at its own registry. A
# cluster created before that patch is refused by name at bring-up, not diagnosed later as a pull
# failure.

# a VANILLA kind cluster for the @dist tier (the same one @kind uses — safe to run either)
e2e-dist-up:
    kind get clusters | grep -qxF {{ cluster }} || kind create cluster --config deploy/kind.yaml
    @echo "now: \`just e2e-dist\`"

# run the @dist e2e tier (needs `just e2e-dist-up`, and network on every run — the storage is wiped)
e2e-dist:
    mkdir -p features/.tmp && kind export kubeconfig --name {{ cluster }} --kubeconfig features/.tmp/kubeconfig
    KUBECONFIG={{ justfile_directory() }}/features/.tmp/kubeconfig pnpm --filter @jr2/e2e test:e2e:dist

# --- the release (ADR-0055; the tag push is the release) ---
#
# LOCKSTEP: one version across every manifest and the scaffold's exact pins, bumped together here,
# never rewritten at publish time. The recipe bumps, runs the unit gate, commits `release: <ver>`
# and tags `v<ver>`; the human pushes `main` and the tag, and .github/workflows/release.yml does
# the rest in order — check the tag against the manifests, every tier on a runner kind cluster,
# Kit images to their home, THEN the packages STAGED on npm — a 2FA approval per package makes them
# live. The guard against an accidental publish is the credential: no dev box holds an npmjs token,
# and the job holds none either (trusted publishing, stage-only).

# bump every manifest (patch|minor|major|x.y.z), gate, commit, and tag — then `git push origin main v<ver>`
release bump:
    scripts/release.sh {{ bump }}
