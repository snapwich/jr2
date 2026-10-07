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
 * nearest state at or above it that invokes an Agent — `null` where none does. An `answer` shapes
 * only a pick of an Agent seated at one of these (ADR-0067); one written above every Agent's state
 * (`null`) may shape any. Read once per Machine, by the action's identity: one `answer` object
 * written in two places carries both.
 */
export type AnswerSeats = ReadonlySet<Node | null>;

const seatsCache = new WeakMap<AnyStateMachine, Map<unknown, Set<Node | null>>>();

export function seatsOfAnswer(machine: AnyStateMachine, action: unknown): AnswerSeats {
  let byAction = seatsCache.get(machine);
  if (byAction === undefined) {
    byAction = new Map();
    seatsCache.set(machine, byAction);
    const actors = (machine.implementations?.actors ?? {}) as Record<string, unknown>;
    const named = (machine.implementations?.actions ?? {}) as Record<string, unknown>;
    const resolve = (a: unknown): unknown => {
      const type = typeof a === "string" ? a : typeof a === "object" && a !== null ? (a as { type?: unknown }).type : a;
      return typeof type === "string" ? named[type] : a;
    };
    const seatAbove = (n: Node): Node | null => {
      for (let p: Node | undefined = n; p; p = p.parent)
        if (p.invoke.some((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))) return p;
      return null;
    };
    const visit = (n: Node): void => {
      const written = [
        ...n.entry,
        ...n.exit,
        ...[...n.transitions.values()].flat().flatMap((t) => t.actions),
        ...(n.always ?? []).flatMap((t) => t.actions),
        ...(n.initial?.actions ?? []),
      ];
      for (const a of written) {
        const fn = resolve(a);
        if (!isAnswer(fn)) continue;
        const seats = byAction!.get(fn) ?? new Set<Node | null>();
        seats.add(seatAbove(n));
        byAction!.set(fn, seats);
      }
      for (const child of Object.values(n.states)) visit(child);
    };
    if (machine?.root) visit(machine.root);
  }
  return byAction.get(action) ?? new Set<Node | null>([null]);
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
  const action = ({ context, event, self }: { context: TContext; event: TExpressionEvent; self: AnyActorRef }) => {
    const binding = boundRun(self.system);
    // The Agents' states this action is written below: it shapes only a pick of one of those.
    const seats = seatsOfAnswer((self.getSnapshot() as AnyMachineSnapshot).machine as AnyStateMachine, action);
    // No pick of this Machine's Agent is being answered (the state's first entry, a later Turn's):
    // there is nothing to shape, and nothing runs.
    const chain = binding?.chainOf?.(self, seats);
    if (chain === undefined) return;
    // Kit-internal: the host records links by slot name, which is what ChainLink states.
    const links = linksOf(chain) as unknown as readonly ChainLink<TActor, TEvent>[];
    binding?.setAnswer?.(self, seats, fn({ context, event, chain: links }));
  };
  return Object.assign(action, { jr2Answer: true as const }) as unknown as ActionFunction<
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
