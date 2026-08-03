# Menu-only Agents run on the Instance Harness

A workflow should be able to run an Agent whose whole job is a decision — read some inputs, pick the next event — with
no Workspace, no worktree, and no per-run pod: the statelyai/agent shape, at conversational latency, on any configured
model. j2's Menu already _is_ that decision surface (the invoking state derives what the Agent may say —
[ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)/[ADR-0029](0029-a-menu-offers-what-the-machine-will-accept-and-a-pick-that-moves-nothing-says-so.md)),
and the mechanism was already Sandbox-agnostic: `agentRun` needs only an endpoint URL, a registration may carry no
Sandbox (`tokens.ts`), and the stub Harness proved a Harness is "only a different URL". What was missing was the
hosting: the only real Harness anywhere was the one inside a Sandbox pod, so a Turn without a `workspace()` had nowhere
to run. Adopting statelyai/agent instead was rejected outright — it would be a second, weaker agent mechanism (no
Submission/Admission ledger, no re-attach, no Settlement, a menu that is not guard-narrowed) beside the one j2 already
built.

## Decision

- **One Instance Harness per instance, deployed by convention.** `j2 up` converges a Harness Deployment + Service —
  stock `j2-harness:<kitversion>` image, same definitions ConfigMap, same wire — whenever any discovered Agent
  definition declares `workspace: "none"`
  ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)). The scan is static and
  definition-level, deliberately not workflow-level (workflow internals are not statically recoverable — the same line
  ADR-0018 drew for model preflight); a declared-but-never-invoked `"none"` Agent over-deploys, erring toward "the
  convention works when you need it". No config key names, sizes, addresses, or enables it.
- **Placement is definition-wins, not nearest-wins.** A `workspace: "none"` Agent's Turn runs on the Instance Harness
  _always_ — even invoked from inside a `workspace()`. The deciding scenario is conversation continuation: a
  conversation is an Instance ID _on one Harness_ (the server holds the history), and a run-scoped advisor is exactly
  the Agent one continues across workspace boundaries. Nearest-wins would route the same `(agent, iid)` to a different
  server mid-conversation — silent amnesia, indistinguishable from a bad model — or to a pod that no longer exists.
  Definition-wins makes the hazard structurally impossible for the Agents most likely to hit it, and makes "which pod's
  logs" a function of the Agent alone.
- **The cohesive per-run log is solved by projection, not placement.** The cost of definition-wins — decisions vanishing
  from the Workspace pod's log — is repaid by [ADR-0023](0023-the-harness-prints-the-conversation.md)'s echo: the
  enclosing Workspace's Harness prints the run's narrative (admission + pick markers for remotely-hosted Turns, Emits,
  the backfilled preamble). Instance Harness log = every `"none"` conversation, instance-wide, interleaved (the less
  useful top-to-bottom read, accepted); Workspace log = everything that ran there plus the narrative of the run that
  owns it.
- **The Instance Harness pod is Harness + Adapter — the one Harness shape, minus the Workspace.** No user container, no
  `/work` volume, no attach step. The Adapter stays although `"none"` Agents cannot execute code (the
  [ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md) rationale technically lapses): the Harness has exactly one
  menu-delivery path — an Adapter on `localhost` — and forking that path for one pod buys a divergence in the component
  this ADR keeps deliberately uniform. Defense-in-depth is the bonus, not the reason.
- **Image config consolidates into `images`.** The Harness image was configured as `sandbox.image` because the Sandbox
  pod was the only place a Harness ran — now a misnomer. `j2.config.ts` gains one block naming all composed images:
  `images: { harness, adapter, operator, user }` — the kit three defaulting to published `<kitversion>` tags (overridden
  only in kit dev), `user` defaulting to absent (no user container). `sandbox.image`, `sandbox.adapterImage`, and
  `operator.image` dissolve into it; the `sandbox` config section disappears until something genuinely pod-shaped and
  user-tunable exists.

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
  [ADR-0019](0019-one-converging-command-against-the-current-context.md) removed `j2 dev` — there is no host dev mode to
  serve. Local development of a decisioning workflow is `j2 up` against kind, where the Instance Harness converges like
  everything else; an instructions tweak is a ConfigMap update, no image build. The stub Harness keeps its one job: a
  test fixture reached by explicit `endpoint`.

## Consequences

- **`agentRun`'s resolution grows one arm**: explicit `endpoint` (tests) → `workspace: "none"` → Instance Harness
  (deterministic Service DNS) → enclosing `workspace()`'s ambient handles → loud error naming the definition's
  `workspace` value.
- **A `"none"` conversation must not be continued if the Instance Harness pod restarts** — same live-only contract as
  every conversation (ADR-0023): the Deployment restores the endpoint, not the history.
- **An instance with no `"none"` definitions deploys nothing new.** The feature is invisible until the first
  `defineAgent({ ..., workspace: "none" })`, which is its entire user-facing surface.
- **The harness conformance suite (ADR-0027) gains the Menu-only shape**: a Turn whose definition withholds every
  Working tool, settled by pick alone — no infra, same scripted provider.
- **CONTEXT.md**: Harness's "inside a Sandbox" loosens to name the second placement; **Instance Harness** becomes a
  glossary term.
