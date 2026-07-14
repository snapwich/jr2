# example-coding — the jr-parity workflow

`workflows/coding.ts` models [jr](https://github.com/snapwich/jr)'s `start-work` orchestration as a j2 Machine. It began
as a **validation exercise** — can j2 express an existing user workflow faithfully, not a redesign of it — written
against the API j2 _should_ have, with every `GAP(n)` marker naming a mechanism j2 lacked.

**Status: the j2 side is done; the workflow-owned side is sketched.**

- **The Machine is real.** All five gaps landed (the legend at the bottom of the file records which commit closed each),
  so it imports, typechecks, and registers against a live orchestrator. `j2 visualize coding` renders it — including
  `featureWorkspace` and its body, the child machines where the pipeline actually lives.
- **It does not do the work yet.** What is still a sketch is _the workflow's own_ code, not j2's: the tk actors
  (`claimNextFeature`, `claimNextTask`, `backlogCount`) return empty results rather than parsing `tk ready`, and
  `openPr` throws. It also needs a Sandbox backend to run at all (`workspace()` faults without one — `j2 cluster up`).
  The blocker behind the tk actors is a **consistency loop**, not code volume: the orchestrator's tk actors and the
  architect's in-Sandbox tk edits must see each other's writes. That open note is at the bottom of `coding.ts`.

So: read it as the reference for how a real workflow is shaped, run it as far as the sketches allow.

## The settled model (grill session, 2026-07-11)

- **j2 ships mechanisms, zero policy.** No built-in events: `defineEvent` lets the workflow declare its own
  (`request_review`, `approve`, …); j2 provides definition, transport, validation, and delivery only.
- **Events bind to states via the actor that exposes them.** The agent actor registers its `tools` as MCP tools for its
  iid — handlers close over that invocation's `sendBack`, so a tool call fires a transition on exactly the state that
  invoked the agent. `gate` is the same primitive over HTTP for any external caller — humans, webhooks, CI — each
  invocation an addressable gate resource (`{ gate, accepts, meta }` → `POST /runs/:id/gates/:gate/events` → that
  state). No routing layer exists; binding is the closure. The shared HTTP listener with per-iid paths is a transport
  detail.
- **Everything is statically imported.** Actor logic is code; anything live is constructed per-invocation from
  serializable input (flue client from `input.endpoint`, k8s client from ambient config). No kit injection, no
  `defineWorkflow` wrapper — the module contract is all named exports: `export const machine` plus
  `export const events`, the workflow's declared vocabulary (event names are scoped per-workflow).
- **`workspace(body, spec)` owns workspace concerns only**: provision the Sandbox, attach the spec'd repos/worktree,
  hand the body `{ endpoint, workdir, repos, branch }`, destroy when the body reaches final. Getting commits out (push +
  PR before human review) is the workflow's business. A body that parks keeps its Sandbox alive — that _is_ the retain
  policy.
- **The ticket system stays jr's tk**, hierarchy unchanged. The workflow owns plain tk actors; the ready-set is
  re-queried, never materialized.

## jr semantics preserved

Bounded worker pool (`maxConcurrent`), one feature = one workspace = one branch, linear task chains (sequentiality is
machine structure — the worktree lock is gone), coder→reviewer rounds with a cap, architect feature review (with tk
in-Sandbox to reopen/re-chain tasks), budgeted fault retries (resume via flue instance-id + offset re-attach),
escalation per-ticket and non-halting, human gate as a parked durable state (jr's exit 3), `emit("attention")` as jr's
terminal bell.

## Deliberate changes from jr

Human review is PR-based (`openingPr` pushes the branch and opens the PR before the gate), so
`merge-all`/`rebase-feature` move to the forge; rate-limit handling is Harness/flue infra; the investigator persona is
deferred (v1 = budgeted blind retry on `agent.fault`).
