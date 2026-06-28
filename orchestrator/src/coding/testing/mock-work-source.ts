// An in-memory Work Source for unit tests — implements the `WorkSource` port
// (no infra). It models the three properties the real adapter (#6) must have:
//
//   • dependency resolution — `ready()` emits only features whose `dependsOn`
//     are all `done`, in insertion (ready) order.
//   • atomic claim/lease — `claimNext*` is a synchronous check-and-set: it flips
//     the item to `claimed` and hands back a lease token, so two workers can
//     never grab the same item (the parallel-pool invariant).
//   • a MUTATING ready-set — `addFeature`/`reopen` inject work mid-run; the next
//     `claimNext*` picks it up with NO special Machine state (Q10: re-query the
//     pattern, never materialize the queue).
//
// `onReady` is the push signal the readiness slot subscribes to.

import type {
  WorkSource,
  Capabilities,
  Feature,
  Task,
  Lease,
  ClaimedFeature,
  ClaimedTask,
  FeatureStatus,
  TaskStatus,
} from "../work-source.ts";

export interface SeedFeature {
  id: string;
  dependsOn?: string[];
  /** Task ids (or a count → `${id}-t0..`). Defaults to one task. */
  tasks?: string[] | number;
}

export class InMemoryWorkSource implements WorkSource {
  readonly capabilities: Capabilities = { dependencies: true, atomicClaim: true, comment: true };

  private readonly features = new Map<string, Feature>();
  private readonly tasksByFeature = new Map<string, Task[]>();
  private readonly leases = new Map<string, Lease>();
  private leaseSeq = 0;
  private readonly readyListeners = new Set<() => void>();

  /** Recorded for assertions. */
  readonly comments: { id: string; body: string }[] = [];
  readonly statusLog: { id: string; status: string }[] = [];

  constructor(seed: SeedFeature[] = []) {
    for (const s of seed) this.addFeature(s);
  }

  // --- WorkSource port ------------------------------------------------------

  ready(): Feature[] {
    return [...this.features.values()].filter((f) => f.status === "open" && this.depsSatisfied(f));
  }

  claimNextFeature(holder: string): ClaimedFeature | null {
    const f = this.ready()[0]; // Map preserves insertion order → ready-order
    if (!f) return null;
    f.status = "claimed"; // atomic check-and-set (single-threaded → no race)
    const lease = this.mint(f.id, holder);
    return { feature: { ...f }, lease };
  }

  claimNextTask(featureId: string, holder: string): ClaimedTask | null {
    const list = this.tasksByFeature.get(featureId) ?? [];
    const t = list.find((x) => x.status === "open"); // sequential within a feature
    if (!t) return null;
    t.status = "claimed";
    const lease = this.mint(t.id, holder);
    return { task: { ...t }, lease };
  }

  updateStatus(id: string, status: FeatureStatus | TaskStatus): void {
    this.statusLog.push({ id, status });
    const f = this.features.get(id);
    if (f) {
      f.status = status as FeatureStatus;
      this.leases.delete(id);
      this.maybeEmitReady(); // a feature finishing can unblock dependents
      return;
    }
    for (const list of this.tasksByFeature.values()) {
      const t = list.find((x) => x.id === id);
      if (t) {
        t.status = status as TaskStatus;
        this.leases.delete(id);
        return;
      }
    }
  }

  comment(id: string, body: string): void {
    this.comments.push({ id, body });
  }

  // --- test accessors -------------------------------------------------------

  statusOf(id: string): string | undefined {
    const f = this.features.get(id);
    if (f) return f.status;
    for (const list of this.tasksByFeature.values()) {
      const t = list.find((x) => x.id === id);
      if (t) return t.status;
    }
    return undefined;
  }

  allFeaturesDone(): boolean {
    return [...this.features.values()].every((f) => f.status === "done");
  }

  // --- mutation (mid-run) ---------------------------------------------------

  addFeature(seed: SeedFeature): void {
    this.features.set(seed.id, { id: seed.id, dependsOn: seed.dependsOn ?? [], status: "open" });
    const ids =
      typeof seed.tasks === "number"
        ? Array.from({ length: seed.tasks }, (_, i) => `${seed.id}-t${i}`)
        : (seed.tasks ?? [`${seed.id}-t0`]);
    this.tasksByFeature.set(
      seed.id,
      ids.map((tid) => ({ id: tid, featureId: seed.id, status: "open" as TaskStatus })),
    );
    this.maybeEmitReady();
  }

  /** Reopen a finished feature (and optionally its tasks) — models a reopen. */
  reopen(featureId: string, { tasks = true }: { tasks?: boolean } = {}): void {
    const f = this.features.get(featureId);
    if (!f) return;
    f.status = "open";
    if (tasks) for (const t of this.tasksByFeature.get(featureId) ?? []) t.status = "open";
    this.maybeEmitReady();
  }

  // --- push readiness signal ------------------------------------------------

  /** Subscribe to "the ready-set may be non-empty". Returns an unsubscribe. */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  // --- internals ------------------------------------------------------------

  private depsSatisfied(f: Feature): boolean {
    return f.dependsOn.every((d) => this.features.get(d)?.status === "done");
  }

  private mint(itemId: string, holder: string): Lease {
    const lease: Lease = { leaseId: `lease-${++this.leaseSeq}`, holder };
    this.leases.set(itemId, lease);
    return lease;
  }

  private maybeEmitReady(): void {
    if (this.ready().length > 0) for (const cb of this.readyListeners) cb();
  }
}
