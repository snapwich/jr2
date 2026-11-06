// The kept conversations (ADR-0023, ADR-0065): what the Harness sends of each conversation while
// its Turn runs, kept in `conversations.db` beside `state.db` on the state volume, for as long as
// the run is kept. A second SQLite file, because its writes are larger and more frequent than a
// snapshot's, and its sweep frees pages: neither may slow the snapshot's synchronous write.
//
//   conversations   one row per conversation: its run, its Agent, the bytes kept, `cut`, `swept`
//   entries         one row per entry, keyed by (instance_id, seq): a batch sent again adds nothing
//
// The rows are plain JSON (`entry` is the entry as the Harness sent it, with the Agent from the
// ledger), so a person or a tool can query the file with SQLite alone. The file is made with
// `auto_vacuum = INCREMENTAL`, and each delete frees its pages, so the file gets smaller after a
// sweep. There is no compression now: when it comes, it is Node's own zstd on the entry text, with
// the queryable columns kept.
//
// The cap is per conversation: an entry that would take it past `capBytes` is not kept. One marker
// entry takes its place, and every later entry of that conversation is dropped. The cap keeps the
// start of the conversation, which tells why the Agent did what it did.

import { readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SnapshotStore } from "./snapshot-store.ts";

/** One entry of a kept conversation (ADR-0023): one body of the print, its label as `kind` and the
 * rest as `text`. `seq` goes up for as long as the Instance ID is kept; a new record starts it at
 * the clock (the Harness's keep.ts). */
export type ConversationEntry = {
  id: string;
  seq: number;
  at: string;
  agent: string;
  kind: string;
  text: string;
};

/** What an entry is, as the Harness sends it: the Agent comes from the ledger, not the body. */
export type SentEntry = Omit<ConversationEntry, "agent">;

/** One kept conversation, as `GET /runs/:runId/conversations` lists it (without `open`, which is the
 * host's to say). */
export type KeptConversation = {
  agent: string;
  instanceId: string;
  bytes: number;
  cut: boolean;
  /** Why the conversation's entries are gone while its run is kept: the space guard swept them. */
  swept?: typeof SWEPT_NO_SPACE;
};

/** The one reason the guard sweeps a conversation (ADR-0065). */
export const SWEPT_NO_SPACE = "no space";

/** What a run says when the guard swept its conversations (ADR-0065). */
export const CONVERSATION_SWEPT = "conversation swept: no space" as const;

/** The cap of one kept conversation (ADR-0023). */
export const CONVERSATION_CAP_BYTES = 8 * 1024 * 1024;

/** The `kind` of the marker entry that a cut leaves (ADR-0023). */
export const CUT_KIND = "cut";

/** An append's outcome: how many entries are new, and whether the conversation is cut. */
export type AppendResult = { kept: number; cut: boolean };

type ConversationRow = {
  run_id: string;
  agent: string;
  bytes: number;
  cut: number;
  swept: string | null;
};

/** The listener of one conversation's new entries (the SSE follow). */
type EntryListener = (entries: ConversationEntry[]) => void;

export class ConversationStore {
  private readonly db: DatabaseSync;
  private readonly capBytes: number;
  private readonly listeners = new Map<string, Set<EntryListener>>();
  /** Set by the guard: the volume is past its last bound, and no entry is kept (ADR-0065). */
  #full = false;

  constructor(path: string, opts: { capBytes?: number } = {}) {
    this.db = new DatabaseSync(path);
    this.capBytes = opts.capBytes ?? CONVERSATION_CAP_BYTES;
  }

  init(): void {
    // Before the first table, or it has no effect: a file's vacuum mode is set when it is made.
    this.db.exec(`PRAGMA auto_vacuum = INCREMENTAL`);
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        instance_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        cut INTEGER NOT NULL DEFAULT 0,
        swept TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS conversations_run ON conversations (run_id, created_at)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        instance_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (instance_id, seq)
      ) WITHOUT ROWID
    `);
    // The entry id dedupes (ADR-0023): a batch sent again adds nothing, and an entry of a new
    // record whose seq meets an old one (a pod on a node whose clock is behind) is still kept.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS entries_id ON entries (instance_id, id)`);
  }

  /** The volume is past the guard's last bound: no entry is kept, and each conversation that gets
   * one more is cut with a marker, as at its cap (ADR-0065). */
  get full(): boolean {
    return this.#full;
  }
  set full(value: boolean) {
    this.#full = value;
  }

  /**
   * Keep a batch of one conversation's entries. An entry whose `(instanceId, seq)` is kept already
   * adds nothing, so a batch sent again is harmless. An entry that would take the conversation past
   * its cap, or that comes while the volume is full, is replaced by one marker, and the conversation
   * is cut: no later entry is kept. A conversation that the guard swept keeps nothing more.
   */
  append(runId: string, instanceId: string, agent: string, sent: readonly SentEntry[]): AppendResult {
    const now = new Date().toISOString();
    const added: ConversationEntry[] = [];
    let kept = 0;
    this.db.exec("BEGIN IMMEDIATE");
    let row: ConversationRow;
    try {
      const found = this.row(instanceId);
      if (!found) {
        this.db
          .prepare(
            `INSERT INTO conversations (instance_id, run_id, agent, bytes, cut, created_at, updated_at)
             VALUES (?, ?, ?, 0, 0, ?, ?)`,
          )
          .run(instanceId, runId, agent, now, now);
      }
      row = found ?? { run_id: runId, agent, bytes: 0, cut: 0, swept: null };
      if (row.cut || row.swept !== null) {
        this.db.exec("COMMIT");
        return { kept: 0, cut: row.cut === 1 };
      }
      const hasId = this.db.prepare(`SELECT 1 FROM entries WHERE instance_id = ? AND id = ?`);
      const hasSeq = this.db.prepare(`SELECT 1 FROM entries WHERE instance_id = ? AND seq = ?`);
      const last = this.db.prepare(`SELECT MAX(seq) AS seq FROM entries WHERE instance_id = ?`);
      const insertRow = this.db.prepare(`INSERT INTO entries (instance_id, seq, id, entry) VALUES (?, ?, ?, ?)`);
      for (const e of [...sent].sort((a, b) => a.seq - b.seq)) {
        if (hasId.get(instanceId, e.id)) continue;
        // Another entry has this seq: a new record whose clock is behind. Keep it after the last.
        const seq = hasSeq.get(instanceId, e.seq)
          ? ((last.get(instanceId) as { seq: number | null }).seq ?? 0) + 1
          : e.seq;
        const entry: ConversationEntry = { id: e.id, seq, at: e.at, agent, kind: e.kind, text: e.text };
        const json = JSON.stringify(entry);
        const size = Buffer.byteLength(json);
        if (this.#full || row.bytes + size > this.capBytes) {
          const marker: ConversationEntry = {
            id: `${CUT_KIND}-${seq}`,
            seq,
            at: now,
            agent,
            kind: CUT_KIND,
            text: this.#full
              ? "the Orchestrator keeps no more of this conversation: its state volume is full (ADR-0065)"
              : `the Orchestrator keeps no more of this conversation: it is at its cap of ${capText(this.capBytes)} (ADR-0023)`,
          };
          insertRow.run(instanceId, seq, marker.id, JSON.stringify(marker));
          added.push(marker);
          row.cut = 1;
          break;
        }
        insertRow.run(instanceId, seq, e.id, json);
        added.push(entry);
        kept += 1;
        row.bytes += size;
      }
      this.db
        .prepare(`UPDATE conversations SET bytes = ?, cut = ?, updated_at = ? WHERE instance_id = ?`)
        .run(row.bytes, row.cut, now, instanceId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (added.length > 0) for (const listener of this.listeners.get(instanceId) ?? []) listener(added);
    return { kept, cut: row.cut === 1 };
  }

  /** A run's kept conversations, the first kept first. */
  list(runId: string): KeptConversation[] {
    const rows = this.db
      .prepare(
        `SELECT instance_id, agent, bytes, cut, swept FROM conversations WHERE run_id = ?
           ORDER BY created_at, instance_id`,
      )
      .all(runId) as Array<{ instance_id: string; agent: string; bytes: number; cut: number; swept: string | null }>;
    return rows.map((r) => ({
      agent: r.agent,
      instanceId: r.instance_id,
      bytes: r.bytes,
      cut: r.cut === 1,
      ...(r.swept !== null ? { swept: SWEPT_NO_SPACE } : {}),
    }));
  }

  /** One kept conversation of a run, or undefined when the run has none of that id. */
  conversation(runId: string, instanceId: string): KeptConversation | undefined {
    return this.list(runId).find((c) => c.instanceId === instanceId);
  }

  /** The entries of a conversation after `after` (-1: from the first), in order, at most `limit`. */
  entries(instanceId: string, after: number, limit: number): ConversationEntry[] {
    const rows = this.db
      .prepare(`SELECT entry FROM entries WHERE instance_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(instanceId, after, limit) as Array<{ entry: string }>;
    return rows.map((r) => JSON.parse(r.entry) as ConversationEntry);
  }

  /** The runs, of `runIds`, whose conversations the guard swept (ADR-0065). */
  sweptRuns(runIds: readonly string[]): Set<string> {
    const swept = new Set<string>();
    const query = this.db.prepare(`SELECT 1 FROM conversations WHERE run_id = ? AND swept IS NOT NULL LIMIT 1`);
    for (const runId of runIds) if (query.get(runId)) swept.add(runId);
    return swept;
  }

  /** Hear the new entries of one conversation. Returns the unsubscribe. */
  follow(instanceId: string, listener: EntryListener): () => void {
    let set = this.listeners.get(instanceId);
    if (!set) this.listeners.set(instanceId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(instanceId) === set) this.listeners.delete(instanceId);
    };
  }

  /** Delete the conversations of runs that the retention sweep deleted (ADR-0065), and free their
   * pages. */
  deleteRuns(runIds: readonly string[]): void {
    if (runIds.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const entries = this.db.prepare(
        `DELETE FROM entries WHERE instance_id IN (SELECT instance_id FROM conversations WHERE run_id = ?)`,
      );
      const rows = this.db.prepare(`DELETE FROM conversations WHERE run_id = ?`);
      for (const runId of runIds) {
        entries.run(runId);
        rows.run(runId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.vacuum();
  }

  /** Each run that has a kept conversation, swept or not. */
  runIds(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT run_id FROM conversations ORDER BY run_id`).all() as Array<{
      run_id: string;
    }>;
    return rows.map((r) => r.run_id);
  }

  /** The runs that have conversations with entries kept, the run whose first conversation is
   * oldest first: the order in which the guard sweeps (ADR-0065). */
  runsOldestFirst(): string[] {
    const rows = this.db
      .prepare(`SELECT run_id FROM conversations WHERE swept IS NULL GROUP BY run_id ORDER BY MIN(created_at), run_id`)
      .all() as Array<{ run_id: string }>;
    return rows.map((r) => r.run_id);
  }

  /** Delete the entries of a run's conversations for space (ADR-0065). The rows stay, marked
   * swept, so the list says why the conversation is gone. */
  sweepForSpace(runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`DELETE FROM entries WHERE instance_id IN (SELECT instance_id FROM conversations WHERE run_id = ?)`)
        .run(runId);
      this.db
        .prepare(`UPDATE conversations SET swept = ?, bytes = 0, updated_at = ? WHERE run_id = ?`)
        .run(SWEPT_NO_SPACE, new Date().toISOString(), runId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.vacuum();
  }

  /** Give the freed pages back to the file system: the file, and the WAL beside it, get smaller. */
  private vacuum(): void {
    this.db.exec(`PRAGMA incremental_vacuum`);
    this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  }

  private row(instanceId: string): ConversationRow | undefined {
    return this.db
      .prepare(`SELECT run_id, agent, bytes, cut, swept FROM conversations WHERE instance_id = ?`)
      .get(instanceId) as ConversationRow | undefined;
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }
}

function capText(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

// ---- The space guard (ADR-0065) ------------------------------------------------------------------

/** Above this part of the volume, the guard sweeps the conversations of ended runs. */
export const GUARD_SWEEP_AT = 0.8;
/** Above this part, with no conversation of an ended run left, no entry is kept. */
export const GUARD_FULL_AT = 0.95;

/** What the guard reads and does. Injected, so a test sets the sizes. */
export type SpaceGuardPort = {
  conversations: ConversationStore;
  /** The bytes of the files on the state volume: both databases with their `-wal` files, the
   * Assemblies and the Charts. */
  used(): number;
  /** The size of the state volume: the smaller of the claim and what `statfs` says. */
  capacity(): number;
  /** Whether a run is live. A live run's conversations are never swept for space. */
  isLive(runId: string): Promise<boolean>;
  /** Hears each run whose conversations went. */
  onSwept?: (runId: string) => void;
};

/**
 * One pass of the space guard (ADR-0065). Above 80% of the volume, it deletes the kept
 * conversations of ended runs, the oldest run first, until the volume is below 80%. A live run's
 * conversations are never swept. Above 95% with no ended run's conversation left, it sets the
 * store full, and each open conversation is cut at its next entry; below that, the store keeps
 * entries again. Answers the runs whose conversations went.
 */
export async function guardSpace(port: SpaceGuardPort): Promise<string[]> {
  const capacity = port.capacity();
  if (!(capacity > 0)) return [];
  const swept: string[] = [];
  let used = port.used();
  if (used > GUARD_SWEEP_AT * capacity) {
    for (const runId of port.conversations.runsOldestFirst()) {
      if (used < GUARD_SWEEP_AT * capacity) break;
      if (await port.isLive(runId)) continue;
      port.conversations.sweepForSpace(runId);
      swept.push(runId);
      port.onSwept?.(runId);
      used = port.used();
    }
  }
  port.conversations.full = used > GUARD_FULL_AT * capacity;
  return swept;
}

/** The bytes of every file under `dir`, at any depth. A file that goes while it is read counts 0. */
export function bytesUnder(dir: string): number {
  let total = 0;
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += bytesUnder(path);
    else if (entry.isFile()) {
      try {
        total += statSync(path).size;
      } catch {
        // Gone between the read and the stat.
      }
    }
  }
  return total;
}

/** The size of the file system that holds `dir` (`statfs`), or Infinity when it cannot be read. */
export function fileSystemBytes(dir: string): number {
  try {
    const fs = statfsSync(dir);
    return fs.blocks * fs.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const QUANTITY = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;
const UNIT: Record<string, number> = {
  "": 1,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** A Kubernetes storage quantity (`"5Gi"`) in bytes, or undefined for one that does not parse. */
export function quantityBytes(quantity: string): number | undefined {
  const m = QUANTITY.exec(quantity);
  if (!m) return undefined;
  return Number.parseFloat(m[1]!) * UNIT[m[2] ?? ""]!;
}

/**
 * Delete the kept conversations whose run has no row in the run store, and answer those run ids.
 * Such a conversation stays when a crash comes between the store's sweep and `deleteRuns`, or when
 * a batch is placed just before the sweep deletes its row. The retention sweep never names that
 * run again, so each sweep calls this (ADR-0065).
 */
export async function deleteOrphanConversations(
  conversations: ConversationStore,
  runs: Pick<SnapshotStore, "findIdsByPrefix">,
): Promise<string[]> {
  const orphans: string[] = [];
  for (const runId of conversations.runIds()) {
    // The ids that share a prefix come sorted, so the run's own id, when it exists, is first.
    const [first] = await runs.findIdsByPrefix(runId, 1);
    if (first !== runId) orphans.push(runId);
  }
  conversations.deleteRuns(orphans);
  return orphans;
}
