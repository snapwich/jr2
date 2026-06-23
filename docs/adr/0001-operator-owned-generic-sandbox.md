# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — a primary container, a generic list of additional sidecar
container specs, volumes, resources, secrets, idle timeout — and a custom operator reconciles it into a Pod plus a
Service, reporting a `status.endpoint` the Orchestrator uses to reach the Harness. The CRD knows nothing about git,
worktrees, or Agents; those are layered on by composable helpers after the Sandbox reaches `Ready`.

We chose the operator over the Orchestrator calling the Kubernetes API directly because the custom resource _is_ the
durable desired state: Sandboxes survive an Orchestrator restart, and garbage collection / readiness / retries live in
one reconciler instead of being threaded through the Machine. We kept the CRD generic (rather than coding/worktree-aware
with an init-container clone) so the operator stays workflow-agnostic — matching j2's thesis that the framework is a
grab-bag of composable pieces, with git/worktree being just one piece a coding Machine bolts on. The cost is an extra
runtime step (worktree setup as its own state that can fail independently) and an operator to build and maintain.

## Agents are sidecars, but the CRD stays agent-agnostic

Agents run as sidecar containers in the Sandbox pod (Kubernetes can't add containers to a live pod, so they must be in
the spec at spin-up). This does **not** make the CRD agent-aware: the spec enumerates plain Kubernetes `Container`
fragments (image, ports, env, volumeMounts), and the operator schedules them without knowing any are "agents." The
agent-awareness lives one layer up — the agent-aware "setup Sandbox" provider compiles the chosen Agents into container
specs and injects them into the CR's sidecar list, exactly as a Deployment's pod template carries arbitrary containers
without the controller understanding them. The trade is that agent-shape validation moves up into the provider/Machine
layer (where the domain types live) instead of the operator.

## Known limitations

These are accepted gaps in the current operator, recorded so they aren't silently forgotten. None block the PoC; each is
a deliberate deferral.

- **Network isolation is not yet enforced.** The pod is hardened at the host boundary —
  `automountServiceAccountToken: false`, pod/container `securityContext` (`runAsNonRoot`,
  `allowPrivilegeEscalation: false`, drop `ALL`, seccomp `RuntimeDefault`) — but nothing yet restricts pod _egress_. An
  untrusted Agent can still reach the cluster's API server IP and sibling Sandbox Services over the pod network. The
  next isolation layer is a default-deny `NetworkPolicy` per Sandbox (deny egress to the API server and to other
  Sandboxes, allow only what the workflow needs). Requires a CNI that enforces NetworkPolicy (kind's default `kindnet`
  does not; Calico/Cilium do).
- **Sidecars are plain containers, not native sidecars.** Agents are scheduled as ordinary `containers`, not Kubernetes
  ≥1.29 native sidecars (`initContainers` with `restartPolicy: Always`). There is no start-ordering or
  termination-ordering guarantee between the Harness and its Agents — the Harness may begin serving before an Agent is
  up, or outlive it during shutdown. Revisit if ordering becomes load-bearing.
- **`idleTimeout` measures from creation, not from orphaning.** `reconcileIdleTimeout` keys off `CreationTimestamp`, so
  a Sandbox that is owned for most of its life and only released (made ownerless) _after_ the deadline is deleted on the
  very next reconcile, with no grace period. A correct implementation tracks "orphaned since" (e.g. a status timestamp
  set when the last owner is removed) and measures the timeout from there.
- **`reconcileStatus` writes status unconditionally.** Every reconcile issues a `Status().Update`, even when nothing
  changed. Harmless today (reconciles are event-driven, not hot-looping), but add an equality guard before the write if
  a status busy-loop ever appears.
- **Consumers must gate on `phase: Ready`, not endpoint presence.** `status.endpoint` is populated as soon as the
  Service exists, before the Harness is reachable; only `phase: Ready` (now backed by a readiness probe) means
  "serving". The `Terminating` phase is best-effort — there is no finalizer, so a fast delete may GC the Pod/Service
  before the phase is observed.
