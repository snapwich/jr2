// A run's pending timers across a restart (ADR-0007).
//
// xstate 5 keeps a delayed event (`after`, a named delay, a delayed `raise` or `sendTo`) on the
// actor SYSTEM's scheduler, not in the Machine snapshot. `getPersistedSnapshot()` carries no trace
// of it, and a restored actor runs no entry actions again, so nothing schedules it again: the
// timer is lost, not restarted. xstate 5 has a `snapshot.scheduler` seam in `createSystem`, but
// the Actor constructor never passes it.
//
// So the run host records each pending timer's absolute DEADLINE beside the snapshot, in the same
// blob, and schedules it again on the restored system after `start()`. The author writes plain
// `after`. The scheduled id is xstate's own (`xstate.after.<delay>.<stateId>` for an `after`), so
// the state's exit `cancel(id)` still cancels a re-armed timer.
//
// This reads an xstate INTERNAL: `system.getSnapshot()._scheduledEvents` (typed in xstate's
// `ActorSystem`, but underscored), `system.scheduler.schedule`, and `system.scheduler.cancel`
// (wrapped for the length of `start()`). An xstate bump can break it; the raw-xstate tests in
// test/timers.test.ts are the canary. xstate 6 persists timers in the snapshot and re-arms them
// itself, with the same deadline and clamp: on xstate 6, delete this module.

import type { AnyActorRef, EventObject } from "xstate";

/** One pending delayed event, JSON-safe. An actor is named by its path of child ids below the
 * run's root (`[]` is the root). */
export type PendingTimer = {
  source: string[];
  target: string[];
  /** xstate's scheduled id. */
  id: string;
  event: EventObject;
  /** The delay as last scheduled, ms: the upper bound on what remains (see {@link startAndRearm}). */
  delay: number;
  /** Wall-clock ms at which it is due, on the host's clock (`now`). */
  deadline: number;
};

function childrenOf(ref: AnyActorRef): Record<string, AnyActorRef> {
  return (ref.getSnapshot() as { children?: Record<string, AnyActorRef> }).children ?? {};
}

function pathOf(root: AnyActorRef, ref: AnyActorRef, path: string[] = []): string[] | undefined {
  if (ref === root) return path;
  for (const [id, child] of Object.entries(childrenOf(root))) {
    const found = pathOf(child, ref, [...path, id]);
    if (found) return found;
  }
  return undefined;
}

function refAt(root: AnyActorRef, path: string[]): AnyActorRef | undefined {
  let ref: AnyActorRef | undefined = root;
  for (const id of path) ref = ref && childrenOf(ref)[id];
  return ref;
}

/** xstate's key for a scheduled event: one per source actor and id. */
const keyOf = (source: AnyActorRef, id: string) => `${source.sessionId}.${id}`;

const clamp = (ms: number, delay: number) => Math.min(delay, Math.max(0, ms));

/**
 * The run's pending timers, read off its actor system. Call at persist time: the scheduler's table
 * and the snapshot are read in the same tick, so they agree. A timer whose source or target is not
 * in the run's tree (a delayed send to an actor outside it) is not recorded; jr2 has no such idiom.
 *
 * xstate stamps a timer's start with `Date.now()`, so the time that remains is read on that clock;
 * the deadline is `now + remaining`, on the host's clock. With the default `now` the two are one
 * clock and the deadline is xstate's own `startedAt + delay`.
 */
export function pendingTimers(root: AnyActorRef, now = Date.now()): PendingTimer[] {
  const wall = Date.now();
  const out: PendingTimer[] = [];
  for (const s of Object.values(root.system.getSnapshot()._scheduledEvents)) {
    const source = pathOf(root, s.source);
    const target = pathOf(root, s.target);
    if (!source || !target) continue;
    const remaining = clamp(s.startedAt + s.delay - wall, s.delay);
    out.push({ source, target, id: s.id, event: s.event, delay: s.delay, deadline: now + remaining });
  }
  return out;
}

/**
 * The pending delayed events whose TARGET is `ref`, from any source: what Rest asks (rest.ts) —
 * an `after`, a named delay, a delayed `raise` or `sendTo(self)`, a child's delayed `sendParent`.
 * The same table {@link pendingTimers} persists and {@link startAndRearm} re-arms, so Rest reads
 * the same timers after a restore as before it.
 */
export function scheduledFor(ref: AnyActorRef): Array<{ id: string; event: EventObject }> {
  return Object.values(ref.system.getSnapshot()._scheduledEvents)
    .filter((s) => s.target === ref)
    .map((s) => ({ id: s.id, event: s.event }));
}

/**
 * Start a restored run, then schedule each recorded timer again on it. One function, so the order
 * cannot be got wrong: re-armed BEFORE `start()`, a timer is armed twice and fires twice, because
 * the system's own `start()` schedules whatever is already in its table; and `start()` is where
 * xstate builds the children, so a child's path resolves only after it.
 *
 * `start()` drains the mailbox: a child that sends on start (an author's `fromCallback`) can move
 * the Machine out of a state before any timer is re-armed. That exit's `cancel(id)` finds nothing
 * armed yet. So every cancel during `start()` is recorded, and a row it names is not re-armed: a
 * state exit cancels the timer whether it happens during `start()` or after it.
 *
 * A child stopped during `start()` takes its timers with it, but xstate stops a child with
 * `scheduler.cancelAll`, which walks the table, and the table is still empty: no cancel is seen.
 * If its parent state is entered again, a NEW child sits at the same path. So each row's actors are
 * resolved BEFORE `start()` (the restored tree already holds them), and a row is re-armed only on
 * the same actors after it. A row of a stopped child then fires into nothing, not into its
 * replacement.
 *
 * Remaining time is `deadline - now`, clamped to `[0, delay]`. A deadline that passed while the
 * Orchestrator was down fires at once. A wall clock that went BACKWARDS cannot push a timer past its
 * own delay. A wall clock that jumped forwards fires a timer early: only the wall clock survives a
 * process, so the deadline is a wall-clock time. Rows are scheduled in deadline order, so timers
 * that are all overdue (remaining 0) fire in the order they fell due, as in an uninterrupted run.
 */
export function startAndRearm(root: AnyActorRef, timers: readonly PendingTimer[], now = Date.now()): void {
  const scheduler = root.system.scheduler;
  const cancel = scheduler.cancel;
  const cancelled = new Set<string>();
  const rows = [...timers]
    // `sort` is stable: equal deadlines keep the order xstate scheduled them in.
    .sort((a, b) => a.deadline - b.deadline)
    .map((t) => ({ t, source: refAt(root, t.source), target: refAt(root, t.target) }));
  scheduler.cancel = (source, id) => {
    cancelled.add(keyOf(source, id));
    cancel(source, id);
  };
  try {
    root.start();
  } finally {
    scheduler.cancel = cancel;
  }
  for (const { t, source, target } of rows) {
    if (!source || !target || cancelled.has(keyOf(source, t.id))) continue;
    if (refAt(root, t.source) !== source || refAt(root, t.target) !== target) continue;
    scheduler.schedule(source, target, t.event, clamp(t.deadline - now, t.delay), t.id);
  }
}
