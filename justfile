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

# --- kit images (docker) — the local tags instance configs override to (ADR-0019 kit dev) ---

harness_dev_image := "j2-harness-dev:local"
adapter_image := "j2-adapter:local"

# Builds only — `e2e-kind-up` is what loads it onto the cluster, batched with the Adapter.
# build the DEV stub Harness image (@kind): the wire-compatible stub + a scripted persona + git
harness-image-dev:
    docker build -f deploy/harness-dev/Dockerfile -t {{ harness_dev_image }} .

# build the Adapter image: the Agent's MCP surface, hosted in the Sandbox (ADR-0013)
adapter-image:
    docker build -f deploy/adapter/Dockerfile -t {{ adapter_image }} .

# ADR-0018: definitions are injected at pod start, so no per-instance Harness image exists;
# `images.harness` override territory (ADR-0031).
# build the STOCK Harness image (what a real instance runs) and load it into kind
harness-image:
    docker build -f deploy/harness/Dockerfile -t j2-harness:local .
    kind load docker-image j2-harness:local --name {{ cluster }}

# --- kind e2e tier (ADR-0010; requires docker + kind) ---

# a VANILLA cluster + the locally built kit images. Nothing is instance-bound to the cluster
# (ADR-0019): each @kind scenario `j2 up`s into a fresh namespace, operator included.
e2e-kind-up: harness-image-dev adapter-image
    kind get clusters | grep -qxF {{ cluster }} || kind create cluster --config deploy/kind.yaml
    docker build -t j2-operator:local operator
    kind load docker-image {{ harness_dev_image }} --name {{ cluster }}
    kind load docker-image {{ adapter_image }} --name {{ cluster }}
    kind load docker-image j2-operator:local --name {{ cluster }}
    @echo "now: \`just e2e-kind\`"

# run the kind e2e tier (needs `just e2e-kind-up`)
e2e-kind:
    pnpm --filter @j2/e2e test:e2e:kind

# render the operator install manifest shipped inside the npm package (ADR-0019; check in the result)
operator-manifest:
    kubectl kustomize operator/config/default > packages/cli/manifests/operator.yaml

# build the operator controller image for kit dev and load it into kind (`images.operator` override)
operator-image:
    docker build -t j2-operator:local operator
    kind load docker-image j2-operator:local --name {{ cluster }}
    # Kit dev pins a STATIC tag, so a rebuild leaves the pod template identical and nothing rolls —
    # `j2 up`'s image verification compares tags and cannot see it. Restarting here is what makes
    # "rebuilt" mean "running" (ignored when the operator isn't deployed yet).
    kubectl --context kind-{{ cluster }} -n j2-system rollout restart deploy/j2-controller-manager 2>/dev/null || true

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
