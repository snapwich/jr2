// The held answer (ADR-0024, ADR-0013): a pick that moves the workflow to a state inside the Agent's
// state is answered when the workflow is back at Rest there (rest.ts). Until then the pick is
// OUTSTANDING: its POST answered at once with a delivery id, and the Harness long-polls
// `GET /agents/:iid/deliveries/:id` for the answer, inside the one tool call.
//
// A hold is plain data on the run (`RunBlob.holds`), saved with the snapshot, so a park or an
// Orchestrator restart is a longer wait in the same Turn: the restored host reads the same Rest off
// the restored Machine, and answers the same poll. What a hold keeps beside the delivery id is the
// LAST reply from below the Agent's state since the pick (`last`) — the answer's default — because the
// events that carried it are gone after a restart.
//
// The answer is the last reply since the pick, rendered by the Harness: a party's event (a Gate's
// answer, a nested Agent's pick) with its payload, or a child's output (a child Machine, an Effect
// stand-in). A chain link is a reply from below the Agent's state — from the set of active states
// under it, never from a sibling region or the root; the events the Machine sent itself (`raise`,
// `sendTo(self)`, a timer) are skipped. With no link, the pick moved the workflow and nothing ran.

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
  /** The last reply since the pick: the answer's default. */
  last?: PickAnswer;
  /** The last event the Machine took while the Agent's state was the hold's was no reply from below
   * it. If the Machine then left the Agent's state, the pick's route did not take it out: the exit
   * stopped the work below (a timer that leaves, an outside event, the Agent's own end). */
  cutShort?: true;
  /** The answer, once the Machine is back at Rest or has left the Agent's state. */
  answer?: HeldAnswer;
  /** The answer reached the model: the poll read it, or a re-admission carried it (ADR-0031). */
  fetched?: boolean;
};

/** The answer to an outstanding pick: the receipt's facts at the moment of Rest (ADR-0024). */
export type HeldAnswer = {
  /** The Machine left the Agent's state: the Turn is over. */
  turnComplete: boolean;
  /** The Allowed picks read AFTER the route (ADR-0029); empty once the Turn is over. */
  allowed: string[];
  answer?: PickAnswer;
  /** The Machine left the Agent's state while the work ran: the exit stopped it (`cutShort`). */
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
 * `sendTo(self)`, a timer), an xstate event other than a child's end, and an event from outside the
 * set — a Gate in a sibling region, a root Gate, an outside `jr2 send`. Read it as the event is
 * relayed, before the Machine processes it: the states the reply came from are still active. A
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
  const done = /^xstate\.(done|error)\.actor\.(.+)$/.exec(event.type);
  if (done) {
    const src = (source as { src?: unknown } | undefined)?.src;
    const actor = typeof src === "string" ? src : done[2]!;
    if (done[1] === "done") return { kind: "output", actor, output: (event as { output?: unknown }).output };
    const error = (event as { error?: unknown }).error;
    return { kind: "error", actor, error: error instanceof Error ? error.message : String(error) };
  }
  if (event.type.startsWith("xstate.")) return undefined;
  const payload = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type" && key !== SENDER_KEY));
  return { kind: "event", event: event.type, ...(sender ? { sender: { ...sender } } : {}), payload };
}
