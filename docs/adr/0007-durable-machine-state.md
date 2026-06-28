# Durable Machine state: serializable context, injected infrastructure

The Orchestrator is a forever-running daemon that must survive a `kill -9` and resume in-flight work (PoC #7), so every
Machine has to be reconstructable from a persisted xstate snapshot. That forces one invariant across **all** templates
and providers:

> Machine context and actor input hold **plain serializable data only** — ids, counters, status, data-shaped handles
> (e.g. a Sandbox's `endpoint` string). Live infrastructure — the `ControlPlane`, HTTP servers, live actor references —
> is **injected at assemble/restore time and never persisted**. Parent↔child coordination uses `sendParent` events plus
> serializable ids, never a held child-actor reference.

PoC #7 discovered this the hard way (a live `http.Server` in context crashed `JSON.stringify`); PoC #8 was designed to
it from the start (the top Machine keeps only counts + ids, children report completion UP via
`sendParent('FEATURE_DONE')`). They are the same invariant — #8's discipline is precisely what makes #7's
snapshot/restore possible.

## Mechanism (the non-obvious parts)

- **Strip live handles from two places, not one.** A live handle hides in both the parent `context` and the invoked
  child's **persisted input** (`snapshot.children.<id>.snapshot.input`). `serializeSnapshot` must strip both before
  persist; `hydrateSnapshot` re-injects the live instance into both before `createActor(machine, { snapshot })`.
- **Re-attach is driven by the child's persisted input, not the parent `invoke`.** On restore, xstate v5 re-spawns an
  invoked actor from its **persisted input** — it does **not** re-evaluate the parent's `invoke: { input: … }`. So the
  re-attach lever is rewriting the child's persisted input on hydrate (drop `prompt`, set `attachOffset` to the
  persisted admission offset) so the run resumes its stream instead of re-POSTing. Keep the parent-side input expression
  as defence-in-depth, but know it is not what fires on restore.
- **Reconcile against the live world before re-attaching.** Restore is not blind resume: a present Sandbox CR →
  re-attach; an absent one → the defined failure path (mark the run `lost`, do not re-attach).

## Consequences

- Providers may not stash live connections in context for convenience; infra is bound in the assemble-time closure
  (slots take **semantic** input — role, instance id, prompt — and the real adapter injects infra), which is also why a
  mock↔real swap never touches a template.
- The known durability edge stands: a crash between "run admitted" and "offset persisted" degrades to an at-most-once
  re-POST (a live-run probe replays from `-1`; a genuinely-absent run re-POSTs), and an in-flight POST at the instant of
  the kill is the irreducible at-most-once sliver.
