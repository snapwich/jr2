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
//
// What jr2 computes with it:
//   - `mayTake`: may this sender take this writing? ADR-0015's position rule, per writing.
//   - `takesNow`: an Agent's Allowed picks and a Gate's `acceptsNow`, payload-blind (ADR-0029).
//   - `notTaken`: at delivery, exact — a delivery whose selection holds another party's writing is
//     refused before the Machine sees it.
//   - `partyWarnings`: the load walk's warnings over parties and writings.

import type { AnyActorRef, AnyEventObject, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { SENDER_KEY, type Sender } from "@jr2/agent-protocol";
import { isAgent } from "./agent.ts";
import { vocabularyOf } from "./vocabulary.ts";

/** The guard type `sentBy` names: dotted, so no author guard can take the name. */
export const SENT_BY = "jr2.sentBy";

/**
 * A guard that is true for an event that one party sent, and false for an event that another party
 * sent: `guard: sentBy("coder")`. Use it where two parties may send the same event to one state,
 * and the transition must run for one of them only. It is also true for an event that the Machine
 * sends itself, which has no sender.
 *
 * It can only make a transition decline the events of other parties. It never lets a party send
 * an event that the party may not send at that state: the position of the `on` key decides that.
 * When the guard is false, xstate tries the next transition for the event, as for any guard. Use
 * it alone, or inside `and([…])`.
 *
 * `createMachine` refuses an id that is not a party of the Machine: ``machine "<id>":
 * sentBy("<party>") on "<event>" at "<state>" names no party of this Machine (Agent slots:
 * <slots>; Gate invoke ids: <ids>)``
 *
 * @param id - The party: the slot key of an Agent of this Machine, or the invoke `id` of one of its
 *   Gates.
 * @returns A named guard object, for a transition's `guard`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, jr2Setup, sentBy } from "@jr2/orchestrator";
 *
 * const done = defineEvent({
 *   name: "done",
 *   description: "Call this when the draft is ready for review.",
 *   input: z.object({}),
 * });
 *
 * export const machine = jr2Setup({
 *   events: [done],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You write release notes.",
 *       workspace: "none",
 *     }),
 *   },
 * }).createMachine({
 *   id: "notes",
 *   initial: "drafting",
 *   states: {
 *     drafting: {
 *       invoke: [
 *         { src: "writer", input: { prompt: "Draft the release notes." } },
 *         { src: "gate", id: "editor" },
 *       ],
 *       on: {
 *         // The writer's `done` goes to review; the editor's `done` skips it.
 *         done: [{ guard: sentBy("writer"), target: "review" }, { target: "published" }],
 *       },
 *     },
 *     review: { invoke: { src: "gate" }, on: { done: "published" } },
 *     published: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/the-menu.md
 * @see docs/concepts/gates.md
 * @see docs/reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md
 */
export function sentBy<const Id extends string>(id: Id): { type: typeof SENT_BY; params: { id: Id } } {
  // A NAMED guard with params, so the load walk can read it (see the module header). The id is
  // refused at load by `refuseUnknownSentBy` when no Agent slot or Gate invoke id has it.
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

const isAncestorOrSelf = (a: Node, b: Node): boolean => {
  for (let n: Node | undefined = b; n; n = n.parent) if (n === a) return true;
  return false;
};

/** The nearest state at or above `node` that invokes a party; undefined when none does. */
export function ownerOf(node: Node, machine: AnyStateMachine): Node | undefined {
  for (let n: Node | undefined = node; n; n = n.parent) if (partiesAt(n, machine).length) return n;
  return undefined;
}

/**
 * The state whose invoke registered `invokeId` — the seat its registration speaks for. Two states
 * may author one invoke id when they are never active together; the active one is the seat.
 */
export function seatOf(snapshot: AnyMachineSnapshot, invokeId: string): Node | undefined {
  const machine = snapshot.machine as AnyStateMachine;
  const found = allNodes(machine).filter((node) => node.invoke.some((inv) => inv.id === invokeId));
  if (found.length <= 1) return found[0];
  const active = new Set((snapshot as { _nodes?: Node[] })._nodes ?? []);
  return found.find((node) => active.has(node)) ?? found[0];
}

/**
 * May `sender`, seated at `seat`, take the writing of `type` on `source` (ADR-0015, per writing)?
 *
 * In reach: the seat or a state above it, or a state below it with no party-invoking state between
 * — an Agent's modes, and a Gate's plain children, which the same position rule gives the Gate.
 * And owned: an unset audience gives a writing to the party of the nearest party-invoking state at
 * or above it (none: both parties); an explicit audience gives it, by kind, to every party whose
 * reach holds it. `sentBy` plays no part here: it can decline, never give.
 */
export function mayTake(machine: AnyStateMachine, sender: Sender, seat: Node, source: Node, type: string): boolean {
  let inReach = isAncestorOrSelf(source, seat);
  if (!inReach && isAncestorOrSelf(seat, source)) {
    inReach = true;
    for (let n: Node | undefined = source; n && n !== seat; n = n.parent)
      if (partiesAt(n, machine).length) inReach = false;
  }
  if (!inReach) return false;
  const audience = vocabularyOf(machine)?.get(type)?.audience;
  if (audience !== undefined)
    return audience === "any" || audience === (sender.party === "agent" ? "agent" : "external");
  const owner = ownerOf(source, machine);
  return owner === undefined || owner === seat;
}

// --- Selection: what xstate would run, payload-blind ---------------------------------------------
//
// A copy of xstate 5.32.2's `transitionNode` / `StateNode.next` / `evaluateGuard`, with one change:
// each guard is asked behind a Proxy, and a guard that read the payload answers UNKNOWN, which
// passes. `type` and `sender` are not payload. `and` / `or` / `not` are evaluated here over their
// members in three-valued logic, so `and([payloadGuard, sentBy("other")])` still declines. Pinned
// against xstate's own `getTransitionData` in `party-xstate.test.ts`: an xstate bump that changes
// selection fails there first.

type Tri = true | false | "unknown";
type Transition = ReturnType<AnyStateMachine["getTransitionData"]>[number];

function evalGuard(
  guard: unknown,
  snapshot: AnyMachineSnapshot,
  event: AnyEventObject,
  read: { payload: boolean },
): Tri {
  const machine = snapshot.machine as AnyStateMachine;
  const isInline = typeof guard === "function";
  const key = typeof guard === "string" ? guard : (guard as { type?: string }).type;
  const resolved: unknown = isInline ? guard : (machine.implementations.guards as Record<string, unknown>)[key!];
  if (!isInline && !resolved) throw new Error(`Guard '${key}' is not implemented.`);
  if (typeof resolved !== "function") return evalGuard(resolved, snapshot, event, read);
  const context = snapshot.context;
  const members = (resolved as { guards?: unknown[] }).guards;
  if ("check" in resolved && Array.isArray(members)) {
    const values = members.map((m) => evalGuard(m, snapshot, event, read));
    if (resolved.name === "and") return values.includes(false) ? false : values.includes("unknown") ? "unknown" : true;
    if (resolved.name === "or") return values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
    if (resolved.name === "not") return values[0] === "unknown" ? "unknown" : !values[0];
  }
  const params =
    isInline || typeof guard === "string" || !("params" in (guard as object))
      ? undefined
      : typeof (guard as { params: unknown }).params === "function"
        ? (guard as { params: (a: unknown) => unknown }).params({ context, event })
        : (guard as { params: unknown }).params;
  const before = read.payload;
  read.payload = false;
  const value =
    "check" in resolved
      ? (resolved as { check: (s: unknown, a: unknown, r: unknown) => boolean }).check(
          snapshot,
          { context, event },
          resolved,
        )
      : (resolved as (a: unknown, p: unknown) => boolean)({ context, event }, params);
  const looked = read.payload;
  read.payload = before || looked;
  return looked ? "unknown" : Boolean(value);
}

/** xstate's `getCandidates` for a name with no dot: the exact writing, then the wildcard. */
function candidates(node: Node, type: string): Transition[] {
  return [
    ...((node.transitions.get(type) ?? []) as Transition[]),
    ...((node.transitions.get("*") ?? []) as Transition[]),
  ];
}

function next(node: Node, snapshot: AnyMachineSnapshot, event: AnyEventObject, read: { payload: boolean }) {
  for (const candidate of candidates(node, event.type)) {
    const guard = (candidate as { guard?: unknown }).guard;
    if (!guard || evalGuard(guard, snapshot, event, read) !== false) return [candidate];
  }
  return undefined;
}

function select(
  node: Node,
  value: unknown,
  snapshot: AnyMachineSnapshot,
  event: AnyEventObject,
  read: { payload: boolean },
): Transition[] | undefined {
  if (typeof value === "string") {
    const inner = next(node.states[value]!, snapshot, event, read);
    return inner?.length ? inner : next(node, snapshot, event, read);
  }
  const keys = Object.keys(value as object);
  if (keys.length === 1) {
    const inner = select(node.states[keys[0]!]!, (value as Record<string, unknown>)[keys[0]!], snapshot, event, read);
    return inner?.length ? inner : next(node, snapshot, event, read);
  }
  const all: Transition[] = [];
  for (const key of keys) {
    const sub = (value as Record<string, unknown>)[key];
    if (!sub) continue;
    all.push(...(select(node.states[key]!, sub, snapshot, event, read) ?? []));
  }
  return all.length ? all : next(node, snapshot, event, read);
}

/** The writings xstate would select for `type` from `sender`, every payload-reading guard passing. */
export function selectPayloadBlind(
  snapshot: AnyMachineSnapshot,
  type: string,
  sender: Sender | undefined,
): Transition[] {
  const read = { payload: false };
  const base: Record<string, unknown> = { type, ...(sender ? { [SENDER_KEY]: sender } : {}) };
  const watch = (prop: string | symbol): void => {
    if (typeof prop === "string" && prop !== "type" && prop !== SENDER_KEY) read.payload = true;
  };
  const probe = new Proxy(base, {
    get(target, prop, receiver) {
      watch(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      watch(prop);
      return Reflect.has(target, prop);
    },
  }) as AnyEventObject;
  const machine = snapshot.machine as AnyStateMachine;
  return select(machine.root, snapshot.value, snapshot, probe, read) ?? [];
}

/** xstate's `can()`: a selected writing that neither targets nor acts is not a move. */
const moves = (ts: Transition[]): boolean => ts.some((t) => t.target !== undefined || t.actions.length > 0);

/** What a registration needs to ask the party questions: who it sends as, its seat, its Machine. */
export type PartySeat = { sender?: Sender; invokeId?: string; invoker?: AnyActorRef };

function seated(reg: PartySeat): { machine: AnyStateMachine; seat: Node; snapshot: AnyMachineSnapshot } | undefined {
  if (!reg.sender || !reg.invokeId || !reg.invoker) return undefined;
  const snapshot = reg.invoker.getSnapshot() as AnyMachineSnapshot | undefined;
  const machine = snapshot?.machine as AnyStateMachine | undefined;
  if (!snapshot || !machine?.root) return undefined;
  const seat = seatOf(snapshot, reg.invokeId);
  return seat ? { machine, seat, snapshot } : undefined;
}

/**
 * Would the run take `type` from this registration's sender NOW, payload-blind (ADR-0029)? The one
 * question behind an Agent's Allowed picks and a Gate's `acceptsNow`: xstate's selection for an
 * event that carries the sender, a payload-reading guard counted as passing, must move something,
 * and every writing it selects must be one the sender may take. Undefined when the question cannot
 * be asked (no seat); the caller then asks `mayMove`. Fails open like ADR-0029's readings: a wrong
 * `true` costs one refused send, and delivery still judges it exactly.
 */
export function takesNow(reg: PartySeat, type: string): boolean | undefined {
  const at = seated(reg);
  if (!at) return undefined;
  try {
    const selected = selectPayloadBlind(at.snapshot, type, reg.sender);
    if (!moves(selected)) return false;
    return selected.every((t) => mayTake(at.machine, reg.sender!, at.seat, t.source, type));
  } catch {
    return true;
  }
}

/** A writing a delivery would run that its sender may not take: its state, and who owns it. */
export type NotTakenWriting = { state: string; owners: Sender[] };

/**
 * At delivery, exact: the writings xstate WILL select for this event (its real payload, its real
 * sender) that the sender may not take. Empty: deliver. Not empty: refuse before the Machine sees it.
 */
export function notTaken(reg: PartySeat, event: AnyEventObject): NotTakenWriting[] {
  const at = seated(reg);
  if (!at) return [];
  try {
    return at.machine
      .getTransitionData(at.snapshot, event)
      .filter((t) => !mayTake(at.machine, reg.sender!, at.seat, t.source, event.type))
      .map((t) => {
        const owner = ownerOf(t.source, at.machine);
        return { state: t.source.id, owners: owner ? partiesAt(owner, at.machine) : [] };
      });
  } catch {
    return [];
  }
}

// --- The load walk's warnings over parties and writings (ADR-0015) --------------------------------

/** Neither above the other, and their nearest common state is parallel: two regions. */
function orthogonal(a: Node, b: Node): boolean {
  if (isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a)) return false;
  for (let n: Node | undefined = a.parent; n; n = n.parent) if (isAncestorOrSelf(n, b)) return n.type === "parallel";
  return false;
}

/** Can the two states be active at the same time? */
const together = (a: Node, b: Node): boolean => isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a) || orthogonal(a, b);

/** One writing: one `on` key on one state, with its candidates (an array writing has several). */
type Writing = { node: Node; name: string; candidates: Transition[] };

function writingsOf(machine: AnyStateMachine): Writing[] {
  const defs = vocabularyOf(machine);
  const out: Writing[] = [];
  for (const node of allNodes(machine))
    for (const [name, candidates] of node.transitions)
      if (defs?.has(name) ?? (!name.includes(".") && name !== "*"))
        out.push({ node, name, candidates: candidates as Transition[] });
  return out;
}

const targetsOf = (w: Writing): string =>
  [...new Set(w.candidates.flatMap((t) => (t.target ?? []).map((target) => target.id)))].sort().join(", ");

/** The line the warning shows: the deeper writing, declining every sender but its own party. */
function correctedLine(w: Writing, id: string): string {
  const guard = `sentBy("${id}")`;
  const only = w.candidates.length === 1 ? w.candidates[0]! : undefined;
  const target = only?.target?.length === 1 ? `, target: "#${only.target[0]!.id}"` : ", …";
  const body =
    only === undefined
      ? `[{ guard: ${guard}, … }, …]  (on each candidate)`
      : only.guard === undefined
        ? `{ guard: ${guard}${target} }`
        : `{ guard: and([${guard}, <its guard>])${target} }`;
  return `  ${w.node.key}: { on: { ${w.name}: ${body} } }`;
}

/**
 * The load walk's party warnings (ADR-0015). Warnings, never refusals: the Machine is legal, and
 * delivery refuses what would misroute.
 *
 * - **Two parties' writings of one name that can be active together.** A seat — one party on its
 *   state — may take a writing of a name, and ANOTHER party's writing of that name can be active
 *   with the seat's state and is selected first: deeper on the same path, or in another parallel
 *   region. Unless that writing declines the seat's sender with `sentBy`, xstate selects it for
 *   the seat's event, delivery refuses the event, and the seat cannot send the name while it is
 *   active. The warning names both writings and shows the corrected line; the guard goes on the
 *   DEEPER writing, because xstate selects deepest first. A root writing is both parties', so the
 *   root-writing shape (a root `cancel`, a Gate below, the Agent's `cancel` in a mode) is the same
 *   case. Not when the seat is an Agent and the deeper writing's party is seated below the Agent's
 *   state: that state is busy while the party runs, so every Agent pick is refused there (ADR-0024).
 * - **One def, one meaning.** One party may take two writings of one name on one path with
 *   different targets: its sender reads one description for both.
 *
 * `derivedGateIds` are the Gate invoke ids the walk named: the line says how to name one instead.
 */
export function partyWarnings(machine: AnyStateMachine, derivedGateIds: ReadonlySet<string> = new Set()): string[] {
  const writings = writingsOf(machine);
  const seats = allNodes(machine).flatMap((node) => partiesAt(node, machine).map((sender) => ({ node, sender })));
  const warnings = new Map<string, string>();
  for (const seat of seats) {
    const reader =
      seat.sender.party === "agent" ? `Agent "${seat.sender.id}"` : `the caller of Gate "${seat.sender.id}"`;
    for (const own of writings) {
      if (!mayTake(machine, seat.sender, seat.node, own.node, own.name)) continue;
      for (const other of writings) {
        if (other.name !== own.name || other === own) continue;
        if (mayTake(machine, seat.sender, seat.node, other.node, other.name)) {
          // One def, one meaning: the same party, one path, different targets.
          if (!isAncestorOrSelf(own.node, other.node) || targetsOf(own) === targetsOf(other)) continue;
          warnings.set(
            `meaning:${seat.sender.party}:${seat.sender.id}:${own.name}:${own.node.id}:${other.node.id}`,
            `"${own.name}" is written for ${senderText(seat.sender)} on "${own.node.id}" (→ ${targetsOf(own) || "no target"}) ` +
              `and on "${other.node.id}" (→ ${targetsOf(other) || "no target"}): ${reader} reads one description for both ` +
              `— make the def's description true at each writing, or give them distinct names`,
          );
          continue;
        }
        const deeper = isAncestorOrSelf(own.node, other.node) && own.node !== other.node;
        const parallel = orthogonal(own.node, other.node);
        if ((!deeper && !parallel) || !together(seat.node, other.node)) continue;
        if (other.candidates.every((t) => declines((t as { guard?: unknown }).guard, seat.sender.id))) continue;
        const ownerNode = ownerOf(other.node, machine);
        // Under the Rest rule (ADR-0024) a party seated BELOW the Agent's state keeps that state
        // busy while it is active, so every pick of the Agent is refused there, whatever its guard:
        // the Agent never sends this name while the deeper writing is active, and no `sentBy` on it
        // would change that. Nothing to warn about.
        if (
          seat.sender.party === "agent" &&
          ownerNode !== undefined &&
          ownerNode !== seat.node &&
          isAncestorOrSelf(seat.node, ownerNode)
        )
          continue;
        const owners = ownerNode ? partiesAt(ownerNode, machine) : [];
        const owner = owners.find((p) => p.id !== seat.sender.id) ?? owners[0];
        const named = owner?.party === "gate" && derivedGateIds.has(owner.id);
        warnings.set(
          `party:${seat.sender.party}:${seat.sender.id}:${other.name}:${other.node.id}`,
          `"${own.name}" on "${own.node.id}" (${senderText(seat.sender)}) and on "${other.node.id}" ` +
            `(${owners.map(senderText).join(" and ")}) can be active together${parallel ? " (parallel regions)" : ""}; ` +
            `${senderText(seat.sender)}'s "${own.name}" would run ${owner ? `${senderText(owner)}'s` : "the other"} writing` +
            `${parallel ? " too" : ""}, so jr2 refuses it while both are active. Make the ` +
            `${parallel ? `writing on "${other.node.id}"` : "deeper writing"} decline other senders:\n` +
            correctedLine(other, owner?.id ?? "<its party>") +
            (named
              ? `\n(the Gate's invoke id "${owner!.id}" is derived from its state; give its invoke an \`id\` to name it)`
              : ""),
        );
      }
    }
  }
  return [...warnings.values()];
}

/** How a sender reads in a message: `Agent "coder"`, `Gate "review"`. */
export const senderText = (s: Sender): string => (s.party === "agent" ? `Agent "${s.id}"` : `Gate "${s.id}"`);
