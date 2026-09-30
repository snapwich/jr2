// The store's own claims (ADR-0065): a persist survives a process crash (WAL, `synchronous=NORMAL`),
// `restore()` reads live rows only, and a finished run's row lives a week and no longer. Driven
// against a file-backed db where the claim is about the file — `:memory:` has no journal to set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";

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
