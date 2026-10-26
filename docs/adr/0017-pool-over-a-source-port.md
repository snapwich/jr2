# The run loop is a jr2 `pool` over a generalized source port

Third of the workflow-API redesign trio ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md),
[ADR-0016](0016-agent-turn-mechanics-are-internal.md); full record in
[docs/design/workflow-api/](https://github.com/snapwich/jr2/blob/71ebe36/docs/design/workflow-api/proposal.md)). The top
of every jr-shaped workflow — claim ready items, run one child per item under a cap, wake on push or poll, settle when
done — was ~90 lines of hand-rolled bookkeeping in the jr-parity exercise (`active[]`, `spawnChild`/`stopChild`,
`xstate.done.actor.*` casts, the discover/saturated/settling/idle choreography, and a comment-enforced "keep
`spawnChild` top-level or visualize goes blind" footgun). No xstate-ecosystem primitive exists for this (verified: the
canonical v5 pattern _is_ the hand-rolled loop), so jr2 ships one.

## `pool(worker, spec)` — a machine factory, like `workspace()`

`pool(worker, { source, itemId, cap, itemInput, onDrained, failures })` returns a plain machine that owns
spawn-under-cap, stable child identity, typed completion collection (`DoneActorEvent<Output, string>` + the
`xstate.done.actor.*` wildcard — zero casts), `stopChild` bookkeeping, the wake gate, and the re-query timer. The one
top-level `spawnChild` lives in jr2's pool code, once — the visualize footgun is dissolved by construction, and
everything durable is a registered string src (xstate cannot persist inline-src children, which independently forces
this shape). The pool composes: it returns a plain machine and can itself be nested as a child. The typed idioms
(wildcard done events, `assertEvent`, outcome-in-context root output) ship as documented patterns regardless, so
outgrowing the pool means hand-rolling without penalty, not fighting a framework.

## The source port is generalized; Work Source is one adapter

The pool draws from a **Source** port — `next(active) → item | null`, plus an optional `wake` event def (webhook /
`jr2 send` push seam) and `pollEvery` (the set mutates underneath us) — a queue, a generator, or a re-queried set. tk's
claim actor is one adapter; GLOSSARY.md's **Work Source** reframes as _the Source adapter for tickets_, and the
Ready-set doctrine (re-query, never materialize) survives as that adapter's semantics, not the primitive's.

A Work Source — `tk`, GitHub issues, Jira, a task queue — is a behavior port, not a canonical data schema: verbs like
`claimNext`, `updateStatus` and `comment`, each gated by a capability the adapter advertises. It owns the dependency
graph and hands out the Ready-set, the currently-unblocked items in dependency order, so the Machine never encodes a
dependency edge. The Ready-set mutates during execution — items can be reopened or created mid-run — so it is not a
static FIFO queue.

## Terminal triage is three-valued, surfaced as status

Forced by parking-is-retention (ADR-0012) plus workflows whose children park on gates (escalation, human review):

- **drained** — source empty and all children settled → final, or the run ends `failed` when items failed (below);
- **deadlocked** — open-but-never-ready items with nothing progressing → surfaced distinctly (jr exit 2), not an
  indistinguishable idle poll, or the run ends `failed` when items failed (below);
- **waiting** — children parked in gates → the run stays open and the gates list is the "what needs me" surface (jr exit
  3).

The pool can make this call because it owns both the source and the children — the strongest single argument for the
primitive over an authored loop. Triage surfaces as run _status_ (feed, `jr2 runs`), not machine events; a
`pool.deadlock` event can be added if a workflow ever needs to react rather than a human.

## The pool catches a worker's Failure

A worker that fails ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)) ends
only its own item. The pool catches the Failure on `xstate.error.actor.*`, keeps its payload in `failures` by item id,
stops that worker, and claims again: the output is `{ status, items, failures }`. The pool is a kit-owned parent, so an
author cannot give it an `onError`; if it let the Failure go up, one lost `task` would end the whole run `failed`, and
the host would delete the Sandbox of each sibling, also one that waits at its `review` Gate with commits that it did not
push. That breaks parking-is-retention for work that did not fail. A defect in a worker still goes up and ends the run
`error`.

The option `failures: "fail" | "report"` says how a pool ends when one or more items failed. It catches each worker's
Failure in both modes, so one failed item never stops its siblings. With `"fail"`, the default, a pool that ends
`drained` or `deadlocked` with failures invokes `fail` with the reason `"<n> of <m> items failed"` and the detail
`{ status, items, failures }`, so the run ends `failed` and `jr2 run` exits 1. At either end no worker is live, because
a pool with a live worker parks, so the Failure deletes no sibling's Sandbox. With `"report"`, the pool ends `done` and
`failures` in its output says which items did not succeed: for a pool whose job is to try each item, where a failed item
is a correct answer. The default is `"fail"` because `done` means that the work succeeded (ADR-0073), and a CI loop must
not exit 0 while every item failed. The deadlock is the usual end of a dependency backlog with a failure: a Source over
a tracker keeps the failed item open, so its dependents never become ready. The `status` in the detail tells the two
ends apart, and the two details have one shape.
