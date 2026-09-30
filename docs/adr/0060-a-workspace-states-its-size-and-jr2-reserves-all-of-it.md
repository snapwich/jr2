# A Workspace states its Size, and jr2 reserves all of it

No jr2 pod asked Kubernetes for anything. `Sandbox.spec.resources` existed and nothing filled it; the Custodian, the
Instance Harness and the Orchestrator set nothing either. Every pod was BestEffort, so the scheduler packed Sandboxes
without limit, the cluster autoscaler saw no demand, and a full cluster showed up as OOMKill and eviction instead of
Pending — an eviction takes `/work` with it (ADR-0021). The scaling review (2026-09-27) and a lab of real workloads on
the home cluster (2026-09-28: Playwright, `tsc` + vitest on hono, `cargo build` of ripgrep; one run each) measured what
a Sandbox uses. The owner plans to move Workspaces onto Agent Substrate later, so the shape is chosen to move there
unchanged.

## Decision

- **A Workspace states one Size: a ceiling for its whole Sandbox, cpu and memory, nothing else.** The shape is Agent
  Substrate's `ActorTemplate.resources`: a Kubernetes `ResourceRequirements` of which only `limits.cpu` and
  `limits.memory` are accepted; `requests` and any other key are refused where they are read.
  `workspace(body, { resources: { limits: { memory: "3Gi", cpu: "2" } } })`.
- **The Size is a fact of the Machine**, like its Sandbox Image (ADR-0037, ADR-0049): the author knows the toolchain,
  the runner, the worker count. It is never per run. The resolution chain, most specific first:
  `customize(machine, { resources })` (the composer, whose Repo may be bigger than the author's) → the `workspace()` →
  `sandbox.resources` in `jr2.config.ts` (the Instance's default, applied **only** to a Workspace that states none —
  never an override of a stated Size, so each fact has one override path) → the kit default.
- **jr2 reserves the whole Size.** Memory request = limit and cpu request = limit: the Sandbox pod is Guaranteed. Memory
  pressure never picks a Workspace, and placement accounts the way Substrate's does. Density is paid for here and
  recovered later by suspend (the scaling review's R15), not by overcommit.
- **The CPU limit is enforced.** Nothing reads a CPU request (the cgroup shows `cpu.max = max`), while Node's
  `availableParallelism`, Go 1.25, Rust and cargo, the JVM, .NET and every Substrate runtime read the limit. Throttling
  is the accepted cost.
- **Tools that read neither the limit nor affinity get hints**, from the Downward API (`limits.cpu`, divisor 1):
  `JR2_CPUS`, `OMP_NUM_THREADS` (which also makes `nproc` answer N), `PYTHON_CPU_COUNT`, `GOMAXPROCS`. `os.cpus()` still
  reports the node, and Playwright sizes its workers from it alone, so a Machine passes `--workers=$JR2_CPUS`; the Agent
  is told its CPU count by the Briefing ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)), never
  by the Frame.
- **jr2 splits the Size inside the pod.** The Custodian takes a fixed kit slice (64Mi, 50m). The User Container takes
  its split if the Machine states one — `user` widens from a string to
  `{ image, resources?: { limits: { memory?, cpu? } } }` (ADR-0005 foresaw the widening) — and otherwise shares the pod
  budget with no limit of its own. The Harness container gets the rest as its own limit, so an OOM stays per container
  where it can. Pod-level resources (KEP-2837) hold the whole-pod ceiling. A server with the PodLevelResources gate off
  drops them without a word, so `jr2 up` dry-runs a pod that states them and refuses the cluster when they are gone.
  `jr2 up` refuses a split that leaves the Harness below its floor (256Mi) and names the line.
- **Kit numbers.** Default Size: memory 2Gi, cpu 1. Node gives each process a V8 heap of about 55% of its container
  limit, and hono's `tsc` aborted with a heap error below about 1.1Gi, so 1Gi fails a common task. 2Gi covers `tsc` +
  vitest, `cargo build` and Playwright at 2 workers; Playwright at 4 workers and large monorepos state a Size. No
  `NODE_OPTIONS` heap raise: a V8 abort is a tool error the Agent reads, while a bigger heap turns it into a kernel
  kill.
- **`/dev/shm` is a memory-backed emptyDir in the Harness container only**, `sizeLimit` = 25% of the Harness share
  (minimum 64Mi). It reserves nothing extra (shm is charged inside the Harness limit), and a full shm is ENOSPC or
  SIGBUS — a tool error, never an OOM (lab). The Harness clears it at start: shm files outlive a container restart and
  stay charged to the pod, which crash-looped the restarted container in the lab. There is no `shm` field; a Machine
  that needs more raises its Size.
- **`/work` disk is a kit-fixed ephemeral-storage request of 10Gi on the Harness container, with no cap.** The request
  places the pod and ranks it last under node disk pressure; no `sizeLimit` and no limit, because passing one evicts the
  pod and loses `/work` (T12). Disk is not part of the Size: Substrate's template size is cpu and memory only.
- **Priority.** `jr2 up` creates two cluster-scoped PriorityClasses beside the CRDs: `jr2-control` (100000,
  PreemptLowerPriority) for the Orchestrator, the operator and the Repo cache agent — small, fixed and needed by every
  Sandbox; `jr2-sandbox` (1000, preemptionPolicy `Never`) for Sandboxes and the Instance Harness — a pod of ordinary
  priority cannot preempt a live Workspace, and a waiting Sandbox evicts nobody. Both stay far below the system classes.
  A cluster with its own scheme names its classes in `priorityClasses: { control?, sandbox? }`.
- **Voluntary disruption.** A Sandbox pod and the Instance Harness pod carry
  `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` and `karpenter.sh/do-not-disrupt: "true"`: moving either
  loses work (`/work`; live conversations). The Orchestrator, the operator and the Repo cache agent carry neither — a
  restarted Orchestrator re-attaches (ADR-0007). No PodDisruptionBudget: `maxUnavailable: 0` blocks node upgrades
  without end. A drain ends in `workspace.lost`, and the body's policy decides (ADR-0021).
- **jr2's own pods are kit-sized, with no config key**: memory request = limit, a CPU request, no CPU limit (a
  provisioning burst needs CPU, and no Substrate move applies to them). Orchestrator 500m / 1Gi. Instance Harness 250m /
  1Gi (it frees every conversation no live run holds — ADR-0031). Operator 50m / 256Mi (it caches every Pod in the
  cluster). Repo cache agent 50m, memory request 128Mi and limit 1Gi — the one exception, since `git index-pack` spikes
  and its OOM costs only a refetch.

## Considered options

- **Sizes as named classes in `jr2.config.ts`, which the Machine names** (`workspace(body, { class: "browser" })`, the
  config maps the class to resources). Rejected: it breaks packaging. Two packages each name `browser` and mean
  different sizes, and the consumer must supply numbers only the package's author knew. ADR-0052's named class stays
  placement only — node labels are the cluster's facts; a memory need is the Machine's.
- **Raw `ResourceRequirements`, all of it.** Rejected: the author could set a request below the limit, leave out the
  memory limit, or reach fields Substrate refuses, and a Machine would depend on something the move drops.
- **A jr2 shape** (`{ memory, memoryLimit?, cpu }`). Rejected for the same reason in the other direction: one more
  translation at the move, for no gain the Substrate subset does not give.
- **Burstable: reserve the working peak, allow bursts to the limit.** About twice the density. Rejected: with no
  suspend, several Workspaces bursting at once is node pressure, and pressure evicts a whole pod with its `/work`.
- **Reserve CPU, never throttle.** Chosen first, then reversed: no mechanism tells a tool its CPU request (the lab tried
  affinity, CPU Manager, LXCFS, gVisor, Kata and `LD_PRELOAD` shims; all but affinity need a limit, and affinity misses
  `os.cpus()` and lets pods pin the same cores), while every container-aware runtime reads the limit.
- **An `shm` field, or a `/work` disk field, on the Size.** Deferred: Substrate has neither. A jr2 field beside the Size
  can come when a real Machine needs one.
- **`/dev/shm` without a `sizeLimit`, or the container's 64Mi default.** Rejected: unbounded, a full shm OOM-kills the
  container and poisons its restart; 64Mi crashed Chromium renderers when Playwright's `--disable-dev-shm-usage` was
  off.

## Consequences

- ADR-0005 is rewritten in place: containers now carry limits from the Size, the User Container may take a split, and
  `/dev/shm` joins the Harness container's mounts.
- ADR-0052 gains `sandbox.resources` beside `nodeSelector` and `tolerations`; its reserved named class stays placement
  only, so its `node:` name stays.
- An OOM in the Harness container still kills the Harness with the Agent's processes (cgroup v2 group kill). Containing
  it is ADR-0061.
- A Workspace parked on a Gate holds its whole Size. That is the density problem R15 exists for.
- On a move to Substrate, a Workspace with a User Container split needs a microVM pool: Substrate accepts per-container
  limits on microVM runtimes only, and gVisor refuses them.
- `jr2 up` warns — never refuses — when no current Sandbox node could hold a Workspace's Size (the ADR-0052 stance: the
  node set moves).
- CONTEXT.md gains **Size**.
