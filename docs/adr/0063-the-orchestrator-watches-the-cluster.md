# The Orchestrator watches the cluster

The Orchestrator talked to Kubernetes by starting a `kubectl` process for every call (`sandbox-kubectl.ts`). A short
process can only ask "what is the state now?", so waiting became polling: `get sandbox` every second while a Workspace
provisioned (and `get pod` every fifth time), `get sandbox` every second while a fetch ask waited (ADR-0053), and
detection of a lost Workspace only on the Lease's 5-minute renewal (ADR-0021 chose that and named the watch as the thing
to revisit "if something needs sub-minute loss detection"). The attach was a `kubectl exec` stream per Workspace through
the API server. The scaling review (2026-09-27) measured 36 concurrent `kubectl` processes and about one core of
Orchestrator CPU at 40 Workspaces starting, and `workspace.lost` arriving 4.6–4.7 minutes after an eviction or drain.
Decisions since then need pod facts at once: the scheduler's reason for a Pending pod, a lost pod's reason, and
`OOMKilled` to name a memory fault (ADR-0060, ADR-0061).

## Decision

- **One in-process client on Node's built-in `fetch`, with no new dependency.** The Orchestrator is always in-cluster
  (ADR-0019). The Deployment sets `NODE_EXTRA_CA_CERTS` to the ServiceAccount's `ca.crt` (concatenated with the ADR-0020
  bundle if the Orchestrator ever needs both). The client does plain REST for jr2's own kinds — Sandbox, Repo, Secret —
  including server-side apply, and one watch loop. Its rules, each observed on a real cluster (2026-09-29):
  - The token is read from its file on every request, never cached: the kubelet replaced a 10-minute token only about 50
    seconds before it expired. A `401` re-reads the file and retries once.
  - A watch asks for bookmarks and `timeoutSeconds=240`. Built-in `fetch` aborts a response body that sends nothing for
    300 seconds (`UND_ERR_BODY_TIMEOUT`, at 300.8s), and that timeout cannot be changed without undici's dispatcher; the
    server closing first, and bookmarks about every 60 seconds, keep a healthy watch clear of it. The abort itself is a
    resume, not a failure.
  - Every bookmark's `resourceVersion` is kept, so a resume after a quiet period starts from a recent point.
  - A resume that is too old arrives as an `ERROR` event with code 410 **inside an HTTP 200**. Any `ERROR` event
    re-lists.
  - Concurrent writes are capped (8–16). 200 parallel writes each opened a TLS connection and cost about 130% CPU.
- **The Orchestrator watches Sandboxes only**, one watch on the Instance's namespace — the namespace is the Instance's
  identity (ADR-0019), and `jr2 up` refuses one another Instance owns — selected by the `jr2.dev/run` label every
  Sandbox it provisions carries. Observed: event latency p50 11ms, p95 92ms, max 186ms; 0 events lost across a
  200-object burst and a CRD run; about 75 MiB and 3% CPU for the watcher. **It never reads a Pod.** The operator owns
  the pod (ADR-0001) and already reads it on every reconcile, so it publishes what the Orchestrator needs onto the
  Sandbox's status: a scheduling condition with the scheduler's message — or a quota's refusal of the pod create
  ([ADR-0064](0064-a-workspace-waits-for-capacity.md)) — the Harness container's restarts and last terminated reason,
  and `podUID`.
- **The watch drives everything that polled.**
  - Placing and provisioning wait on watch events: an Unschedulable pod or a quota refusal is a wait with its reason
    (ADR-0064), a crash-looping Harness is seen as it happens — and named: the Harness container's termination message
    falls back to its last log lines (`terminationMessagePolicy: FallbackToLogsOnError`), so the fault that ends the
    provision carries the Harness's own last words, and the Harness says them plainly at startup (a port another
    container in the pod took: `EADDRINUSE` names the port and the cause). No reason is invented for what a log line
    already says. And readiness proves the Harness, not the port: the probe is a GET of the Harness's own `/healthz`,
    because a pod has one network namespace and a socket probe passes for whatever listens there — the nginx that took
    `:8080` made the pod Ready and the attach met its 404 page (scaling review R16, 2026-09-30).
  - Continuity: a gone or `Lost` Sandbox is `workspace.lost` within seconds, and a Harness restart ends the Turns
    waiting on it (ADR-0021). A dropped watch is unknown, never loss; the loop re-lists and reconciles.
  - A fetch ask (ADR-0053) is answered by the watch event that carries its landing.
  - Restore (ADR-0012): the first list after start is the reconcile.
- **The Lease stays a write.** It is still the assertion that lets the operator reap an orphaned Sandbox (ADR-0001): one
  merge patch per Workspace every 5 minutes, ±20% jitter so Leases never renew in lockstep after a restart. It no longer
  carries detection.
- **The attach is a Harness call, not an exec.** The Harness runs the attach — ACL stamp, `git clone --shared` from the
  node cache, remotes, `git worktree add` — on `POST /attach { slots, branch }`, authenticated like every Harness call
  (ADR-0058). No stream per Workspace crosses the API server, and **`pods/exec` leaves the Orchestrator's RBAC**. It
  also binds work late: a pod already running receives its Repos and branch, the shape standby Sandboxes and Agent
  Substrate need.

## Considered options

- **`@kubernetes/client-node`.** Informers built in, but a large dependency tree and generated models for every kind jr2
  never touches, around kubeconfig handling in-cluster code does not need. A contained swap if jr2 ever needs exec or
  many more kinds: every call stays behind the Sandbox and Repo ports.
- **`node:https` with its own agent.** Trust scoped to this client alone, but transport code built-in `fetch` makes
  unnecessary; the Orchestrator sets `NODE_EXTRA_CA_CERTS` for nothing else.
- **Keep `kubectl`, add `kubectl get -w`.** Fixes detection, not the process per write, and adds a long-lived child per
  watch.
- **Watch Pods as well.** Two watches, and the Orchestrator interpreting pod internals the operator already reads.
- **A jr2 WebSocket API.** Nothing to add: a Kubernetes watch is already a pushed stream of events.
- **Keep the attach as exec through the new client.** The exec protocol is the hardest part of any Kubernetes client, it
  keeps one stream per Workspace through the API server, and it keeps `pods/exec`.
- **Attach from an init container.** Declarative, but it fixes the Repos and branch at pod creation, which rules out
  late binding, and it must wait on a cache that exists only after scheduling.

## Consequences

- ADR-0021 is rewritten in place: the watch answers, the Lease only asserts. ADR-0012, ADR-0004 and ADR-0053 now read
  the watch and the Harness attach. ADR-0001: the operator publishes pod facts on the Sandbox's status, and writes
  status only on change — every write is now a watch event at the Orchestrator.
- The Harness gains a route that is not about a conversation. It is jr2's own work in the container ADR-0005 gives it.
- The CLI keeps `kubectl` on the user's machine (`jr2 up`, `jr2 ssh`, ADR-0009); only the Orchestrator stops using it.
- Tests fake the client with a small HTTP server instead of a `kubectl` stub.
