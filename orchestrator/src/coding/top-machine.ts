// The Top Machine — a bounded worker-pool TEMPLATE (ADR-0003). A daemon: it
// never reaches a final state, it idles (idle ⇄ working) forever.
//
//   idle ──readiness fires WORK_READY──▶ draining
//   draining ──claimNextFeature──┬─ feature ─▶ spawn Workspace child; afterClaim
//                                └─ none ────▶ idle
//   afterClaim ──always──┬─ at maxConcurrent ─▶ saturated
//                        └─ room left ────────▶ draining   (claim again)
//   saturated ──FEATURE_DONE──▶ draining       (a worker freed up)
//   idle      ──FEATURE_DONE──▶ draining       (a completion may unblock downstream)
//
// Bounded pool: claims ONLY while under `maxConcurrent`; each claimed feature is
// a `spawnChild` Workspace (true parallelism, N children at once). Children
// report completion UP via `sendParent('FEATURE_DONE')`, so the parent keeps no
// live actor refs in context — only counts + ids (plain serializable data). On
// any completion the ready-set is re-queried: "encode the pattern, never the
// queue" — a finished feature may unblock a dependent (CONTEXT.md: Ready-set).

import { setup, assign, fromCallback, fromPromise, enqueueActions } from "xstate";
import type { ClaimedFeature } from "./work-source.ts";
import { workspaceTemplate } from "./workspace-machine.ts";

export interface TopInput {
  maxConcurrent: number;
  /** Worker identity presented when leasing features (atomic claim). */
  holder?: string;
  reviewRoundsMax?: number;
}

export interface TopContext {
  maxConcurrent: number;
  activeCount: number;
  activeFeatureIds: string[];
  holder: string;
  reviewRoundsMax: number;
}

type TopEvent = { type: "WORK_READY" } | { type: "FEATURE_DONE"; featureId: string; outcome: string };

export const topTemplate = setup({
  types: {
    context: {} as TopContext,
    input: {} as TopInput,
    events: {} as TopEvent,
  },
  actors: {
    // Default readiness = never fires (a bare template just idles). Real/mock
    // providers poll the ready-set or subscribe to a push signal.
    readiness: fromCallback(() => {}),
    claimNextFeature: fromPromise<ClaimedFeature | null, { holder: string }>(async () => {
      throw new Error('coding slot "claimNextFeature" was not provided');
    }),
    workspace: workspaceTemplate,
  },
  actions: {
    // Side-effect on a feature finishing — write its status back to the Work
    // Source. Default noop; `provide()` wires the injected port.
    updateFeatureStatus: (_e, _p: { featureId: string; outcome: string }) => {},
    // Bookkeeping: a worker freed up.
    releaseWorker: assign({
      activeCount: ({ context }) => context.activeCount - 1,
      activeFeatureIds: ({ context, event }) =>
        context.activeFeatureIds.filter((id) => id !== (event as { featureId: string }).featureId),
    }),
    // Spawn a Workspace child for a freshly-claimed feature (no ref kept).
    spawnFeature: enqueueActions(({ enqueue, context, event }) => {
      const claimed = (event as unknown as { output: ClaimedFeature }).output;
      enqueue.spawnChild("workspace", {
        id: `ws-${claimed.feature.id}`,
        input: {
          feature: claimed.feature,
          holder: context.holder,
          branch: `feature/${claimed.feature.id}`,
          reviewRoundsMax: context.reviewRoundsMax,
        },
      });
      enqueue.assign({
        activeCount: context.activeCount + 1,
        activeFeatureIds: [...context.activeFeatureIds, claimed.feature.id],
      });
    }),
  },
  guards: {
    isSaturated: ({ context }) => context.activeCount >= context.maxConcurrent,
    claimedFeature: ({ event }) => (event as unknown as { output: ClaimedFeature | null }).output !== null,
  },
}).createMachine({
  id: "top",
  context: ({ input }) => ({
    maxConcurrent: input.maxConcurrent,
    activeCount: 0,
    activeFeatureIds: [],
    holder: input.holder ?? "orchestrator",
    reviewRoundsMax: input.reviewRoundsMax ?? 2,
  }),
  initial: "idle",
  // A completion can land in any state. Where it also unblocks progress (idle /
  // saturated) it drives back to draining; mid-claim it is pure bookkeeping
  // (we're already going to re-drain) so it does not cancel the in-flight claim.
  states: {
    idle: {
      invoke: { src: "readiness" },
      on: {
        WORK_READY: "draining",
        FEATURE_DONE: {
          target: "draining",
          actions: [{ type: "updateFeatureStatus", params: ({ event }) => event }, "releaseWorker"],
        },
      },
    },

    draining: {
      invoke: {
        src: "claimNextFeature",
        input: ({ context }) => ({ holder: context.holder }),
        onDone: [{ guard: "claimedFeature", target: "afterClaim", actions: "spawnFeature" }, { target: "idle" }],
        onError: { target: "idle" },
      },
      on: {
        FEATURE_DONE: {
          actions: [{ type: "updateFeatureStatus", params: ({ event }) => event }, "releaseWorker"],
        },
      },
    },

    afterClaim: {
      always: [{ guard: "isSaturated", target: "saturated" }, { target: "draining" }],
      on: {
        FEATURE_DONE: {
          actions: [{ type: "updateFeatureStatus", params: ({ event }) => event }, "releaseWorker"],
        },
      },
    },

    saturated: {
      on: {
        FEATURE_DONE: {
          target: "draining",
          actions: [{ type: "updateFeatureStatus", params: ({ event }) => event }, "releaseWorker"],
        },
      },
    },
  },
});

export type TopMachine = typeof topTemplate;
