# Menu-only Agents run on the Instance Harness

A workflow should be able to run an Agent whose whole job is a decision — read some inputs, pick the next event — with
no Workspace, no worktree, and no per-run pod: the statelyai/agent shape, at conversational latency, on any configured
model. jr2's Menu already _is_ that decision surface (the invoking state derives what the Agent may say —
[ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)/[ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)),
and the mechanism was already Sandbox-agnostic: `agentRun` needs only an endpoint URL, a registration may carry no
Sandbox (`tokens.ts`), and the stub Harness proved a Harness is "only a different URL". What was missing was the
hosting: the only real Harness anywhere was the one inside a Sandbox pod, so a Turn without a `workspace()` had nowhere
to run. Adopting statelyai/agent instead was rejected outright — it would be a second, weaker agent mechanism (no
Submission/Admission ledger, no re-attach, no Settlement, a menu that is not guard-narrowed) beside the one jr2 already
built.

## Decision

- **One Instance Harness per instance, deployed by convention.** `jr2 up` converges a Harness StatefulSet + Service —
  stock `jr2-harness:<kitversion>` image, same wire — whenever any Agent slot carried by a registered Machine
  (ADR-0049's walk) declares `workspace: "none"`
  ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)). The scan is static and
  definition-level, deliberately not workflow-level (workflow internals are not statically recoverable — the same line
  ADR-0018 drew for model preflight); a declared-but-never-invoked `"none"` Agent over-deploys, erring toward "the
  convention works when you need it". No config key names, sizes, addresses, or enables it.
- **Placement is definition-wins, not nearest-wins.** A `workspace: "none"` Agent's Turn runs on the Instance Harness
  _always_ — even invoked from inside a `workspace()`. It is ADR-0028's thesis extended one step: an Agent that touches
  no Workspace has no reason to run in one, and a Sandbox — torn down at its Workspace's final state, replaced after an
  eviction — is the wrong home for a conversation whose definition says it needs no Workspace. A conversation is an
  Instance ID _on one Harness_ (the server holds the history), so placement must be a function of the definition, not of
  where an invocation happens to sit; nearest-wins would make the Harness that holds a `"none"` conversation an accident
  of authoring. Definition-wins also makes "which pod's logs" a function of the Agent alone.
- **The cohesive per-run log is solved by projection, not placement.** The cost of definition-wins — decisions vanishing
  from the Workspace pod's log — is repaid by [ADR-0023](0023-the-harness-prints-the-conversation.md)'s echo: the
  enclosing Workspace's Harness prints the run's narrative (admission + pick markers for remotely-hosted Turns, Emits,
  the backfilled preamble). Instance Harness log = every `"none"` conversation, instance-wide, interleaved (the less
  useful top-to-bottom read, accepted); Workspace log = everything that ran there plus the narrative of the run that
  owns it.
- **The Instance Harness pod is Harness + Custodian — the one Harness shape, minus the Workspace.** No user container,
  no `/work` volume, no attach step. The Custodian stays although `"none"` Agents cannot execute code (the
  [ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md) rationale technically lapses):
  the Harness has exactly one route to its Menu — the Custodian on `localhost` — and forking that path for one pod buys
  a divergence in the component this ADR keeps deliberately uniform. The pod is composed by the same function a
  Sandbox's is ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)), so its Custodian holds
  the same held secrets and carries the Instance Harness's model calls the same way. Defense-in-depth is the bonus, not
  the reason.
- **No image config at all.** The Harness image was once configured as `sandbox.image` because the Sandbox pod was the
  only place a Harness ran — a misnomer once the Instance Harness exists, and config is the wrong seat regardless:
  `jr2 up` builds and resolves every image it deploys ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)), and
  the per-Workspace images (Sandbox Image, User Container) are static `workspace()` options carried by the Machine
  itself ([ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md),
  [ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md),
  [ADR-0005](0005-sandbox-pod-composition.md)). `sandbox.image`, the per-component image keys, and `operator.image`
  dissolve; the `sandbox` config section disappears until something genuinely pod-shaped and user-tunable exists.

## The Instance Harness holds a conversation as long as its run, and frees the rest

The scaling review (R11, 2026-09-30) found the `conversations` map with no delete path: every Menu-only Agent instance
of every run stayed until the pod restarted, and the restart lost every conversation at once. The research that preceded
it checked Agent Substrate's own model against the primary sources: an actor is stateful, the platform snapshots its
memory and its `DurableDir` volumes and resumes it on any worker, and its control plane holds metadata and snapshot
pointers only; memory snapshots are tied to one template version, so the state with a documented path across a code
change is a volume the actor reloads on a cold boot. These decisions take that shape.

- **A conversation is persisted to a directory, and rebuilt from it on boot.** The Harness writes each conversation as
  it goes: jr2's own record — the stream log, the Settlements, the history messages, in the wire's shapes — plus the
  engine's state as an opaque, engine-named part (pi's session through its file-backed session repo today). Rebuilding
  reads jr2's record first; an engine that cannot read the engine part (another engine, another version) continues from
  the history messages. The record is the contract; the engine part is not. A Submission in flight at the restart
  settles `failed` (the typed error `harness_restarted`, which the Agent actor reads as "Turn lost") on the rebuilt
  stream, so the Orchestrator reads a Settlement, not a 404, and the conversation's next Turn continues it.
- **Both placements persist, to different volumes.** The Instance Harness to a PersistentVolumeClaim of its own; a
  Sandbox's Harness to an emptyDir mounted into the Harness container alone (the User Container must not read it), so a
  Harness container that restarts inside a living pod keeps its conversations. A pod that is gone takes the emptyDir
  with it — that Workspace is `Lost` (ADR-0021), and no conversation persistence should say otherwise.
- **The Instance Harness is a StatefulSet of one, with a per-ordinal volume.** The value is the stable volume; the
  stable name is what N > 1 would pin a conversation to (the admission ledger already records its endpoint). N is a kit
  value, 1 until a measured need; never an HPA, which would kill conversations on a scale-down and land a continuation
  on a replica that never saw it. A rollout at N = 1 has no surge, so admissions are refused while the new pod starts;
  the Orchestrator already absorbs an admission refused at the connection (ADR-0042), so a rollout delays a Turn and
  faults nothing.
- **A rollout drains Turns.** On SIGTERM the Harness stops admitting, finishes the Turns it holds (the queued ones too),
  then exits; the termination grace is a Turn's worst case. It refuses an admission with a 503 before it reads or queues
  anything, and closes that connection, so the Orchestrator re-sends it on ADR-0042's ladder and the re-send dials the
  Service anew. Readiness stays up (the probe is the socket), and the dialed Service is a ClusterIP one, which
  kube-proxy still routes to a terminating pod that serves while no other is ready — so reads keep answering and a
  `wait` on the draining pod still reads its Settlement. A headless name would not: DNS stops naming a terminating pod,
  so the StatefulSet's headless governing Service is a second one, dialed by no one. The Custodian is a native sidecar,
  stopped only after the Harness exits, so the drain keeps its Menu and its model to the end. A deploy loses no Turn
  and, with the volume, no conversation — as long as the drain and the replacement's start fit ADR-0042's window; a
  longer one faults the waiting admission with the Harness's own 503 words.
- **The Orchestrator states the live set; the Harness frees the rest.** After every restore and every 5 minutes (the
  Lease's cadence) the Orchestrator tells the Instance Harness which conversations its live runs hold — from the
  admission ledgers in memory, never from the store — and the Harness frees memory and files of every other one.
  Level-triggered, idempotent, a missed statement costs nothing, and a crashed Orchestrator's leftovers go at its next
  boot. No idle TTL: a run parked on a Gate for a day keeps its conversation, and nothing else can decide that. A
  Sandbox's Harness is not told; its Workspace's teardown frees everything.
- **The Orchestrator keeps holding handles only** (ADR-0007): no conversation state crosses to it. Storing sessions
  centrally and re-sending them to a fresh pod was considered and rejected — it is the design Substrate does not have,
  and it puts every Menu-only Turn's history on the single writer's path.

## Considered options

- **statelyai/agent (or any in-process decision actor).** Rejected above; the long form: every ADR from 0011 to 0029
  would stop being the single story of how models drive Machines, and the copy would be the lesser one — its picks
  bypass the Menu's guard-narrowing, its runs bypass the admission ledger, its failures bypass Settlement.
- **Unconditional ambient fallback** (no enclosing `workspace()` → Instance Harness, for every Agent). Rejected: a coder
  invoked outside its `workspace()` by mistake would run bash in the shared pod instead of failing loudly — precisely
  the mistake today's error catches. The fallback is gated on `workspace: "none"`; everything else keeps the loud error,
  now sharper ("agent `x` has `workspace: "write"` — invoke it inside a `workspace()`").
- **Nearest-wins placement** (a `"none"` Agent invoked inside a `workspace()` runs on that Workspace's Harness).
  Genuinely attractive — the Workspace pod log stays the one coherent story with zero new mechanism — and rejected on
  the continuation amnesia above plus three lesser costs: decisioner turns die with workspace churn, share limits with
  builds, and scatter one Agent's history across pods. The log story it bought is recovered by ADR-0023's echo.
- **On-demand pod per workspace-less run.** Rejected: pays pod-start latency on the path whose whole point is a fast
  pick.
- **Hosting the Turn in the Orchestrator process.** Rejected: no pod logs, and it crosses the line the architecture
  draws hardest — the Orchestrator holds handles; models act remotely.
- **A host-local dev Harness.** Considered as a dev story and dropped when the premise died:
  [ADR-0019](0019-one-converging-command-against-the-current-context.md) removed `jr2 dev` — there is no host dev mode
  to serve. Local development of a decisioning workflow is `jr2 up` against kind, where the Instance Harness converges
  like everything else; an instructions tweak rides the next admission, no image build. The stub Harness keeps its one
  job: a test fixture reached by explicit `endpoint`.

## Consequences

- **The Agent actor's resolution grows one arm**: explicit `endpoint` (tests) → `workspace: "none"` → Instance Harness
  (deterministic Service DNS) → enclosing `workspace()`'s ambient handles → loud error naming the definition's
  `workspace` value.
- **A `"none"` conversation survives the Instance Harness pod's restart**: the StatefulSet restores the endpoint and the
  volume restores the history. A Turn in flight at the restart settles `failed`; nothing is continued silently.
- **An instance with no `"none"` definitions deploys nothing new.** The feature is invisible until the first
  `agent({ ..., workspace: "none" })` a Machine carries, which is its entire user-facing surface.
- **The harness conformance suite (ADR-0027) gains the Menu-only shape**: a Turn whose definition withholds every
  Working tool, settled by pick alone — no infra, same scripted provider.
- **CONTEXT.md**: Harness's "inside a Sandbox" loosens to name the second placement; **Instance Harness** becomes a
  glossary term.
