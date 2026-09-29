# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — a primary container, a generic list of additional sidecar
container specs, volumes, resources, secrets, idle timeout — and a custom operator reconciles it into a Pod plus a
Service, reporting a `status.endpoint` the Orchestrator uses to reach the Harness. The CRD names the Repos a Sandbox
needs by identity — enough for the operator to place the pod and mount each node cache read-only (ADR-0051) — and knows
nothing about clones, worktrees, or Agents; those are layered on by the Orchestrator after the Sandbox reaches `Ready`.
The operator also publishes what the Orchestrator needs to know about the pod onto the Sandbox's status — `podUID`, a
scheduling condition with the scheduler's message, the Harness container's restarts and last terminated reason — because
the Orchestrator watches Sandboxes and never reads a Pod ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)).

We chose the operator over the Orchestrator calling the Kubernetes API directly because the custom resource _is_ the
durable desired state: Sandboxes survive an Orchestrator restart, and garbage collection / readiness / retries live in
one reconciler instead of being threaded through the Machine. We kept the CRD generic (rather than coding/worktree-aware
with an init-container clone) so the operator stays workflow-agnostic — matching jr2's thesis that the framework is a
grab-bag of composable pieces, with git/worktree being just one piece a coding Machine bolts on. The operator is
git-aware to exactly the extent of the `Repo` CRD and the cache agent that keeps a bare checkout per node (ADR-0051): a
fetch is infrastructure, shared by every Sandbox on the node; a worktree is a Machine's. The cost is an extra runtime
step (worktree setup as its own state that can fail independently) and an operator to build and maintain.

## The Harness is the primary container; sidecars are opaque fragments

The CR's `spec.image` is the **Harness** — jr2's own server hosting the instance's Agents (ADR-0005/0018/0027).
Everything else in the pod rides `spec.sidecars`: plain Kubernetes `Container` fragments (image, ports, env,
volumeMounts) the operator schedules **without understanding them** — exactly as a Deployment's pod template carries
arbitrary containers without the controller knowing their roles. That is how the Custodian (ADR-0013, ADR-0059) and the
User Container (ADR-0005) land in the pod with zero operator awareness: `kubectlSandbox` compiles them into the sidecar
list when it builds the CR. Containers cannot be added to a live pod (native containers, that is), so everything a
Sandbox will run must be in the spec at spin-up.

One Harness **image** serves many **Agents** — the Harness resolves model, instructions, and its Menu at runtime without
a rebuild, reading the definition each admission carries (ADR-0018, ADR-0049) and reading the Menu through the Custodian
per turn (ADR-0013). So the Orchestrator injects a fixed Harness image plus **config** (env + the prepared worktree),
never a per-Agent image build. The HTTP prompt body itself carries only `{message, images}`, so anything persona-shaping
is set at provision time, not per request.

## Idle GC: a renewed lease, not a TTL

The operator reaps **abandoned** Sandboxes — ones whose Orchestrator is gone — as the backstop behind the Orchestrator's
own teardown (ADR-0012). "Abandoned" is defined by a lease: each live workspace renews a keepalive annotation
(`jr2.dev/keepalive: <timestamp>`) on its CR, and the operator deletes a Sandbox only once `spec.idleTimeout` (default
`30m`) has elapsed since **max(creation, last keepalive)**. A run parked on a Gate for hours keeps its Sandbox — its
lease is still renewing — while a `kill -9`'d Orchestrator's Sandboxes reap one idle-timeout later. An Orchestrator that
restarts within the timeout re-attaches and resumes renewing; one that stays down longer finds the CR gone and delivers
`workspace.lost` to the restored body. Creation counts as the initial lease, so a CR whose run faults before it ever
reaches `running` is still reaped on schedule, unleased from birth.

There are no ownerReferences in this scheme — nothing in the cluster represents a run, so liveness has to be asserted,
not referenced. Because the Orchestrator must hold that conversation open anyway, it is also where it _learns_: the
renewal returns the patched CR, so the same call that asserts liveness reports whether the workspace is still there and
still the same pod (ADR-0021). One exchange, both directions.

## Known limitations

These are accepted gaps in the current operator, recorded so they aren't silently forgotten. Each is a deliberate
deferral.

- **Egress is not restricted.** The pod is hardened at the host boundary — `automountServiceAccountToken: false`,
  pod/container `securityContext` (`runAsNonRoot`, `allowPrivilegeEscalation: false`, drop `ALL`, seccomp
  `RuntimeDefault`) — and its _ingress_ is the Orchestrator's alone: `jr2 up` converges a NetworkPolicy that admits no
  other pod to a Sandbox ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)), which kind's `kindnet`
  enforces. Nothing yet restricts _egress_: an untrusted Agent can still reach the cluster's API server IP (it holds no
  credential there) and the internet. A default-deny egress policy with an allowlist is the next layer, and ADR-0058
  records it open. The ADR-0013 boundary does not depend on either: only the token bounds what a pod may _do_;
  NetworkPolicy bounds where it may _talk_.
- **Sidecars are plain containers, not native sidecars.** They are scheduled as ordinary `containers`, not Kubernetes
  ≥1.29 native sidecars (`initContainers` with `restartPolicy: Always`). There is no start-ordering or
  termination-ordering guarantee between the Harness and its sidecars — the Harness may begin serving before the
  Custodian is up, or outlive it during shutdown. Start-up is covered without ordering: the Custodian's readiness probe
  holds the pod's Ready, which holds the Sandbox's, so no Turn is admitted before it serves (ADR-0059). Revisit if
  ordering becomes load-bearing.
- **`reconcileStatus` writes status only when it changed.** Every status write is a watch event at the Orchestrator
  (ADR-0063), so an unconditional `Status().Update` per reconcile would wake it for nothing.
- **Consumers must gate on `phase: Ready`, not endpoint presence.** `status.endpoint` is populated as soon as the
  Service exists, before the Harness is reachable; only `phase: Ready` (backed by a readiness probe) means "serving".
  The `Terminating` phase is best-effort — there is no finalizer, so a fast delete may GC the Pod/Service before the
  phase is observed.
