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

# --- kind e2e tier (ADR-0010/0012; requires docker + kind + go) ---

harness_image := "j2-harness-dev:local"
adapter_image := "j2-adapter:local"
kind_instance := "features/.tmp/kind"

# build the dev Harness image: the wire-compatible stub Harness + an Agent persona + git
harness-image:
    docker build -f deploy/harness-dev/Dockerfile -t {{ harness_image }} .

# build the Adapter image: the Agent's MCP surface, hosted in the Sandbox (ADR-0013)
adapter-image:
    docker build -f deploy/adapter/Dockerfile -t {{ adapter_image }} .

# scaffold the kind e2e instance and create the cluster AROUND it (the repos mount is baked at
# creation — ADR-0009 — so the instance folder must exist first, and must never be deleted after)
e2e-kind-up: harness-image adapter-image
    mkdir -p {{ kind_instance }}/workflows
    cp features/fixtures/kind-instance/j2.config.ts {{ kind_instance }}/j2.config.ts
    # the seed repo `repos[].url` points at; the boot reconcile clones it to repos/app/default
    [ -d {{ kind_instance }}/src/app/.git ] || ( mkdir -p {{ kind_instance }}/src/app && git -C {{ kind_instance }}/src/app init -q -b main && printf '# app\n' > {{ kind_instance }}/src/app/README.md && git -C {{ kind_instance }}/src/app add -A && git -C {{ kind_instance }}/src/app -c user.email=e2e@j2 -c user.name=e2e commit -qm init )
    cd {{ kind_instance }} && node ../../../packages/cli/bin/j2.ts cluster up
    kind load docker-image {{ harness_image }} --name {{ cluster }}
    kind load docker-image {{ adapter_image }} --name {{ cluster }}
    @echo "now run the operator in another shell (\`just operator-run\`), then \`just e2e-kind\`"

# run the kind e2e tier (needs `just e2e-kind-up` + a running operator)
e2e-kind:
    pnpm --filter @j2/e2e test:e2e:kind

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
