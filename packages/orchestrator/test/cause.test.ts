// PickCauses (`cause.ts`, ADR-0024) on its own: the cause rides each relay, a relay's cause is the
// set of picks it comes from, a timer keeps the cause of the relay that armed it, and the relay
// order stays bounded. Socket-free and xstate-free: the actors are stand-ins with a status.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnyActorRef, AnyEventObject } from "xstate";
import { PickCauses } from "../src/cause.ts";
import type { Registration } from "../src/registration.ts";

const actor = (status = "active") => ({ getSnapshot: () => ({ status }) }) as unknown as AnyActorRef;
const reg = (id: string) => ({ address: `agent/${id}` }) as unknown as Registration;

/** The cause of the relay `sender` takes now, as a relay it sends inherits it. */
function causeSentBy(causes: PickCauses, sender: AnyActorRef): ReadonlySet<Registration> | undefined {
  const probe = actor();
  causes.relayed(sender, probe, { type: "probe" }, () => undefined);
  const pending = (causes as unknown as { pending: WeakMap<AnyActorRef, Array<{ cause: unknown }>> }).pending;
  return pending.get(probe)?.[0]?.cause as ReadonlySet<Registration> | undefined;
}

test("the cause rides the relay, not the event object: one object relayed once by a pick and once by nothing has two causes", () => {
  const causes = new PickCauses();
  const machine = actor();
  const coder = reg("coder");
  const leave: AnyEventObject = { type: "leave" };
  causes.relayed(undefined, machine, leave, () => new Set([coder]));
  assert.deepEqual([...(causeSentBy(causes, machine) ?? [])], [coder], "while it takes the pick's relay");
  causes.taken(machine, leave);
  causes.relayed(undefined, machine, leave, () => undefined);
  assert.equal(causeSentBy(causes, machine), undefined, "the same object, relayed again by nothing");
});

test("a relay's cause is the union of the picks it answers and the cause of the relay its sender takes", () => {
  const causes = new PickCauses();
  const child = actor();
  const parent = actor();
  const inner = reg("reviewer");
  const outer = reg("coder");
  const pick: AnyEventObject = { type: "approve" };
  causes.relayed(undefined, child, pick, () => new Set([inner]));
  const answer: AnyEventObject = { type: "approve" };
  causes.relayed(child, parent, answer, () => new Set([outer]));
  const cause = causeSentBy(causes, parent);
  assert.deepEqual(new Set(cause), new Set([inner, outer]));
});

test("each timer keeps the cause of the relay that armed it, on its own `setTimeout`: two timers armed one after the other keep two causes; a stopped actor takes nothing", () => {
  const causes = new PickCauses();
  const callbacks: Array<() => void> = [];
  const clock = causes.clockOver({
    setTimeout: (fn: () => void) => callbacks.push(fn) - 1,
    clearTimeout: () => {},
  });
  const machine = actor();
  const coder = reg("coder");
  // What each timer's relay gets: the scheduler's callback relays the timer's event.
  const seen: Array<ReadonlySet<Registration> | undefined> = [];
  const relayLeave = () => {
    const leave: AnyEventObject = { type: "leave" };
    causes.relayed(machine, machine, leave, () => undefined);
    seen.push(causeSentBy(causes, machine));
    causes.taken(machine, leave);
  };
  // The pick's relay arms the first timer; an uncaused relay arms the second, with the same id.
  const go: AnyEventObject = { type: "go" };
  causes.relayed(undefined, machine, go, () => new Set([coder]));
  causes.armingFrom(machine);
  clock.setTimeout(relayLeave, 10);
  causes.taken(machine, go);
  const bump: AnyEventObject = { type: "bump" };
  causes.relayed(undefined, machine, bump, () => undefined);
  causes.armingFrom(machine);
  clock.setTimeout(relayLeave, 10);
  causes.taken(machine, bump);
  callbacks[0]!();
  callbacks[1]!();
  assert.deepEqual([...(seen[0] ?? [])], [coder], "the timer the pick's relay armed");
  assert.equal(seen[1], undefined, "the timer of the same id that an uncaused relay armed");

  const stopped = actor("stopped");
  causes.relayed(undefined, stopped, go, () => new Set([coder]));
  assert.equal(causeSentBy(causes, stopped), undefined);
  const done = actor("done");
  causes.relayed(undefined, done, go, () => new Set([coder]));
  assert.deepEqual(
    [...(causeSentBy(causes, done) ?? [])],
    [coder],
    "a done actor relays its done event with its cause",
  );
});

test("the relay order stays bounded: each relay taken leaves the order", () => {
  const causes = new PickCauses();
  const machine = actor();
  for (let i = 0; i < 2000; i++) {
    const event: AnyEventObject = { type: i % 2 ? "go" : "toggle" };
    causes.relayed(undefined, machine, event, () => undefined);
    causes.taken(machine, event);
  }
  const pending = (causes as unknown as { pending: WeakMap<AnyActorRef, unknown[]> }).pending.get(machine);
  assert.equal(pending?.length, 0);
});
