# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — a primary container, a generic list of additional sidecar
container specs, volumes, resources, secrets, idle timeout — and a custom operator reconciles it into one Pod — created
once, never recreated: a pod that is gone or terminal makes the Sandbox `Lost` (ADR-0021) — plus a Service, reporting a
`status.endpoint` the Orchestrator uses to reach the Harness. The CRD names the Repos a Sandbox needs by identity —
enough for the operator to place the pod and mount each node cache read-only (ADR-0051) — and knows nothing about
clones, worktrees, or Agents; those are layered on by the Orchestrator after the Sandbox reaches `Ready`. The operator
also publishes what the Orchestrator needs to know about the pod onto the Sandbox's status — `podUID`, a scheduling
condition with the scheduler's message, the Harness container's restarts and last terminated reason — because the
Orchestrator watches Sandboxes and never reads a Pod ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)).

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
renews is still reaped on schedule. The lease is renewed from the CR's write, so a Sandbox that waits for a node or for
quota is never taken for abandoned (ADR-0064).

There are no ownerReferences in this scheme — nothing in the cluster represents a run, so liveness has to be asserted,
not referenced. The lease only asserts; the Orchestrator learns from its watch of the Sandboxes (ADR-0021, ADR-0063).

## The operator scales with Sandboxes, not with the cluster

The operator is deployed once per cluster (ADR-0008), so its cost must follow what jr2 runs, not what the cluster runs.
The scaling review (R7, 2026-09-30) found it fine at 40 Sandboxes and predicted the breaks at hundreds, or on a busy
cluster; these are the rules.

- **The operator caches only what it labels.** controller-runtime keeps an in-memory copy of every object a controller
  watches; the Pod and Service informers take the selector `app.kubernetes.io/managed-by=jr2-operator`, which every
  object the operator creates carries, so memory and watch traffic are O(Sandboxes) whatever cluster the operator lands
  in. Sandboxes and Repos are jr2's own kinds and are cached whole. The one read that must not trust the cache — the
  confirmation before a pod is declared lost (ADR-0021) — goes past it through the API reader.
- **Reconciles run in parallel, at fixed numbers.** controller-runtime never reconciles one Sandbox twice at once and a
  reconcile holds no shared state, so the Sandbox controller runs 16 workers, the Repo controller 4, and the client's
  rate limit is 100 QPS with a burst of 200, so a burst of CRs is placed in a fraction of a second instead of one API
  round trip at a time. Kit values, not config: nobody has a reading to tune them by, and the API server's own priority
  and fairness still governs.
- **A Repo event wakes only the Sandboxes it changes.** A Sandbox reads only its own node's entry of each Repo it names
  (ADR-0051, ADR-0053), so the Repo watch diffs `status.nodes` and enqueues the Sandboxes naming the Repo whose
  `status.node` changed; a spec change wakes them all. Without this a cache agent's per-fetch status write woke every
  Sandbox naming the Repo on every node, S×N per interval and S² on a burst of asks.
- **The token Secret is owned from birth.** The Orchestrator writes the CR first, then the Secret with the CR as its
  owner, so no path — an ownerRef patch that fails, an Orchestrator that dies between the two writes — leaves a token
  behind on the cluster. The pod is created the moment the CR is seen and may reach its mount before the Secret lands;
  kubelet retries the mount, and the Secret arrives one API round trip after the CR, well before the scheduler and
  kubelet get there.

Not taken (R14): a headless Service. A ClusterIP Service programs kube-proxy rules on every node per Sandbox; a headless
one keeps the name and the endpoint and costs no node anything. Deferred until a cluster with many nodes measures it.

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
