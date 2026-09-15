# Control events are workflow-defined and delivered by closure, not routed

Two decisions, out of the jr-parity design exercise: **j2 ships the event mechanism and zero events**, and **an event
binds to a Machine state through the actor that exposes it** — delivery is a closure created at invoke time, so no
routing layer exists anywhere.

## `defineEvent`: mechanism, not policy

`defineEvent({ name, input, audience?, semantics? })` produces a pure-data definition: a name, a zod input schema (flat
tagged objects, never `oneOf` — the ADR-0006 encoding rule), an optional audience tag (`agent` | `external` | `any`,
ADR-0015), and an optional semantics tag (`ack` | `deferred` | `poll`). It is a **pure factory — no import-time side
effects, no global registry**. Because actor **inputs are serializable** (ADR-0007) they carry event _names_, so
resolution needs a name→def scope; that scope is **per-Machine**: `j2Setup` takes the defs as values and attaches the
vocabulary to the machine (ADR-0015 — discovery reads it there; the module contract is `export const machine` alone),
and `gate`/`agentRun` resolve names against **the Machine that invoked them** — `self._parent.logic`, public xstate API
— never a run-wide set. Names are local to their Machine: `coding`'s `approve` and `release`'s `approve` may differ, and
one run may hold both, because a Machine nested inside another resolves against its own defs and no map is ever merged.
That is what makes a Machine composable by plain `invoke` (ADR-0049): the importing Machine neither re-declares nor sees
the nested one's events, and `workspace()`/`pool()` propagate nothing. An unlisted name fails at invoke time with an
error naming the Machine and its declared set. The attachment is keyed on the machine's `config`, which xstate's
`.provide()` passes through unchanged, so the host's per-run provide and a test's `.provide()` both keep it. We rejected
a global name registry (import = registration): it couples every workflow in an instance — and any future
npm-distributed one — through one namespace, and attribution can't be inferred at import time. We also retired the
run-scoped set this ADR first specified (`RunBinding.events`, the root's vocabulary): it made every nested Machine's
events the root's problem to re-declare, and turned a same-name-different-payload pair into a collision that the
per-Machine defs had already avoided.

`defineEvent` also carries the TypeScript side: `j2Setup` derives the machine's event union from the defs — one source
of truth, no schema/type drift, and the machine stays fully typed for xstate tooling.

There is no j2-blessed event vocabulary. `request_review`, `review_verdict`, `approve` are the _coding workflow's_
words; another workflow defines others. j2 owns only definition, transport, validation, and delivery.

## Agent side: invoke-scoped registration, delivery via `sendBack`

On start, the `agentRun` actor registers, for its instance id, a toolset — the menu derived from its invoking state's
transitions (ADR-0015) — whose handlers **close over that invocation's `sendBack`**; on stop it deregisters. A tool call
→ validate against the named schema → `sendBack` a typed event → the event lands on **the state that invoked the agent**
(bubbling to ancestor states per statechart semantics — a machine can handle a `report_blocked`-style event once at its
root). The binding _is_ the closure.

- **No routing.** There is no instance→actor table and no workflow-side forwarding boilerplate; delivery works at any
  nesting depth (workspace wrappers, pool children) with zero authored code.
- **State-scoped menus for free.** A transition swaps actors, which swaps registrations; the surface an Agent sees is
  exactly the live registration.
- **One catch point.** A call for an unregistered iid (settled run, exited state) is rejected at the demux.

**Transport: the Agent's registration is served from the Sandbox** (ADR-0013). The Orchestrator speaks no MCP: it serves
`GET /agents/:iid/surface` + `POST /agents/:iid/events` under the Sandbox token, and the pod's Adapter renders that as
the MCP server the Agent's Harness connects to on `localhost` (`…/mcp/<iid>` — the Harness re-lists tools per Submission
(ADR-0013), so the iid in the path is all the addressing needed). Lookup, validation, delivery, and lifecycle stay
implemented once, in the registration table.

## External side: the same primitive over HTTP (`gate`), and each gate is a resource

`gate` is the symmetric actor for **every non-agent caller** — humans (`j2 send`, a UI), webhook translators, CI, other
systems. "Human" is policy, not mechanism, so the actor is not named for one caller. Each invocation is an addressable
**gate**: input is `{ gate?, meta? }` — `gate` an optional authored id (the id is derived when absent — below), `meta`
serializable caller/integration context (PR URL, title); its accepted set derives from the gated state's transitions
(ADR-0015). Registration is per-gate: `GET /runs/:runId` lists open gates (`{ gate, accepts (names + schemas), meta }`),
`POST /runs/:runId/gates/:gate/events` validates the body against the named schema and delivers via `sendBack` into the
gated state, and leaving the state destroys the gate. Gate ids are **run-scoped by mechanism** (the same `system`→run
mapping that scopes event resolution), so `gate: "F-12"` in two concurrent runs cannot collide.

Gate-as-resource is forced by concurrency: several children park simultaneously (three features in `humanReview` is the
_normal_ case), all accepting `approve` — a run-level POST is ambiguous. And every real external surface already thinks
in gates: a CLI listing shows pending decisions and acts on one; a UI inbox renders one card per gate (schemas drive the
forms, `meta` drives the copy); a forge webhook translator finds its gate by matching `meta` (e.g. `prUrl`), which is
why `meta` exists. Generalizing beyond humans also closes a hole hard-coded event types left: a push seam like "a
work-source webhook wakes discovery" is just an idle state holding a gate accepting `work_ready` (the `wake` seam of
ADR-0017). Two obvious later additions, both deferred: a cross-run inbox (`GET /gates`), and CLI segment-matching over
derived gate ids (`--gate F-12` resolving an unambiguous segment, git-style like run-id prefixes).

**The gate id is derived; authoring one is the exception.** Absent an authored `gate`, the id is the gate actor's own
path below the run root, and j2Setup's menu-derivation walk names an unnamed gate invoke with its state key path so the
leaf segment is readable — `F-12.body.humanReview`, not xstate's `0.body.humanReview` default. This is unique wherever
concurrently live siblings have distinct actor ids — the invariant any correct fan-out already maintains, because xstate
keys children by id (a duplicate silently shadows the children-map entry and breaks `xstate.done.actor.<id>`
correlation). Authored ids exist for meaningful flat names (jr's feature id) and collision on them is a loud invoke-time
error. Derivation runs at actor start, not the input mapper — deterministic from structure, so recomputation on every
(re)start is restore-stable, and one mechanism serves j2Setup and plain-`setup` machines alike (the walk contributes id
_quality_ only, never correctness). Rejected: a workflow-computed id as the default (`gate: context.feature.id`) — it
quietly violated the address doctrine (Consequences below), making the gate id the one caller-facing address a workflow
computed by hand, and a machine with a static id (`"humanReview"`) was correct standalone but a latent, timing-dependent
collision once composed under a pool, firing only when two children park concurrently. Also rejected: deriving only in
the walk (a second dialect and an error case for plain-setup callers), and xstate's default invoke ids as the name
(invoke-index noise no caller cares about).

The full symmetry: **agents deliver through their per-iid registration (via the Adapter); everything else delivers over
HTTP (per-gate registration).** Two dialects, one primitive, zero routing. Internally that is literal structure: one
registration table (`address → { accepted event defs, deliver closure, meta }`) that `agentRun` and `gate` register
into, with the Adapter surface and the gates HTTP API as dialect adapters over it — a future caller class (a Slack
bridge, an email reply) is another adapter, not a third mechanism. The table is implementation structure, not vocabulary
— workflows speak only `defineEvent` / `agentRun` / `gate`.

`CANCEL` stays reserved as the run-level infra interrupt. jr's "exit 3 and let the human drive the bash script" becomes
"park in a durable state that advertises its human surface."

## Static imports; live objects constructed per-invocation from input

Everything above is reachable by plain `import`. We rejected two alternatives:

- **Injected closures / a `defineWorkflow(kit)` wrapper** — xstate's `provide()` fills only the machine it is called on;
  it cannot reach actors inside child machines, so host-side injection cannot compose past one level (the finding that
  retired the templates-with-injected-providers model — see ADR-0015).
- **Adapter singletons** — a module-global "current adapters" holder cross-contaminates in-process multi-instance use
  and turns mocking into global state. (The demux registry above is not this: it is rendezvous keyed by globally unique
  ids, not a swappable adapter.)

The doctrine that makes static import work, sharpening ADR-0007: **actor logic is code; everything live is constructed
per-invocation from serializable input** — the Harness client from an endpoint, the kube client from ambient config.
Tests mock by `machine.provide()` at the layer under test.

## Consequences

- Addresses are computed by j2, never by the workflow — iids always (ADR-0016): fresh per invocation by default (the
  lossy handoff), or derived from `(run, enclosing child id, agent, scope)` under `session: "continue"`; gate ids
  derived from the gate's actor path by default, authored only to give external callers a meaningful name. Durable
  handles live in the host ledger (ADR-0016), not in machine contexts.
- **Test stubbing happens at the wire, not in the actor.** The e2e tier (ADR-0010) hosts a wire-compatible stub Harness
  beside its orchestrator fixture (admits the agent, holds the stream open, never acts). An endpoint is just a URL, so
  `agentRun` keeps a single code path and cannot tell it is talking to a fake. Scope: **workspace-less test workflows
  only**, which pass `endpoint` directly in run input — e2e drives their Machines by playing the Adapter against
  `/agents/<iid>/*` with no cluster. Workflows that invoke `workspace()` always get real Sandboxes (the data plane is
  never faked — ADR-0009); their e2e tier requires kind.
- Unsolicited mid-turn steering remains the residual hard case (ADR-0002/0006).
