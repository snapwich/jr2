// Parties and their writings (ADR-0015, ADR-0029). A party is who may send a workflow event into a
// Machine: an Agent, through its Menu, or a Gate's caller. Every event a party delivers carries
// `sender: { party, id }` (ADR-0011) — the Agent's slot, or the Gate's invoke id.
//
// What an author writes with it: `guard: sentBy("coder")` on a writing — one `on` key on one state.
// A NAMED guard with params, `{ type: "jr2.sentBy", params: { id } }`, so the load walk can read it.
// It is false for an event another party sent, and true for the named party's event and for the
// Machine's own (no sender). xstate's own rule does the rest: a false guard on the deepest writing
// lets selection move outward. It can only make a writing DECLINE other senders; it never gives a
// writing to a party — position does that (`mayTake`).

import type { AnyEventObject, AnyStateMachine } from "xstate";
import { SENDER_KEY, type Sender } from "@jr2/agent-protocol";
import { isAgent } from "./agent.ts";

/** The guard type `sentBy` names: dotted, so no author guard can take the name. */
export const SENT_BY = "jr2.sentBy";

/** A writing runs for this party's events, and for the Machine's own: `guard: sentBy("coder")`. The
 * id is an Agent slot, or a Gate's invoke id, of this Machine — an unknown id is refused at load. */
export function sentBy<const Id extends string>(id: Id): { type: typeof SENT_BY; params: { id: Id } } {
  return { type: SENT_BY, params: { id } };
}

/** The implementation `jr2Setup` registers under {@link SENT_BY}. */
export function sentByGuard({ event }: { event: AnyEventObject }, params: { id: string }): boolean {
  const sender = (event as { [SENDER_KEY]?: Sender })[SENDER_KEY];
  return sender === undefined || sender.id === params.id;
}

/**
 * The ids a writing's guard names with `sentBy`, read statically: the guard itself, or a member of
 * xstate's `and([...])` — a conjunct, so the writing declines whatever it declines. Under `or()` or
 * `not()` a `sentBy` says nothing certain about the writing, so it is not read (`opaque`); neither
 * is an author's own guard that reads `event.sender`. Undefined when no `sentBy` is readable.
 */
export function sentByIds(guard: unknown): { ids: string[]; opaque: boolean } | undefined {
  if (guard && typeof guard === "object" && (guard as { type?: unknown }).type === SENT_BY) {
    return { ids: [String((guard as { params: { id: string } }).params.id)], opaque: false };
  }
  const members = typeof guard === "function" ? (guard as { guards?: unknown }).guards : undefined;
  if (Array.isArray(members)) {
    const named = members.map(sentByIds).filter((m) => m !== undefined);
    if (named.length === 0) return undefined;
    if (guard instanceof Function && guard.name !== "and") return { ids: [], opaque: true };
    return { ids: [...new Set(named.flatMap((m) => m.ids))], opaque: named.some((m) => m.opaque) };
  }
  return undefined;
}

/** Does this guard (one candidate of a writing) decline `senderId`'s events, by its `sentBy`, for
 * sure? `and([sentBy(a), sentBy(b)])` with a ≠ b declines every party. */
export function declines(guard: unknown, senderId: string): boolean {
  const named = sentByIds(guard);
  if (!named || named.opaque) return false;
  return named.ids.some((id) => id !== senderId);
}

type Node = AnyStateMachine["root"];

/** The parties a built state invokes, each as the sender it delivers as. */
export function partiesAt(node: Node, machine: AnyStateMachine): Sender[] {
  const actors = (machine.implementations.actors ?? {}) as Record<string, unknown>;
  const out: Sender[] = [];
  for (const inv of node.invoke) {
    if (typeof inv.src !== "string") continue;
    if (inv.src === "gate") out.push({ party: "gate", id: inv.id });
    else if (isAgent(actors[inv.src])) out.push({ party: "agent", id: inv.src });
  }
  return out;
}

/** Every built state node, document order. */
export function allNodes(machine: AnyStateMachine): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    out.push(node);
    for (const child of Object.values(node.states)) visit(child);
  };
  visit(machine.root);
  return out;
}

/** The Agent slots and Gate invoke ids of a Machine: every id a `sentBy` may name. */
export function senderIds(machine: AnyStateMachine): { agents: Set<string>; gates: Set<string> } {
  const agents = new Set<string>();
  const gates = new Set<string>();
  for (const node of allNodes(machine))
    for (const p of partiesAt(node, machine)) (p.party === "agent" ? agents : gates).add(p.id);
  return { agents, gates };
}

/**
 * Refuse a `sentBy` that names no party of this Machine — an Agent slot or a Gate's invoke id — at
 * load, like an unknown event key (ADR-0015): a typo would decline every sender, and the writing
 * would run for none.
 */
export function refuseUnknownSentBy(machine: AnyStateMachine): void {
  const { agents, gates } = senderIds(machine);
  for (const node of allNodes(machine)) {
    for (const [name, candidates] of node.transitions) {
      for (const candidate of candidates) {
        for (const id of sentByIds((candidate as { guard?: unknown }).guard)?.ids ?? []) {
          if (agents.has(id) || gates.has(id)) continue;
          throw new Error(
            `machine "${machine.id}": sentBy("${id}") on "${name}" at "${node.id}" names no party of this Machine ` +
              `(Agent slots: ${[...agents].join(", ") || "none"}; Gate invoke ids: ${[...gates].join(", ") || "none"})`,
          );
        }
      }
    }
  }
}
