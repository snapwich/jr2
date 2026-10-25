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
import { enqueueActions } from "xstate";
import type { z } from "zod";
import { SENDER_KEY, type EventDef, type Sender } from "@jr2/agent-protocol";
import { isAgent } from "./agent.ts";
import { boundRun } from "./registration.ts";
import type { PickAnswer } from "./wire.ts";

/**
 * Read the params of a pick from the event that entered the state. Use it in a plain `input`
 * mapper when the Machine must change a param before the invoked actor gets it. When the params go
 * to the input as they are, use `fromPick`.
 *
 * It parses the params with the `input` schema of the pick. It refuses an event that is not this
 * pick: `state entered by "<event>", but its input reads the params of pick "<pick>"`.
 *
 * `createMachine` calls each mapper one time to see which params it reads. When the mapper throws
 * there, `jr2 up` prints a warning before a run starts: `pick "<pick>" enters state "<state>"
 * (Effect "<slot>"): could not probe the input mapper (<error>); its params are unchecked`.
 *
 * `createMachine` refuses a param of a pick that enters a state that invokes an Effect, when
 * nothing reads the param: `machine "<id>": pick "<pick>" enters state "<state>" (Effect
 * "<slot>"), which never reads "<param>": the Agent supplies it and nothing uses it — map it in an
 * invoke's input, store it with assign, or drop it from the def`.
 *
 * @param event - The event that entered the state: the `event` that the mapper gets.
 * @param def - The pick, as `defineEvent` made it.
 * @returns The params of the pick, typed by its `input` schema.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import {
 *   agent,
 *   arg,
 *   command,
 *   defineEvent,
 *   jr2Setup,
 *   paramsOf,
 *   workspace,
 *   type Workspaced,
 * } from "@jr2/orchestrator";
 *
 * const runTest = defineEvent({
 *   name: "run_test",
 *   description: "Run the tests of one module.",
 *   input: z.object({ module: z.string() }),
 * });
 *
 * const finished = defineEvent({
 *   name: "finished",
 *   description: "Say that all the tests pass.",
 *   input: z.object({}),
 * });
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   events: [runTest, finished],
 *   actors: {
 *     coder: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You are a careful engineer.",
 *     }),
 *     test: command(["node", "--test", arg("file")]),
 *   },
 * }).createMachine({
 *   id: "fix-tests",
 *   context: ({ input }) => input,
 *   initial: "coding",
 *   states: {
 *     coding: {
 *       invoke: {
 *         src: "coder",
 *         input: { prompt: "Make the tests pass. Run the tests of one module at a time." },
 *       },
 *       on: { finished: "done" },
 *       initial: "ready",
 *       states: {
 *         ready: { on: { run_test: "testing" } },
 *         testing: {
 *           invoke: {
 *             src: "test",
 *             // A plain mapper: the Machine makes the file name from the pick's `module`.
 *             input: ({ event }) => ({ file: `test/${paramsOf(event, runTest).module}.test.js` }),
 *             onDone: "ready",
 *           },
 *         },
 *       },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "fix-tests" }),
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export function paramsOf<N extends string, I extends z.ZodObject>(event: EventObject, def: EventDef<N, I>): z.infer<I> {
  // Throws on a jr2 or author defect, which the load walk (effect-checks.ts) finds first: it probes
  // the mapper before the Machine runs.
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

/**
 * Make the `input` of the invoke of a state that a pick enters: the params of the pick go to the
 * input of the invoked actor by name. With `fill`, the Machine adds the keys that the Agent must
 * not choose. So one expression shows the security boundary: the pick is what the Agent gives, and
 * `fill` is what the Machine adds.
 *
 * TypeScript checks the params and the keys of `fill` together against the input type of the
 * invoked actor. It finds a missing key or a key of the wrong type, but it accepts an extra key.
 *
 * So `createMachine` refuses:
 * - a param that is no key of the input of the Effect, and that nothing else reads: ``machine
 *   "<id>": pick "<pick>" enters state "<state>" (Effect "<slot>") with fromPick: "<param>" is no
 *   key of the Effect's input (<keys>), and nothing else reads it — the Agent supplies it and it
 *   reaches nothing; name an argv slot for it, read it in `fill`, store it with assign, or drop it
 *   from the def``
 * - a key that `fill` sets and that is also a param: ``machine "<id>": pick "<pick>" enters state
 *   "<state>" (Effect "<slot>"): `fill` sets "<param>", which is also a param of the pick — the
 *   Machine's value wins and the Agent's is dropped; rename one, or drop it from the def``
 * - a `fromPick` in a state that another event enters: `machine "<id>": state "<state>" (Effect
 *   "<slot>") reads the params of pick "<pick>" but is entered on "<event>" — that event does not
 *   carry them`
 *
 * The input of an Open argv is one string for each key, so TypeScript checks no key for it. A key
 * that the bound argv names and the input does not give stops the Effect when it starts.
 *
 * The state that the pick enters has one of two places:
 * - A child state of the Agent's state, as in the first example. The Turn stays open, and the
 *   pick is outstanding until the Effect ends. Use this shape when the Agent must see the result.
 *   The Agent reads the Effect's output as the answer only when the route after the Effect stays
 *   in the Agent's state, as `onDone: "ready"` does. Then the Agent can pick again. A route that
 *   leaves the Agent's state ends the Turn when the Effect ends, and no Agent reads the output.
 * - A sibling state of the Agent's state, as in the second example. The pick leaves the Agent's
 *   state, so the Turn ends before the Effect runs, and the Agent does not see the output. Use
 *   this shape for a pick that ends the work of the Agent.
 *
 * @param def - The pick, as `defineEvent` made it.
 * @returns An `input` mapper for the `invoke` of the state.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, fromPick, http, jr2Setup } from "@jr2/orchestrator";
 *
 * const postNote = defineEvent({
 *   name: "post_note",
 *   description: "Post a note to the team channel.",
 *   input: z.object({ text: z.string() }),
 * });
 *
 * const finish = defineEvent({
 *   name: "finish",
 *   description: "The note is posted. This ends your work.",
 *   input: z.object({}),
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: {}; input: {} },
 *   events: [postNote, finish],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You write one short note for the team.",
 *       workspace: "none",
 *     }),
 *     note: http({
 *       method: "POST",
 *       url: "https://hooks.example.com/notes",
 *       input: z.object({ text: z.string() }),
 *       request: ({ text }) => ({ json: { text } }),
 *     }),
 *   },
 * }).createMachine({
 *   id: "note",
 *   initial: "writing",
 *   states: {
 *     writing: {
 *       invoke: {
 *         src: "writer",
 *         input: {
 *           prompt: "Write a note that says the release is out, post it, and check the reply.",
 *         },
 *       },
 *       initial: "ready",
 *       states: {
 *         ready: { on: { post_note: "posting", finish: "#done" } },
 *         posting: {
 *           // The `text` of the pick goes to the input of `note` as it is. The route goes back
 *           // to `ready`, in `writing`: the writer reads the output and picks again.
 *           invoke: { src: "note", input: fromPick(postNote), onDone: "ready" },
 *         },
 *       },
 *     },
 *     done: { id: "done", type: "final" },
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, fromPick, http, jr2Setup } from "@jr2/orchestrator";
 *
 * const postNote = defineEvent({
 *   name: "post_note",
 *   description: "Post the note to the team channel. This ends your work.",
 *   input: z.object({ text: z.string() }),
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: {}; input: {} },
 *   events: [postNote],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You write one short note for the team.",
 *       workspace: "none",
 *     }),
 *     note: http({
 *       method: "POST",
 *       url: "https://hooks.example.com/notes",
 *       input: z.object({ text: z.string() }),
 *       request: ({ text }) => ({ json: { text } }),
 *     }),
 *   },
 * }).createMachine({
 *   id: "note",
 *   initial: "writing",
 *   states: {
 *     // The pick leaves this state, so it ends the Turn of the writer.
 *     writing: {
 *       invoke: {
 *         src: "writer",
 *         input: { prompt: "Write a note that says the release is out, and post it." },
 *       },
 *       on: { post_note: "posting" },
 *     },
 *     // A sibling of `writing`: the Effect runs after the Turn, and no Agent reads its output.
 *     posting: {
 *       invoke: { src: "note", input: fromPick(postNote), onDone: "done" },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export function fromPick<N extends string, I extends z.ZodObject, C, E extends EventObject>(
  def: EventDef<N, I>,
): (args: { context: C; event: E; self: AnyActorRef }) => z.infer<I>;
/**
 * Make the `input` from the params of the pick and the keys that `fill` adds. {@link fromPick}
 * tells the rest, and what `createMachine` refuses.
 *
 * @param def - The pick, as `defineEvent` made it.
 * @param fill - Gets `{ context, params }` and gives back only the keys that the Machine adds. Do
 *   not set a key that is also a param.
 * @returns An `input` mapper for the `invoke` of the state.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, bearer, defineEvent, fromPick, http, jr2Setup, secret } from "@jr2/orchestrator";
 *
 * const postComment = defineEvent({
 *   name: "post_comment",
 *   description: "Post a comment on the ticket.",
 *   input: z.object({ body: z.string() }),
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: { ticket: string }; input: { ticket: string } },
 *   events: [postComment],
 *   actors: {
 *     triager: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You triage tickets.",
 *       workspace: "none",
 *     }),
 *     comment: http({
 *       method: "POST",
 *       url: "https://jira.example.com/rest/api/2/issue",
 *       auth: bearer(secret("jira")),
 *       input: z.object({ ticket: z.string(), body: z.string() }),
 *       request: ({ ticket, body }) => ({ path: [ticket, "comment"], json: { body } }),
 *     }),
 *   },
 * }).createMachine({
 *   id: "triage",
 *   context: ({ input }) => input,
 *   initial: "triaging",
 *   states: {
 *     triaging: {
 *       invoke: {
 *         src: "triager",
 *         input: ({ context }) => ({
 *           prompt: `Read ticket ${context.ticket}, then post one comment on it.`,
 *         }),
 *       },
 *       initial: "ready",
 *       states: {
 *         ready: { on: { post_comment: "posting" } },
 *         posting: {
 *           invoke: {
 *             src: "comment",
 *             // The Agent gives `body`. The Machine gives `ticket`, so the Agent cannot post on
 *             // another ticket.
 *             input: fromPick(postComment, ({ context }) => ({ ticket: context.ticket })),
 *             onDone: "#done",
 *           },
 *         },
 *       },
 *     },
 *     done: { id: "done", type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
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
 * there. At `null`, the event that took the transition names the Agent whose pick it shapes (the
 * run host reads it off the event).
 */
export type AnswerSeat = Node | null;

const seatsCache = new WeakMap<AnyStateMachine, Map<unknown, Set<Node | null>>>();

/** How an `answer` makes the copy of itself that runs from one seat. */
const PLACE = Symbol("jr2.answer.place");
type Placeable = { [PLACE]: (seat: AnswerSeat) => unknown; readonly jr2Answer: true };

/** An action of `machine` as it is written — inline, or by name — resolved to its implementation.
 */
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

/** xstate's `enqueueActions` as it is written: its `collect` runs at the place the action stands,
 * and the actions it enqueues run there too. */
type Enqueuing = { type: "xstate.enqueueActions"; collect: (args: EnqueueArgs, params: unknown) => void };
type EnqueueArgs = { context: unknown; event: unknown; enqueue: ((action: unknown) => void) & object };
const isEnqueuing = (action: unknown): action is Enqueuing =>
  typeof action === "function" &&
  (action as Partial<Enqueuing>).type === "xstate.enqueueActions" &&
  typeof (action as Partial<Enqueuing>).collect === "function";

/** The params an action written as `{ type, params }` is run with, as xstate reads them. */
function paramsAt(written: unknown, args: EnqueueArgs): unknown {
  if (typeof written !== "object" || written === null || !("params" in written)) return undefined;
  const params = (written as { params?: unknown }).params;
  return typeof params === "function" ? params({ context: args.context, event: args.event }) : params;
}

/**
 * Give every place an `answer` is written in `machine` a copy of its own, bound to that place's
 * seat (ADR-0067): one action object written in two places then shapes, from each, by that place's
 * rule alone — below an Agent's state, only that Agent's pick; on a transition below none, the pick
 * of the Agent the event names. An entry or an exit below no Agent's state is given an `answer`
 * that sets nothing. At run time an action cannot tell where it was written, so the place is
 * decided here. Called for each Machine of a run's tree as its actor is created, before its first
 * state is entered. Each list is replaced, never written in place: a list the author shared between
 * two places stays the author's.
 */
export function placeAnswers(machine: AnyStateMachine): void {
  if (placedMachines.has(machine) || !machine?.root) return;
  placedMachines.add(machine);
  const resolve = resolverOf(machine);
  const seatAbove = seatFinderOf(machine);
  const placeOne = (a: unknown, seat: AnswerSeat | "nowhere"): unknown => {
    const fn = resolve(a);
    // An `enqueueActions` runs what it enqueues at its own place: each `answer` it enqueues, at any
    // depth, runs from the seat the enqueuing action is written at (ADR-0067). The load walk cannot
    // see inside one, so the copy places what it enqueues as it is enqueued.
    if (isEnqueuing(fn)) {
      const collect = fn.collect;
      return enqueueActions(((args: EnqueueArgs) => {
        const enqueue = Object.assign((action: unknown) => args.enqueue(placeOne(action, seat)), args.enqueue);
        collect({ ...args, enqueue }, paramsAt(a, args));
      }) as never);
    }
    if (!isAnswer(fn)) return a;
    if (seat === "nowhere") return unseatedAnswer(originalOf(fn));
    const original = originalOf(fn) as Partial<Placeable>;
    return typeof original[PLACE] === "function" ? original[PLACE](seat) : fn;
  };
  const placed = (list: readonly unknown[], seat: AnswerSeat | "nowhere"): unknown[] =>
    list.map((a) => placeOne(a, seat));
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

/**
 * The brand the load walk reads: this action is an `answer`.
 *
 * @internal
 */
export type AnswerAction = { readonly jr2Answer: true };

/** Is this action an `answer`? */
export const isAnswer = (action: unknown): boolean =>
  typeof action === "function" && (action as Partial<AnswerAction>).jr2Answer === true;

/**
 * Set what the Agent reads when jr2 answers its pick. It is an xstate action: write it in
 * `entry`, `exit` or the `actions` of a transition. Without it, the Agent reads the last reply
 * since the pick.
 *
 * `fn` gets `{ context, event, chain }`. `chain` is every reply since the pick, oldest first. Each
 * link is `{ kind: "output", src, output }`, the output of an invoked actor, or `{ kind: "event",
 * event }`, an event that a Gate or a nested Agent sent. TypeScript types each link, but not the
 * order or the number of links. What `fn` gives back goes to the Agent as JSON. A value with no
 * JSON form clears the answer: the Agent then reads the last reply. When more than one `answer`
 * runs, the last one wins.
 *
 * Where you write it decides which pick it answers:
 *
 * - At or below the state of an Agent, it answers only a pick of that Agent.
 * - On a transition below no Agent's state, it answers a pick of the Agent whose event took the
 *   transition.
 * - On an `entry` or an `exit` below no Agent's state, it sets nothing, and `jr2 up` prints a
 *   warning: `an answer on the <entry|exit> of "<state>" is below no Agent's state, so it shapes
 *   no pick — an <entry|exit> there is no transition an Agent's event takes; move it under
 *   "<agent state>", or onto a transition (ADR-0067)`.
 *
 * The error of an invoked actor is no link, and the Agent does not see it. To tell the Agent,
 * write `answer` on the `onError` route. An Effect never takes that route for an outcome: every
 * outcome is output.
 *
 * @param fn - Gets `{ context, event, chain }` and gives back what the Agent reads, as a value
 *   with a JSON form.
 * @returns An xstate action.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import {
 *   agent,
 *   answer,
 *   command,
 *   defineEvent,
 *   jr2Setup,
 *   workspace,
 *   type Workspaced,
 * } from "@jr2/orchestrator";
 *
 * const runTests = defineEvent({
 *   name: "run_tests",
 *   description: "Run the test suite. Its result is this call's answer.",
 *   input: z.object({}),
 * });
 *
 * const finished = defineEvent({
 *   name: "finished",
 *   description: "Say that the tests pass.",
 *   input: z.object({}),
 * });
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   events: [runTests, finished],
 *   actors: {
 *     coder: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You are a careful engineer.",
 *     }),
 *     tests: command(["npm", "test"]),
 *   },
 * }).createMachine({
 *   id: "fix-tests",
 *   context: ({ input }) => input,
 *   initial: "coding",
 *   states: {
 *     coding: {
 *       invoke: { src: "coder", input: { prompt: "Make the tests pass." } },
 *       on: { finished: "done" },
 *       initial: "ready",
 *       states: {
 *         ready: { on: { run_tests: "testing" } },
 *         testing: {
 *           invoke: {
 *             src: "tests",
 *             onDone: {
 *               target: "ready",
 *               // The Agent reads this string, not the whole output of the command.
 *               actions: answer(({ event }) =>
 *                 event.output.outcome === "exited" && event.output.code === 0
 *                   ? "The tests pass."
 *                   : `The tests fail:\n${"tail" in event.output ? event.output.tail : event.output.reason}`,
 *               ),
 *             },
 *           },
 *         },
 *       },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "fix-tests" }),
 * });
 * ```
 *
 * @see docs/concepts/the-menu.md
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 * @see docs/reference/decisions/0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md
 */
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
  // `null` on a transition below none. The object the author holds runs as `null`: it runs only from
  // a Machine `placeAnswers` never placed.
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
