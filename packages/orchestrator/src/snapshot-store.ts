// Persistence for durable Machine snapshots (ADR-0007). A `SnapshotStore` is keyed by `runId`;
// `SqliteSnapshotStore` is the default backing for a deployed Orchestrator, with `:memory:` for
// tests. `markLost` records a run whose live state could not be re-hydrated (e.g. its flue
// handle is gone) without deleting its history.

import { DatabaseSync } from "node:sqlite";
import type { StoredSnapshot } from "./durability.ts";

export interface SnapshotStore {
  init(): Promise<void>;
  load(runId: string): Promise<StoredSnapshot | null>;
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
