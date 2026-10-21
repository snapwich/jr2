// Persistence for durable Machine snapshots (ADR-0007). A `SnapshotStore` is keyed by `runId`, one
// blob per run: the snapshot is a tree xstate restores from its root, and one row keeps it atomic
// (ADR-0065). `SqliteSnapshotStore` on the Instance's volume is the one implementation — no other
// store is owed — with `:memory:` for tests. A persist survives a process crash, not a power loss
// (WAL, `synchronous=NORMAL`), and the write stays synchronous so the row is on disk before the
// Machine's next side effect runs. `markLost` records a run whose live state could not be
// re-hydrated (e.g. its flue handle is gone), keeping any snapshot the row had; a non-live row
// lives a week, then `sweep` deletes it.

import { DatabaseSync } from "node:sqlite";
import type { StoredSnapshot } from "./durability.ts";

export interface SnapshotStore {
  init(): Promise<void>;
  load(runId: string): Promise<StoredSnapshot | null>;
  /** The `live` runs, in insertion order — what `restore()` reads (ADR-0065). Terminal rows are
   * filtered by the store, not the host, so a boot never parses a week of finished runs. */
  live(): Promise<StoredSnapshot[]>;
  /**
   * The `live` runs by the Assembly hash their blob names (ADR-0069), each list in insertion order:
   * what holds an Assembly. A hold is the ROW, not the process: a run this process failed to
   * restore is still live here, so it still holds its Assembly. Read without parsing a snapshot,
   * because `GET /assembly` and every collection ask. A live row that names no Assembly is not
   * listed.
   */
  liveAssemblies(): Promise<Map<string, string[]>>;
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
  /**
   * The run whose blob carries the idempotency key `effect` (`dispatchedBy.effect`, ADR-0071), in
   * any status, or undefined: what answers a re-sent dispatch with the run it already started. A
   * row `markLost` wrote with no save before it has no snapshot, and so no key; a swept row is gone
   * with its key.
   */
  findByDispatch(effect: string): Promise<string | undefined>;
  save(runId: string, snapshot: unknown, status?: string): Promise<void>;
  /**
   * Record a run whose live state could not be re-hydrated. An upsert: a row that was saved KEEPS
   * its snapshot and its idempotency key, because a lost dispatched run must keep answering its
   * key — a re-send from its caller would otherwise start a second run (ADR-0071). Only a run with
   * no row before gets a row with no snapshot.
   */
  markLost(runId: string, reason: string): Promise<void>;
  /**
   * Record a run this Orchestrator can no longer read (ADR-0030, ADR-0069) — refused, not resumed:
   * the Assembly its snapshot names is not on the volume, was published for another Kit version or
   * does not load, or its Machine's shape does not match the snapshot's stamp.
   *
   * An UPDATE of a row that is there, and it KEEPS the snapshot: a drifted run is intact and only
   * unreadable by this Orchestrator, and it is the one a human most needs to inspect. Nulling it
   * would also hide the run entirely: `read()` returns undefined for a null blob, so
   * `jr2 status <id>` would answer `no run` — a refusal indistinguishable from a run that never
   * existed. It keeps the row's idempotency key too (ADR-0071).
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

/** The lookup `findByDispatch` runs, exported so a test can ask the planner about THIS statement,
 * not a copy of it: the column is indexed, so the plan is a seek. */
export const FIND_BY_DISPATCH_SQL = `SELECT run_id FROM machine_snapshots
  WHERE dispatch_effect = ? ORDER BY rowid LIMIT 1`;

/** The idempotency key a blob carries at `dispatchedBy.effect` (ADR-0071), or null. */
function dispatchEffectOf(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const by = (snapshot as { dispatchedBy?: unknown }).dispatchedBy;
  if (typeof by !== "object" || by === null) return null;
  const effect = (by as { effect?: unknown }).effect;
  return typeof effect === "string" ? effect : null;
}

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
    // The idempotency key of a dispatched run (ADR-0071) is copied out of its blob into a column of
    // its own when `save` writes the row, and the column is indexed. Not an expression index over
    // `json_extract(snapshot, …)`: that runs on every row and THROWS on a blob SQLite's JSON parser
    // refuses (nested about a thousand deep), so one such row would fail its own save and every
    // later `init()` over the volume. A column also costs no JSON parse a save.
    const columns = this.db.prepare(`PRAGMA table_info(machine_snapshots)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "dispatch_effect")) {
      this.db.exec(`ALTER TABLE machine_snapshots ADD COLUMN dispatch_effect TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS machine_snapshots_dispatch_effect ON machine_snapshots(dispatch_effect)`);
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

  async liveAssemblies(): Promise<Map<string, string[]>> {
    const rows = this.db
      .prepare(
        `SELECT run_id, json_extract(snapshot, '$.assembly') AS assembly FROM machine_snapshots
         WHERE status = 'live' AND json_valid(snapshot) ORDER BY rowid`,
      )
      .all() as Array<{ run_id: string; assembly: unknown }>;
    const held = new Map<string, string[]>();
    for (const { run_id, assembly } of rows) {
      if (typeof assembly !== "string") continue;
      held.set(assembly, [...(held.get(assembly) ?? []), run_id]);
    }
    return held;
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

  async findByDispatch(effect: string): Promise<string | undefined> {
    const row = this.db.prepare(FIND_BY_DISPATCH_SQL).get(effect) as { run_id: string } | undefined;
    return row?.run_id;
  }

  async save(runId: string, snapshot: unknown, status = "live"): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO machine_snapshots (run_id, status, snapshot, reason, updated_at, dispatch_effect)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           snapshot = excluded.snapshot,
           reason = NULL,
           updated_at = excluded.updated_at,
           dispatch_effect = excluded.dispatch_effect`,
      )
      .run(runId, status, JSON.stringify(snapshot), new Date().toISOString(), dispatchEffectOf(snapshot));
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
