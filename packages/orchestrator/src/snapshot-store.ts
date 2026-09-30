// Persistence for durable Machine snapshots (ADR-0007). A `SnapshotStore` is keyed by `runId`, one
// blob per run: the snapshot is a tree xstate restores from its root, and one row keeps it atomic
// (ADR-0065). `SqliteSnapshotStore` on the Instance's volume is the one implementation — no other
// store is owed — with `:memory:` for tests. A persist survives a process crash, not a power loss
// (WAL, `synchronous=NORMAL`), and the write stays synchronous so the row is on disk before the
// Machine's next side effect runs. `markLost` records a run whose live state could not be
// re-hydrated (e.g. its flue handle is gone); a non-live row lives a week, then `sweep` deletes it.

import { DatabaseSync } from "node:sqlite";
import type { StoredSnapshot } from "./durability.ts";

export interface SnapshotStore {
  init(): Promise<void>;
  load(runId: string): Promise<StoredSnapshot | null>;
  /** The `live` runs, in insertion order — what `restore()` reads (ADR-0065). Terminal rows are
   * filtered by the store, not the host, so a boot never parses a week of finished runs. */
  live(): Promise<StoredSnapshot[]>;
  /**
   * Delete every non-live row last written before `olderThan`, and answer how many (ADR-0065). A
   * `live` row is never swept, whatever its age: a run parked on a Gate for a month is restored.
   * A swept id is gone as if it never ran — `read()` answers undefined, and its abbreviations are
   * free again (ADR-0009).
   */
  sweep(olderThan: Date): Promise<number>;
  /**
   * Persisted run ids sharing a prefix, sorted, capped at `limit` — the store half of abbreviated
   * run ids (ADR-0009). Includes `lost` rows: the ambiguity set is the ids that EXIST, not the ones
   * that are readable. Skipping a lost row would let a prefix it shares with a live run resolve
   * silently to the live one, which makes resolution unsound.
   */
  findIdsByPrefix(prefix: string, limit: number): Promise<string[]>;
  save(runId: string, snapshot: unknown, status?: string): Promise<void>;
  markLost(runId: string, reason: string): Promise<void>;
  /**
   * Record a run whose Machine changed shape underneath it (ADR-0030) — refused, not resumed.
   *
   * Unlike {@link markLost} this KEEPS the snapshot. A lost run has nothing left to look at, so
   * nulling it costs nothing; a drifted run is intact and merely unreadable by the Machine now
   * loaded, and it is the one a human most needs to inspect. Nulling it would also hide the run
   * entirely: `read()` returns undefined for a null blob, so `jr2 status <id>` would answer
   * `no run` — a refusal indistinguishable from a run that never existed.
   */
  markDrifted(runId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}

type Row = {
  run_id: string;
  status: string;
  snapshot: string | null;
  reason: string | null;
  updated_at: string;
};

export class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    // A persist survives a process crash, not a power loss (ADR-0065): a write is durable once the
    // OS holds it, and sqlite fsyncs only at a checkpoint. FULL cost 4.5 ms a persist, all fsync.
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machine_snapshots (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'live',
        snapshot TEXT,
        reason TEXT,
        updated_at TEXT
      )
    `);
  }

  async load(runId: string): Promise<StoredSnapshot | null> {
    const row = this.db
      .prepare(`SELECT run_id, status, snapshot, reason, updated_at FROM machine_snapshots WHERE run_id = ?`)
      .get(runId) as Row | undefined;
    if (!row) return null;

    const stored: StoredSnapshot = {
      runId: row.run_id,
      status: row.status,
      snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot),
    };
    if (row.reason !== null) stored.reason = row.reason;
    return stored;
  }

  async live(): Promise<StoredSnapshot[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id, status, snapshot, reason, updated_at FROM machine_snapshots
         WHERE status = 'live' ORDER BY rowid`,
      )
      .all() as Row[];
    return rows.map((row) => {
      const stored: StoredSnapshot = {
        runId: row.run_id,
        status: row.status,
        snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot),
      };
      if (row.reason !== null) stored.reason = row.reason;
      return stored;
    });
  }

  /**
   * A range scan rather than `LIKE`/`GLOB`. `run_id` is the BINARY-collated PRIMARY KEY, but
   * SQLite's `LIKE` is ASCII-case-insensitive by default, so the planner declines the index range
   * and falls back to a full scan. `GLOB` would seek correctly but obliges every caller to escape
   * `*?[]` first — a store shouldn't have to trust that. The `CHAR(0x10FFFF)` sentinel as the upper
   * bound also avoids incrementing the prefix's last character, which has edge cases.
   */
  async findIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id FROM machine_snapshots
         WHERE run_id >= ? AND run_id < ? || CHAR(0x10FFFF)
         ORDER BY run_id LIMIT ?`,
      )
      .all(prefix, prefix, limit) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  async save(runId: string, snapshot: unknown, status = "live"): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO machine_snapshots (run_id, status, snapshot, reason, updated_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           snapshot = excluded.snapshot,
           reason = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(runId, status, JSON.stringify(snapshot), new Date().toISOString());
  }

  async markLost(runId: string, reason: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO machine_snapshots (run_id, status, snapshot, reason, updated_at)
         VALUES (?, 'lost', NULL, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = 'lost',
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(runId, reason, new Date().toISOString());
  }

  /** An UPDATE, not an upsert: a drifted run is one we already have a snapshot for, and the whole
   * point is to keep it. A row that is not there is not a drifted run — nothing to record. */
  async markDrifted(runId: string, reason: string): Promise<void> {
    this.db
      .prepare(`UPDATE machine_snapshots SET status = 'drifted', reason = ?, updated_at = ? WHERE run_id = ?`)
      .run(reason, new Date().toISOString(), runId);
  }

  /** `updated_at` is an ISO-8601 UTC string, so a string comparison is a time comparison. A
   * terminal row's `updated_at` is its terminal write — the age the week counts from. */
  async sweep(olderThan: Date): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM machine_snapshots WHERE status != 'live' AND updated_at < ?`)
      .run(olderThan.toISOString());
    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
