// The Orchestrator's durable snapshot store (PoC #7).
//
// A forever-running Orchestrator survives a process crash by persisting the
// xstate Machine snapshot after every transition and restoring it on restart.
// The snapshot is keyed by a Machine **run id** (one row per durable Machine
// run) and holds the JSON-safe persisted snapshot produced by `durability.ts`'s
// codec (context with the live ControlPlane stripped — see serializeSnapshot).
//
// Postgres per the plan (poc-plan.md §7). This is DISTINCT from the Harness's own
// `sqlite()` durable-execution log (ADR-0005): that log is the Harness's concern
// (it keeps the Agent run alive across a Harness restart); this store is the
// Orchestrator's concern (it keeps the Machine that drives the run alive across an
// Orchestrator restart). The two are independent durability layers.

import { Pool, type PoolConfig } from "pg";

/** A persisted Machine run as stored. `snapshot` is the xstate persisted snapshot. */
export interface StoredSnapshot {
  runId: string;
  /** "live" while driving, "done"/"blocked"/… at terminal, "lost" if reconcile failed. */
  status: string;
  snapshot: unknown;
  reason?: string;
  updatedAt: Date;
}

export interface SnapshotStore {
  /** Create the table if absent. Idempotent. */
  init(): Promise<void>;
  /** Load the persisted run, or null if this run id has never been saved. */
  load(runId: string): Promise<StoredSnapshot | null>;
  /** Upsert the snapshot for a run id. `status` defaults to "live". */
  save(runId: string, snapshot: unknown, status?: string): Promise<void>;
  /** Mark a run terminal-without-reattach (reconcile failure / lost Sandbox). */
  markLost(runId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS machine_snapshots (
    run_id     text PRIMARY KEY,
    status     text NOT NULL DEFAULT 'live',
    snapshot   jsonb,
    reason     text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

export class PgSnapshotStore implements SnapshotStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
    // Without a handler, an idle client erroring (PG blip / restart) throws on the
    // pool and crashes the daemon. Swallow it — the next query reconnects.
    this.pool.on("error", () => {});
  }

  // A restarting Orchestrator may briefly race its Postgres: the pod/service is not
  // yet reachable, or — observed under heavy host load — the postmaster's accept
  // backlog is momentarily starved and the kernel returns ECONNREFUSED for several
  // seconds. Hard-crashing on the first failure would turn a recoverable hiccup into
  // a lost run, so the connect+DDL is retried over a generous window (~30s).
  async init(attempts = 30, backoffMs = 1000): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.pool.query(DDL);
        return;
      } catch (e) {
        if (i >= attempts) throw e;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  async load(runId: string): Promise<StoredSnapshot | null> {
    const { rows } = await this.pool.query(
      "SELECT run_id, status, snapshot, reason, updated_at FROM machine_snapshots WHERE run_id = $1",
      [runId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.run_id,
      status: r.status,
      snapshot: r.snapshot,
      reason: r.reason ?? undefined,
      updatedAt: r.updated_at,
    };
  }

  // Upsert. Persisted on EVERY Machine transition; for the minimal driveMachine
  // that is a handful of writes, so no debounce is needed here. A richer #8 Machine
  // with chatty transitions would debounce in front of this call — the store API
  // stays the same.
  async save(runId: string, snapshot: unknown, status = "live"): Promise<void> {
    await this.pool.query(
      `INSERT INTO machine_snapshots (run_id, status, snapshot, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (run_id) DO UPDATE
         SET status = EXCLUDED.status, snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [runId, status, JSON.stringify(snapshot)],
    );
  }

  async markLost(runId: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO machine_snapshots (run_id, status, reason, updated_at)
       VALUES ($1, 'lost', $2, now())
       ON CONFLICT (run_id) DO UPDATE SET status = 'lost', reason = EXCLUDED.reason, updated_at = now()`,
      [runId, reason],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
