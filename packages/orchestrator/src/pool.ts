// `pool(worker, spec)` (ADR-0017): the j2-owned top-of-the-run Machine — one worker per Source
// item, at most `cap` at once. It absorbs what every jr-shaped workflow used to hand-roll:
// spawn-under-cap, stable child identity, `xstate.done.actor.*` completion collection,
// `stopChild` bookkeeping, the wake gate, and the re-query timer. The one top-level `spawnChild`
// lives HERE, once — which is what keeps the visualizer's static trace guaranteed by
// construction (the comment-enforced "keep spawnChild top-level" footgun deletes), and the
// worker is a registered string src, which is what makes spawned children persistable at all
// (xstate cannot persist inline-src children).
//
// The Source port is generalized — `next(active) → item | null`, plus an optional `wake` event
// def (a webhook / `j2 send` push seam, served as a standing gate named "source") and
// `pollEvery` (the set mutates underneath us — re-query). A queue, a generator, or a re-queried
// set; tk's claim actor is one adapter (CONTEXT.md: Work Source is the ticket-flavored Source).
//
// Terminal triage is three-valued (ADR-0017, forced by parking-is-retention):
//   - drained    — source empty and all children settled → final (jr exit 0);
//   - deadlocked — open-but-never-ready items and nothing running that could unblock them →
//                  final, distinct status (jr exit 2), never an indistinguishable idle poll;
//   - waiting    — children parked (gates, agents) → the run stays open; the gates list is the
//                  "what needs me" surface (jr exit 3).
// The pool can make this call because it owns both the source and the children. Distinguishing
// drained from deadlocked needs one more bit than `null` carries, so a Source's `next` MAY
// resolve the richer `{ item: null, open: n }` shape; a bare `null` means drained-when-idle.

import { assign, setup, spawnChild, stopChild, type AnyStateMachine, type PromiseActorLogic } from "xstate";
import type { EventDef } from "@j2/agent-protocol";
import { gate } from "./gate.ts";
import { attachVocabulary, vocabularyOf } from "./vocabulary.ts";

/**
 * What `next` resolves. A plain item claims it; `null` says "nothing ready now" (drained, when
 * nothing is running); the rich shape adds `open` — how many items exist but are not ready —
 * which is the one bit that separates DRAINED from DEADLOCKED when the pool goes idle.
 */
export type SourceNextResult<T> = T | null | { item: T | null; open: number };

/** The Source port (ADR-0017): where a pool draws work from. Build one with {@link source}. */
export type SourceSpec<T> = {
  /** Claim the next ready item, excluding the ones already being worked (`input.active`).
   * A union of the accepted output shapes because xstate's actor-logic type is invariant in its
   * output — a `fromPromise` inferred as `T | null` must still assign. */
  next:
    | PromiseActorLogic<SourceNextResult<T>, { active: string[] }>
    | PromiseActorLogic<{ item: T | null; open: number }, { active: string[] }>
    | PromiseActorLogic<T | null, { active: string[] }>
    | PromiseActorLogic<null, { active: string[] }>;
  /** An external event def that wakes discovery early (webhook / `j2 send` push seam). The pool
   * serves it as a standing gate named "source" and adds the def to the machine vocabulary. */
  wake?: EventDef;
  /** Re-query cadence while parked, in ms — for sets that mutate underneath us. */
  pollEvery?: number;
};

/** Declare a Source. Identity by design — the value IS the spec; this is the naming/typing seam. */
export function source<T>(spec: SourceSpec<T>): SourceSpec<T> {
  return spec;
}

/** How a pool run ends (its machine output). `items` maps itemId → the worker's output. */
export type PoolOutput = { status: "drained" | "deadlocked"; items: Record<string, unknown> };

export type PoolSpec<T> = {
  /** The machine id (the workflow's name in the visualizer). Default "pool". */
  id?: string;
  source: SourceSpec<T>;
  /** Stable child identity: the spawn id, the active-set entry, the outcome key. */
  itemId: (item: T) => string;
  /** Max concurrent workers — a number, or derived from run input. Default 1. */
  cap?: number | ((args: { input: any }) => number);
  /** Map an item (+ run input) to the worker's input. Default: the item itself. */
  itemInput?: (item: T, args: { input: any }) => unknown;
  /** Terminal policy when the source runs dry and children settle. Only "final" exists today
   * (jr semantics: runs END); a parking policy can be added when a workflow needs one. */
  onDrained?: "final";
};

type PoolCtx = {
  runInput: Record<string, unknown>;
  cap: number;
  /** Item ids currently being worked — the spawn ids of live workers, and `next`'s exclusion. */
  active: string[];
  /** Settled workers' outputs, by item id — the pool's output collects them. */
  items: Record<string, unknown>;
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

/**
 * Build the pool machine (ADR-0017). Returns a plain machine — the usual workflow ROOT
 * (`export const machine = pool(...)`), but nestable as a child like any other. The worker's
 * vocabulary (plus the wake def) is propagated onto it, so discovery reads the full set off the
 * exported machine (ADR-0015).
 */
export function pool(worker: AnyStateMachine, spec: PoolSpec<any>): AnyStateMachine {
  const wake = spec.source.wake;
  const claimOf = (event: unknown): Claim => normalizeClaim((event as { output: unknown }).output);
  const itemIdOf = (event: unknown): string => spec.itemId(claimOf(event).item as never);
  /** `xstate.done.actor.<childId>` → the settled worker's item id. */
  const doneChildOf = (event: unknown): string =>
    ((event as { type: string }).type.match(/^xstate\.done\.actor\.(.+)$/) as RegExpMatchArray)[1]!;

  const machine = setup({
    actors: { worker, next: spec.source.next, gate },
  }).createMachine({
    id: spec.id ?? "pool",
    context: ({ input }): PoolCtx => ({
      runInput: (input ?? {}) as Record<string, unknown>,
      cap: typeof spec.cap === "function" ? spec.cap({ input }) : (spec.cap ?? 1),
      active: [],
      items: {},
    }),
    // The wake seam: a standing gate for the whole run's life (root invokes stop only at final).
    // The invoke id IS the gate's name (the id derives from the actor path — ADR-0011 as
    // amended): `source` when the pool is the root, `<path>.source` nested — so two nested
    // pools' wake gates cannot collide.
    invoke: wake ? [{ id: "source", src: "gate", input: { accepts: [wake.name] } }] : [],
    initial: "discovering",
    on: {
      // A worker settled, at any moment: collect its output, free its slot, stop the ref, and
      // go look for more work. Internal to j2 once — the consumer casts this used to force
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
        // Every slot full: only a settling worker (the root `xstate.done.actor.*`) moves us.
      },
      parked: {
        // Waiting on the world: wake early on push, or re-query on the poll cadence.
        on: wake ? { [wake.name]: "discovering" } : {},
        after: spec.source.pollEvery ? { [spec.source.pollEvery]: { target: "discovering" } } : {},
      },
      drained: { type: "final" },
      deadlocked: { type: "final" },
    },
    // Outcome-in-context (the documented cast-free idiom): the two finals stamped `status`.
    output: ({ context }): PoolOutput => ({
      status: (context as unknown as PoolCtx).status ?? "drained",
      items: (context as unknown as PoolCtx).items,
    }),
  });

  // Propagate the worker's vocabulary (+ the wake def) onto the pool (ADR-0015): the pool is
  // the exported root, and discovery reads the vocabulary off the exported machine.
  const merged = new Map(vocabularyOf(worker) ?? []);
  if (wake) {
    const existing = merged.get(wake.name);
    if (existing && existing !== wake) {
      throw new Error(`pool: wake event "${wake.name}" collides with a worker event of the same name`);
    }
    merged.set(wake.name, wake);
  }
  if (merged.size) attachVocabulary(machine, merged);
  return machine;
}
