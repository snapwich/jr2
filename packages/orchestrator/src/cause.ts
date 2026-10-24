// What took the Machine out of an Agent's state (ADR-0024): the Turn's own pick, or something else.
// The Agent's Actor asks it as its invocation stops, and its sweep says `cause: "pick"` only for
// the first, so the Harness settles that Submission `ended` and every other end `aborted`. The pick
// may be from an earlier Submission of the same Turn: a nudge or a wake starts a new Submission in
// the same Turn.
//
// The answer comes from the events the Machines took, never from the pick's answer: "was the pick's
// work stopped" (`Hold.cutShort`, the answer's `stopped`) is another question. Two facts are kept,
// read off xstate's inspection stream and the actor system's scheduler and clock:
//
//   - THE CAUSE OF EACH RELAY: the set of Agents' picks it comes from. ADR-0024 lists the four ways
//     a relay comes from a pick: the pick itself, the work below the Agent's state, a send of an
//     actor that takes a caused relay, and a timer armed while its Machine took one. The cause rides
//     the RELAY, never the event object: xstate relays one object each time a config action with an
//     object literal runs. A timer's cause rides its own `setTimeout` on the run's clock, so two
//     timers of one id each keep their own.
//   - THE EXIT. On each microstep of a Machine, the first microstep that stops the Agent's
//     invocation names the cause of the macrostep it is part of. After it, the Agent's actor is no
//     longer the child of the Machine that invokes it, a child Machine on the way up is no longer a
//     child of the one above, or a Machine on the way up is done. A microstep that throws is never
//     inspected, so a fault is never the exit. The stop of a run is no event of the Machine's.
//
// Which relay an actor takes now is read from the relay order: xstate relays an event (inspected as
// `@xstate.event`) to the actor's mailbox. The mailbox takes events one at a time, in order, and
// xstate inspects `@xstate.snapshot` with that event when the actor has taken it. An actor's own done
// or error event (`xstate.done.actor.<id>`, `xstate.error.actor.<id>`) is the last relay it makes
// with a cause. It takes the cause of the relay the actor took then; after it, the actor is
// finished. A finished actor has no cause, and a relay to it, or to a stopped actor, is not queued:
// xstate drops it. Status alone does not say it: a done Machine makes its last deferred sends with
// status `done`, and a Machine done at start is `done` before its init relay. And an errored callback
// is never stopped: its own later sends still reach its parent.

import type { AnyActorRef, AnyEventObject, AnyMachineSnapshot } from "xstate";
import type { Registration } from "./registration.ts";

const XSTATE_STOP = "xstate.stop";

/** The Agents' picks a relay comes from; undefined for none. */
type Cause = ReadonlySet<Registration> | undefined;

export class PickCauses {
  /** Each actor's relays that it has not taken yet, in order, with their causes: the first is the
   * one it takes now, or next. */
  private readonly pending = new WeakMap<AnyActorRef, Array<{ event: AnyEventObject; cause: Cause }>>();
  /** For each registration, the cause of the microstep that took the Machine out of its Agent's
   * state, or `null` for none. Set once, at the first such microstep. */
  private readonly exits = new WeakMap<Registration, Cause | null>();
  /** Each registration's Agent actor, read off the invoking Machine's committed snapshot. */
  private readonly actors = new WeakMap<Registration, AnyActorRef>();
  /** Each actor that relayed its own done or error event: it takes nothing more, and has no cause. */
  private readonly finished = new WeakSet<AnyActorRef>();
  /** The cause of the timer the scheduler arms now: the next `setTimeout` on the clock keeps it. */
  private arming: Cause;
  /** Set while a timer's callback runs: its cause, for the relay the scheduler makes next. */
  private firing: { cause: Cause } | undefined;

  /** The scheduler arms a timer whose source is `source`: its cause is the relay `source` takes now. */
  armingFrom(source: AnyActorRef): void {
    this.arming = this.causeOfCurrent(source);
  }

  /**
   * The run's clock, over `base`: each `setTimeout` keeps the cause of the timer the scheduler arms
   * with it, and gives it to the relay its callback makes. So each timer's cause is its own, even
   * for two timers of one id. A clear needs nothing: the callback never runs.
   */
  clockOver<T>(base: { setTimeout: (fn: () => void, ms: number) => T; clearTimeout: (timer: T) => void }) {
    return {
      setTimeout: (fn: () => void, ms: number): T => {
        const cause = this.arming;
        this.arming = undefined;
        return base.setTimeout(() => {
          this.firing = { cause };
          try {
            fn();
          } finally {
            this.firing = undefined;
          }
        }, ms);
      },
      clearTimeout: (timer: T) => base.clearTimeout(timer),
    };
  }

  /**
   * `@xstate.event`: `event` is relayed from `source` to `target`. `pickOf` names the registrations
   * whose pick it is, or whose work below it comes from. With them: the cause of the timer whose
   * callback makes this relay, or else of the relay that `source` takes now.
   */
  relayed(source: AnyActorRef | undefined, target: AnyActorRef, event: AnyEventObject, pickOf: () => Cause): void {
    const firing = this.firing;
    this.firing = undefined;
    const by = firing ? firing.cause : source !== undefined ? this.causeOfCurrent(source) : undefined;
    const cause = union(pickOf(), by);
    // The source's own done or error event: the last relay it makes with a cause.
    if (source !== undefined && isOwnEnd(source, event)) {
      this.finished.add(source);
      this.pending.delete(source);
    }
    if (this.finished.has(target) || statusOf(target) === "stopped") return;
    const queue = this.pending.get(target);
    if (queue) queue.push({ event, cause });
    else this.pending.set(target, [{ event, cause }]);
  }

  /** `@xstate.snapshot`: `actor` has taken `event`. An event that was not relayed (a stop) leaves
   * the order as it is; a stop clears it, since a stopped actor takes nothing more. */
  taken(actor: AnyActorRef, event: AnyEventObject): void {
    const queue = this.pending.get(actor);
    if (!queue) return;
    if (event.type === XSTATE_STOP) {
      queue.length = 0;
      return;
    }
    const at = queue.findIndex((relay) => relay.event === event);
    if (at !== -1) queue.splice(0, at + 1);
  }

  /**
   * `@xstate.microstep` of `machine`, with the snapshot after it: record the exit of each of
   * `registrations` that this microstep takes out of the Machine.
   */
  microstep(
    machine: AnyActorRef,
    snapshot: AnyMachineSnapshot,
    event: AnyEventObject,
    registrations: Iterable<Registration>,
  ): void {
    for (const reg of registrations) {
      if (this.exits.has(reg) || !reg.invoker || !reg.invokeId) continue;
      if (!this.actors.has(reg)) {
        // The committed snapshot: the invoking Machine's own microstep is not committed until its
        // macrostep ends, so this is the actor the registration was made for.
        const ref = childrenOf(reg.invoker.getSnapshot())[reg.invokeId];
        if (ref === undefined) continue;
        this.actors.set(reg, ref);
      }
      if (!leaves(reg, this.actors.get(reg)!, machine, snapshot)) continue;
      this.exits.set(reg, event.type === XSTATE_STOP ? null : (this.causeOfCurrent(machine) ?? null));
    }
  }

  /** Did this registration's own pick take the Machine out of its Agent's state? */
  endedByPick(reg: Registration): boolean {
    return this.exits.get(reg)?.has(reg) === true;
  }

  /** The cause of the relay `actor` takes now. A done or errored actor relays its own done or error
   * event while it takes its last relay, so that event keeps the cause. A finished or stopped actor
   * has none. */
  private causeOfCurrent(actor: AnyActorRef): Cause {
    const status = statusOf(actor);
    if (status === undefined || status === "stopped" || this.finished.has(actor)) return undefined;
    return this.pending.get(actor)?.[0]?.cause;
  }
}

function statusOf(actor: AnyActorRef): string | undefined {
  return (actor.getSnapshot() as { status?: string } | undefined)?.status;
}

/** Is `event` the actor's own done or error event? */
function isOwnEnd(actor: AnyActorRef, event: AnyEventObject): boolean {
  return event.type === `xstate.done.actor.${actor.id}` || event.type === `xstate.error.actor.${actor.id}`;
}

function union(a: Cause, b: Cause): Cause {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return new Set([...a, ...b]);
}

/** Does this microstep of `machine` stop `reg`'s invocation: `machine` is on the way up from the
 * Agent and is done, or the actor (or child Machine) on the way down is no longer its child. */
function leaves(reg: Registration, agent: AnyActorRef, machine: AnyActorRef, snapshot: AnyMachineSnapshot): boolean {
  let below = agent;
  for (let at: AnyActorRef | undefined = reg.invoker; at !== undefined; below = at, at = at._parent) {
    if (at === machine) return snapshot.status === "done" || childrenOf(snapshot)[below.id] !== below;
  }
  return false;
}

function childrenOf(snapshot: unknown): Record<string, AnyActorRef | undefined> {
  return (snapshot as { children?: Record<string, AnyActorRef | undefined> } | undefined)?.children ?? {};
}
