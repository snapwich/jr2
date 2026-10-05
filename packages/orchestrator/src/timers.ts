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
// `ActorSystem`, but underscored) and `system.scheduler.schedule`. An xstate bump can break it; the
// raw-xstate tests in test/timers.test.ts are the canary. xstate 6 persists timers in the snapshot
// and re-arms them itself, with the same deadline and clamp: on xstate 6, delete this module.

import type { AnyActorRef, EventObject } from "xstate";

/** One pending delayed event, JSON-safe. An actor is named by its path of child ids below the
 * run's root (`[]` is the root). */
export type PendingTimer = {
  source: string[];
  target: string[];
  /** xstate's scheduled id. */
  id: string;
  event: EventObject;
  /** The delay as last scheduled, ms: the upper bound on what remains (see {@link rearmTimers}). */
  delay: number;
  /** Wall-clock ms (`Date.now()`) at which it is due. */
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

/**
 * The run's pending timers, read off its actor system. Call at persist time: the scheduler's table
 * and the snapshot are read in the same tick, so they agree. A timer whose source or target is not
 * in the run's tree (a delayed send to an actor outside it) is not recorded; jr2 has no such idiom.
 */
export function pendingTimers(root: AnyActorRef): PendingTimer[] {
  const out: PendingTimer[] = [];
  for (const s of Object.values(root.system.getSnapshot()._scheduledEvents)) {
    const source = pathOf(root, s.source);
    const target = pathOf(root, s.target);
    if (!source || !target) continue;
    out.push({ source, target, id: s.id, event: s.event, delay: s.delay, deadline: s.startedAt + s.delay });
  }
  return out;
}

/**
 * Schedule each recorded timer again on a restored run. Call AFTER `actor.start()`, never before:
 * `start()` is where xstate builds the children (so a child's path resolves), and the system's own
 * `start()` schedules whatever is already in its table, so a timer re-armed before it is armed
 * twice and fires twice.
 *
 * Remaining time is `deadline - now`, clamped to `[0, delay]`. A deadline that passed while the
 * Orchestrator was down fires at once. A wall clock that went BACKWARDS cannot push a timer past its
 * own delay. A wall clock that jumped forwards fires a timer early: only the wall clock survives a
 * process, so the deadline is a wall-clock time.
 */
export function rearmTimers(root: AnyActorRef, timers: readonly PendingTimer[], now = Date.now()): void {
  for (const t of timers) {
    const source = refAt(root, t.source);
    const target = refAt(root, t.target);
    if (!source || !target) continue;
    const remaining = Math.min(t.delay, Math.max(0, t.deadline - now));
    root.system.scheduler.schedule(source, target, t.event, remaining, t.id);
  }
}
