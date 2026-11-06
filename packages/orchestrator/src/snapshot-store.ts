// Persistence for durable Machine snapshots (ADR-0007). A `SnapshotStore` is keyed by `runId`, one
// blob per run: the snapshot is a tree xstate restores from its root, and one row keeps it atomic
// (ADR-0065). `SqliteSnapshotStore` on the Instance's volume is the one implementation — no other
// store is owed — with `:memory:` for tests. A persist survives a process crash, not a power loss
// (WAL, `synchronous=NORMAL`), and the write stays synchronous so the row is on disk before the
// Machine's next side effect runs. `markLost` records a run whose live state could not be
// re-hydrated (e.g. its flue handle is gone), keeping any snapshot the row had; a non-live row
// lives for `runs.retain`, then `sweep` deletes it. `ended` lists the non-live rows for
// `GET /runs` off columns that `save` copies out of the blob, so a listing parses no snapshot.

import { DatabaseSync } from "node:sqlite";
import type { StoredSnapshot } from "./durability.ts";

export interface SnapshotStore {
  init(): Promise<void>;
  load(runId: string): Promise<StoredSnapshot | null>;
  /** The `live` runs, in insertion order — what `restore()` reads (ADR-0065). Terminal rows are
   * filtered by the store, not the host, so a boot never parses the kept history. */
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
   * Delete every non-live row last written before `olderThan`, and answer their run ids, so that
   * the run's kept conversations go with it (ADR-0065, ADR-0023). A
   * `live` row is never swept, whatever its age: a run parked on a Gate for a month is restored.
   * A swept id is gone as if it never ran — `read()` answers undefined, and its abbreviations are
   * free again (ADR-0009).
   */
  sweep(olderThan: Date): Promise<string[]>;
  /**
   * Persisted run ids sharing a prefix, sorted, capped at `limit` — the store half of abbreviated
   * run ids (ADR-0009). Includes `lost` rows: the ambiguity set is the ids that EXIST, not the ones
   * that are readable. Skipping a lost row would let a prefix it shares with a live run resolve
   * silently to the live one, which makes resolution unsound.
   */
  findIdsByPrefix(prefix: string, limit: number): Promise<string[]>;
  /**
   * The run of `workflow` whose blob carries the idempotency key `key` (`dispatchedBy.effect`,
   * ADR-0071), in any status, or undefined: what answers a re-sent dispatch with the run it already
   * started. The key is scoped to the callee Workflow, so the same key in two Workflows is two runs.
   * A row `markLost` wrote with no save before it has no snapshot, and so no key; a swept row is
   * gone with its key.
   */
  findByDispatch(workflow: string, key: string): Promise<string | undefined>;
  /**
   * The non-live runs that `query` selects, newest start first, at most `limit` (ADR-0009): what
   * `GET /runs` lists of the history. Read off the summary columns, never by parsing a snapshot. A
   * row with no snapshot (`markLost` with no save before it) is not listed: it names no Workflow,
   * and `read()` does not know it either.
   */
  ended(query: EndedQuery): Promise<EndedRow[]>;
  /**
   * The `live` rows that `query` selects (its `statuses` are not read), in the order of `ended`, at
   * most `limit`: what `GET /runs` lists of a live run that the registry does not hold — a restore
   * that a boot deferred (ADR-0069) or that failed and waits for the next boot (ADR-0030). The host
   * leaves out the ids it hosts. Its `endedAt` is the row's last write.
   */
  liveRows(query: EndedQuery): Promise<EndedRow[]>;
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
  /**
   * Claim a Hook's delivery for the fan-in (ADR-0011): when the hook log holds no delivery of this
   * Hook with this id OR this digest, it writes a `pending` line and answers the line's id, which
   * `writeHookLine` finishes; else it answers `undefined`, a repeat, and writes nothing. The check and the write are one synchronous step, so of two deliveries
   * that come at once, one claims. Only the lines of a claimed delivery count: a handshake, a
   * `payload-refused` line and an `unreadable` line never make a repeat, so a payload that the parse
   * refused is parsed again when the service sends it again.
   */
  claimHookDelivery(hook: string, delivery: string, digest: string): number | undefined;
  /** Write one line of the hook log (ADR-0011), or finish the `pending` line of `claimed`. */
  writeHookLine(line: HookLogLine, claimed?: number): void;
  /** The hook log of one Hook, newest first, at most `limit` lines. */
  hookLog(hook: string, limit: number): HookLogLine[];
  /**
   * The head of each standing Workflow (ADR-0017): its newest run, live or not, and whether it is
   * paused. Synchronous, as `writeStanding` is, so a hand-over's start, its end and the head that
   * names the new run are one step.
   */
  standingHeads(): StandingHead[];
  /** Write the head of one standing Workflow. The sweep never deletes the run a head names:
   * a paused Pool keeps its held items in that run's blob for as long as it is paused. */
  writeStanding(head: StandingHead): void;
  /**
   * Keep the Machine an ended run ran on (ADR-0069), as structure with its Charts compiled, under
   * `key`: a digest of the kept doc. One copy for each key, so a thousand runs of one Workflow on
   * one Assembly keep one copy; the run's row holds only the key. Synchronous, so the terminal save and this are one step.
   */
  keepMachine(runId: string, key: string, doc: unknown): void;
  /** The Machine that {@link keepMachine} kept for an ended run, with the run's Workflow name (one
   * copy can serve runs of two names: a Chart wrapper and its named Chart), or undefined. */
  keptMachine(runId: string): { workflow: string; doc: unknown } | undefined;
  close(): Promise<void>;
}

/**
 * The head of a standing Workflow (ADR-0017): `run` is its newest run, `since` when that run
 * started, `streak` how many runs in a row ended `error`, `failed` or at the bound with no run
 * started by an item that the run took itself, and `paused` why jr2 starts no run of it: a Caller
 * cancelled the run (`cancel`), or, after 3 hand-overs from such runs, the next one ended `error`
 * or `failed` (`errors`) or at its bound (`bound`).
 */
export type StandingHead = {
  workflow: string;
  run: string;
  since: string;
  streak: number;
  paused?: "cancel" | "errors" | "bound";
};

/**
 * One line of the hook log (ADR-0011): what the door did with one delivery of one Hook, and when.
 * `kind` says which line it is: `delivered` (the fan-in ran; `outcome` holds what it did), `seen` (a
 * repeat), `hold-full` (the fan-in ran and every Source was full, ADR-0017: the line does not claim
 * the id, so a send again is heard), `no-live-run` (the fan-in ran, and a standing Pool that hears the
 * kind and key has no live run and is not paused: 503, and the line does not claim the id either),
 * `handshake`, `payload-refused` (with zod's `issues`), `unreadable` (the kind could not
 * read the request: `error`) or `follow-up` (the follow-up post of an answer that a person reads
 * failed, or went to a url outside the kind's `posts`: `post` and `error`; its `status` is 0). A
 * `reply` that threw is in the `replyErrors` of its delivery's `detail`. `status` is the status that
 * the rules give, which is the status of the answer unless a person reads the answer: that answer is
 * 200 (ADR-0011).
 */
export type HookLogLine = {
  hook: string;
  at: string;
  kind:
    | "pending"
    | "delivered"
    | "seen"
    | "hold-full"
    | "no-live-run"
    | "handshake"
    | "payload-refused"
    | "unreadable"
    | "too-large"
    | "follow-up";
  status: number;
  delivery?: string;
  digest?: string;
  /** The event key, when the kind read one. */
  key?: string;
  /** What the line says: the outcome, zod's issues, the error. */
  detail?: unknown;
};

/** What `ended` selects (ADR-0009). Each field left out selects every row. */
export type EndedQuery = {
  /** The statuses to list; absent: every status that is not `live`. */
  statuses?: readonly string[];
  /** The Workflows to list. A name also opens its Charts, `<name>/<chart>`, as a scope grant does
   * (ADR-0078). Absent: every Workflow. */
  workflows?: readonly string[];
  /** The one Workflow to list, by its exact name. */
  workflow?: string;
  /** List only the runs that started at or after this ISO-8601 time. */
  since?: string;
  /** List only the runs after this one in the order: an older start, or the same start and a
   * smaller run id. The cursor of a page. */
  after?: { startedAt: string; runId: string };
  limit: number;
};

/** One non-live run as `ended` reads it: the columns, and the summary that `save` copied out of
 * the blob. `endedAt` is the row's terminal write. */
export type EndedRow = {
  runId: string;
  workflow: string;
  status: string;
  /** The store's reason (`drifted`, `lost`), else the Failure's reason, else the fault. */
  reason?: string;
  startedAt: string;
  endedAt: string;
  startedBy?: unknown;
  assembly?: string;
  dispatchedBy?: unknown;
};

/** The part of a blob that a listing shows (ADR-0009), copied into the `summary` column by `save`. */
type RowSummary = {
  startedBy?: unknown;
  assembly?: string;
  dispatchedBy?: unknown;
  failure?: string;
  fault?: string;
};

/** The listing fields of a blob: its Workflow (null when it names none), its start, and the
 * summary. A blob with no `startedAt` (written before the field) takes `fallback`. */
function listingOf(
  snapshot: unknown,
  fallback: string,
): { workflow: string | null; startedAt: string; summary: string } {
  const blob = (typeof snapshot === "object" && snapshot !== null ? snapshot : {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const failure = blob.failure as { reason?: unknown } | undefined;
  const summary: RowSummary = {
    ...(blob.startedBy !== undefined ? { startedBy: blob.startedBy } : {}),
    ...(text(blob.assembly) !== undefined ? { assembly: text(blob.assembly) } : {}),
    ...(blob.dispatchedBy !== undefined ? { dispatchedBy: blob.dispatchedBy } : {}),
    ...(text(failure?.reason) !== undefined ? { failure: text(failure?.reason) } : {}),
    ...(text(blob.fault) !== undefined ? { fault: text(blob.fault) } : {}),
  };
  return {
    workflow: text(blob.workflow) ?? null,
    startedAt: text(blob.startedAt) ?? fallback,
    summary: JSON.stringify(summary),
  };
}

/** The kinds of line that make a repeat: a delivery that the door claimed. */
const CLAIMED_KINDS = ["pending", "delivered", "seen"];

type Row = {
  run_id: string;
  status: string;
  snapshot: string | null;
  reason: string | null;
  updated_at: string;
  started_at: string | null;
};

/** A row as `load` and `live` give it. */
function storedOf(row: Row): StoredSnapshot {
  const stored: StoredSnapshot = {
    runId: row.run_id,
    status: row.status,
    snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot),
  };
  if (row.reason !== null) stored.reason = row.reason;
  if (row.started_at !== null) stored.startedAt = row.started_at;
  return stored;
}

/** The lookup `findByDispatch` runs, exported so a test can ask the planner about THIS statement,
 * not a copy of it: the pair of columns is indexed, so the plan is a seek. */
export const FIND_BY_DISPATCH_SQL = `SELECT run_id FROM machine_snapshots
  WHERE dispatch_workflow = ? AND dispatch_effect = ? ORDER BY rowid LIMIT 1`;

/** The idempotency key a blob carries (ADR-0071): `dispatchedBy.key`, else `dispatchedBy.effect`, or null. */
function dispatchEffectOf(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const by = (snapshot as { dispatchedBy?: unknown }).dispatchedBy;
  if (typeof by !== "object" || by === null) return null;
  // A Pool's item id is the key when there is one (ADR-0017); else the caller's ledger row id.
  const key = (by as { key?: unknown }).key;
  if (typeof key === "string") return key;
  const effect = (by as { effect?: unknown }).effect;
  return typeof effect === "string" ? effect : null;
}

/** Whether a blob carries its run's start (`startedAt`). */
function hasStartedAt(snapshot: unknown): boolean {
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    typeof (snapshot as { startedAt?: unknown }).startedAt === "string"
  );
}

/** The Workflow a blob names (`workflow`): the scope of its idempotency key (ADR-0071), or null. */
function dispatchWorkflowOf(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const workflow = (snapshot as { workflow?: unknown }).workflow;
  return typeof workflow === "string" ? workflow : null;
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
    // later `init()` over the volume. A column also costs no JSON parse a save. The key is scoped
    // to the callee Workflow, so the Workflow is copied out too, and the index is on the pair.
    const columns = this.db.prepare(`PRAGMA table_info(machine_snapshots)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "dispatch_effect")) {
      this.db.exec(`ALTER TABLE machine_snapshots ADD COLUMN dispatch_effect TEXT`);
    }
    if (!columns.some((c) => c.name === "dispatch_workflow")) {
      this.db.exec(`ALTER TABLE machine_snapshots ADD COLUMN dispatch_workflow TEXT`);
      this.fillDispatchWorkflow();
    }
    // The listing columns (ADR-0009): the Workflow, the start and the summary, copied out of the
    // blob by `save`, so `ended` lists the history with no JSON parse. `listed_at` is the
    // `updated_at` of the save that wrote them. A row whose two times differ was written by a store
    // that does not know the columns — a volume from before them, or an older image in the Kit bump
    // window (ADR-0069) — and each boot fills those rows again, in one transaction (SQLite's DDL is
    // transactional): a process that stops part of the way leaves no column and no row half done,
    // so the next boot does it again.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const name of ["workflow", "started_at", "summary", "listed_at"]) {
        if (!columns.some((c) => c.name === name)) {
          this.db.exec(`ALTER TABLE machine_snapshots ADD COLUMN ${name} TEXT`);
        }
      }
      this.fillListing();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS machine_snapshots_started ON machine_snapshots(started_at DESC, run_id DESC)`,
    );
    this.db.exec(`DROP INDEX IF EXISTS machine_snapshots_dispatch_effect`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS machine_snapshots_dispatch_key ON machine_snapshots(dispatch_workflow, dispatch_effect)`,
    );
    // The hook log (ADR-0011): one row per line, kept for `runs.retain` like a finished run (ADR-0065).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hook_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hook TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        status INTEGER NOT NULL,
        delivery TEXT,
        digest TEXT,
        key TEXT,
        detail TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS hook_log_delivery ON hook_log(hook, delivery)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS hook_log_digest ON hook_log(hook, digest)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS hook_log_at ON hook_log(at)`);
    // The head of each standing Workflow (ADR-0017): one row for each, kept while the Workflow is.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS standing (
        workflow TEXT PRIMARY KEY,
        run TEXT NOT NULL,
        since TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0,
        paused TEXT
      )
    `);
    // The Machine each ended run ran on (ADR-0069): one row for each distinct doc, and the run's
    // row names it. The run sweep deletes a doc that no kept row names.
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_machines (key TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
    const now = this.db.prepare(`PRAGMA table_info(machine_snapshots)`).all() as Array<{ name: string }>;
    if (!now.some((c) => c.name === "machine_key")) {
      this.db.exec(`ALTER TABLE machine_snapshots ADD COLUMN machine_key TEXT`);
    }
  }

  /** A volume a store before the Workflow column wrote: copy the Workflow out of each keyed row, so
   * its key keeps answering. The blob is parsed here, not by `json_extract`, which refuses a blob
   * nested about a thousand deep. */
  private fillDispatchWorkflow(): void {
    const rows = this.db
      .prepare(`SELECT run_id, snapshot FROM machine_snapshots WHERE dispatch_effect IS NOT NULL`)
      .all() as Array<{ run_id: string; snapshot: string | null }>;
    const update = this.db.prepare(`UPDATE machine_snapshots SET dispatch_workflow = ? WHERE run_id = ?`);
    for (const row of rows) {
      if (row.snapshot === null) continue;
      let blob: unknown;
      try {
        blob = JSON.parse(row.snapshot);
      } catch {
        continue; // A blob that does not parse names no Workflow, and restore reports it.
      }
      update.run(dispatchWorkflowOf(blob), row.run_id);
    }
  }

  /** The rows whose listing columns a store that does not know them left out of date: copy them
   * out of each blob again. A row whose blob does not parse keeps no Workflow, and is not listed. A
   * blob with no `startedAt` keeps the start that the row has. */
  private fillListing(): void {
    const rows = this.db
      .prepare(
        `SELECT run_id, snapshot, updated_at FROM machine_snapshots
         WHERE snapshot IS NOT NULL AND listed_at IS NOT updated_at`,
      )
      .all() as Array<{ run_id: string; snapshot: string; updated_at: string | null }>;
    const update = this.db.prepare(
      `UPDATE machine_snapshots SET workflow = ?,
         started_at = CASE WHEN ? THEN ? ELSE COALESCE(started_at, ?) END,
         summary = ?, listed_at = updated_at WHERE run_id = ?`,
    );
    for (const row of rows) {
      let blob: unknown;
      try {
        blob = JSON.parse(row.snapshot);
      } catch {
        continue;
      }
      const listing = listingOf(blob, row.updated_at ?? new Date().toISOString());
      const own = hasStartedAt(blob) ? 1 : 0;
      update.run(listing.workflow, own, listing.startedAt, listing.startedAt, listing.summary, row.run_id);
    }
  }

  async load(runId: string): Promise<StoredSnapshot | null> {
    const row = this.db
      .prepare(
        `SELECT run_id, status, snapshot, reason, updated_at, started_at FROM machine_snapshots WHERE run_id = ?`,
      )
      .get(runId) as Row | undefined;
    return row ? storedOf(row) : null;
  }

  async live(): Promise<StoredSnapshot[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id, status, snapshot, reason, updated_at, started_at FROM machine_snapshots
         WHERE status = 'live' ORDER BY rowid`,
      )
      .all() as Row[];
    return rows.map(storedOf);
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

  async findByDispatch(workflow: string, key: string): Promise<string | undefined> {
    const row = this.db.prepare(FIND_BY_DISPATCH_SQL).get(workflow, key) as { run_id: string } | undefined;
    return row?.run_id;
  }

  async save(runId: string, snapshot: unknown, status = "live"): Promise<void> {
    const now = new Date().toISOString();
    const listing = listingOf(snapshot, now);
    // A blob with no `startedAt` keeps the start that the row has: its first save's time.
    this.db
      .prepare(
        `INSERT INTO machine_snapshots
           (run_id, status, snapshot, reason, updated_at, dispatch_effect, dispatch_workflow, workflow, started_at, summary, listed_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           snapshot = excluded.snapshot,
           reason = NULL,
           updated_at = excluded.updated_at,
           dispatch_effect = excluded.dispatch_effect,
           dispatch_workflow = excluded.dispatch_workflow,
           workflow = excluded.workflow,
           started_at = CASE WHEN ? THEN excluded.started_at ELSE COALESCE(started_at, excluded.started_at) END,
           summary = excluded.summary,
           listed_at = excluded.listed_at`,
      )
      .run(
        runId,
        status,
        JSON.stringify(snapshot),
        now,
        dispatchEffectOf(snapshot),
        dispatchWorkflowOf(snapshot),
        listing.workflow,
        listing.startedAt,
        listing.summary,
        now,
        hasStartedAt(snapshot) ? 1 : 0,
      );
  }

  async ended(query: EndedQuery): Promise<EndedRow[]> {
    return this.listRows(`status != 'live'`, query);
  }

  async liveRows(query: EndedQuery): Promise<EndedRow[]> {
    const { statuses: _statuses, ...rest } = query;
    return this.listRows(`status = 'live'`, rest);
  }

  private listRows(status: string, query: EndedQuery): EndedRow[] {
    const where = [status, `workflow IS NOT NULL`, `started_at IS NOT NULL`];
    const args: Array<string | number> = [];
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return [];
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      args.push(...query.statuses);
    }
    if (query.workflows !== undefined) {
      if (query.workflows.length === 0) return [];
      const marks = query.workflows.map(() => "?").join(", ");
      // A grant of a Chart wrapper opens its Charts, `<wrapper>/<chart>` (ADR-0078).
      where.push(
        `(workflow IN (${marks}) OR (instr(workflow, '/') > 0 AND substr(workflow, 1, instr(workflow, '/') - 1) IN (${marks})))`,
      );
      args.push(...query.workflows, ...query.workflows);
    }
    if (query.workflow !== undefined) {
      where.push(`workflow = ?`);
      args.push(query.workflow);
    }
    if (query.since !== undefined) {
      where.push(`started_at >= ?`);
      args.push(query.since);
    }
    if (query.after !== undefined) {
      where.push(`(started_at < ? OR (started_at = ? AND run_id < ?))`);
      args.push(query.after.startedAt, query.after.startedAt, query.after.runId);
    }
    const rows = this.db
      .prepare(
        `SELECT run_id, workflow, status, reason, started_at, updated_at, summary FROM machine_snapshots
         WHERE ${where.join(" AND ")} ORDER BY started_at DESC, run_id DESC LIMIT ?`,
      )
      .all(...args, query.limit) as Array<{
      run_id: string;
      workflow: string;
      status: string;
      reason: string | null;
      started_at: string;
      updated_at: string;
      summary: string | null;
    }>;
    return rows.map((row) => {
      let summary: RowSummary = {};
      try {
        summary = row.summary === null ? {} : (JSON.parse(row.summary) as RowSummary);
      } catch {
        // A summary that does not parse lists the columns alone.
      }
      const reason = row.reason ?? summary.failure ?? summary.fault;
      return {
        runId: row.run_id,
        workflow: row.workflow,
        status: row.status,
        ...(reason !== undefined ? { reason } : {}),
        startedAt: row.started_at,
        endedAt: row.updated_at,
        ...(summary.startedBy !== undefined ? { startedBy: summary.startedBy } : {}),
        ...(summary.assembly !== undefined ? { assembly: summary.assembly } : {}),
        ...(summary.dispatchedBy !== undefined ? { dispatchedBy: summary.dispatchedBy } : {}),
      };
    });
  }

  async markLost(runId: string, reason: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO machine_snapshots (run_id, status, snapshot, reason, updated_at)
         VALUES (?, 'lost', NULL, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = 'lost',
           reason = excluded.reason,
           updated_at = excluded.updated_at,
           listed_at = CASE WHEN listed_at IS updated_at THEN excluded.updated_at ELSE listed_at END`,
      )
      .run(runId, reason, new Date().toISOString());
  }

  /** An UPDATE, not an upsert: a drifted run is one we already have a snapshot for, and the whole
   * point is to keep it. A row that is not there is not a drifted run — nothing to record. */
  async markDrifted(runId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        // The blob is not touched, so listing columns that were current stay current.
        `UPDATE machine_snapshots SET status = 'drifted', reason = ?, updated_at = ?,
           listed_at = CASE WHEN listed_at IS updated_at THEN ? ELSE listed_at END WHERE run_id = ?`,
      )
      .run(reason, now, now, runId);
  }

  /** `updated_at` is an ISO-8601 UTC string, so a string comparison is a time comparison. A
   * terminal row's `updated_at` is its terminal write — the age `runs.retain` counts from. The hook
   * log's lines go by the same time (ADR-0011); the count is of runs alone. */
  async sweep(olderThan: Date): Promise<string[]> {
    // The run a standing head names stays (ADR-0017): a paused Pool's held items are in its blob.
    const swept = this.db
      .prepare(
        `DELETE FROM machine_snapshots WHERE status != 'live' AND updated_at < ?
           AND run_id NOT IN (SELECT run FROM standing) RETURNING run_id`,
      )
      .all(olderThan.toISOString()) as Array<{ run_id: string }>;
    this.db.prepare(`DELETE FROM hook_log WHERE at < ?`).run(olderThan.toISOString());
    if (swept.length) {
      this.db
        .prepare(
          `DELETE FROM run_machines WHERE key NOT IN
             (SELECT machine_key FROM machine_snapshots WHERE machine_key IS NOT NULL)`,
        )
        .run();
    }
    return swept.map((r) => r.run_id);
  }

  keepMachine(runId: string, key: string, doc: unknown): void {
    this.db.prepare(`INSERT OR IGNORE INTO run_machines (key, doc) VALUES (?, ?)`).run(key, JSON.stringify(doc));
    this.db.prepare(`UPDATE machine_snapshots SET machine_key = ? WHERE run_id = ?`).run(key, runId);
  }

  keptMachine(runId: string): { workflow: string; doc: unknown } | undefined {
    const row = this.db
      .prepare(
        `SELECT s.workflow, m.doc FROM machine_snapshots s JOIN run_machines m ON m.key = s.machine_key
           WHERE s.run_id = ?`,
      )
      .get(runId) as { workflow: string | null; doc: string } | undefined;
    return row?.workflow ? { workflow: row.workflow, doc: JSON.parse(row.doc) } : undefined;
  }

  claimHookDelivery(hook: string, delivery: string, digest: string): number | undefined {
    const kinds = CLAIMED_KINDS.map(() => "?").join(", ");
    const held = this.db
      .prepare(`SELECT 1 FROM hook_log WHERE hook = ? AND (delivery = ? OR digest = ?) AND kind IN (${kinds}) LIMIT 1`)
      .get(hook, delivery, digest, ...CLAIMED_KINDS);
    if (held) return undefined;
    const result = this.db
      .prepare(`INSERT INTO hook_log (hook, at, kind, status, delivery, digest) VALUES (?, ?, 'pending', 0, ?, ?)`)
      .run(hook, new Date().toISOString(), delivery, digest);
    return Number(result.lastInsertRowid);
  }

  writeHookLine(line: HookLogLine, claimed?: number): void {
    const detail = line.detail === undefined ? null : JSON.stringify(line.detail);
    if (claimed !== undefined) {
      this.db
        .prepare(`UPDATE hook_log SET kind = ?, status = ?, key = ?, detail = ? WHERE id = ?`)
        .run(line.kind, line.status, line.key ?? null, detail, claimed);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO hook_log (hook, at, kind, status, delivery, digest, key, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        line.hook,
        line.at,
        line.kind,
        line.status,
        line.delivery ?? null,
        line.digest ?? null,
        line.key ?? null,
        detail,
      );
  }

  hookLog(hook: string, limit: number): HookLogLine[] {
    const rows = this.db
      .prepare(
        `SELECT hook, at, kind, status, delivery, digest, key, detail FROM hook_log WHERE hook = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(hook, limit) as Array<{
      hook: string;
      at: string;
      kind: HookLogLine["kind"];
      status: number;
      delivery: string | null;
      digest: string | null;
      key: string | null;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      hook: r.hook,
      at: r.at,
      kind: r.kind,
      status: r.status,
      ...(r.delivery !== null ? { delivery: r.delivery } : {}),
      ...(r.digest !== null ? { digest: r.digest } : {}),
      ...(r.key !== null ? { key: r.key } : {}),
      ...(r.detail !== null ? { detail: JSON.parse(r.detail) as unknown } : {}),
    }));
  }

  standingHeads(): StandingHead[] {
    const rows = this.db.prepare(`SELECT workflow, run, since, streak, paused FROM standing`).all() as Array<{
      workflow: string;
      run: string;
      since: string;
      streak: number;
      paused: string | null;
    }>;
    return rows.map((r) => ({
      workflow: r.workflow,
      run: r.run,
      since: r.since,
      streak: Number(r.streak),
      ...(r.paused === "cancel" || r.paused === "errors" || r.paused === "bound" ? { paused: r.paused } : {}),
    }));
  }

  writeStanding(head: StandingHead): void {
    this.db
      .prepare(
        `INSERT INTO standing (workflow, run, since, streak, paused) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workflow) DO UPDATE SET
           run = excluded.run, since = excluded.since, streak = excluded.streak, paused = excluded.paused`,
      )
      .run(head.workflow, head.run, head.since, head.streak, head.paused ?? null);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
