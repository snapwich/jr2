# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — a primary container, a generic list of additional sidecar
container specs, volumes, resources, secrets, idle timeout — and a custom operator reconciles it into a Pod plus a
Service, reporting a `status.endpoint` the Orchestrator uses to reach the Harness. The CRD names the Repos a Sandbox
needs by identity — enough for the operator to place the pod and mount each node cache read-only (ADR-0051) — and knows
nothing about clones, worktrees, or Agents; those are layered on by the Orchestrator after the Sandbox reaches `Ready`.

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
arbitrary containers without the controller knowing their roles. That is how the Adapter (ADR-0013) and the User
Container (ADR-0005) land in the pod with zero operator awareness: `kubectlSandbox` compiles them into the sidecar list
when it builds the CR. Containers cannot be added to a live pod (native containers, that is), so everything a Sandbox
will run must be in the spec at spin-up.

One Harness **image** serves many **Agents** — the Harness resolves model, instructions, and MCP tool sources at runtime
without a rebuild, re-reading the mounted definitions per Submission (ADR-0018) and connecting the Adapter's tool menu
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

- **Network isolation is not yet enforced.** The pod is hardened at the host boundary —
  `automountServiceAccountToken: false`, pod/container `securityContext` (`runAsNonRoot`,
  `allowPrivilegeEscalation: false`, drop `ALL`, seccomp `RuntimeDefault`) — but nothing yet restricts pod _egress_. An
  untrusted Agent can still reach the cluster's API server IP and sibling Sandbox Services over the pod network. The
  next isolation layer is a default-deny `NetworkPolicy` per Sandbox (deny egress to the API server and to other
  Sandboxes, allow only what the workflow needs). Requires a CNI that enforces NetworkPolicy (kind's default `kindnet`
  does not; Calico/Cilium do). Note the ADR-0013 boundary does not depend on this: only the token bounds what a pod may
  _do_; NetworkPolicy would bound where it may _talk_.
- **Sidecars are plain containers, not native sidecars.** They are scheduled as ordinary `containers`, not Kubernetes
  ≥1.29 native sidecars (`initContainers` with `restartPolicy: Always`). There is no start-ordering or
  termination-ordering guarantee between the Harness and its sidecars — the Harness may begin serving before the Adapter
  is up, or outlive it during shutdown. Revisit if ordering becomes load-bearing.
- **`reconcileStatus` writes status unconditionally.** Every reconcile issues a `Status().Update`, even when nothing
  changed. Harmless today (reconciles are event-driven, not hot-looping), but add an equality guard before the write if
  a status busy-loop ever appears.
- **Consumers must gate on `phase: Ready`, not endpoint presence.** `status.endpoint` is populated as soon as the
  Service exists, before the Harness is reachable; only `phase: Ready` (backed by a readiness probe) means "serving".
  The `Terminating` phase is best-effort — there is no finalizer, so a fast delete may GC the Pod/Service before the
  phase is observed.
