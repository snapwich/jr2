# The run loop is a jr2 `pool` over a generalized source port

Third of the workflow-API redesign trio ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md),
[ADR-0016](0016-agent-turn-mechanics-are-internal.md); full record in
[docs/design/workflow-api/](../design/workflow-api/proposal.md)). The top of every jr-shaped workflow — claim ready
items, run one child per item under a cap, wake on push or poll, settle when done — was ~90 lines of hand-rolled
bookkeeping in the jr-parity exercise (`active[]`, `spawnChild`/`stopChild`, `xstate.done.actor.*` casts, the
discover/saturated/settling/idle choreography, and a comment-enforced "keep `spawnChild` top-level or visualize goes
blind" footgun). No xstate-ecosystem primitive exists for this (verified: the canonical v5 pattern _is_ the hand-rolled
loop), so jr2 ships one.

## `pool(worker, spec)` — a machine factory, like `workspace()`

`pool(worker, { source, itemId, cap, itemInput, onDrained })` returns a plain machine that owns spawn-under-cap, stable
child identity, typed completion collection (`DoneActorEvent<Output, string>` + the `xstate.done.actor.*` wildcard —
zero casts), `stopChild` bookkeeping, the wake gate, and the re-query timer. The one top-level `spawnChild` lives in
jr2's pool code, once — the visualize footgun is dissolved by construction, and everything durable is a registered
string src (xstate cannot persist inline-src children, which independently forces this shape). The pool composes: it
returns a plain machine and can itself be nested as a child. The typed idioms (wildcard done events, `assertEvent`,
outcome-in-context root output) ship as documented patterns regardless, so outgrowing the pool means hand-rolling
without penalty, not fighting a framework.

## The source port is generalized; Work Source is one adapter

The pool draws from a **Source** port — `next(active) → item | null`, plus an optional `wake` event def (webhook /
`jr2 send` push seam) and `pollEvery` (the set mutates underneath us) — a queue, a generator, or a re-queried set. tk's
claim actor is one adapter; CONTEXT.md's **Work Source** reframes as _the ticket-flavored Source adapter_, and the
Ready-set doctrine (re-query, never materialize) survives as that adapter's semantics, not the primitive's.

## Terminal triage is three-valued, surfaced as status

Forced by parking-is-retention (ADR-0012) plus workflows whose children park on gates (escalation, human review):

- **drained** — source empty and all children settled → the pool reaches final (jr exit 0);
- **deadlocked** — open-but-never-ready items with nothing progressing → surfaced distinctly (jr exit 2), not an
  indistinguishable idle poll;
- **waiting** — children parked in gates → the run stays open and the gates list is the "what needs me" surface (jr exit
  3).

The pool can make this call because it owns both the source and the children — the strongest single argument for the
primitive over an authored loop. Triage surfaces as run _status_ (feed, `jr2 runs`), not machine events; a
`pool.deadlock` event can be added if a workflow ever needs to react rather than a human.
