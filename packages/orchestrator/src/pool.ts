// `pool(worker, spec)` (ADR-0017): the jr2-owned top-of-the-run Machine — one worker per Source
// item, at most `cap` at once. It absorbs what every jr-shaped workflow used to hand-roll:
// spawn-under-cap, stable child identity, `xstate.done.actor.*` completion collection,
// `stopChild` bookkeeping, the Source's Gate, and the re-query timer. The `spawnChild`s live HERE,
// top-level — which is what keeps the Console's static trace guaranteed by construction (the
// comment-enforced "keep spawnChild top-level" footgun deletes), and the worker is a registered
// string src, which is what makes spawned children persistable at all (xstate cannot persist
// inline-src children).
//
// ONE CLAIM LOOP, TWO POLICIES. The worker is a child Machine, which runs inside the Pool's run, or
// a `dispatch(...)` slot (ADR-0071), which makes each item a run of its own, keyed by its item id
// in the callee Workflow. The loop is the same; the policy says what a settled worker means. A child
// keeps its output or its Failure, and the Pool ends when it drains. A run's end is one item's end,
// never the Pool's: a Pool of runs stands (`standing: true`) and never ends by itself.
//
// THREE SOURCE FORMS, THREE CLAIM PATHS:
//   - PULL: `next({ active, settled, input }) → item | null`, one item a call, as before.
//   - READ: `read` reads the whole set (an `http` Effect marked idempotent, or a promise), and
//     `items` turns its answer into items. One read claims every free slot (the reads merge), after
//     the Pool drops each known id — and, for a Pool of runs, each key that a run of the callee
//     holds (the store's key check). A `reread` or a settled worker during a read sets the LATCH,
//     and the loop reads once more after that read, so no change is lost.
//   - PUSH: `item`, a zod schema, and `hooks` that `carry(item)`. The Pool HOLDS each carried item
//     in its context (so in the run's blob), in arrival order, and claims it when a slot is free.
//     The key check comes before the hold, and `hold` bounds the held items.
//
// THE PUSH HALF of every form is the Pool's `source` Gate (ADR-0011): a Hook's fan-in reaches it as
// it reaches any open Gate, and its seat on the registration runs the Source's handler and answers
// the verdict (`held`, `existing`, `hold-full`, `reread`, `skipped`).
//
// Terminal triage of a Pool of children is three-valued (ADR-0017, forced by parking-is-retention):
//   - drained    — source empty and all children settled → final (jr exit 0);
//   - deadlocked — open-but-never-ready items and nothing running that could unblock them →
//                  final, distinct status (jr exit 2), never an indistinguishable idle poll;
//   - waiting    — children parked (gates, agents) → the run stays open; the gates list is the
//                  "what needs me" surface (jr exit 3).
// With failures and `failures: "fail"` (the default), a drained or deadlocked pool fails the run instead
// (ADR-0073), and the detail of the Failure carries the status.
// The pool can make this call because it owns both the source and the children. Distinguishing
// drained from deadlocked needs one more bit than `null` carries, so a Source's `next` MAY
// resolve the richer `{ item: null, open: n }` shape; a bare `null` means drained-when-idle.

import {
  assign,
  fromPromise,
  setup,
  spawnChild,
  stopChild,
  type AnyActorLogic,
  type AnyStateMachine,
  type PromiseActorLogic,
  type StateMachine,
} from "xstate";
import type { z } from "zod";
import type { EventDef } from "@jr2/agent-protocol";
import type { KindHooks } from "@jr2/hooks";
import type { CallerRecord } from "./callers.ts";
import { poolWorker } from "./dispatch-effect.ts";
import type { DispatchOutput, EffectLogic } from "./effect.ts";
import { fail, failurePayload, isFailure, type FailureInput } from "./fail.ts";
import { hooksTableFault, lookFault, plainGate, sourceGate, type LookOutput, type SourceSeatOf } from "./gate.ts";
import { attachWrapperBody, type JR2Wrapper, type WrapperActors } from "./parts.ts";
import { boundRun, type AnyActorSystem, type DispatchedBy, type PoolMarker, type SourceHeard } from "./registration.ts";
import { parsedNestedDoor } from "./vocabulary.ts";
import { attachInputSchema, attachVocabulary } from "./vocabulary.ts";

// --- What a Source's handler gives ----------------------------------------------------------------

/** The brand of a Source handler's answer: what tells `reread()`, `carry()` and `skip()` apart from
 * any other value a handler gives. */
const VERDICT: unique symbol = Symbol.for("jr2.source.verdict");

/** What `reread()` gives. Only a Source that can read (`next` or `read`) gives it. */
export type Reread = { readonly [VERDICT]: "reread" };
/** What `carry(item)` gives. Only a push Source (one with an `item` schema) gives it. */
export type Carry<T> = { readonly [VERDICT]: "carry"; readonly item: T };
/** What `skip(reason)` gives: the delivery brings nothing, and the reason says why. */
export type Skip = { readonly [VERDICT]: "skip"; readonly reason: string };

/**
 * Read the Source again. The Pool calls its `next`, or runs its `read`, at once; a read that runs
 * now reads once more after it ends. Only a Source that can read gives it.
 *
 * @see docs/concepts/pools-and-sources.md
 */
export function reread(): Reread {
  return { [VERDICT]: "reread" };
}

/**
 * Give the item itself. The Pool holds it, in its run's blob, until it claims it. Only a push
 * Source gives it.
 *
 * @param item - The item, of the type of the Source's `item` schema.
 * @see docs/concepts/pools-and-sources.md
 */
export function carry<T>(item: T): Carry<T> {
  return { [VERDICT]: "carry", item };
}

/**
 * Bring nothing, and say why. The reason goes in the Hook's answer and in its hook log.
 *
 * @param reason - Why the delivery brings nothing, for a person to read.
 * @see docs/concepts/pools-and-sources.md
 */
export function skip(reason: string): Skip {
  return { [VERDICT]: "skip", reason: String(reason) };
}

/** What a Source's handler reads beside `payload`. `caller` is the Hook as a Caller, `delivery` the
 * delivery id, and `input` the Pool's input (`{}` for a standing Pool). */
export type SourceIn<TInput = unknown> = {
  readonly caller: CallerRecord;
  readonly delivery: string;
  readonly input: TInput;
};

/** A Source's handlers, by Hook kind and event key. They have the shape of a Gate's `hooks`. A
 * handler is pure and synchronous. It gives `Out` or `skip(reason)`, never `undefined`; a throw is a
 * skip with the error as its reason. */
export type SourceHooks<Out, TInput = unknown> = KindHooks<SourceIn<TInput>, Out | Skip>;

/**
 * A Source's verdict on one delivery, as its `reply` reads it (ADR-0017). `held`, `existing` and
 * `hold-full` come from a push Source and carry the item and its key; `existing` names the run
 * that holds the key, when one holds it. `reread` comes from a Source that can read. `skipped`
 * carries the reason. A Pool that is paused has no run, so no `reply` of it runs: the door writes
 * that text.
 */
export type SourceVerdict<T> =
  | { readonly verdict: "held"; readonly key: string; readonly item: T }
  | { readonly verdict: "existing"; readonly key: string; readonly item: T; readonly run?: string }
  | { readonly verdict: "hold-full"; readonly key: string; readonly item: T }
  | { readonly verdict: "reread" }
  | { readonly verdict: "skipped"; readonly reason: string };

/**
 * The text that the person who acted reads, from this Source's verdict (ADR-0011, ADR-0017).
 * Plain text: the Hook kind escapes it and puts it in its envelope. Pure and synchronous.
 * `undefined` or `""`: this Source says nothing. It runs only for a delivery whose answer a person
 * reads (`slack`, `discord`). The text of a `skipped` verdict shows only when no other target gave
 * a text.
 */
export type SourceReply<T> = (verdict: SourceVerdict<T>, at: { readonly caller: CallerRecord }) => string | undefined;

// --- The three forms of a Source --------------------------------------------------------------------

// The rich shape's `open` is the one bit that separates DRAINED from DEADLOCKED when the pool goes
// idle (ADR-0017); a bare `null` means drained-when-idle.
/**
 * What the `next` of a Source resolves to: an item, to claim it; `null`, when no item is ready
 * now; or `{ item, open }`, where `open` is the number of items that exist but are not ready.
 * When no worker runs and `next` gives no item, the Pool ends: `drained` when `open` is 0 or
 * absent, `deadlocked` when `open` is more than 0.
 */
export type SourceNextResult<T> = T | null | { item: T | null; open: number };

/** The input of a Source's `next`: the ids of the items that workers have now, the ids of the items
 * that settled, and the Pool's input. So a Source over a list that a Machine holds needs no state
 * of its own. */
export type PoolNextInput<TInput = unknown> = { active: string[]; settled: string[]; input: TInput };

// The Source port (ADR-0017).
/** A pull Source. `next` claims one item at a time. Make one with {@link source}. */
export type SourceSpec<T, TInput = unknown> = {
  // A union of the accepted output shapes because xstate's actor-logic type is invariant in its
  // output — a `fromPromise` inferred as `T | null` must still assign.
  /** Claim the next ready item. Write it as an xstate promise actor,
   * `fromPromise(async ({ input }) => …)`. Its input is {@link PoolNextInput}: `active`, the ids of
   * the items that workers have now, `settled`, the ids of the items that finished or failed, and
   * `input`, the Pool's input. It must not give again an item in `active` or `settled`. It resolves
   * to a {@link SourceNextResult}. The Pool calls it when the run starts, after each claim, and when a worker settles. While workers run and no item is ready, it
   * also calls it on `wake`, on a Hook's `reread()` and every `pollEvery`. */
  next:
    | PromiseActorLogic<SourceNextResult<T>, PoolNextInput<TInput>>
    | PromiseActorLogic<{ item: T | null; open: number }, PoolNextInput<TInput>>
    | PromiseActorLogic<T | null, PoolNextInput<TInput>>
    | PromiseActorLogic<null, PoolNextInput<TInput>>;
  // The `jr2 send` push seam. The def IS the pool machine's vocabulary (ADR-0011).
  /** An external event, made with `defineEvent`, that tells the Pool that new work is ready, for
   * example from `jr2 send`. While workers run and no item is ready, it makes the Pool call `next`
   * at once. The Pool serves it as a Gate named `source` for the whole run (`<path>.source` when the
   * Pool is composed in another Machine). Default: none. */
  wake?: EventDef;
  // For sets that mutate underneath us.
  /** While workers run and no item is ready, call `next` again after this many milliseconds. Use
   * it for a Source whose items change while the run waits. Default: none, so the Pool calls
   * `next` again only when a worker settles, `wake` comes, or a Hook's handler gives `reread()`. */
  pollEvery?: number;
  /** What a Hook's delivery does: a handler for each Hook kind id and event key gives `reread()` or
   * `skip(reason)`. Default: none. */
  hooks?: SourceHooks<Reread, TInput>;
  /** The text that the person who acted reads, from the verdict. Default: none. */
  reply?: SourceReply<T>;
};

/**
 * A read Source. `read` reads the whole set, and `items` turns its answer into the items, in
 * order. The read is an `http` Effect marked `idempotent: true`, so it can spend a secret that the
 * Instance Effector holds, or a promise (`fromPromise`). Its input is the Pool's input. A read that
 * fails gives no items. The read is the truth: a Hook's delivery only says "read again". Make one
 * with {@link source}.
 */
export type ReadSourceSpec<T, TInput = unknown, R extends AnyActorLogic = AnyActorLogic> = {
  /** The read: an `http` Effect marked `idempotent: true`, or a promise. The Pool runs it at the
   * start, after a worker settles, on `wake`, on a Hook's `reread()` and every `pollEvery`. */
  read: R;
  /** The items in the read's answer, in order. Default: the answer itself, when it is an array. */
  items?: (output: LookOutput<R>, args: { input: TInput }) => readonly T[];
  /** As a pull Source's `wake`. */
  wake?: EventDef;
  /** Read again after this many milliseconds while the Pool waits. Default: none. */
  pollEvery?: number;
  /** What a Hook's delivery does: a handler gives `reread()` or `skip(reason)`. Default: none. */
  hooks?: SourceHooks<Reread, TInput>;
  /** The text that the person who acted reads, from the verdict. Default: none. */
  reply?: SourceReply<T>;
};

/**
 * A push Source. Nothing can be read again, and each item comes in a Hook's delivery. A handler
 * gives `carry(item)` or `skip(reason)`. The Pool holds each carried item in its run's blob, in the
 * order of arrival, until it claims it. Only a standing Pool takes a push Source. Make one with
 * {@link source}.
 */
export type PushSourceSpec<T> = {
  /** The schema of an item. The Pool parses each carried item with it before it holds it. */
  item: z.ZodType<T>;
  /** A handler for each Hook kind id and event key. It gives `carry(item)` or `skip(reason)`. */
  hooks: SourceHooks<Carry<T>, {}>;
  /** The most items that the Pool holds. Above it, a carried item is `hold-full`, and the Hook's
   * answer is 429. Default: 1000. */
  hold?: number;
  /** The text that the person who acted reads, from the verdict. Default: none. */
  reply?: SourceReply<T>;
};

/** Any form of Source. */
export type AnySourceSpec<T, TInput = unknown> = SourceSpec<T, TInput> | ReadSourceSpec<T, TInput> | PushSourceSpec<T>;

// Identity by design — the value IS the spec; this is the naming/typing seam.
/**
 * Declare a Source: where a `pool()` gets its work items, one at a time. It gives back the spec
 * that you pass. The item type `T` types what `next` gives. `pool()` does not carry `T` to
 * `itemId` and `itemInput`, so write the item type on their parameter, as the `pool()` example does.
 *
 * @param spec - How to claim the next item, and when to look again. See {@link SourceSpec}.
 * @returns The same spec.
 *
 * @example
 * ```ts
 * import { fromPromise } from "xstate";
 * import { source, type PoolNextInput } from "@jr2/orchestrator";
 *
 * type Issue = { id: string; title: string };
 *
 * const backlog: Issue[] = [
 *   { id: "ISSUE-1", title: "Fix the greeting." },
 *   { id: "ISSUE-2", title: "Add a --name flag." },
 * ];
 *
 * export const issues = source<Issue>({
 *   next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
 *     const issue = backlog.find((i) => !input.active.includes(i.id)) ?? null;
 *     if (issue) backlog.splice(backlog.indexOf(issue), 1);
 *     return issue;
 *   }),
 *   pollEvery: 60_000,
 * });
 * ```
 *
 * @see docs/guides/run-one-worker-per-item.md
 * @see docs/concepts/pools-and-sources.md
 * @see docs/reference/decisions/0017-pool-over-a-source-port.md
 */
export function source<T, TInput = unknown>(spec: SourceSpec<T, TInput>): SourceSpec<T, TInput>;
/**
 * Declare a PUSH Source: the schema of an item, and the handlers that carry it. Only a standing
 * Pool of runs takes it.
 *
 * @param spec - `item`, `hooks`, `hold` and `reply`. See {@link PushSourceSpec}.
 * @returns The same spec.
 *
 * @see docs/concepts/pools-and-sources.md
 */
export function source<const S extends z.ZodType>(spec: {
  item: S;
  hooks: SourceHooks<Carry<z.output<NoInfer<S>>>, {}>;
  hold?: number;
  reply?: SourceReply<z.output<NoInfer<S>>>;
}): PushSourceSpec<z.output<S>>;
/**
 * Declare a READ Source: a read of the whole set, and the items in its answer.
 *
 * @param spec - `read`, `items`, `wake`, `pollEvery`, `hooks` and `reply`. See {@link ReadSourceSpec}.
 * @returns The same spec.
 *
 * @see docs/concepts/pools-and-sources.md
 */
export function source<T, TInput = unknown, R extends AnyActorLogic = AnyActorLogic>(
  spec: ReadSourceSpec<T, TInput, R>,
): ReadSourceSpec<T, TInput, R>;
export function source(spec: unknown): unknown {
  return spec;
}

// --- The Pool ------------------------------------------------------------------------------------

/** How a pool run ends (its machine output). `items` maps itemId → the output of a worker that got
 * to a final state. `failures` maps itemId → the Failure of a worker that failed (ADR-0073). */
export type PoolOutput = {
  status: "drained" | "deadlocked";
  items: Record<string, unknown>;
  failures: Record<string, FailureInput>;
};

// How a pool is configured (ADR-0017, ADR-0033). `TInput` is what came through the pool's door:
// the PARSED schema when `input` declares one, and `unknown` when it does not — absence is
// permissive, so jr2 knows nothing and says so, exactly as `workspace()`'s door-less path does.
// A pool that is fed by something other than a caller may state what it is fed by annotating the
// mapper's parameter; for anything a caller starts, the honest fix is to declare `input`.
/** What you pass to `pool()` with a child Machine as its worker. It says where the items come
 * from, how many workers run at once, and what each worker gets. */
export type PoolSpec<T, TInput = unknown> = {
  /** The Machine id: the name of the Pool in the Console. Default: `"pool"`. */
  id?: string;
  // The WORKER's schema is deliberately not the door (ADR-0033): workers are fed per-ITEM (the
  // source item, or `itemInput`'s result), never the run body, so it describes nothing a starter
  // sends.
  /** The run input of the Pool, as a zod object: what a caller sends to start a run. `cap` and
   * `itemInput` read it, typed by it. A worker never gets it: each worker gets its item. Default:
   * none, and then their `input` is `unknown`. */
  input?: z.ZodObject;
  // `SourceSpec<T>` too: xstate's actor logic is invariant in its input, so a `next` that does not
  // read the Pool's input must still assign under a typed door.
  /** Where the items come from: a pull or a read Source. Make it with {@link source}. A push Source
   * needs a standing Pool of runs. */
  source: SourceSpec<T, TInput> | SourceSpec<T> | ReadSourceSpec<T, TInput> | ReadSourceSpec<T>;
  // Stable child identity: the spawn id, the active-set entry, the outcome key.
  /** The id of an item. The Pool uses it as the id of the item's worker and in the `active` list
   * that `next` gets. It is also the key of that worker's output in `items`. Give each item an id
   * of its own, and the same id every time. */
  itemId: (item: T) => string;
  /** The most workers that run at once: a number, or a function of the run input. Default: `1`. */
  cap?: number | ((args: { input: TInput }) => number);
  /** Make a worker's input from its item and the run input. Default: the item itself. */
  itemInput?: (item: T, args: { input: TInput }) => unknown;
  // jr semantics: runs END; a parking policy can be added when a workflow needs one.
  /** What the Pool does when the Source has no more items and every worker has settled. Only
   * `"final"`: the run ends. Default: `"final"`. */
  onDrained?: "final";
  /** What the Pool does at the end when one or more workers failed. The Pool catches each worker's
   * Failure either way, so one failed item does not stop the other workers. `"fail"`: when the Pool
   * ends with failures, `drained` or `deadlocked`, it fails the run with the reason
   * `"<n> of <m> items failed"` and the detail `{ status, items, failures }`. `"report"`: the Pool
   * ends `done`, with the failures in its output. Default: `"fail"`. */
  failures?: "fail" | "report";
  /** A Pool of child Machines never stands: a child cannot be handed over. */
  standing?: false;
};

/**
 * What you pass to `pool()` for a Pool of runs. The worker is a `dispatch(...)` slot, and the Pool
 * stands. Each item is a run of the slot's Workflow, keyed by `itemId` in that Workflow.
 */
export type StandingPoolSpec<T, I> = {
  /** The Machine id: the name of the Pool in the Console. Default: `"pool"`. */
  id?: string;
  /** A Pool of runs stands: jr2 keeps one live run of its Workflow, and it never ends by itself. */
  standing: true;
  /** Where the items come from: a pull, a read or a push Source. Make it with {@link source}. */
  source: SourceSpec<T, {}> | SourceSpec<T> | ReadSourceSpec<T, {}> | ReadSourceSpec<T> | PushSourceSpec<T>;
  /** The id of an item, and the KEY of its run in the slot's Workflow (ADR-0071): every Pool, every
   * hand-over and every `jr2 run` that gives this key to that Workflow gets the same run while its
   * row lives — while it is live, and a week after it ends. */
  itemId: (item: T) => string;
  /** The most LIVE runs at once that this Pool dispatched. You must choose it. */
  cap: number;
  /** Make a run's body from its item. Default: the item itself. */
  itemInput?: (item: T) => I;
  input?: never;
  onDrained?: never;
  failures?: never;
};

/**
 * What `pool()` returns: the door a run of it starts with, the pool's own output, and the
 * wrapper's actor slots — `worker` holding the worker's own type, because the pool is
 * TRANSPARENT to its worker (ADR-0049), so `customize(machine, { agents })` on a pool-rooted
 * workflow offers the WORKER's Agents and the composer never spells `worker`. {@link JR2Wrapper} is
 * what marks it a jr2 wrapper: the transparency follows the marker, not the slot's spelling.
 *
 * @internal
 */
export type PoolMachine<TWorker extends AnyStateMachine, TInput> = StateMachine<
  any,
  any,
  any,
  WrapperActors<"worker", TWorker, "next" | "gate" | "fail">,
  any,
  any,
  any,
  any,
  any,
  TInput,
  PoolOutput,
  any,
  any,
  any
> &
  JR2Wrapper<TWorker>;

/**
 * What `pool()` returns for a Pool of runs: a Machine with no input and no output, because it
 * stands. It is not a wrapper: `customize()` reaches nothing in the runs (ADR-0049).
 *
 * @internal
 */
export type StandingPoolMachine = StateMachine<any, any, any, any, any, any, any, any, any, {}, never, any, any, any>;

/** One item that the Pool holds or claimed: its key, the item, and the Hook delivery that carried
 * it, when one did. */
type Held = { key: string; item: unknown; hook?: DispatchedBy["hook"] };

type PoolCtx = {
  runInput: Record<string, unknown>;
  cap: number;
  /** Item ids currently being worked — the spawn ids of live workers, and `next`'s exclusion. */
  active: string[];
  /** Settled workers' outputs, by item id — the pool's output collects them. For a Pool of runs, the
   * run and its status, for the runs that ended in this run's life. */
  items: Record<string, unknown>;
  /** Failed workers' payloads, by item id (ADR-0073). */
  failures: Record<string, FailureInput>;
  status?: "drained" | "deadlocked";
  /** A push Source's carried items, in arrival order, until the Pool claims them (ADR-0017). */
  held: Held[];
  /** The items that the last read found and may start, in the read's order: claimed while a slot
   * is free, and the rest dropped when the claim ends — the next read finds them again. */
  ready: Held[];
  /** A Pool of runs: each active key's item, so a hand-over can send it again (ADR-0017). */
  claimed: Record<string, Held>;
  /** A Pool of runs: the keys whose wait ended while their run was still live. Each is sent again
   * under its key: the key finds the run, and the wait follows it, so `cap` still counts it. */
  again: string[];
  /** A `reread`, a `wake` or a settled worker came while the Source read: read once more after it. */
  latch: boolean;
  /** How many items this run claimed and spawned a worker for (ADR-0017). */
  taken: number;
  /** A Pool of runs: the active keys that a hand-over carried to this run (ADR-0017). Each is sent
   * again and finds its run, so its run is not one that this run's items started: the standing
   * streak reads only the items that this run took. */
  carried: string[];
  /** The held items that a hand-over carried and the `item` schema refused: each is a
   * `carry-refused` mark when the run starts, and then the list is empty. */
  refused: Array<{ key: string; reason: string }>;
};

/** A claimed item, normalized (see {@link SourceNextResult}). */
type Claim = { item: unknown | null; open: number };

function normalizeClaim(output: unknown): Claim {
  if (
    output !== null &&
    typeof output === "object" &&
    "item" in output &&
    typeof (output as { open?: unknown }).open === "number"
  ) {
    return output as Claim;
  }
  return { item: output, open: 0 };
}

/** The event that holds a carried item (ADR-0017): sent by the `source` Gate's seat after the key
 * check. */
const CARRY = "jr2.source.carry";
/** The event that makes the Source read again: a Hook's `reread()`. */
const REREAD = "jr2.source.reread";
/** The default of `hold`: not measured (ADR-0017). */
export const HOLD_DEFAULT = 1000;

/** The key of the run input that carries a hand-over to a standing Pool's new run (ADR-0017): the
 * held items and the active keys of the run before it. Only jr2 starts a standing run, so no Caller
 * sends it; the Pool takes it out of its input, so a handler never reads it. */
export const HAND_OVER = "jr2.pool.handOver";

/** One item of a standing Pool that a hand-over carries: its key, the item, and the Hook delivery
 * that carried it, when one did. JSON-safe: it rides the new run's input. */
export type StandingItem = { key: string; item: unknown; hook?: DispatchedBy["hook"] };

/** What a hand-over carries to the new run (ADR-0017): the held items, in the order of arrival, and
 * the item of each active key, which the new run sends again with `wait: true`. */
export type StandingCarry = { held: StandingItem[]; active: StandingItem[] };

/**
 * What a hand-over carries from a standing Pool's context, live or saved (ADR-0017): its held items
 * (none with `dropHeld`) and the item of each active key. A context that is not a Pool's carries
 * nothing.
 */
export function standingCarryOf(context: unknown, opts: { dropHeld?: boolean } = {}): StandingCarry {
  const c = (context ?? {}) as Partial<PoolCtx>;
  const held = Array.isArray(c.held) && !opts.dropHeld ? c.held : [];
  const active = Array.isArray(c.active) ? c.active.filter((k): k is string => typeof k === "string") : [];
  const claimed = typeof c.claimed === "object" && c.claimed !== null ? c.claimed : {};
  return {
    held: held.filter((h) => typeof h?.key === "string").map((h) => ({ ...h })),
    active: active.map((key) => ({ ...(claimed[key] ?? { key, item: undefined }), key })),
  };
}

/** How many items a standing Pool's run took (ADR-0017): each claim that spawned its worker, not a
 * key that a hand-over carried. jr2 reads it for the bound. */
export function standingTaken(context: unknown): number {
  const taken = (context as Partial<PoolCtx> | null | undefined)?.taken;
  return typeof taken === "number" ? taken : 0;
}

/**
 * What the items that a standing Pool's run took itself did (ADR-0017), not the keys that a
 * hand-over carried to it: `started` when one of them started a run (or found its run under its
 * key), and `answered`, how many of them ended in this run's life. A settled item names its run in
 * the context; a live worker's dispatch names it on its ledger row, which `runOf` reads by the
 * worker's Effect id. The standing streak counts a run whose own items started no run.
 */
export function standingTook(
  snapshot: unknown,
  runOf: (effectId: string) => string | undefined,
): { started: boolean; answered: number } {
  const snap = (snapshot ?? {}) as {
    context?: Partial<PoolCtx>;
    children?: Record<string, { getSnapshot?: () => unknown } | undefined>;
  };
  const c = snap.context ?? {};
  const carried = new Set(Array.isArray(c.carried) ? c.carried : []);
  let started = false;
  let answered = 0;
  for (const [key, v] of Object.entries(typeof c.items === "object" && c.items !== null ? c.items : {})) {
    if (carried.has(key)) continue;
    answered++;
    if (typeof (v as { run?: unknown } | undefined)?.run === "string") started = true;
  }
  if (!started) {
    const active = new Set(Array.isArray(c.active) ? c.active : []);
    for (const [id, child] of Object.entries(snap.children ?? {})) {
      if (!active.has(id) || carried.has(id)) continue;
      const effectId = (child?.getSnapshot?.() as { effectId?: unknown } | undefined)?.effectId;
      if (typeof effectId === "string" && runOf(effectId) !== undefined) started = true;
    }
  }
  return { started, answered };
}

/** Is this worker a `dispatch(...)` slot (ADR-0071)? */
function isDispatchWorker(worker: unknown): worker is EffectLogic<unknown, DispatchOutput> {
  return (worker as { effect?: { kind?: unknown } } | null)?.effect?.kind === "dispatch";
}

/** The form of a Source, or why it has none. */
function formOf(src: unknown): "pull" | "read" | "push" | { fault: string } {
  if (typeof src !== "object" || src === null) return { fault: "its source is made with source({ … })" };
  const s = src as Record<string, unknown>;
  const forms = (["next", "read", "item"] as const).filter((k) => s[k] !== undefined);
  if (forms.length !== 1) {
    return {
      fault:
        "its source has exactly one of `next` (a pull Source), `read` (a read Source) and `item` (a push Source)" +
        (forms.length ? `, and it has ${forms.map((f) => `\`${f}\``).join(" and ")}` : ""),
    };
  }
  return forms[0] === "next" ? "pull" : forms[0] === "read" ? "read" : "push";
}

/** Every refusal of a Pool's spec that `pool()` can see, with its fix (ADR-0017). Thrown at
 * `createMachine` time, so the load walk refuses the Workflow, naming the fix. */
function refusal(worker: unknown, spec: Record<string, unknown>): string | undefined {
  if (typeof worker === "string") {
    return (
      `its worker is the Workflow name "${worker}" — a worker is a Machine, or a dispatch(...) slot for a run of ` +
      `each item: pool(dispatch(${JSON.stringify(worker)}, { input, wait: true }), { … })`
    );
  }
  const form = formOf(spec.source);
  if (typeof form === "object") return form.fault;
  const src = spec.source as Record<string, unknown>;
  const hooksFault = hooksTableFault(src.hooks);
  if (hooksFault) return `its source: ${hooksFault.replace(/^its /, "")}`;
  if (form === "read") {
    const fault = lookFault({ read: src.read, input: () => undefined, until: () => undefined });
    if (fault) return `its source's read: ${fault.replace(/^its look's read is|^its look reads with/, "it is")}`;
    if (src.items !== undefined && typeof src.items !== "function") return "its source's items is a function";
  }
  if (form === "push") {
    if (typeof (src.item as { safeParse?: unknown }).safeParse !== "function") {
      return "its source's item is a zod schema";
    }
    if (src.hold !== undefined && !(Number.isInteger(src.hold) && (src.hold as number) > 0)) {
      return "its source's hold is a whole number above 0";
    }
  }
  if (isDispatchWorker(worker)) {
    const effect = (worker as unknown as { effect: { workflow: string; wait: boolean; target?: unknown } }).effect;
    if (spec.standing !== true) {
      return (
        "a Pool of runs stands: give it `standing: true`. A Pool of runs that a Caller starts and that ends is not " +
        "offered: its itemId is a key that lives a week past the run, so a second batch in that week does no work"
      );
    }
    if (effect.wait !== true) {
      return `its dispatch slot for "${effect.workflow}" has no \`wait: true\` — with \`started\` alone, the Pool cannot know when a run ends, and \`cap\` counts nothing`;
    }
    if (effect.target !== undefined) {
      return `its dispatch slot for "${effect.workflow}" has a \`target\` — a Pool of runs on another Orchestrator is not designed: remove the target`;
    }
    if (!(Number.isInteger(spec.cap) && (spec.cap as number) > 0)) {
      return "a Pool of runs states its `cap`, a whole number above 0: the most live runs at once";
    }
    for (const key of ["input", "onDrained", "failures"] as const) {
      if (spec[key] !== undefined) return `a standing Pool has no \`${key}\`: it never ends, and nobody starts it`;
    }
    return undefined;
  }
  if (spec.standing === true) {
    return "`standing: true` needs a Pool of runs (a dispatch(...) slot as its worker): a child Machine cannot be handed over";
  }
  if (form === "push") {
    return "a push Source needs a standing Pool of runs: a Pool that ends when it drains would end at once";
  }
  return undefined;
}

/** The standing mark: a Machine that `pool()` made with `standing: true` (ADR-0017). What the load
 * walk reads to refuse one that is not the top Machine of its Workflow. */
const STANDING = Symbol.for("jr2.pool.standing");

/** What jr2 reads of a standing Pool (ADR-0017): the Machine id, the callee Workflow, the Hook kinds
 * that its Source's handlers hear, and whether a handler hears one kind and event key. */
export type StandingPoolInfo = {
  id: string;
  callee: string;
  kinds: string[];
  hears: (kind: string, key: string) => boolean;
};

/** What a standing Pool says of itself, or undefined for any other Machine (ADR-0017). */
export function standingPoolOf(machine: unknown): StandingPoolInfo | undefined {
  if (typeof machine !== "object" || machine === null) return undefined;
  const info = (machine as Record<symbol, unknown>)[STANDING];
  return typeof info === "object" && info !== null ? (info as StandingPoolInfo) : undefined;
}

/** Is this Machine a standing Pool (ADR-0017)? */
export function isStandingPool(machine: unknown): boolean {
  return standingPoolOf(machine) !== undefined;
}

// Build the pool machine (ADR-0017). Returns a plain machine — the usual workflow ROOT, but
// nestable as a child like any other. Its vocabulary is the wake def alone: the worker keeps its
// own (ADR-0011, ADR-0049).
/**
 * Make a Pool: a Machine that runs one worker for each item that a Source gives, with at most
 * `cap` workers at once. Use it as the root of a Workflow (`export const machine = pool(…)`), or
 * compose it in another Machine.
 *
 * The worker is a Machine, which runs inside the Pool's run, or a `dispatch(...)` slot, which makes
 * each item a run of its own (a Pool of runs, which stands; see the third form).
 *
 * The run ends when the Source has no item ready and no worker runs. Its output is
 * `{ status, items, failures }`: `status` is `"drained"` when no item is left, or `"deadlocked"`
 * when items exist but none can start; `items` holds the output of each worker that got to a final
 * state, by item id; `failures` holds the Failure of each worker that failed, by item id. A worker's
 * Failure stops only that worker: the other workers and their Sandboxes stay. When the Pool ends
 * with one or more failures, `drained` or `deadlocked`, it fails the run by default: the reason is
 * `"<n> of <m> items failed"`, and the detail is `{ status, items, failures }`. With
 * `failures: "report"`, it ends `done` with that output. A worker's defect ends the whole run
 * `error`. While workers wait on Gates, the run stays open.
 *
 * `customize()` reaches through a Pool to its worker: `customize(pool, { agents })` retunes the
 * worker's Agents. The events that the Pool accepts are its `wake` event only; each worker keeps
 * its own.
 *
 * @param worker - The Machine to run for each item. It gets the item, or what `itemInput` makes
 * of it, as its input. It does not get the run input.
 * @param spec - The Source, the item id, the cap, and the worker's input. See {@link PoolSpec}.
 * @returns The Pool, as a Machine.
 *
 * @example
 * ```ts
 * import { fromPromise } from "xstate";
 * import { customize, pool, source, type PoolNextInput } from "@jr2/orchestrator";
 * import { task } from "@jr2/machines";
 *
 * type Issue = { id: string; title: string };
 *
 * const backlog: Issue[] = [
 *   { id: "ISSUE-1", title: "Fix the greeting." },
 *   { id: "ISSUE-2", title: "Add a --name flag." },
 * ];
 *
 * const issues = source<Issue>({
 *   next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
 *     const issue = backlog.find((i) => !input.active.includes(i.id)) ?? null;
 *     if (issue) backlog.splice(backlog.indexOf(issue), 1);
 *     return issue;
 *   }),
 * });
 *
 * const fixer = customize(task, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   agents: { coder: { model: "anthropic/claude-haiku-5-5" } },
 * });
 *
 * export const machine = pool(fixer, {
 *   id: "issues",
 *   source: issues,
 *   itemId: (issue: Issue) => issue.id,
 *   cap: 2,
 *   itemInput: (issue: Issue) => ({ prompt: issue.title, branch: `fix/${issue.id}` }),
 * });
 * ```
 *
 * @see docs/guides/run-one-worker-per-item.md
 * @see docs/concepts/pools-and-sources.md
 * @see docs/reference/decisions/0017-pool-over-a-source-port.md
 */
export function pool<TWorker extends AnyStateMachine, TSchema extends z.ZodObject>(
  worker: TWorker,
  spec: PoolSpec<any, z.infer<TSchema>> & { input: TSchema },
): PoolMachine<TWorker, z.infer<TSchema>>;
/**
 * Make a Pool with no `input` schema. A Pool is a Machine that runs one worker Machine for each
 * item that a Source gives, with at most `cap` workers at once. See {@link pool} for the full description and
 * an example.
 *
 * @param worker - The Machine to run for each item. It gets the item, or what `itemInput` makes
 * of it, as its input. It does not get the run input.
 * @param spec - The Source, the item id, the cap, and the worker's input. See {@link PoolSpec}.
 * @returns The Pool, as a Machine.
 *
 * @see docs/guides/run-one-worker-per-item.md
 * @see docs/concepts/pools-and-sources.md
 * @see docs/reference/decisions/0017-pool-over-a-source-port.md
 */
export function pool<TWorker extends AnyStateMachine, TInput = unknown>(
  worker: TWorker,
  spec: PoolSpec<any, TInput> & { input?: never },
): PoolMachine<TWorker, TInput>;
/**
 * Make a standing Pool of runs: each item that the Source gives is a run of the `dispatch` slot's
 * Workflow, keyed by `itemId` in that Workflow, with at most `cap` live at once (ADR-0017). The
 * slot says `wait: true` and has no `target`. The Pool never ends by itself: when it has no work, it
 * waits for a Hook's delivery, a `reread` or its `pollEvery`. A run that ends in any way frees its
 * slot, and is a `settled` mark on the run's feed; it is never the Pool's error, because the run is
 * not the Pool's child. Use it as the top Machine of its Workflow, in a file of its own.
 *
 * @param worker - The `dispatch(...)` slot of the Workflow that runs each item.
 * @param spec - The Source, the item id, the cap and the run's body. See {@link StandingPoolSpec}.
 * @returns The standing Pool, as a Machine.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { carry, dispatch, pool, skip, source } from "@jr2/orchestrator";
 * import type {} from "@jr2/hooks/gitlab";
 *
 * const failed = z.object({ sha: z.string() });
 *
 * export const machine = pool(dispatch("triage", { input: failed, wait: true }), {
 *   id: "pipelines",
 *   standing: true,
 *   source: source({
 *     item: failed,
 *     hooks: {
 *       gitlab: {
 *         "pipeline.failed": ({ payload }) =>
 *           payload.object_attributes.sha === "" ? skip("no commit") : carry({ sha: payload.object_attributes.sha }),
 *       },
 *     },
 *   }),
 *   itemId: (p) => `pipeline-${p.sha}`,
 *   cap: 4,
 * });
 * ```
 *
 * @see docs/concepts/pools-and-sources.md
 * @see docs/reference/decisions/0017-pool-over-a-source-port.md
 */
export function pool<I, T>(worker: EffectLogic<I, DispatchOutput>, spec: StandingPoolSpec<T, I>): StandingPoolMachine;
export function pool(worker: unknown, specIn: unknown): AnyStateMachine {
  const spec = specIn as PoolSpec<any, any> & { standing?: boolean };
  const refused = refusal(worker, spec as unknown as Record<string, unknown>);
  if (refused) throw new Error(`pool(${JSON.stringify(spec?.id ?? "pool")}): ${refused} (ADR-0017)`);
  return poolMachine(worker, spec);
}

function poolMachine(workerIn: unknown, spec: PoolSpec<any, any> & { standing?: boolean }): AnyStateMachine {
  const runs = isDispatchWorker(workerIn);
  const callee = runs ? (workerIn as unknown as { effect: { workflow: string } }).effect.workflow : undefined;
  const form = formOf(spec.source) as "pull" | "read" | "push";
  const src = spec.source as unknown as Partial<
    SourceSpec<unknown> & ReadSourceSpec<unknown> & PushSourceSpec<unknown>
  > & { hooks?: Record<string, Record<string, (d: unknown) => unknown>> };
  const id = spec.id ?? "pool";
  const wake = form === "push" ? undefined : src.wake;
  const hooks = src.hooks ?? {};
  const hears = Object.values(hooks).some((keys) => Object.keys(keys ?? {}).length > 0);
  const hold = form === "push" ? (src.hold ?? HOLD_DEFAULT) : 0;
  // A Pool of runs spawns its slot with the item's id as the dispatch's key (ADR-0017, ADR-0071).
  const worker = runs ? poolWorker(workerIn as EffectLogic<any, DispatchOutput>) : (workerIn as AnyStateMachine);

  const ctxOf = (context: unknown): PoolCtx => context as PoolCtx;
  const claimOf = (event: unknown): Claim => normalizeClaim((event as { output: unknown }).output);
  const itemIdOf = (event: unknown): string => spec.itemId(claimOf(event).item as never);
  /** `xstate.done.actor.<childId>` or `xstate.error.actor.<childId>` → the settled worker's item id. */
  const childOf = (event: unknown): string =>
    ((event as { type: string }).type.match(/^xstate\.(?:done|error)\.actor\.(.+)$/) as RegExpMatchArray)[1]!;
  const report = spec.failures === "report";
  const failuresOf = (context: unknown) => ctxOf(context).failures;
  /** The worker's input: the item, or what `itemInput` makes of it; for a Pool of runs, the run's
   * body and the Hook delivery that carried the item. */
  const inputFor = (h: Held, runInput: Record<string, unknown>): unknown => {
    const body = spec.itemInput ? spec.itemInput(h.item as never, { input: runInput }) : h.item;
    return runs ? { body, ...(h.hook !== undefined ? { hook: h.hook } : {}) } : body;
  };
  const mark = (system: unknown, m: Omit<PoolMarker, "kind" | "pool">): void =>
    boundRun(system as AnyActorSystem)?.marker?.({ kind: "pool", pool: id, ...m });

  // The push half of the Source (ADR-0017): the seat on the `source` Gate's registration.
  const seat: SourceSeatOf = ({ pool: poolRef, send, system }) => {
    const now = (): PoolCtx => ctxOf(poolRef.getSnapshot().context);
    const skipped = (reason: string): SourceHeard => ({ verdict: "skipped", reason });
    const reply = typeof src.reply === "function" ? src.reply : undefined;
    return {
      hears: (kind, key) => typeof hooks[kind]?.[key] === "function",
      ...(reply ? { reply: (verdict, caller) => reply(verdict as never, { caller }) } : {}),
      hear: async (d) => {
        const handler = hooks[d.kind]?.[d.key];
        if (typeof handler !== "function") return skipped("no handler of the Source hears this kind and key");
        let given: unknown;
        try {
          given = handler({ payload: d.payload, caller: d.caller, delivery: d.delivery, input: now().runInput });
        } catch (err) {
          return skipped(`its handler threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        const v = (given as { [VERDICT]?: unknown } | null | undefined)?.[VERDICT];
        if (v === "skip") return skipped((given as Skip).reason);
        if (v === "reread") {
          if (form === "push") return skipped("its handler gave reread(), and a push Source cannot read again");
          if (poolRef.getSnapshot().status !== "active") return skipped("the Pool's run has ended");
          send({ type: REREAD } as never);
          return { verdict: "reread" };
        }
        if (v !== "carry") return skipped("its handler gave neither carry(item), reread() nor skip(reason)");
        if (form !== "push") return skipped("its handler gave carry(item), and only a push Source holds items");
        const parsed = (src.item as z.ZodType).safeParse((given as Carry<unknown>).item);
        if (!parsed.success) {
          return skipped(
            `the carried item does not parse: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`).join("; ")}`,
          );
        }
        let key: unknown;
        try {
          key = spec.itemId(parsed.data as never);
        } catch (err) {
          return skipped(`its itemId threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (typeof key !== "string" || key === "") return skipped("its itemId gave no id");
        // The key check before the hold (ADR-0017): a held item, then a run of the callee, then an
        // active worker. Asked again after the store's answer, because another delivery can hold the
        // key while it is asked.
        const item: unknown = parsed.data;
        const local = (): SourceHeard | undefined => {
          const c = now();
          if (c.held.some((h) => h.key === key) || c.active.includes(key)) return { verdict: "existing", key, item };
          if (c.held.length >= hold) return { verdict: "hold-full", key, item };
          return undefined;
        };
        if (now().held.some((h) => h.key === key)) return { verdict: "existing", key, item };
        const found = callee ? await boundRun(system)?.dispatch?.lookup?.(callee, key) : undefined;
        if (found) return { verdict: "existing", key, run: found.runId, item };
        const again = local();
        if (again) return again;
        if (poolRef.getSnapshot().status !== "active") return skipped("the Pool's run has ended");
        const hook: Held["hook"] = {
          name: d.hook,
          delivery: d.delivery,
          ...(d.caller.onBehalfOf !== undefined ? { onBehalfOf: d.caller.onBehalfOf } : {}),
        };
        send({ type: CARRY, key, item: parsed.data, hook } as never);
        return now().held.some((h) => h.key === key) || now().active.includes(key)
          ? { verdict: "held", key, item }
          : skipped("the Pool did not take the item");
      },
    };
  };

  // The items that a read skipped, by run: a read at each poll finds them again, so each is one
  // `skipped` mark in a run's life, not one at each read.
  const skippedIn = new WeakMap<object, Set<string>>();
  const skipOnce = (system: unknown, item: unknown, reason: string): void => {
    let text: string;
    try {
      text = JSON.stringify(item) ?? String(item);
    } catch {
      text = String(item);
    }
    const seen = skippedIn.get(system as object) ?? new Set<string>();
    skippedIn.set(system as object, seen);
    if (seen.has(text)) return;
    seen.add(text);
    mark(system, { mark: "skipped", reason });
  };

  // The read's key check (ADR-0017): drop each known id, then — for a Pool of runs — each key that a
  // run of the callee holds. For a Pool of runs, the store is the record of an item that started a
  // run; `knownOf` holds each item that ended with no run.
  const check = fromPromise(
    async ({
      input,
      system,
    }: {
      input: { output: unknown; runInput: Record<string, unknown>; known: string[] };
      system: AnyActorSystem;
    }): Promise<Held[]> => {
      const found = src.items ? src.items(input.output as never, { input: input.runInput }) : input.output;
      if (!Array.isArray(found)) throw new Error("the read's items are not an array");
      const known = new Set(input.known);
      const out: Held[] = [];
      for (const [i, item] of found.entries()) {
        // One item with no id is that item's fault, as for a push Source: it is skipped with a mark,
        // and the rest of the read goes on (ADR-0017).
        let key: unknown;
        try {
          key = spec.itemId(item as never);
        } catch (err) {
          skipOnce(
            system,
            item,
            `item ${i} of the read: its itemId threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (typeof key !== "string" || key === "") {
          skipOnce(system, item, `item ${i} of the read: its itemId gave no id`);
          continue;
        }
        if (known.has(key)) continue;
        known.add(key);
        if (callee && (await boundRun(system)?.dispatch?.lookup?.(callee, key))) continue;
        out.push({ key, item });
      }
      return out;
    },
  );

  // A Pool of runs knows, too, each item that ended with no run (`start-refused`, `dispatch-error`,
  // `unreachable`, `unknown`): the store has no row for it, so without this the read that its own
  // settle starts claims it again, at once and with no end (ADR-0017). The next run of the Pool
  // tries it again.
  const knownOf = (c: PoolCtx): string[] => [
    ...c.active,
    ...c.held.map((h) => h.key),
    ...(runs
      ? Object.entries(c.items)
          .filter(([, v]) => (v as { run?: unknown } | undefined)?.run === undefined)
          .map(([k]) => k)
      : [...Object.keys(c.items), ...Object.keys(c.failures)]),
  ];
  const settledOf = (c: PoolCtx): string[] => [...Object.keys(c.items), ...Object.keys(c.failures)];

  /** Free a settled worker's slot and stop its ref. */
  const free = [
    assign({
      active: ({ context, event }) => ctxOf(context).active.filter((k) => k !== childOf(event)),
      claimed: ({ context, event }) => {
        const { [childOf(event)]: _gone, ...rest } = ctxOf(context).claimed;
        return rest;
      },
    }),
    stopChild(({ event }) => childOf(event)),
  ];

  // What a settled worker means: the policy. A child keeps its output or its Failure; a run's end
  // is one item's end, with its status, and never the Pool's.
  const doneActions = runs
    ? [
        ({ event, system }: { event: unknown; system: unknown }) => {
          const out = (event as { output?: DispatchOutput }).output;
          mark(system, { mark: "settled", key: childOf(event), ...settledOfRun(out) });
        },
        assign({
          items: ({ context, event }) => ({
            ...ctxOf(context).items,
            [childOf(event)]: settledOfRun((event as { output?: DispatchOutput }).output),
          }),
        }),
        ...free,
      ]
    : [
        assign({
          items: ({ context, event }) => ({
            ...ctxOf(context).items,
            [childOf(event)]: (event as unknown as { output: unknown }).output,
          }),
        }),
        ...free,
      ];
  const errorActions = runs
    ? [
        ({ event, system }: { event: unknown; system: unknown }) => {
          const error = (event as { error?: unknown }).error;
          mark(system, {
            mark: "settled",
            key: childOf(event),
            status: "dispatch-error",
            reason: error instanceof Error ? error.message : String(error),
          });
        },
        assign({
          items: ({ context, event }) => ({ ...ctxOf(context).items, [childOf(event)]: { status: "dispatch-error" } }),
        }),
        ...free,
      ]
    : [
        assign({
          failures: ({ context, event }) => ({
            ...ctxOf(context).failures,
            [childOf(event)]: failurePayload((event as unknown as { error: never }).error),
          }),
        }),
        ...free,
      ];
  const isActive = ({ context, event }: { context: unknown; event: unknown }) =>
    ctxOf(context).active.includes(childOf(event));
  /** A Pool of runs: the wait ended at its timeout with the run still live. */
  const stillLive = ({ event }: { event: unknown }) => {
    const out = (event as { output?: DispatchOutput }).output;
    return out?.outcome === "settled" && out.status === "live";
  };
  const waitAgain = [
    assign({ again: ({ context, event }) => [...ctxOf(context).again, childOf(event)] }),
    stopChild(({ event }: { event: unknown }) => childOf(event)),
  ];
  // After a settle: claim again. A pull Source asks `next`; a read Source reads (or latches, when
  // it reads now); a push Source claims from its held items (the root's `always`).
  const settleTarget = form === "pull" ? ".discovering" : form === "read" ? ".reading" : undefined;
  const settleTransitions = (inRead: boolean) => ({
    "xstate.done.actor.*": [
      ...(runs ? [{ guard: (a: any) => isActive(a) && stillLive(a), actions: waitAgain }] : []),
      {
        // A Pool of runs hears only its own live workers' ends; a Pool of children, as before, every
        // child's.
        ...(runs ? { guard: isActive } : {}),
        ...(inRead ? {} : settleTarget ? { target: settleTarget } : {}),
        actions: [...doneActions, ...(inRead ? [assign({ latch: true })] : [])],
      },
    ],
    // A worker failed (ADR-0073): keep its Failure, free its slot, stop the ref, and go look for
    // more work. The Pool is the parent that catches it, so one failed item does not end the run and
    // the host does not delete the Sandboxes of the other workers — a worker parked at a Gate keeps
    // its work (parking is retention, ADR-0012). Only a Failure of a live worker: a defect, or an
    // error of `next`, takes no transition here, so it goes up and ends the run `error`. A Pool of
    // runs takes any error of a live worker: a dispatch's error is its item's end, not the Pool's.
    "xstate.error.actor.*": {
      guard: (a: { context: unknown; event: unknown }) =>
        isActive(a) && (runs || isFailure((a.event as { error?: unknown }).error)),
      ...(inRead ? {} : settleTarget ? { target: settleTarget } : {}),
      actions: [...errorActions, ...(inRead ? [assign({ latch: true })] : [])],
    },
  });

  const hearAgain = form === "pull" ? "discovering" : form === "read" ? "reading" : undefined;
  const wakeNames = [...(wake ? [wake.name] : []), ...(hears ? [REREAD] : [])];
  const latchOn = Object.fromEntries(wakeNames.map((n) => [n, { actions: assign({ latch: true }) }]));

  /** Spawn the next claimed item: the root's `always`, one item a microstep, so each spawn is a
   * top-level `spawnChild`. A wait sent again first (its slot is counted already), then a read's
   * ready items, then the held items, while a slot is free. */
  const nextClaim = (c: PoolCtx): Held | undefined => c.ready[0] ?? c.held[0];
  const claimAlways = [
    ...(runs
      ? [
          {
            guard: ({ context }: { context: unknown }) => ctxOf(context).again.length > 0,
            actions: [
              spawnChild("worker", {
                id: ({ context }) => ctxOf(context).again[0]!,
                input: ({ context }: { context: unknown }) => {
                  const c = ctxOf(context);
                  const h = c.claimed[c.again[0]!] ?? { key: c.again[0]!, item: undefined };
                  // The key finds the run before the body is read (ADR-0071), so a body that this
                  // Assembly's `itemInput` cannot make from an item an older one claimed is no fault:
                  // the item goes as it is.
                  try {
                    return inputFor(h, c.runInput) as never;
                  } catch {
                    return { body: h.item, ...(h.hook !== undefined ? { hook: h.hook } : {}) } as never;
                  }
                },
              }),
              assign({ again: ({ context }) => ctxOf(context).again.slice(1) }),
            ],
          },
        ]
      : []),
    {
      guard: ({ context }: { context: unknown }) => {
        const c = ctxOf(context);
        return nextClaim(c) !== undefined && c.active.length < c.cap;
      },
      actions: [
        ({ context, system }: { context: unknown; system: unknown }) => {
          if (runs) mark(system, { mark: "started", key: nextClaim(ctxOf(context))!.key });
        },
        spawnChild("worker", {
          id: ({ context }) => nextClaim(ctxOf(context))!.key,
          input: ({ context }: { context: unknown }) =>
            inputFor(nextClaim(ctxOf(context))!, ctxOf(context).runInput) as never,
        }),
        assign(({ context }) => {
          const c = ctxOf(context);
          const h = nextClaim(c)!;
          const fromReady = c.ready.length > 0;
          return {
            active: [...c.active, h.key],
            ready: fromReady ? c.ready.slice(1) : c.ready,
            held: fromReady ? c.held : c.held.slice(1),
            claimed: runs ? { ...c.claimed, [h.key]: h } : c.claimed,
            taken: c.taken + 1,
          } as never;
        }),
      ],
    },
  ];

  /** Idle with nothing to claim: a Pool of children ends; a standing Pool parks. */
  const idleEnd = (status: (event: unknown) => "drained" | "deadlocked") => [
    ...(report || runs
      ? []
      : [
          {
            guard: ({ context }: { context: unknown }) => Object.keys(failuresOf(context)).length > 0,
            target: "failing",
            actions: assign({ status: ({ event }) => status(event) }) as never,
          },
        ]),
  ];

  /**
   * What a hand-over carries into this run (ADR-0017): the held items, each parsed again by THIS
   * Assembly's `item` schema (an item that does not parse, or whose key is held or active already,
   * is refused, with the reason), and the active keys. A Source that is not a push Source holds
   * nothing, so a held item that it is given is refused too.
   */
  const carriedOf = (
    handOver: unknown,
  ): { held: Held[]; active: string[]; claimed: Record<string, Held>; refused: PoolCtx["refused"] } => {
    const given = (handOver ?? {}) as Partial<StandingCarry>;
    const claimed: Record<string, Held> = {};
    for (const a of Array.isArray(given.active) ? given.active : []) {
      if (typeof a?.key === "string" && a.key !== "") claimed[a.key] = { ...a };
    }
    const held: Held[] = [];
    const refused: PoolCtx["refused"] = [];
    for (const h of Array.isArray(given.held) ? given.held : []) {
      if (typeof h?.key !== "string") continue;
      if (form !== "push") {
        refused.push({ key: h.key, reason: "the Source is no longer a push Source, so it holds no item" });
        continue;
      }
      const parsed = (src.item as z.ZodType).safeParse(h.item);
      if (!parsed.success) {
        refused.push({
          key: h.key,
          reason: `the item does not parse: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`).join("; ")}`,
        });
        continue;
      }
      if (claimed[h.key] || held.some((x) => x.key === h.key)) continue;
      held.push({ key: h.key, item: parsed.data, ...(h.hook !== undefined ? { hook: h.hook } : {}) });
    }
    return { held, active: Object.keys(claimed), claimed, refused };
  };

  const actors: Record<string, AnyActorLogic> = {
    worker: worker as AnyActorLogic,
    ...(src.next ? { next: src.next as AnyActorLogic } : {}),
    ...(src.read ? { read: src.read as AnyActorLogic, check } : {}),
    gate: hears ? sourceGate(seat) : plainGate,
    fail: fail(),
  };
  const machine = setup({ actors }).createMachine({
    id,
    context: ({ input, self }: { input: unknown; self: { _parent?: unknown } }): PoolCtx => {
      // RunHost parsed a root run's door. A parent's input is parsed here, and a value that is
      // wrong starts no worker (ADR-0033). The handles and `instanceId` are no caller's to send.
      const { [HAND_OVER]: handOver, ...sent } = (input ?? {}) as Record<string, unknown>;
      const runInput =
        spec.input && self._parent
          ? parsedNestedDoor(spec.input, sent, ["workspace", "instanceId"], "pool input invalid, before any worker")
          : sent;
      const carried = runs ? carriedOf(handOver) : { held: [], active: [], claimed: {}, refused: [] };
      return {
        runInput,
        cap: typeof spec.cap === "function" ? spec.cap({ input: runInput as never }) : (spec.cap ?? 1),
        // A hand-over's active keys are counted at once, and each is sent again under its key: the
        // key finds its run, and the wait follows it (ADR-0017).
        active: carried.active,
        items: {},
        failures: {},
        held: carried.held,
        ready: [],
        claimed: carried.claimed,
        again: [...carried.active],
        latch: false,
        taken: 0,
        carried: [...carried.active],
        refused: carried.refused,
      };
    },
    // Each held item that the hand-over carried and the `item` schema refused is a mark on the feed.
    entry: [
      ({ context, system }: { context: unknown; system: unknown }) => {
        for (const r of ctxOf(context).refused) mark(system, { mark: "carry-refused", key: r.key, reason: r.reason });
      },
      assign({ refused: [] }) as never,
    ],
    // The Source's Gate: a standing gate for the whole run's life (root invokes stop only at final).
    // The invoke id IS the gate's name (the id derives from the actor path — ADR-0011): `source`
    // when the pool is the root, `<path>.source` nested — so two nested pools' Gates cannot collide.
    // It hears `wake` (`jr2 send`), and a Hook's delivery reaches the Source's handlers through it.
    invoke: wake || hears ? [{ id: "source", src: "gate", input: { accepts: wake ? [wake.name] : [] } }] : [],
    initial: form === "pull" ? "discovering" : form === "read" ? "reading" : "parked",
    // A pull Source claims in `discovering`; the other paths claim here.
    ...(form !== "pull" || runs ? { always: claimAlways as never } : {}),
    on: {
      ...settleTransitions(false),
      ...latchOn,
      // The push half: the seat checked the key and the bound before it sent this. Checked again
      // here, in the transition, so a held item is held once.
      ...(form === "push"
        ? {
            [CARRY]: {
              guard: ({ context, event }: { context: unknown; event: unknown }) => {
                const c = ctxOf(context);
                const key = (event as { key: string }).key;
                return c.held.length < hold && !c.held.some((h) => h.key === key) && !c.active.includes(key);
              },
              actions: assign({
                held: ({ context, event }) => {
                  const e = event as unknown as Held;
                  return [...ctxOf(context).held, { key: e.key, item: e.item, ...(e.hook ? { hook: e.hook } : {}) }];
                },
              }),
            },
          }
        : {}),
    } as never,
    states: {
      ...(form === "pull"
        ? {
            discovering: {
              entry: assign({ latch: false }),
              // Saturated: don't even query — park until a worker settles (which re-enters here).
              always: [
                {
                  guard: ({ context }: { context: unknown }) => ctxOf(context).active.length >= ctxOf(context).cap,
                  target: "saturated",
                },
              ],
              invoke: {
                id: "discover",
                src: "next",
                input: ({ context }: { context: unknown }) => ({
                  active: ctxOf(context).active,
                  settled: settledOf(ctxOf(context)),
                  input: ctxOf(context).runInput,
                }),
                onDone: [
                  {
                    // Claimed: record it, spawn its worker (TOP-LEVEL spawnChild — the visualize
                    // trace), and loop for more. `reenter` re-invokes the query actor.
                    guard: ({ event }: { event: unknown }) => claimOf(event).item !== null,
                    target: "discovering",
                    reenter: true,
                    actions: [
                      ({ event, system }: { event: unknown; system: unknown }) => {
                        if (runs) mark(system, { mark: "started", key: itemIdOf(event) });
                      },
                      assign({
                        taken: ({ context }) => ctxOf(context).taken + 1,
                        active: ({ context, event }) => [...ctxOf(context).active, itemIdOf(event)],
                        claimed: ({ context, event }) =>
                          runs
                            ? {
                                ...ctxOf(context).claimed,
                                [itemIdOf(event)]: { key: itemIdOf(event), item: claimOf(event).item },
                              }
                            : ctxOf(context).claimed,
                      }),
                      spawnChild("worker", {
                        id: ({ event }) => itemIdOf(event),
                        input: ({ context, event }: { context: unknown; event: unknown }) =>
                          inputFor(
                            { key: itemIdOf(event), item: claimOf(event).item },
                            ctxOf(context).runInput,
                          ) as never,
                      }),
                    ],
                  },
                  // A `reread` or a `wake` came while `next` ran: ask once more.
                  {
                    guard: ({ context }: { context: unknown }) => ctxOf(context).latch,
                    target: "discovering",
                    reenter: true,
                  },
                  // Nothing ready, workers live → healthy parking: their settling re-queries, as do
                  // the Source's Gate and the poll timer. This is jr's exit-3 "waiting" as a state.
                  // A standing Pool parks whatever runs.
                  {
                    guard: ({ context }: { context: unknown }) => runs || ctxOf(context).active.length > 0,
                    target: "parked",
                  },
                  // Idle with failures: the run fails (ADR-0017, ADR-0073), at a drain and at a deadlock.
                  // No worker is live, so the Failure deletes no sibling's Sandbox. `"report"` has no
                  // `failing` state and no branch to it, so the walk lists no state that fails the run.
                  ...(runs
                    ? []
                    : [
                        ...idleEnd((event) => (claimOf(event).open > 0 ? "deadlocked" : "drained")),
                        // Idle + items exist that will never become ready by themselves → jr's exit 2.
                        {
                          guard: ({ event }: { event: unknown }) => claimOf(event).open > 0,
                          target: "deadlocked",
                          actions: assign({ status: () => "deadlocked" as const }),
                        },
                        // Idle + nothing anywhere → done (jr exit 0).
                        { target: "drained", actions: assign({ status: () => "drained" as const }) },
                      ]),
                ],
              },
            },
            saturated: {
              // Every slot full: only a settling worker (the root `xstate.done.actor.*` or a caught
              // Failure) moves us.
            },
          }
        : {}),
      ...(form === "read"
        ? {
            reading: {
              entry: assign({ latch: false, ready: [] }),
              // During a read, a `reread`, a `wake` and a settled worker set the latch: the loop
              // reads once more after this read, so no change is lost.
              on: { ...settleTransitions(true), ...latchOn },
              initial: "fetch",
              states: {
                fetch: {
                  invoke: {
                    id: "read",
                    src: "read",
                    input: ({ context }: { context: unknown }) => ctxOf(context).runInput,
                    onDone: { target: "check" },
                    // A failed read gives no items. The next settle, `reread` or poll reads again.
                    onError: { target: "#jr2PoolReadDone" },
                  },
                },
                check: {
                  invoke: {
                    id: "check",
                    src: "check",
                    input: ({ context, event }: { context: unknown; event: unknown }) => ({
                      output: (event as { output?: unknown }).output,
                      runInput: ctxOf(context).runInput,
                      known: knownOf(ctxOf(context)),
                    }),
                    onDone: {
                      target: "claiming",
                      actions: assign({ ready: ({ event }) => (event as unknown as { output: Held[] }).output }),
                    },
                    onError: { target: "#jr2PoolReadDone" },
                  },
                },
                // The reads merge: the root's `always` claims the ready items while a slot is free.
                // The rest are dropped: the next read finds them again.
                claiming: {
                  always: {
                    guard: ({ context }: { context: unknown }) =>
                      ctxOf(context).ready.length === 0 || ctxOf(context).active.length >= ctxOf(context).cap,
                    target: "#jr2PoolReadDone",
                    actions: assign({ ready: [] }),
                  },
                },
              },
            },
            readDone: {
              id: "jr2PoolReadDone",
              always: [
                { guard: ({ context }: { context: unknown }) => ctxOf(context).latch, target: "reading" },
                {
                  guard: ({ context }: { context: unknown }) => runs || ctxOf(context).active.length > 0,
                  target: "parked",
                },
                ...(runs
                  ? []
                  : [
                      ...idleEnd(() => "drained"),
                      { target: "drained", actions: assign({ status: () => "drained" as const }) },
                    ]),
              ],
            },
          }
        : {}),
      parked: {
        // Waiting on the world: a `wake`, a Hook's `reread()`, or the poll's cadence reads again. A
        // push Source's held items are claimed by the root's `always` as slots free.
        on: hearAgain ? Object.fromEntries(wakeNames.map((n) => [n, { target: hearAgain }])) : {},
        after: hearAgain && src.pollEvery ? { [src.pollEvery]: { target: hearAgain } } : {},
      },
      // Not a final state: the run ends `failed`, and the Failure says which items failed.
      ...(report || runs
        ? {}
        : {
            failing: {
              invoke: {
                src: "fail" as const,
                input: ({ context }: { context: unknown }) => {
                  const { status, items, failures } = ctxOf(context);
                  const n = Object.keys(failures).length;
                  const m = n + Object.keys(items).length;
                  return { reason: `${n} of ${m} items failed`, detail: { status, items, failures } };
                },
              },
            },
          }),
      // A standing Pool never ends by itself (ADR-0017): it has no final state.
      ...(runs ? {} : { drained: { type: "final" as const }, deadlocked: { type: "final" as const } }),
    },
    // Outcome-in-context (the documented cast-free idiom): the two finals stamped `status`.
    output: ({ context }: { context: unknown }): PoolOutput => ({
      status: ctxOf(context).status ?? "drained",
      items: ctxOf(context).items,
      failures: ctxOf(context).failures,
    }),
  } as never) as unknown as AnyStateMachine;

  // The pool's vocabulary is the pool's OWN — the wake def and nothing else (ADR-0011,
  // ADR-0049). The worker's names stay the worker's: its gates and menus resolve against the
  // Machine that invoked them, which is the worker, so merging them up here would only make a
  // same-name/different-payload pair between two workers a collision that per-Machine scoping
  // had already avoided.
  if (wake) attachVocabulary(machine, new Map([[wake.name, wake]]));
  if (runs) {
    // A standing Pool is the Workflow (ADR-0017): the load walk refuses one that is not the top
    // Machine. A run is not the Pool's child, so `customize()` reaches nothing in it (ADR-0049).
    const info: StandingPoolInfo = {
      id,
      callee: callee!,
      kinds: Object.keys(hooks).filter((kind) => Object.keys(hooks[kind] ?? {}).length > 0),
      hears: (kind, key) => typeof hooks[kind]?.[key] === "function",
    };
    Object.defineProperty(machine, STANDING, { value: info, enumerable: false });
    return machine;
  }
  // The pool is TRANSPARENT to its worker (ADR-0049), exactly as `workspace()` is to its body: a
  // `customize(machine, { agents })` on a pool-rooted workflow means the worker's Agents, which
  // is the only Machine under a pool that carries any.
  attachWrapperBody(machine, "worker");
  // The run input does NOT propagate from the worker (ADR-0033): a wrapper declares its own door,
  // because what it feeds its child is not what a caller sends. Here it is sharpest — the pool
  // never passes the run body to a worker at all, workers get items — so propagating the worker's
  // schema would demand fields at the door the pool never uses, and zod's unknown-key stripping
  // would silently DROP the pool-level fields `cap`/`itemInput` actually read. `workspace` is the
  // milder case of the same species. A pool with a contract declares `spec.input`.
  if (spec.input) attachInputSchema(machine, spec.input);
  return machine;
}

/** What a Pool of runs records of a settled item (ADR-0017): the run and its status, or why no run
 * came of it. */
function settledOfRun(out: DispatchOutput | undefined): { run?: string; status: string; reason?: string } {
  if (!out) return { status: "unknown" };
  switch (out.outcome) {
    case "settled":
      return { run: out.run, status: out.status };
    case "started":
      return { run: out.run, status: "started" };
    case "refused":
      return { status: "start-refused", reason: `${out.status}: ${out.report.join("; ")}` };
    case "unreachable":
      return { status: "unreachable" };
    default:
      return { status: "unknown", ...("reason" in out ? { reason: String(out.reason) } : {}) };
  }
}
