# operator

The Kubernetes operator that reconciles the generic `Sandbox` CRD into a Pod + Service and reports a `status.endpoint`.
A standalone Go module (kubebuilder / controller-runtime). See
[ADR-0001](../docs/adr/0001-operator-owned-generic-sandbox.md). This is **PoC #1** of the j2 orchestrator rewrite.

- **Group/Version:** `core.j2.dev/v1alpha1`; **Kinds:** `Sandbox`, `Repo`
- **Module:** `github.com/snapwich/j2/operator`

## Two CRDs (ADR-0051)

A `Repo` is one git repository the Instance keeps a bare cache of per node: `spec.url` (the Binding's own spelling),
`spec.secretRef` (a Secret with Flux's key names, resolved from `git.credentials` by the Orchestrator that creates the
resource), `spec.refreshInterval`; `status.nodes[]` is written per node by that node's cache agent (`present`, `synced`,
`lastAttempt`, `lastFetched`, `lastError`), and `RepoReconciler` folds it into one `Synced` condition. A `Sandbox` names
the Repos it attaches by cache key in `spec.repos[]`; for each the operator adds a read-only hostPath volume
`repo-<key>` at `/repos/<key>` in the primary container, prefers nodes whose `Repo` status holds the cache, publishes
`status.node`, and holds `Ready` until every key is present on that node and fetched since the Sandbox was created — a
cache whose refresh failed is `Ready` with `ReposFresh=False`, a cold node that could not clone is held with
`RepoCloneFailed`. That list of keys is the whole of what the Sandbox CRD knows about git; clone and worktree stay the
Orchestrator's post-Ready step (ADR-0004).

## What it does (ADR-0001)

The CRD is infrastructure-only — it knows nothing about git, worktrees, or Agents. Agents are injected one layer up as
plain Kubernetes `Container` fragments in `spec.sidecars`; the operator schedules them without understanding them.

The reconciler (`internal/controller/sandbox_controller.go`):

- Builds a **bare Pod** (no Deployment/Job) from `spec.image` (the primary "harness" container) plus any
  `spec.sidecars`, with `spec.volumes` / `volumeMounts` / `resources` / `env` / `envFrom`.
- Creates a **Service** per Sandbox selecting the pod, exposing `spec.port` (default 8080).
- Owns both via owner references, so deleting the `Sandbox` garbage-collects the Pod + Service.
- Reports `status.phase` (`Pending` → `Ready` → `Terminating`), gating **Ready on the pod's `Ready` condition** (not
  just scheduling), and populates `status.endpoint` (`http://<name>.<ns>.svc:<port>`), `podRef`, `serviceRef`.
- Garbage-collects an **orphaned** Sandbox (no owner references) once `spec.idleTimeout` elapses.

## Sandbox spec/status

```yaml
spec:
  image: <harness image> # primary container, required
  command/args: [...] # optional entrypoint override
  port: 8080 # surfaced in status.endpoint
  sidecars: [<corev1.Container>...] # generic; agents live here, operator stays agnostic
  volumes / volumeMounts: [...]
  resources: { requests, limits }
  env / envFrom: [...] # e.g. an ANTHROPIC_API_KEY secret
  idleTimeout: 30m # GC an orphaned Sandbox after this
status:
  phase: Pending | Ready | Terminating
  endpoint: http://<name>.<ns>.svc:8080
  podRef / serviceRef: { name }
  conditions: [...] # Ready mirrors status.phase
```

## Local dev loop

Requires `kind`, `kubebuilder`, `kubectl`, Docker, Go 1.26+.

```sh
# from repo root
just kind-up                       # create the local kind cluster (deploy/kind.yaml)

# from operator/
make install                       # install the CRD into the cluster
make run                           # run the operator against the current kubecontext (foreground)

# in another shell
kubectl apply -f config/samples/core_v1alpha1_sandbox.yaml
kubectl get sandbox -w             # watch Pending -> Ready, endpoint populated
kubectl delete sandbox sandbox-sample   # owner-ref GC of Pod + Service
```

## Tests

```sh
make test          # envtest-backed controller suite + fast fake-client unit tests
```

- `internal/controller/sandbox_controller_test.go` — envtest: owned Pod+Service creation, Pending→Ready transition,
  endpoint/refs.
- `internal/controller/idletimeout_test.go` — fake-client: orphan idle-GC fires; owned Sandbox survives and provisions.

> The Makefile pins `GOTOOLCHAIN` to the `go` version in `go.mod` so local builds are reproducible and match CI. This
> avoids two `GOTOOLCHAIN=auto` drift bugs: the `golangci-lint custom` build producing a linter that refused the newer
> target, and `make test` failing with `no such tool "covdata"` from an auto-pulled patch toolchain. Override with
> `make GOTOOLCHAIN=auto <target>` to opt back into auto-selection.
