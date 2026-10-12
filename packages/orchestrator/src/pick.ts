// What an author writes between a pick and the work it starts (ADR-0067). All three are optional:
// plain xstate — an input mapper, no answer — is legal.
//
//   - `fromPick(def, fill)` — the `input` of a state a pick enters. The pick's params flow into the
//     invoked actor's input BY NAME; `fill` returns only what the MACHINE adds. So the security
//     boundary reads in one expression: the def is what the Agent supplies, `fill` is what the
//     Machine adds, and the sum is checked against the invoked actor's input type — for a missing or
//     mistyped key only: TypeScript accepts an extra key on a spread. The load walk refuses the rest
//     (effect-checks.ts): a param that is no key of an Effect's input and that `fill` does not read,
//     and a param `fill` overwrites.
//   - `paramsOf(event, def)` — the same params, for a plain mapper that wants them.
//   - `answer(fn)` — an xstate action that sets what the Agent reads when its pick is answered
//     (ADR-0024). Absent, it reads the last reply since the pick. `fn` gets `{ context, event, chain }`:
//     `chain` is every reply since the pick, oldest first, each typed by its slot and its kind. Its
//     order and length are run-time facts, not typed. Last call wins. It runs where xstate runs it —
//     a `rest`-entry `answer` runs only when a route enters `rest` again.

import type {
  ActionFunction,
  AnyActorRef,
  AnyMachineSnapshot,
  AnyStateMachine,
  EventObject,
  MachineContext,
  OutputFrom,
  ParameterizedObject,
  ProvidedActor,
} from "xstate";
import type { z } from "zod";
import { SENDER_KEY, type EventDef, type Sender } from "@jr2/agent-protocol";
import { isAgent } from "./agent.ts";
import { boundRun } from "./registration.ts";
import type { PickAnswer } from "./wire.ts";

/** The pick's params, read off the event that entered the state. Throws — a jr2 or author defect
 * the load walk refuses first — when the event is not this pick. */
export function paramsOf<N extends string, I extends z.ZodObject>(event: EventObject, def: EventDef<N, I>): z.infer<I> {
  if (event.type !== def.name) {
    throw new Error(`state entered by "${event.type}", but its input reads the params of pick "${def.name}"`);
  }
  const { type: _type, [SENDER_KEY]: _sender, ...payload } = event as EventObject & Record<string, unknown>;
  return def.input.parse(payload);
}

/** The brand `fromPick` puts on the mapper it returns: the pick whose params it reads, and the
 * `fill` the load walk probes. */
export type PickMapper = {
  readonly pick: EventDef;
  readonly fill?: (args: { context: unknown; params: unknown }) => unknown;
};

/** Is this invoke input a `fromPick` mapper? */
export function isPickMapper(value: unknown): value is PickMapper & ((args: unknown) => unknown) {
  return typeof value === "function" && "pick" in value;
}

export function fromPick<N extends string, I extends z.ZodObject, C, E extends EventObject>(
  def: EventDef<N, I>,
): (args: { context: C; event: E; self: AnyActorRef }) => z.infer<I>;
export function fromPick<N extends string, I extends z.ZodObject, C, E extends EventObject, R extends object>(
  def: EventDef<N, I>,
  fill: (args: { context: C; params: z.infer<I> }) => R,
): (args: { context: C; event: E; self: AnyActorRef }) => z.infer<I> & R;
export function fromPick<N extends string, I extends z.ZodObject, C, E extends EventObject, R extends object>(
  def: EventDef<N, I>,
  fill?: (args: { context: C; params: z.infer<I> }) => R,
) {
  const mapper = ({ context, event }: { context: C; event: E; self: AnyActorRef }) => {
    const params = paramsOf(event, def);
    return fill ? { ...params, ...fill({ context, params }) } : params;
  };
  return Object.assign(mapper, { pick: def, ...(fill ? { fill } : {}) });
}

/**
 * One reply since the pick, as the author reads it: an invoked actor's output, typed by its slot
 * (`src`); or an event that answered a state below the Agent's — a Gate's answer, a nested Agent's
 * pick — typed by the Machine's events. A reply is from outside the Machine: the events it sends
 * itself are not links.
 */
export type ChainLink<TActor extends ProvidedActor, TEvent extends EventObject> =
  | (TActor extends unknown ? { kind: "output"; src: TActor["src"]; output: OutputFrom<TActor["logic"]> } : never)
  | { kind: "event"; event: Exclude<TEvent, { type: `${string}.${string}` }> };

/** The chain as the author reads it, from the replies the run host recorded. */
function linksOf(chain: readonly PickAnswer[]): unknown[] {
  return chain.flatMap((link): unknown[] => {
    if (link.kind === "output") return [{ kind: "output", src: link.actor, output: link.output }];
    if (link.kind === "event") {
      const sender: Sender | undefined = link.sender;
      return [
        { kind: "event", event: { type: link.event, ...link.payload, ...(sender ? { [SENDER_KEY]: sender } : {}) } },
      ];
    }
    return [];
  });
}

type Node = AnyStateMachine["root"];

/**
 * Where an `answer` is written, as the Agents' states it is below: for each place the action is
 * written (a state's entry or exit, a transition on a state, a state's initial transition), the
 * nearest state at or above it that invokes an Agent — `null` for a transition where none does; an
 * entry or exit below no Agent's state seats nowhere. Read once per Machine, by the action's
 * identity: one `answer` object written in two places carries both. At run time each place runs as
 * its own seat (`placeAnswers`): an `answer` cannot tell where it was written, so the place is
 * decided before the Machine runs.
 */
export type AnswerSeats = ReadonlySet<Node | null>;

/**
 * The one place an `answer` runs from (ADR-0067): the Agent's state it is written below, or `null`
 * on a transition below no Agent's state. At a state, it shapes only a pick of the Agent seated
 * there. At `null`, the event that took the transition names the Agent whose pick it shapes (the run
 * host reads it off the event).
 */
export type AnswerSeat = Node | null;

const seatsCache = new WeakMap<AnyStateMachine, Map<unknown, Set<Node | null>>>();

/** How an `answer` makes the copy of itself that runs from one seat. */
const PLACE = Symbol("jr2.answer.place");
type Placeable = { [PLACE]: (seat: AnswerSeat) => unknown; readonly jr2Answer: true };

/** An action of `machine` as it is written — inline, or by name — resolved to its implementation. */
function resolverOf(machine: AnyStateMachine): (a: unknown) => unknown {
  const named = (machine.implementations?.actions ?? {}) as Record<string, unknown>;
  return (a) => {
    const type = typeof a === "string" ? a : typeof a === "object" && a !== null ? (a as { type?: unknown }).type : a;
    return typeof type === "string" ? named[type] : a;
  };
}

/** The nearest state at or above `n` that invokes one of `machine`'s Agents, or `null`. */
function seatFinderOf(machine: AnyStateMachine): (n: Node) => Node | null {
  const actors = (machine.implementations?.actors ?? {}) as Record<string, unknown>;
  return (n) => {
    for (let p: Node | undefined = n; p; p = p.parent)
      if (p.invoke.some((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))) return p;
    return null;
  };
}

/** The `answer` a placed copy was made from: the identity `seatsOfAnswer` groups places by. */
const originals = new WeakMap<object, unknown>();
const originalOf = (fn: unknown): unknown => (typeof fn === "function" ? (originals.get(fn) ?? fn) : fn);

/** What stands where `original` was written on an entry or an exit below no Agent's state: an
 * `answer` that runs nothing. Still an `answer` to the load walk, which warns on it. */
function unseatedAnswer(original: unknown): AnswerAction & (() => void) {
  const copy = Object.assign(function unseatedAnswer(): void {}, { jr2Answer: true as const });
  originals.set(copy, original);
  return copy;
}

const placedMachines = new WeakSet<AnyStateMachine>();

/**
 * Give every place an `answer` is written in `machine` a copy of its own, bound to that place's
 * seat (ADR-0067): one action object written in two places then shapes, from each, by that place's
 * rule alone — below an Agent's state, only that Agent's pick; on a transition below none, the pick
 * of the Agent the event names. An entry or an exit below no Agent's state is given an `answer` that
 * sets nothing. At run time an action cannot tell where it was written, so the place is decided
 * here. Called for each Machine of a run's tree as its actor is created, before its first state is
 * entered. Each list is replaced, never written in place: a list the author shared between two
 * places stays the author's.
 */
export function placeAnswers(machine: AnyStateMachine): void {
  if (placedMachines.has(machine) || !machine?.root) return;
  placedMachines.add(machine);
  const resolve = resolverOf(machine);
  const seatAbove = seatFinderOf(machine);
  const placed = (list: readonly unknown[], seat: AnswerSeat | "nowhere"): unknown[] =>
    list.map((a) => {
      const fn = resolve(a);
      if (!isAnswer(fn)) return a;
      if (seat === "nowhere") return unseatedAnswer(originalOf(fn));
      const original = originalOf(fn) as Partial<Placeable>;
      return typeof original[PLACE] === "function" ? original[PLACE](seat) : fn;
    });
  const visit = (n: Node): void => {
    const seat = seatAbove(n);
    const writable = n as unknown as { entry: unknown[]; exit: unknown[] };
    writable.entry = placed(n.entry, seat ?? "nowhere");
    writable.exit = placed(n.exit, seat ?? "nowhere");
    const transitions = [
      ...[...n.transitions.values()].flat(),
      ...(n.always ?? []),
      ...(n.initial ? [n.initial] : []),
    ] as unknown as { actions: readonly unknown[] }[];
    for (const t of new Set(transitions)) t.actions = placed(t.actions, seat);
    for (const child of Object.values(n.states)) visit(child);
  };
  visit(machine.root);
}

export function seatsOfAnswer(machine: AnyStateMachine, action: unknown): AnswerSeats {
  let byAction = seatsCache.get(machine);
  if (byAction === undefined) {
    byAction = new Map();
    seatsCache.set(machine, byAction);
    const resolve = resolverOf(machine);
    const seatAbove = seatFinderOf(machine);
    const visit = (n: Node): void => {
      const seat = seatAbove(n);
      const onEntryOrExit = [...n.entry, ...n.exit];
      const onTransition = [
        ...[...n.transitions.values()].flat().flatMap((t) => t.actions),
        ...(n.always ?? []).flatMap((t) => t.actions),
        ...(n.initial?.actions ?? []),
      ];
      const note = (a: unknown, seated: boolean): void => {
        const fn = resolve(a);
        if (!isAnswer(fn)) return;
        const key = originalOf(fn);
        const seats = byAction!.get(key) ?? new Set<Node | null>();
        if (seated) seats.add(seat);
        byAction!.set(key, seats);
      };
      // An entry or exit below no Agent's state is no transition an Agent's event takes: it seats
      // nowhere, and runs nothing (`placeAnswers`, ADR-0067).
      for (const a of onEntryOrExit) note(a, seat !== null);
      for (const a of onTransition) note(a, true);
      for (const child of Object.values(n.states)) visit(child);
    };
    if (machine?.root) visit(machine.root);
  }
  return byAction.get(originalOf(action)) ?? new Set<Node | null>([null]);
}

/** The brand the load walk reads: this action is an `answer`. */
export type AnswerAction = { readonly jr2Answer: true };

/** Is this action an `answer`? */
export const isAnswer = (action: unknown): boolean =>
  typeof action === "function" && (action as Partial<AnswerAction>).jr2Answer === true;

export function answer<
  TContext extends MachineContext,
  TExpressionEvent extends EventObject,
  TParams extends ParameterizedObject["params"] | undefined,
  TEvent extends EventObject,
  TActor extends ProvidedActor,
>(
  fn: (args: { context: TContext; event: TExpressionEvent; chain: readonly ChainLink<TActor, TEvent>[] }) => unknown,
): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, TActor, never, never, never, never> & AnswerAction {
  // The action as it runs from one seat (`placeAnswers`): the Agent's state it is written below, or
  // `null` on a transition below none. The object the author holds runs as `null`: the walk found it
  // in no place it could seat (an action another action enqueues).
  const at =
    (seat: AnswerSeat) =>
    ({ context, event, self }: { context: TContext; event: TExpressionEvent; self: AnyActorRef }) => {
      const binding = boundRun(self.system);
      // No pick of an Agent this seat reads is being answered (the state's first entry, a later
      // Turn's, another Agent's): there is nothing to shape, and nothing runs.
      const chain = binding?.chainOf?.(self, seat, event);
      if (chain === undefined) return;
      // Kit-internal: the host records links by slot name, which is what ChainLink states.
      const links = linksOf(chain) as unknown as readonly ChainLink<TActor, TEvent>[];
      binding?.setAnswer?.(self, seat, fn({ context, event, chain: links }), event);
    };
  const action = at(null);
  const place = (seat: AnswerSeat): unknown => {
    const copy = Object.assign(at(seat), { jr2Answer: true as const });
    originals.set(copy, action);
    return copy;
  };
  return Object.assign(action, { jr2Answer: true as const, [PLACE]: place }) as unknown as ActionFunction<
    TContext,
    TExpressionEvent,
    TEvent,
    TParams,
    TActor,
    never,
    never,
    never,
    never
  > &
    AnswerAction;
}
