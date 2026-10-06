// Rest (ADR-0024, ADR-0029): the condition of an Agent's state under which a pick is answered.
//
//   A pick that moves the workflow to a state inside the Agent's state is answered when the
//   workflow is at rest there: no state below the Agent's state is running something (an Effect, a
//   Gate, another Agent, a child Machine), and no pending timer will move the workflow to another
//   state inside the Agent's state.
//
// It is read from the Machine, never kept: the snapshot (which states are active, which children
// run) and the timer table (`timers.ts`, the same table a restore re-arms). So a restored run gives
// the same answer as the run before the restart. Read it AFTER the mailbox drains — a microtask
// after a snapshot, or in a request of its own — never inside a subscriber: an event already queued
// (a `sendTo(self)` with no delay) moves the Machine before the next tick.
//
// Everything below is computed over the SET of active states below the Agent's state. Today that set
// is one path (a parallel region below an Agent's state is refused at load, ADR-0015), and nothing
// here assumes it.
//
// What the rule does not know: what an Effect is. It knows what waiting is — a live invoked child, a
// timer that holds. A settled child with no `onDone` is rest; a state named `rest` means nothing.
// Known limit: a delayed `sendTo` to a child whose reply then moves the Machine is not counted.

import type { AnyActorRef, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { seatOf, type PartySeat } from "./party.ts";
import { scheduledFor } from "./timers.ts";

type Node = AnyStateMachine["root"];

/** Is `node` active in `snapshot`? Read off the state value, a public shape. */
function isActive(snapshot: AnyMachineSnapshot, node: Node): boolean {
  let value: unknown = snapshot.value;
  for (const key of node.path) {
    if (typeof value === "string") return value === key && node.path.at(-1) === key;
    if (!value || typeof value !== "object" || !(key in value)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return true;
}

/** Every active state strictly below `s`: a set, which is one path today and may be more. */
export function activeBelow(snapshot: AnyMachineSnapshot, s: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node, value: unknown): void => {
    if (node.type === "parallel") {
      for (const child of Object.values(node.states)) {
        out.push(child);
        visit(child, value && typeof value === "object" ? (value as Record<string, unknown>)[child.key] : undefined);
      }
      return;
    }
    if (typeof value === "string") {
      const child = node.states[value];
      if (child) {
        out.push(child);
        visit(child, undefined);
      }
    } else if (value && typeof value === "object") {
      for (const [key, sub] of Object.entries(value)) {
        const child = node.states[key];
        if (!child) continue;
        out.push(child);
        visit(child, sub);
      }
    }
  };
  let value: unknown = snapshot.value;
  for (const key of s.path)
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  visit(s, value);
  return out;
}

const isInside = (node: Node, s: Node): boolean => {
  for (let n: Node | undefined = node; n; n = n.parent) if (n === s) return true;
  return false;
};

/**
 * The pending timers that hold Rest: a timer whose event, delivered to this Machine, is handled by a
 * transition of an active state at or below `s` whose target is inside `s` (or `s` itself, from `s`,
 * without re-entering it — re-entering ends the Turn). Guards are not run: a guarded handler holds
 * until the timer fires, and then nothing is pending. A timer whose handler leaves `s` (a Turn
 * timeout) does not hold: when it fires, the Turn ends (ADR-0024).
 */
export function holdingTimers(machine: AnyActorRef, s: Node): string[] {
  const snapshot = machine.getSnapshot() as AnyMachineSnapshot;
  const active = [s, ...activeBelow(snapshot, s)];
  return scheduledFor(machine)
    .filter((t) =>
      active.some((node) =>
        (node.transitions.get(t.event.type) ?? []).some((tr) =>
          ((tr.target ?? []) as Node[]).some((target) =>
            target === s ? node === s && !tr.reenter : isInside(target, s),
          ),
        ),
      ),
    )
    .map((t) => t.id);
}

/** The invoke ids of the live children of active states strictly below `s`. The Agent's own invoke
 * is on `s` and does not count. */
export function runningBelow(machine: AnyActorRef, s: Node): string[] {
  const snapshot = machine.getSnapshot() as AnyMachineSnapshot;
  const children = snapshot.children as Record<string, AnyActorRef | undefined>;
  const out: string[] = [];
  for (const node of activeBelow(snapshot, s))
    for (const inv of node.invoke) if (children[inv.id]?.getSnapshot().status === "active") out.push(inv.id);
  return out;
}

/** Is the Machine at Rest in `s`? Nothing below it runs, and no pending timer holds. */
export function atRest(machine: AnyActorRef, s: Node): boolean {
  return runningBelow(machine, s).length === 0 && holdingTimers(machine, s).length === 0;
}

/**
 * Where an Agent's registration stands: `rest`, `busy` (its state is active and not at Rest), or
 * `gone` (its state is no longer active: the Turn is over, ADR-0024). A registration with no seat to
 * read (a plain `setup()` tree, a bare test entry) reads `rest` — today's behavior, never a false
 * hold.
 */
export type RestReading = "rest" | "busy" | "gone";

export function restOf(reg: PartySeat): RestReading {
  if (!reg.invoker || !reg.invokeId) return "rest";
  const snapshot = reg.invoker.getSnapshot() as AnyMachineSnapshot | undefined;
  if (!snapshot || !(snapshot.machine as AnyStateMachine | undefined)?.root) return "rest";
  if (snapshot.status !== "active") return "gone";
  const seat = seatOf(snapshot, reg.invokeId);
  if (!seat) return "rest";
  if (!isActive(snapshot, seat)) return "gone";
  return atRest(reg.invoker, seat) ? "rest" : "busy";
}
