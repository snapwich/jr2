# operator

The Kubernetes operator that reconciles the `Sandbox` CRD into Pods + Services. A standalone Go module (kubebuilder /
controller-runtime). See [ADR-0001](../docs/adr/0001-operator-owned-generic-sandbox.md).

## Status

Not yet scaffolded. `kubebuilder` is required and not currently installed.

## Planned scaffolding

```sh
# from operator/
kubebuilder init --domain j2.dev --repo github.com/CHANGEME/j2/operator
kubebuilder create api --group core --version v1alpha1 --kind Sandbox --resource --controller
```

Proposed API (confirm before running):

- **Group/Version/Kind:** `core.j2.dev/v1alpha1`, `Kind: Sandbox`
- **Go module path:** `github.com/CHANGEME/j2/operator` — set the real repo path before init.

## Responsibilities (generic Sandbox — ADR-0001)

The CRD is infrastructure-only; it knows nothing about git, worktrees, or Agents.

- Reconcile a `Sandbox` CR into a Pod (the Harness image) + a Service.
- Report `status.endpoint` (the Service DNS the Orchestrator's Actor uses to reach the Harness) and `status.phase`
  (`Pending` → `Ready` → `Terminating`).
- Garbage-collect via owner references; honor `spec.idleTimeout`.

## Proposed Sandbox spec/status (sketch)

```yaml
spec:
  image: <harness image>
  resources: { cpu, memory }
  volumes: [...] # e.g. shared default mount, work dir
  env / secretRefs: [...] # ANTHROPIC_API_KEY, etc.
  idleTimeout: 30m
status:
  phase: Pending|Ready|Terminating
  endpoint: http://<sandbox>.<ns>.svc:8080
  podRef: ...
```
