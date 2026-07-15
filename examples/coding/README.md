# example-coding — the jr-parity workflow

`workflows/coding.ts` models [jr](https://github.com/snapwich/jr)'s `start-work` orchestration as a j2 Machine. It began
as a **validation exercise** — can j2 express an existing user workflow faithfully, not a redesign of it — and the API
gaps it exposed drove the workflow-API redesign (ADR-0015..0017, full record in
[docs/design/workflow-api/](../../docs/design/workflow-api/proposal.md)). This is the file on the settled surface: ~200
lines, every one of them workflow.

**Status: the j2 side is done; the workflow-owned side is sketched.**

- **The Machine is real.** It imports, typechecks, and registers against a live orchestrator; `j2 visualize coding`
  renders the whole tree statically — the pool's discovering/parked loop, the spawned worker, the workspace wrapper, and
  the body where the pipeline actually lives.
- **It does not do the work yet.** What is still a sketch is _the workflow's own_ code, not j2's: the tk actors
  (`claimNextTask`, the source's `next`) return empty results rather than parsing `tk ready`, and `openPr`/`pushBranch`
  throw. It also needs a Sandbox backend to run for real (`workspace()` faults without one — `j2 cluster up`). The
  blocker behind the tk actors is a **consistency loop**, not code volume: the orchestrator's tk actors and the
  architect's in-Sandbox tk edits must see each other's writes. That open note is at the bottom of `coding.ts`.

So: read it as the reference for how a real workflow is shaped, run it as far as the sketches allow.

## The shape (ADR-0015..0017)

- **Six statically-imported names**: `defineEvent`, `j2Setup`, `agentRun` + `gate` (pre-registered, invoked by name),
  `workspace`, `pool`/`source`. The module contract is `export const machine` — the vocabulary rides the machine object.
- **Events are the workflow's vocabulary**; `audience` tags who may deliver. A state that invokes `agentRun` gets the
  agent-events its transitions handle as its Agent's tool menu; a `gate` state gets the external set the same way. MCP
  appears nowhere.
- **`agentRun` takes `{ agent, prompt }`.** Sessions are FRESH by default (jr's lossy handoff); `session: "continue"`
  opts into one conversation traveling across states. Endpoint and Sandbox resolve ambiently from the enclosing
  `workspace()`; infra retries live in flue, silence gets a budgeted nudge, and the workflow sees ONE terminal
  `agent.fault { reason }`.
- **`workspace(body, spec)` owns Sandbox lifecycle only** and hands the body `{ workdir, repos, branch }`. Getting
  commits out (push + PR before human review) is the workflow's business. A body that parks keeps its Sandbox alive —
  that _is_ the retain policy.
- **`pool(feature, { source, itemId, cap, … })` is the top of the run**: one body per ready item under a cap, wake on
  push (`work_ready` via the standing `source` gate) or poll, and three-valued terminal triage — drained (jr exit 0),
  deadlocked (exit 2), waiting on parked gates (exit 3, the run stays open).
- **The ticket system stays jr's tk**, hierarchy unchanged. The workflow owns plain tk actors; the ready-set is
  re-queried, never materialized (the Source port's semantics).

## jr semantics preserved

Bounded worker pool (`maxConcurrent`), one feature = one workspace = one branch, linear task chains (sequentiality is
machine structure — the worktree lock is gone), coder→reviewer rounds with a cap and a fresh cycle per task, architect
feature review (with tk in-Sandbox to reopen/re-chain tasks; counter resets on APPROVED, human rework starts a fresh
cycle), fresh agent sessions per turn, escalation that PARKS the environment for the human who must fix it (best-effort
branch publish first), human gate as a parked durable state (jr's exit 3), run termination + deadlock detection (exits
0/2).

## Deliberate changes from jr

Human review is PR-based (`openingPr` pushes the branch and opens the PR before the gate), so
`merge-all`/`rebase-feature` move to the forge; rate-limit handling is Harness/flue infra; the investigator persona is
deferred (it slots in later as a consumer-authored triage state on the `agent.fault` route, receiving the reason).
