// The held answer (ADR-0024, ADR-0013): a pick that moves the workflow to a state inside the Agent's
// state is answered when the workflow is back at Rest there (rest.ts). Until then the pick is
// OUTSTANDING: its POST answered at once with a delivery id, and the Harness long-polls
// `GET /agents/:iid/deliveries/:id` for the answer, inside the one tool call.
//
// A hold is plain data on the run (`RunBlob.holds`), saved with the snapshot, so a park or an
// Orchestrator restart is a longer wait in the same Turn: the restored host reads the same Rest off
// the restored Machine, and answers the same poll. What a hold keeps beside the delivery id is EVERY
// reply from below the Agent's state since the pick (`chain`) — the last is the answer's default —
// because the events that carried them are gone after a restart.
//
// The answer is the last reply since the pick, rendered by the Harness: a party's event (a Gate's
// answer, a nested Agent's pick) with its payload, or a child's output (a child Machine, an Effect
// stand-in). A chain link is a reply from below the Agent's state — from the set of active states
// under it, never from a sibling region or the root; the events the Machine sent itself (`raise`,
// `sendTo(self)`, a timer) are skipped, and so is a child's error: every outcome of work is its
// output, and an error is a jr2 or config defect, never an answer. With no link, the answer carries
// no reply — it does not say whether work ran.

import type { AnyActorRef, AnyEventObject, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { SENDER_KEY, type Sender } from "@jr2/agent-protocol";
import { activeBelow } from "./rest.ts";
import type { PickAnswer } from "./wire.ts";

type Node = AnyStateMachine["root"];

/** One outstanding pick, or its answer not yet superseded. JSON-safe: it rides the run blob. */
export type Hold = {
  /** The Agent address the pick was posted to. */
  instanceId: string;
  deliveryId: string;
  /** The pick's event name. */
  pick: string;
  /** The Agent slot that picked — the Console's "held since" names it. */
  agent: string;
  /** ISO time the pick was delivered: the Console's "held since". */
  since: string;
  /** The Sandbox whose token may read the answer (ADR-0013) — the registration's, kept because the
   * answer outlives a registration that a route out of the Agent's state ends. */
  sandbox?: string;
  /** The invoke id of the Agent's state when the pick was made: a re-registration of the same
   * address by another state is another Turn. */
  invokeId?: string;
  /** The continued conversation (ADR-0057) the picking Turn is part of: where a route out of its
   * state leaves the answer as a notice for its next Turn. Absent for a fresh Turn: no notice. */
  conversation?: string;
  /** Every reply since the pick, oldest first (ADR-0024): the last is the answer's default, and
   * the whole is the `chain` an `answer` action reads (ADR-0067). */
  chain?: PickAnswer[];
  /** What the Machine's `answer` action set since the pick (ADR-0067): it replaces the default.
   * Wrapped, so an answer of `null` is still one. */
  shaped?: { value: unknown };
  /** The last event the Machine took while the Agent's state was the hold's, with work still running
   * below it, was no reply from below and no event a Machine sent itself at once: a timer the Machine
   * set, an event from outside the states below, a party's event, the Agent's own end. If the Machine
   * then left the Agent's state, the pick's route did not take it out: the exit stopped the work
   * below (`HeldAnswer.stopped`). An event a Machine sends itself at once (`sendTo(self)`; a `raise`
   * is never relayed) is part of the route of the event whose actions sent it and changes nothing
   * here; a reply clears it. */
  cutShort?: true;
  /** The answer, once the Machine is back at Rest or has left the Agent's state. */
  answer?: HeldAnswer;
  /** The answer reached the model: the poll read it, or a re-admission carried it (ADR-0031). */
  fetched?: boolean;
};

/** A pick's answer from what the Machine did since it: the author's `answer` when one ran, else the
 * last reply; undefined when neither — the answer then carries no reply. */
export function answerOf(record: {
  chain?: readonly PickAnswer[];
  shaped?: { value: unknown };
}): PickAnswer | undefined {
  if (record.shaped !== undefined) return { kind: "answer", value: record.shaped.value };
  return record.chain?.at(-1);
}

/** The answer to an outstanding pick: the receipt's facts at the moment of Rest (ADR-0024). */
export type HeldAnswer = {
  /** The Machine left the Agent's state: the Turn is over. */
  turnComplete: boolean;
  /** The Allowed picks read AFTER the route (ADR-0029); empty once the Turn is over. */
  allowed: string[];
  /** The last reply since the pick — kept when the work was stopped after an earlier link replied. */
  answer?: PickAnswer;
  /** With `turnComplete`: something other than the pick's route left the Agent's state while the
   * pick's work ran, and that exit stopped the work before it finished (`Hold.cutShort`). */
  stopped?: true;
};

/**
 * The reply one event is, when the invoking Machine receives it during a hold — or undefined when it
 * is no reply. Rest, the answer and the ledger are computed over the SET of active states below the
 * Agent's state (`seat`), so a reply comes from below it:
 *
 *   - from a child invoked on an active state below the seat (`source` is that child: its end, or an
 *     event it sends its parent), or
 *   - from a party seated below it: a Gate whose invoke id, or an Agent whose slot, is invoked on an
 *     active state below the seat (the event's `sender`, ADR-0015).
 *
 * Everything else is skipped: the Machine's own events (`source` is the Machine itself: a `raise`, a
 * `sendTo(self)`, a timer), an xstate event other than a child's output — a child's error
 * (`xstate.error.actor.*`) is a defect, never a reply, so its message never reaches the model — and
 * an event from outside the set: a Gate in a sibling region, a root Gate, an outside `jr2 send`.
 * Read it as the event is relayed, before the Machine processes it: the states the reply came from are still active. A
 * child is named by its slot (`src`) where it has one, else by its invoke id.
 */
export function replyOf(
  event: AnyEventObject,
  source: AnyActorRef | undefined,
  machine: AnyActorRef,
  seat: Node,
): PickAnswer | undefined {
  if (source === machine) return undefined;
  const below = activeBelow(machine.getSnapshot() as AnyMachineSnapshot, seat).flatMap((node) => node.invoke);
  const sender = (event as { [SENDER_KEY]?: Sender })[SENDER_KEY];
  const fromChild = source !== undefined && below.some((inv) => inv.id === source.id);
  const fromParty =
    sender !== undefined &&
    below.some((inv) => (sender.party === "gate" ? inv.id === sender.id : inv.src === sender.id));
  if (!fromChild && !fromParty) return undefined;
  const done = /^xstate\.done\.actor\.(.+)$/.exec(event.type);
  if (done) {
    const src = (source as { src?: unknown } | undefined)?.src;
    const actor = typeof src === "string" ? src : done[1]!;
    return { kind: "output", actor, output: (event as { output?: unknown }).output };
  }
  if (event.type.startsWith("xstate.")) return undefined;
  const payload = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type" && key !== SENDER_KEY));
  return { kind: "event", event: event.type, ...(sender ? { sender: { ...sender } } : {}), payload };
}

/**
 * The error one event is, when it is a child's error from below the Agent's state (`seat`) — or
 * undefined. It is no reply (`replyOf`): the Agent is not told by default, and the operator reads it
 * on the run's feed (ADR-0024). The child is named as `replyOf` names it.
 */
export function childErrorOf(
  event: AnyEventObject,
  source: AnyActorRef | undefined,
  machine: AnyActorRef,
  seat: Node,
): { child: string; error: string } | undefined {
  const failed = /^xstate\.error\.actor\.(.+)$/.exec(event.type);
  if (!failed || source === undefined || source === machine) return undefined;
  const below = activeBelow(machine.getSnapshot() as AnyMachineSnapshot, seat).flatMap((node) => node.invoke);
  if (!below.some((inv) => inv.id === source.id)) return undefined;
  const src = (source as { src?: unknown }).src;
  const error = (event as { error?: unknown }).error;
  return {
    child: typeof src === "string" ? src : failed[1]!,
    error: error instanceof Error ? error.message : String(error),
  };
}
