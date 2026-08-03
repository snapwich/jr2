# Durable Machine state: serializable context, live things constructed from input

The Orchestrator is a forever-running daemon that must survive a `kill -9` and resume in-flight work, so every Machine
has to be reconstructable from a persisted xstate snapshot. That forces one invariant across everything that runs in a
Machine:

> Machine context and actor input hold **plain serializable data only** — ids, counters, status, data-shaped handles
> (e.g. a Sandbox's `endpoint` string). Live infrastructure — HTTP servers, clients, live actor references — is
> **constructed per-invocation from serializable input** (ADR-0011's static-import doctrine) and never persisted.
> Parent↔child coordination uses `sendParent` events plus serializable ids, never a held child-actor reference.

PoC #7 discovered this the hard way (a live `http.Server` in context crashed `JSON.stringify`); PoC #8 was designed to
it from the start (the top Machine keeps only counts + ids, children report completion UP via
`sendParent('FEATURE_DONE')`). They are the same invariant — #8's discipline is precisely what makes #7's
snapshot/restore possible.

Durable **agent handles** do not ride Machine context at all: the host persists an `iid → admission` ledger beside the
snapshot in the same save (ADR-0016). Iids are globally unique, so restore needs no context-tree walking to find them.

## Mechanism (the non-obvious parts)

- **Re-attach is driven by the child's persisted input, not the parent `invoke`.** On restore, xstate v5 re-spawns an
  invoked actor from its **persisted input** — it does **not** re-evaluate the parent's `invoke: { input: … }`. So the
  re-attach lever is rewriting the child's persisted input on hydrate (drop `prompt`, mark it attaching) so the run
  resumes its stream instead of re-POSTing. Keep the parent-side input expression as defence-in-depth, but know it is
  not what fires on restore.
- **Reconcile against the live world before re-attaching.** Restore is not blind resume: a present Sandbox CR →
  re-attach; an absent one → the defined failure path (`workspace.lost` into the body — ADR-0012), never a silent
  re-provision.
- **Reconcile against the MACHINE too** (added 2026-08-02,
  [ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md)). "Reconstructable from a persisted snapshot"
  was only ever true of the Machine that WROTE it, and a run resolves its workflow by filename while the state volume
  outlives the image — so a run parked across a deploy meets whatever was baked in next. The snapshot now carries a
  digest of its Machine's shape, and a mismatch is refused rather than interpreted. This is not belt-and-braces: xstate
  accepts a `value` naming a state the chart no longer has and starts with `value: undefined`, so nothing downstream
  would have caught it.

## Consequences

- Actors may not stash live connections in context for convenience; anything live is rebuilt per-invocation from
  serializable input (the Harness client from an `endpoint`, the kube client from ambient config) — which is also why a
  mock↔real swap happens at the wire (ADR-0011's stub Harness), never inside actor code.
- The known durability edge stands: a crash between "run admitted" and "admission persisted" degrades to an at-most-once
  re-POST (a live-run probe replays from `-1`; a genuinely-absent run re-POSTs), and an in-flight POST at the instant of
  the kill is the irreducible at-most-once sliver.
