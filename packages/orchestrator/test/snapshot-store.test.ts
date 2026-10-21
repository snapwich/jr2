// The store's own claims (ADR-0065): a persist survives a process crash (WAL, `synchronous=NORMAL`),
// `restore()` reads live rows only, and a finished run's row lives a week and no longer. Driven
// against a file-backed db where the claim is about the file — `:memory:` has no journal to set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FIND_BY_DISPATCH_SQL, SqliteSnapshotStore } from "../src/snapshot-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withDb(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-store-"));
  try {
    await fn(join(dir, "state.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Back-date a row as if its last write were `daysAgo` days ago. A second connection, because the
 * store has no seam for a clock and should not grow one for a test. */
function age(path: string, runId: string, daysAgo: number): void {
  const db = new DatabaseSync(path);
  db.prepare(`UPDATE machine_snapshots SET updated_at = ? WHERE run_id = ?`).run(
    new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    runId,
  );
  db.close();
}

test("init sets the write-ahead log and synchronous=NORMAL (ADR-0065)", async () => {
  await withDb(async (path) => {
    const store = new SqliteSnapshotStore(path);
    await store.init();
    // Read back through a second connection: journal_mode is a property of the FILE, so this is
    // what the next process to open state.db inherits.
    const db = new DatabaseSync(path);
    assert.equal((db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode, "wal");
    db.close();
    // `synchronous` is per connection — so it must be the store's own. 1 = NORMAL (2 = FULL).
    const own = (store as unknown as { db: DatabaseSync }).db;
    assert.equal((own.prepare(`PRAGMA synchronous`).get() as { synchronous: number }).synchronous, 1);
    await store.close();
  });
});

test("live() answers live rows only, in insertion order", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  await store.save("a", { n: 1 });
  await store.save("b", { n: 2 }, "done");
  await store.save("c", { n: 3 });
  await store.markLost("d", "gone");
  await store.save("e", { n: 5 });
  await store.markDrifted("e", "changed shape");
  await store.save("f", { n: 6 }, "cancelled");

  assert.deepEqual(
    (await store.live()).map((s) => [s.runId, s.status]),
    [
      ["a", "live"],
      ["c", "live"],
    ],
  );
  await store.close();
});

test("sweep deletes old non-live rows only — not a live row of any age, not a fresh terminal one", async () => {
  await withDb(async (path) => {
    const store = new SqliteSnapshotStore(path);
    await store.init();
    await store.save("old-live", {});
    await store.save("old-done", {}, "done");
    await store.save("old-error", {}, "error");
    await store.markLost("old-lost", "gone");
    await store.save("old-drifted", {});
    await store.markDrifted("old-drifted", "changed shape");
    await store.save("fresh-done", {}, "done");
    for (const id of ["old-done", "old-error", "old-lost", "old-drifted"]) age(path, id, 8);
    // A run parked on a Gate for a month is still a run (ADR-0065).
    age(path, "old-live", 30);
    age(path, "fresh-done", 6);

    const swept = await store.sweep(new Date(Date.now() - 7 * DAY_MS));

    assert.equal(swept, 4);
    for (const id of ["old-done", "old-error", "old-lost", "old-drifted"]) {
      assert.equal(await store.load(id), null, `${id} is swept`);
    }
    assert.equal((await store.load("old-live"))?.status, "live");
    assert.equal((await store.load("fresh-done"))?.status, "done");
    // A swept id frees its abbreviations (ADR-0009).
    assert.deepEqual(await store.findIdsByPrefix("old-", 10), ["old-live"]);
    await store.close();
  });
});

test("liveAssemblies: the live rows by the Assembly their blob names, terminal rows hold nothing (ADR-0069)", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  await store.save("r1", { workflow: "w", assembly: "aaaaaaaaaaaa" });
  await store.save("r2", { workflow: "w", assembly: "bbbbbbbbbbbb" });
  await store.save("r3", { workflow: "w", assembly: "aaaaaaaaaaaa" });
  await store.save("done", { workflow: "w", assembly: "cccccccccccc" }, "done");
  await store.save("unstamped", { workflow: "w" });
  await store.save("drift", { workflow: "w", assembly: "dddddddddddd" });
  await store.markDrifted("drift", "Assembly dddddddddddd is not on the volume");
  await store.markLost("gone", "empty snapshot");
  assert.deepEqual(
    [...(await store.liveAssemblies())],
    [
      ["aaaaaaaaaaaa", ["r1", "r3"]],
      ["bbbbbbbbbbbb", ["r2"]],
    ],
  );
  await store.close();
});

test("findByDispatch finds a run by its blob's idempotency key, in any status, through an index (ADR-0071)", async () => {
  await withDb(async (path) => {
    const store = new SqliteSnapshotStore(path);
    await store.init();
    await store.save("r-plain", { workflow: "ping", snapshot: {} });
    await store.save("r-live", { workflow: "ping", dispatchedBy: { run: "c", slot: "s", effect: "k-live", depth: 1 } });
    await store.save(
      "r-done",
      { workflow: "ping", dispatchedBy: { run: "c", slot: "s", effect: "k-done", depth: 1 } },
      "done",
    );
    assert.equal(await store.findByDispatch("k-live"), "r-live");
    assert.equal(await store.findByDispatch("k-done"), "r-done", "a settled run keeps answering its key");
    assert.equal(await store.findByDispatch("k-none"), undefined);
    // `markLost` on a saved row keeps its blob, so a lost run still answers its key: a re-send
    // after the run was lost names it, and never starts a second.
    await store.markLost("r-live", "gone");
    assert.equal(await store.findByDispatch("k-live"), "r-live");

    // The index exists, and the store's own lookup statement seeks through it.
    const db = new DatabaseSync(path);
    const index = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'machine_snapshots_dispatch_effect'`)
      .get() as { name: string } | undefined;
    assert.equal(index?.name, "machine_snapshots_dispatch_effect");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${FIND_BY_DISPATCH_SQL}`).all("k-done") as Array<{ detail: string }>;
    assert.ok(
      plan.some((row) => row.detail.includes("machine_snapshots_dispatch_effect")),
      JSON.stringify(plan),
    );
    db.close();
    await store.close();
  });
});

/** A blob nested past what SQLite's JSON parser takes (about 1000 levels): `json_extract` throws
 * on it, so nothing on the save or the boot path may run one over every row. */
function deep(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < levels; i++) node = { n: node };
  return node;
}

test("a blob nested past SQLite's JSON depth still saves and answers its key (ADR-0071)", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  const blob = {
    workflow: "parked",
    data: deep(1200),
    dispatchedBy: { run: "c", slot: "s", effect: "k-deep", depth: 1 },
  };
  await store.save("r-deep", blob);
  assert.equal((await store.load("r-deep"))?.status, "live");
  assert.equal(await store.findByDispatch("k-deep"), "r-deep");
  // A save that drops the key drops it from the lookup too.
  await store.save("r-deep", { workflow: "parked" }, "done");
  assert.equal(await store.findByDispatch("k-deep"), undefined);
  await store.close();
});

test("init over a volume an earlier Kit wrote — the old table, a deep row among them — adds the key column (ADR-0071)", async () => {
  await withDb(async (path) => {
    // The table as it was before the key: no `dispatch_effect` column.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE machine_snapshots (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'live',
        snapshot TEXT,
        reason TEXT,
        updated_at TEXT
      )
    `);
    const insert = old.prepare(
      `INSERT INTO machine_snapshots (run_id, status, snapshot, reason, updated_at) VALUES (?, ?, ?, NULL, ?)`,
    );
    const now = new Date().toISOString();
    insert.run("r-old", "live", JSON.stringify({ workflow: "ping" }), now);
    insert.run("r-deep", "done", JSON.stringify({ workflow: "parked", data: deep(1200) }), now);
    old.close();

    const store = new SqliteSnapshotStore(path);
    await store.init();
    await store.init(); // and again, as every boot does
    assert.deepEqual(
      (await store.live()).map((r) => r.runId),
      ["r-old"],
    );
    assert.equal(await store.findByDispatch("k-new"), undefined);
    await store.save("r-new", { workflow: "ping", dispatchedBy: { run: "c", slot: "s", effect: "k-new", depth: 1 } });
    assert.equal(await store.findByDispatch("k-new"), "r-new");
    await store.close();
  });
});
