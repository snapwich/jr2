// `pool(worker, spec)` (ADR-0017): the jr2-owned top-of-the-run Machine — one worker per Source
// item, at most `cap` at once. It absorbs what every jr-shaped workflow used to hand-roll:
// spawn-under-cap, stable child identity, `xstate.done.actor.*` completion collection,
// `stopChild` bookkeeping, the wake gate, and the re-query timer. The one top-level `spawnChild`
// lives HERE, once — which is what keeps the Console's static trace guaranteed by
// construction (the comment-enforced "keep spawnChild top-level" footgun deletes), and the
// worker is a registered string src, which is what makes spawned children persistable at all
// (xstate cannot persist inline-src children).
//
// The Source port is generalized — `next(active) → item | null`, plus an optional `wake` event
// def (a webhook / `jr2 send` push seam, served as a standing gate named "source") and
// `pollEvery` (the set mutates underneath us — re-query). A queue, a generator, or a re-queried
// set; tk's claim actor is one adapter (GLOSSARY.md: Work Source is the Source adapter for tickets).
//
// Terminal triage is three-valued (ADR-0017, forced by parking-is-retention):
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
  setup,
  spawnChild,
  stopChild,
  type AnyStateMachine,
  type PromiseActorLogic,
  type StateMachine,
} from "xstate";
import type { z } from "zod";
import type { EventDef } from "@jr2/agent-protocol";
import { fail, failurePayload, isFailure, type FailureInput } from "./fail.ts";
import { gate } from "./gate.ts";
import { attachWrapperBody, type JR2Wrapper, type WrapperActors } from "./parts.ts";
import { attachInputSchema, attachVocabulary } from "./vocabulary.ts";

// The rich shape's `open` is the one bit that separates DRAINED from DEADLOCKED when the pool goes
// idle (ADR-0017); a bare `null` means drained-when-idle.
/**
 * What the `next` of a Source resolves to: an item, to claim it; `null`, when no item is ready
 * now; or `{ item, open }`, where `open` is the number of items that exist but are not ready.
 * When no worker runs and `next` gives no item, the Pool ends: `drained` when `open` is 0 or
 * absent, `deadlocked` when `open` is more than 0.
 */
export type SourceNextResult<T> = T | null | { item: T | null; open: number };

// The Source port (ADR-0017).
/** Where a Pool gets its work items: the Source. Make one with {@link source}. */
export type SourceSpec<T> = {
  // A union of the accepted output shapes because xstate's actor-logic type is invariant in its
  // output — a `fromPromise` inferred as `T | null` must still assign.
  /** Claim the next ready item. Write it as an xstate promise actor,
   * `fromPromise(async ({ input }) => …)`. Its input is `{ active }`: the ids of the items that
   * workers have now, which it must not give again. It must also not give again an item that a
   * worker finished. It resolves to a {@link SourceNextResult}. The Pool calls it when the run
   * starts, after each claim, and when a worker settles. While workers run and no item is ready, it
   * also calls it on `wake` and every `pollEvery`. */
  next:
    | PromiseActorLogic<SourceNextResult<T>, { active: string[] }>
    | PromiseActorLogic<{ item: T | null; open: number }, { active: string[] }>
    | PromiseActorLogic<T | null, { active: string[] }>
    | PromiseActorLogic<null, { active: string[] }>;
  // The webhook / `jr2 send` push seam. The def IS the pool machine's vocabulary (ADR-0011).
  /** An external event, made with `defineEvent`, that tells the Pool that new work is ready, for
   * example from a webhook or `jr2 send`. While workers run and no item is ready, it makes the Pool
   * call `next` at once. The Pool serves it as a Gate named `source` for the whole run
   * (`<path>.source` when the Pool is composed in another Machine). Default: none. */
  wake?: EventDef;
  // For sets that mutate underneath us.
  /** While workers run and no item is ready, call `next` again after this many milliseconds. Use
   * it for a Source whose items change while the run waits. Default: none, so the Pool calls
   * `next` again only when a worker settles or `wake` comes. */
  pollEvery?: number;
};

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
 * import { source } from "@jr2/orchestrator";
 *
 * type Issue = { id: string; title: string };
 *
 * const backlog: Issue[] = [
 *   { id: "ISSUE-1", title: "Fix the greeting." },
 *   { id: "ISSUE-2", title: "Add a --name flag." },
 * ];
 *
 * export const issues = source<Issue>({
 *   next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
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
export function source<T>(spec: SourceSpec<T>): SourceSpec<T> {
  return spec;
}

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
/** What you pass to `pool()`: where the items come from, how many workers run at once, and what
 * each worker gets. */
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
  /** Where the items come from. Make it with {@link source}. */
  source: SourceSpec<T>;
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

type PoolCtx = {
  runInput: Record<string, unknown>;
  cap: number;
  /** Item ids currently being worked — the spawn ids of live workers, and `next`'s exclusion. */
  active: string[];
  /** Settled workers' outputs, by item id — the pool's output collects them. */
  items: Record<string, unknown>;
  /** Failed workers' payloads, by item id (ADR-0073). */
  failures: Record<string, FailureInput>;
  status?: "drained" | "deadlocked";
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

// Build the pool machine (ADR-0017). Returns a plain machine — the usual workflow ROOT, but
// nestable as a child like any other. Its vocabulary is the wake def alone: the worker keeps its
// own (ADR-0011, ADR-0049).
/**
 * Make a Pool: a Machine that runs one worker Machine for each item that a Source gives, with at
 * most `cap` workers at once. Use it as the root of a Workflow (`export const machine = pool(…)`),
 * or compose it in another Machine.
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
 * import { customize, pool, source } from "@jr2/orchestrator";
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
 *   next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
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
export function pool(worker: AnyStateMachine, spec: PoolSpec<any, any>): AnyStateMachine {
  const wake = spec.source.wake;
  const claimOf = (event: unknown): Claim => normalizeClaim((event as { output: unknown }).output);
  const itemIdOf = (event: unknown): string => spec.itemId(claimOf(event).item as never);
  /** `xstate.done.actor.<childId>` → the settled worker's item id. */
  const doneChildOf = (event: unknown): string =>
    ((event as { type: string }).type.match(/^xstate\.done\.actor\.(.+)$/) as RegExpMatchArray)[1]!;
  /** `xstate.error.actor.<childId>` → the failed worker's item id. */
  const errorChildOf = (event: unknown): string =>
    ((event as { type: string }).type.match(/^xstate\.error\.actor\.(.+)$/) as RegExpMatchArray)[1]!;

  const report = spec.failures === "report";
  const failuresOf = (context: unknown) => (context as PoolCtx).failures;
  const machine = setup({
    actors: { worker, next: spec.source.next, gate, fail: fail() },
  }).createMachine({
    id: spec.id ?? "pool",
    context: ({ input }): PoolCtx => ({
      runInput: (input ?? {}) as Record<string, unknown>,
      cap: typeof spec.cap === "function" ? spec.cap({ input }) : (spec.cap ?? 1),
      active: [],
      items: {},
      failures: {},
    }),
    // The wake seam: a standing gate for the whole run's life (root invokes stop only at final).
    // The invoke id IS the gate's name (the id derives from the actor path — ADR-0011):
    // `source` when the pool is the root, `<path>.source` nested — so two nested
    // pools' wake gates cannot collide.
    invoke: wake ? [{ id: "source", src: "gate", input: { accepts: [wake.name] } }] : [],
    initial: "discovering",
    on: {
      // A worker settled, at any moment: collect its output, free its slot, stop the ref, and
      // go look for more work. Internal to jr2 once — the consumer casts this used to force
      // (`DoneActorEvent` unions, `assertEvent`) ship as documented patterns instead.
      "xstate.done.actor.*": {
        target: ".discovering",
        actions: [
          assign({
            items: ({ context, event }) => ({
              ...(context as unknown as PoolCtx).items,
              [doneChildOf(event)]: (event as unknown as { output: unknown }).output,
            }),
            active: ({ context, event }) =>
              (context as unknown as PoolCtx).active.filter((id) => id !== doneChildOf(event)),
          }),
          stopChild(({ event }) => doneChildOf(event)),
        ],
      },
      // A worker failed (ADR-0073): keep its Failure, free its slot, stop the ref, and go look for
      // more work. The Pool is the parent that catches it, so one failed item does not end the run
      // and the host does not delete the Sandboxes of the other workers — a worker parked at a Gate
      // keeps its work (parking is retention, ADR-0012). Only a Failure of a live worker: a defect,
      // or an error of `next`, takes no transition here, so it goes up and ends the run `error`.
      "xstate.error.actor.*": {
        guard: ({ context, event }) =>
          isFailure((event as { error?: unknown }).error) &&
          (context as unknown as PoolCtx).active.includes(errorChildOf(event)),
        target: ".discovering",
        actions: [
          assign({
            failures: ({ context, event }) => ({
              ...(context as unknown as PoolCtx).failures,
              [errorChildOf(event)]: failurePayload((event as unknown as { error: never }).error),
            }),
            active: ({ context, event }) =>
              (context as unknown as PoolCtx).active.filter((id) => id !== errorChildOf(event)),
          }),
          stopChild(({ event }) => errorChildOf(event)),
        ],
      },
    },
    states: {
      discovering: {
        // Saturated: don't even query — park until a worker settles (which re-enters here).
        always: [{ guard: ({ context }) => context.active.length >= (context as PoolCtx).cap, target: "saturated" }],
        invoke: {
          id: "discover",
          src: "next",
          input: ({ context }) => ({ active: (context as PoolCtx).active }),
          onDone: [
            {
              // Claimed: record it, spawn its worker (TOP-LEVEL spawnChild — the visualize
              // trace), and loop for more. `reenter` re-invokes the query actor.
              guard: ({ event }) => claimOf(event).item !== null,
              target: "discovering",
              reenter: true,
              actions: [
                assign({
                  active: ({ context, event }) => [...(context as unknown as PoolCtx).active, itemIdOf(event)],
                }),
                spawnChild("worker", {
                  id: ({ event }) => itemIdOf(event),
                  input: ({ context, event }) => {
                    const item = claimOf(event).item;
                    const runInput = (context as unknown as PoolCtx).runInput;
                    return (spec.itemInput ? spec.itemInput(item as never, { input: runInput }) : item) as never;
                  },
                }),
              ],
            },
            // Nothing ready, workers live → healthy parking: their settling re-queries, as do
            // the wake gate and the poll timer. This is jr's exit-3 "waiting" as a state.
            { guard: ({ context }) => (context as PoolCtx).active.length > 0, target: "parked" },
            // Idle with failures: the run fails (ADR-0017, ADR-0073), at a drain and at a deadlock.
            // No worker is live, so the Failure deletes no sibling's Sandbox. `"report"` has no
            // `failing` state and no branch to it, so the walk lists no state that fails the run. The
            // branch is spread in, so xstate cannot infer the actor type of its action: `as never`
            // lets the check pass.
            ...(report
              ? []
              : [
                  {
                    guard: ({ context }: { context: unknown }) => Object.keys(failuresOf(context)).length > 0,
                    target: "failing",
                    actions: assign({
                      status: ({ event }) => (claimOf(event).open > 0 ? ("deadlocked" as const) : ("drained" as const)),
                    }) as never,
                  },
                ]),
            // Idle + items exist that will never become ready by themselves → jr's exit 2.
            {
              guard: ({ event }) => claimOf(event).open > 0,
              target: "deadlocked",
              actions: assign({ status: () => "deadlocked" as const }),
            },
            // Idle + nothing anywhere → done (jr exit 0).
            { target: "drained", actions: assign({ status: () => "drained" as const }) },
          ],
        },
      },
      saturated: {
        // Every slot full: only a settling worker (the root `xstate.done.actor.*` or a caught
        // Failure) moves us.
      },
      parked: {
        // Waiting on the world: wake early on push, or re-query on the poll cadence.
        on: wake ? { [wake.name]: "discovering" } : {},
        after: spec.source.pollEvery ? { [spec.source.pollEvery]: { target: "discovering" } } : {},
      },
      // Not a final state: the run ends `failed`, and the Failure says which items failed.
      ...(report
        ? {}
        : {
            failing: {
              invoke: {
                src: "fail" as const,
                input: ({ context }: { context: unknown }) => {
                  const { status, items, failures } = context as PoolCtx;
                  const n = Object.keys(failures).length;
                  const m = n + Object.keys(items).length;
                  return { reason: `${n} of ${m} items failed`, detail: { status, items, failures } };
                },
              },
            },
          }),
      drained: { type: "final" },
      deadlocked: { type: "final" },
    },
    // Outcome-in-context (the documented cast-free idiom): the two finals stamped `status`.
    output: ({ context }): PoolOutput => ({
      status: (context as unknown as PoolCtx).status ?? "drained",
      items: (context as unknown as PoolCtx).items,
      failures: (context as unknown as PoolCtx).failures,
    }),
  });

  // The pool's vocabulary is the pool's OWN — the wake def and nothing else (ADR-0011,
  // ADR-0049). The worker's names stay the worker's: its gates and menus resolve against the
  // Machine that invoked them, which is the worker, so merging them up here would only make a
  // same-name/different-payload pair between two workers a collision that per-Machine scoping
  // had already avoided.
  if (wake) attachVocabulary(machine, new Map([[wake.name, wake]]));
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
