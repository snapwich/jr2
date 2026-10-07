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

The store's own durability — what a persist survives, and how long a finished run's row lives — is
[ADR-0065](0065-a-persist-survives-a-crash-and-history-is-a-week.md).

Durable **agent handles** do not ride Machine context at all: the host persists an `iid → admission` ledger beside the
snapshot in the same save (ADR-0016). Iids are globally unique, so restore needs no context-tree walking to find them.

**Effects** keep a **ledger** beside the snapshot in the same save (ADR-0067): one row per Effect, by its id. An
`intent` row is written before the call — saved at the write, so the snapshot that holds the Effect and the row land
together, before the request leaves; a `settled` row is written with the output, saved at the write, before the
transition the output drives; an `aborted` row when the Effect's state exited while it ran. A restore reads the row and
never guesses: settled → the output is delivered (the transition's save was lost); intent → a command re-attaches to its
exec by id, or settles `unknown` when the Harness no longer knows it; no row → nothing was sent, so it starts. Nothing
an Effect started is run twice by jr2. A row is kept only while the saved snapshot holds its Effect running — a restored
child that is done or stopped never starts, so no restore reads its row. Each row reaches the disk once; the first save
after a `settled` or `aborted` row's own save whose snapshot holds that Effect done or not at all drops it: the save of
the transition it drives, or, for an Effect with no `onDone` that settles in place, the save that holds the done child.
The ledger is as large as the Effects running now, never the run's history.

**Pending timers** do not ride the snapshot either. The host persists a **timer table** beside it in the same save: one
row per pending `after`, named delay, delayed `raise` or delayed `sendTo` in the run's tree, with its absolute deadline.
The author writes plain xstate `after`; there is no kit timer actor, and `after` is refused nowhere.

## Mechanism (the non-obvious parts)

- **Re-attach is driven by the child's persisted input, not the parent `invoke`.** On restore, xstate v5 re-spawns an
  invoked actor from its **persisted input** — it does **not** re-evaluate the parent's `invoke: { input: … }`. So the
  re-attach lever is rewriting the child's persisted input on hydrate (drop `prompt`, mark it attaching) so the run
  resumes its stream instead of re-POSTing. Keep the parent-side input expression as defence-in-depth, but know it is
  not what fires on restore.
- **A timer is re-armed by the host, because xstate 5 drops it.** xstate 5 keeps a delayed event on the actor SYSTEM's
  scheduler, not in the snapshot, and a restore runs no entry action again, so a pending `after` never fires after a
  restore (Pool's `pollEvery` included, ADR-0017). At each save the host reads the scheduler's table and writes each
  timer as `{ source, target, id, event, delay, deadline }`, actors named by their child-id path below the root. The
  deadline is a time on the host's wall clock (`RunHostOptions.now`, `Date.now` by default; tests pass one that does not
  step). On restore the order is: `start()`, then re-arm each row with `deadline − now` clamped to `[0, delay]`, in
  deadline order. Re-armed before `start()`, a timer is armed twice, because the system's own `start()` schedules its
  table. The id is xstate's own, so a state's exit after the re-arm cancels a re-armed timer. `start()` drains the
  mailbox, so a child that sends on start can exit a state before any row is re-armed; the host records each cancel
  during `start()` and does not re-arm a row it names. A child stopped during `start()` is stopped with xstate's
  `cancelAll`, which sees an empty table, and its parent state entered again puts a new child at the same path; so the
  host resolves each row's actors before `start()` and re-arms a row only on the same actors after it. So a timer fires
  once, after the time that remained; at once if its deadline passed while the Orchestrator was down, and timers that
  are all overdue fire in the order they fell due; never if an exit cancelled it, before the save, during `start()` or
  after the re-arm; and never later than its own delay when the wall clock went backwards. A wall clock that jumped
  forwards fires it early: only the wall clock survives a process. "Once" is with respect to the saved state: a timer
  that fired after the last save fires again on restore, as any event after the last save replays. A delayed send to an
  actor outside the run's tree is not recorded; jr2 has no such idiom.
- **The re-arm reads an xstate internal** (`system.getSnapshot()._scheduledEvents`, `system.scheduler.schedule`, and
  `system.scheduler.cancel`, wrapped for the length of `start()`; `packages/orchestrator/src/timers.ts`). The same two
  scheduler functions are also wrapped for the life of the run's system, to tell a timer that fires from an event an
  actor sends at once: both reach the inspection stream alike, and the scheduler forgets a timer as it fires it. An
  outstanding pick's stopped answer needs that difference (ADR-0024). Raw-xstate tests that show xstate itself dropping
  the timer are the canary for an xstate bump. xstate 6 persists timers in the snapshot and re-arms them with the same
  deadline and clamp; on xstate 6 the timer table is deleted.
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
- An Effect has no at-most-once sliver: its intent row is on disk before the call leaves, so a restart either finds no
  row (nothing was sent) or finds the intent and settles `unknown` when it cannot re-attach.
- The known durability edge stands for Agents: a crash between "run admitted" and "admission persisted" degrades to an
  at-most-once re-POST (a live-run probe replays from `-1`; a genuinely-absent run re-POSTs), and an in-flight POST at
  the instant of the kill is the irreducible at-most-once sliver.
