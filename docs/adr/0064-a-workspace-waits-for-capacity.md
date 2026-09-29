# A Workspace waits for capacity

Since ADR-0060 a Sandbox reserves its whole Size, so a full cluster shows as a Pending pod, not as eviction. But the
provision's 120-second budget started at the CR's write, so time spent Unschedulable used it up: the run errored, and
the CR, pod and Secret stayed until the operator's idle GC. A burst of 10 Workspaces at 500m each on the home cluster
(2026-09-29) placed 2; the other 8 errored at 120s and left Pending pods behind, one of which could take a node later
for nobody. Worse, the Lease was renewed only in `running`, so the operator counted creation as the Lease and would reap
a Sandbox that waited past its 30-minute idle timeout. The scaling review asked two more questions: should jr2 cap live
Workspaces for the Instance (R4), and concurrent Turns per model provider (R5)?

## Decision

- **A Sandbox with no node waits, and jr2 sets no deadline on the wait.** jr2 cannot tell "full now" from "never fits":
  the cluster autoscaler, a finished neighbour or a drain can each make room, and the node set moves (ADR-0052).
  `jr2 up` already warns when no node could hold a Size (ADR-0060). A Machine that wants a bound puts `after` on the
  state that holds the Workspace; stopping it is the body's policy, as for `workspace.lost` (ADR-0021).
- **A quota refusal is the same wait.** A ResourceQuota (or Kueue) is the cluster owner's tool; jr2 neither writes one
  nor replaces it. The operator publishes the refusal on the Sandbox's status and keeps retrying the pod create.
- **The Workspace Machine has a state for the wait: `placing`**, before `provisioning`. `placing` writes the CR and
  waits for the pod to be scheduled, with no deadline. `provisioning` waits for `Ready` under the 120-second budget,
  which now measures only what jr2 controls: the image pull, the Harness start and the Repos. A restart re-enters
  `placing`: the apply is idempotent and the watch's first list answers at once (ADR-0063).
- **The wait is visible; its reason is behind the token.**
  - The state is structure, so the Console lights `placing` and `observe()` carries it with no new field.
  - The authenticated `RunStatus` gains `waiting: [{ child, on: "node" | "quota", message, since }]`. `message` is the
    scheduler's or the quota's own words, which can name nodes and taints. `jr2 status <run>` prints it.
  - The feed has two lines per wait: when it starts, with the reason, and when it ends ("placed after 3m12s"). A changed
    reason updates `waiting`; it adds no feed line.
  - `jr2 runs` marks a run that has a Workspace in `placing`.
  - The Machine receives no event: scheduling detail is not the body's concern, and `after` covers a bound.
- **The Lease covers the Sandbox from its write to its teardown**, in every state, so the idle GC reaps only what the
  Orchestrator has abandoned (ADR-0001).
- **Delete what never ran; keep what ran.** A Sandbox whose wait ends without a node — a parent `after`, a stopped run,
  a faulted run — is deleted at once: nothing on it can be inspected, and left alone it could take a node later. A
  Sandbox that was placed and then faulted keeps ADR-0021's rule: it stays inspectable (logs, `jr2 ssh`) and ages out at
  the idle timeout.
- **jr2 caps nothing of its own.** Not live Workspaces (R4), not concurrent Turns per provider (R5). See the options.
- **A provider's refusal is named.** A Turn that ends because pi ran out of retries has a fault reason with the fixed
  prefix `provider limit`, as a memory kill has `memory limit` (ADR-0061), so `jr2 status` and the Machine can tell
  provider pressure from a bug.

## Considered options

- **Keep a deadline on the wait, or make it a config value.** Rejected: any number either faults a Workspace the
  autoscaler was about to place or waits for one that never fits, and the Machine's own `after` already states the
  body's bound where the body can act on it.
- **An Instance-wide cap on live Workspaces (`sandbox.max`)**, first come first served, persisted: Agent Substrate's
  request parking in jr2's terms. Rejected: a count of Workspaces of mixed Sizes is not a measure of resources. A spend
  ceiling is a ResourceQuota on `requests.cpu` and `requests.memory`, exact in resource units and refused before any pod
  exists, so the autoscaler never scales for it. Placement order among Pending pods of one priority is not promised, and
  nothing in jr2 needs strict order. Substrate's parking is driven by capacity, not a count.
- **An Instance-wide cap on concurrent Turns per provider (R5).** Rejected:
  - A Turn is the wrong unit: it is many model calls with tool runs between them, and a slot held while `tsc` runs
    blocks the provider while it has nothing to do.
  - A fixed number is the wrong measure: hosted providers limit tokens and requests per minute, vLLM by batch and KV
    cache.
  - The wait already happens in the right place: vLLM queues in arrival order, and pi retries 429, 503 and overload with
    backoff, honors `retry-after`, and does not retry quota exhaustion (pi-ai 0.82.1). The scaling review measured slow
    Turns at 40 concurrent (about 90s against 14s alone), which is throughput a cap cannot add, and no failed ones.
  - A slow provider cannot make a Runaway: ADR-0035 counts steps and repeats, not time.
  - If a hosted provider's 429 storm is ever measured, the answer is shared backoff at the Custodian (Envoy's global
    rate limit), not a Turn count.
- **Watch for a Pending pod from the Orchestrator.** Rejected by ADR-0063: the operator reads the pod and publishes the
  scheduling condition.

## Consequences

- ADR-0012's lifecycle gains `placing`. ADR-0021: the Lease is no longer only in `running`, so "attach must stay well
  inside the idle timeout" goes away. ADR-0001: the operator publishes a quota refusal like an Unschedulable pod.
- A Workspace parked in `placing` holds no node, only a CR and a Secret. A Workspace that waits a long time still holds
  its run's place in any `pool()`: the Pool's cap is the Machine's own concurrency policy.
- CONTEXT.md gains **Placing**, and **Lease** covers the Sandbox's whole life.
