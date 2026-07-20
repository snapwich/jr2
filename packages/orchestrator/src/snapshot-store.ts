// Persistence for durable Machine snapshots (ADR-0007). A `SnapshotStore` is keyed by `runId`;
// `SqliteSnapshotStore` is the default backing for a deployed Orchestrator, with `:memory:` for
// tests. `markLost` records a run whose live state could not be re-hydrated (e.g. its flue
// handle is gone) without deleting its history.

import { DatabaseSync } from "node:sqlite";
import type { StoredSnapshot } from "./durability.ts";

export interface SnapshotStore {
  init(): Promise<void>;
  load(runId: string): Promise<StoredSnapshot | null>;
  /** Every persisted run, in insertion order. The host filters by `status` on restore. */
  list(): Promise<StoredSnapshot[]>;
  /**
   * Persisted run ids sharing a prefix, sorted, capped at `limit` — the store half of abbreviated
   * run ids (ADR-0009). Includes `lost` rows: the ambiguity set is the ids that EXIST, not the ones
   * that are readable. Skipping a lost row would let a prefix it shares with a live run resolve
   * silently to the live one, which makes resolution unsound.
   */
  findIdsByPrefix(prefix: string, limit: number): Promise<string[]>;
  save(runId: string, snapshot: unknown, status?: string): Promise<void>;
  markLost(runId: string, reason: string): Promise<void>;
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

  async list(): Promise<StoredSnapshot[]> {
    const rows = this.db
      .prepare(`SELECT run_id, status, snapshot, reason, updated_at FROM machine_snapshots ORDER BY rowid`)
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
   * bound also avoids incrementing the prefix's last character, which has edge cases. `>=`/`<`
   * carries to Postgres unchanged, where `LIKE 'x%'` would need `text_pattern_ops` to use an index.
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

  async close(): Promise<void> {
    this.db.close();
  }
}
