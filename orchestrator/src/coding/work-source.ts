// The Work Source port (CONTEXT.md: Work Source / Ready-set).
//
// A behavior port the Orchestrator pulls work from — `tk`, a queue, GitHub
// issues, etc. — modeled as verbs gated by advertised capabilities, NOT a
// canonical data schema. It OWNS the dependency graph and hands out only the
// currently-unblocked items (the ready-set); the Machine never encodes
// dependency edges and never materializes the queue (Q10: "encode the pattern,
// never the queue"). The Machine re-queries `claimNext*` instead.
//
// The port is consumed by the coding template through INJECTED providers
// (`makeWorkSourceProviders` below): xstate actors/actions that close over a
// live `WorkSource`. The live handle lives in the provider closure, never in
// Machine context — so context stays plain, serializable data (the #7 seam).

import { fromPromise } from "xstate";

export type FeatureStatus = "open" | "claimed" | "inProgress" | "done" | "blocked";
export type TaskStatus = "open" | "claimed" | "done" | "blocked";

export interface Feature {
  id: string;
  /** Ids of features that must be `done` before this one is ready. */
  dependsOn: string[];
  status: FeatureStatus;
}

export interface Task {
  id: string;
  featureId: string;
  title?: string;
  status: TaskStatus;
}

/** Proof of an atomic claim — the holder must present it to mutate the item. */
export interface Lease {
  leaseId: string;
  holder: string;
}

export interface ClaimedFeature {
  feature: Feature;
  lease: Lease;
}
export interface ClaimedTask {
  task: Task;
  lease: Lease;
}

/** Advertised capabilities — a template fails fast if a required one is absent. */
export interface Capabilities {
  /** Resolves `dependsOn` and only emits unblocked items in `ready()`. */
  dependencies: boolean;
  /** `claimNext*` takes an atomic lease (no two workers grab the same item). */
  atomicClaim: boolean;
  comment: boolean;
}

export interface WorkSource {
  readonly capabilities: Capabilities;

  /** The currently-unblocked, unclaimed features (dependency-ordered). */
  ready(): Feature[];

  /** Atomically lease the next ready feature for `holder`, or null if none. */
  claimNextFeature(holder: string): ClaimedFeature | null;

  /** Atomically lease the next open task within a feature, or null when drained. */
  claimNextTask(featureId: string, holder: string): ClaimedTask | null;

  /** Set an item's status. The lease (when given) authorizes the write. */
  updateStatus(id: string, status: FeatureStatus | TaskStatus, lease?: Lease): void;

  comment(id: string, body: string): void;
}

// --- Port → provider bridge ------------------------------------------------
//
// Turns any `WorkSource` (mock or real) into the named providers the templates
// reference. `claimNext*` are actors (a real source is async/networked);
// `updateStatus`/`comment` are fire-and-ack actions (sync for the in-memory
// mock; a real async source is revisited in #6). This is port-generic — the
// real Work Source adapter (#6) drops in here unchanged.

export interface ClaimFeatureInput {
  holder: string;
}
export interface ClaimTaskInput {
  featureId: string;
  holder: string;
}

export function makeWorkSourceProviders(ws: WorkSource) {
  return {
    claimNextFeature: fromPromise<ClaimedFeature | null, ClaimFeatureInput>(async ({ input }) =>
      ws.claimNextFeature(input.holder),
    ),
    claimNextTask: fromPromise<ClaimedTask | null, ClaimTaskInput>(async ({ input }) =>
      ws.claimNextTask(input.featureId, input.holder),
    ),
    // Exposed for actions/guards that want the live port (status writes, comments).
    source: ws,
  };
}
