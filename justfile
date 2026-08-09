# j2 dev loop. Run `just --list` to see recipes.
set shell := ["bash", "-uc"]

cluster := "j2"

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
# None of these is a prerequisite of anything. `j2 up` run from this checkout builds every image it
# deploys, at content-addressed tags, and delivers them itself; the `:local` tags below exist only
# for poking at an image by hand, and nothing resolves them.

adapter_image := "j2-adapter:local"

# build the Adapter image: the Agent's MCP surface, hosted in the Sandbox (ADR-0013)
adapter-image:
    docker build -f deploy/adapter/Dockerfile -t {{ adapter_image }} .

# ADR-0018: definitions are injected at pod start, so no per-instance Harness image exists.
# build the STOCK Harness image (what a real instance runs) and load it into kind
harness-image:
    docker build -f deploy/harness/Dockerfile -t j2-harness:local .
    kind load docker-image j2-harness:local --name {{ cluster }}

# --- kind e2e tier (ADR-0010; requires docker + kind) ---

# A VANILLA cluster, and nothing else (ADR-0038): `j2 up` from this checkout builds and `kind load`s
# every image it deploys — Harness, Adapter, operator, instance, and the instance's Sandbox Images.
# Pre-loading a `:local` tag here would be exactly the invisible-stale-image bug that deletes.
# Nothing is instance-bound to the cluster (ADR-0019): each @kind scenario `j2 up`s into a fresh
# namespace, operator included.
e2e-kind-up:
    kind get clusters | grep -qxF {{ cluster }} || kind create cluster --config deploy/kind.yaml
    @echo "now: \`just e2e-kind\`"

# run the kind e2e tier (needs `just e2e-kind-up`)
e2e-kind:
    pnpm --filter @j2/e2e test:e2e:kind

# render the operator install manifest shipped inside the npm package (ADR-0019; check in the result)
operator-manifest:
    kubectl kustomize operator/config/default > packages/cli/manifests/operator.yaml

# build the operator controller image by hand and load it into kind (a shortcut, not a prerequisite)
operator-image:
    docker build -t j2-operator:local operator
    kind load docker-image j2-operator:local --name {{ cluster }}

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
