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

# build the dev Harness image: the wire-compatible stub Harness + a scripted persona + git (@kind)
harness-image:
    docker build -f deploy/harness-dev/Dockerfile -t {{ harness_dev_image }} .

# build the Adapter image: the Agent's MCP surface, hosted in the Sandbox (ADR-0013)
adapter-image:
    docker build -f deploy/adapter/Dockerfile -t {{ adapter_image }} .

# build the STOCK Harness image (ADR-0018: definitions are injected at pod start — no
# per-instance Harness image exists) and load it into kind (`sandbox.image` override territory)
harness-image-stock:
    docker build -f deploy/harness/Dockerfile -t j2-harness:local .
    kind load docker-image j2-harness:local --name {{ cluster }}

# --- kind e2e tier (ADR-0010; requires docker + kind) ---

# a VANILLA cluster + the locally built kit images. Nothing is instance-bound to the cluster
# (ADR-0019): each @kind scenario `j2 up`s into a fresh namespace, operator included.
e2e-kind-up: harness-image adapter-image
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

# build the operator controller image for kit dev and load it into kind (`operator.image` override)
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
