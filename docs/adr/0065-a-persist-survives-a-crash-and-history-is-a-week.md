# A persist survives a crash, and history is a week

Every transition of a run persists its whole snapshot (ADR-0007). The scaling review (R6) read the store and listed its
costs: `JSON.stringify` of the whole run, a synchronous upsert with an fsync on the event loop, a Pool's run as one blob
holding every worker, terminal rows never deleted, and `restore()` parsing every row before the server listens. It also
found the words "Postgres opt-in" in CONTEXT.md, ADR-0008 and ADR-0009, with no such store in the code. Measured on the
home cluster's chaos Instance (2026-09-30, `local-path` volume): a persist costs **4.5 ms, whatever the blob's size** (1
KB or 100 KB), because the cost is the fsync, not the JSON; with the write-ahead log and `synchronous=NORMAL` the same
upserts cost 0.04 ms (1 KB) and 0.18 ms (100 KB). A run's blob is about 1 KB; a Pool of 40 workers is about 100 KB.

## Decision

- **A persist survives a process crash, not a power loss.** The store runs sqlite in WAL mode with `synchronous=NORMAL`:
  a write is durable once the OS holds it, and sqlite fsyncs only at a checkpoint. A node's power loss can lose the
  transitions since the last checkpoint; the file stays consistent, and `restore()` treats the older snapshot as it
  treats any restart — reconcile against the live world, re-attach, or `lost`. The window in which a crash re-POSTs a
  prompt (ADR-0007's at-most-once sliver) widens from one microtask to one checkpoint, and only on a power loss, which
  also ends every Sandbox on that node.
- **The write stays synchronous and on the event loop.** At 0.2 ms for a Pool's blob there is nothing to move off the
  loop, and the ordering matters: the row is on disk before the Machine's next side effect runs, which is what lets an
  epoch bump (ADR-0057) or an admission (ADR-0016) be saved "at the write". A worker thread, an asynchronous driver or a
  network store would land the row after the next `invoke` fires, on every persist.
- **One blob per run stays.** The snapshot is a tree that xstate restores from its root, and one row keeps it atomic; a
  Pool's cost at 40 workers is 0.2 ms, so its workers do not become rows of their own.
- **`restore()` reads live rows only.** The store answers `WHERE status = 'live'`; terminal rows are not parsed at boot.
- **A finished run's row lives 7 days, fixed.** Every non-live status — `done`, `error`, `cancelled`, `lost`, `drifted`
  — ages from its terminal write, and a sweep at boot and every hour deletes what is older. A `live` row is never swept:
  a run parked on a Gate for a month stays and is restored. The value is fixed like the Sandbox idle timeout, not
  config: jr2 is not the record of a run's results (a Machine sends its output where it belongs — a PR, a Source), and
  `jr2 status` on an old run is a debugging act. A swept id frees its abbreviations (ADR-0009).
- **The store is sqlite on the Instance's volume. No Postgres is owed.** The `SnapshotStore` interface stays as the
  seam, with one implementation. `DATABASE_URL` is not a thing jr2 reads.

## Considered options

- **Keep `synchronous=FULL`, move the write to a worker thread.** Rejected: the thread hides 4.5 ms from the loop but
  does not make the disk faster, so writes queue under load and the loop no longer knows how far behind the store is —
  and it opens the ordering gap on every write, which NORMAL opens only on a power loss.
- **Batch persists in a window.** Rejected: one persist per macrostep already coalesces a transition's events, and with
  the fsync gone there is nothing left to amortize.
- **A row per worker.** Rejected: it splits an atomic tree across rows (a worker's row saved, the Pool's not), makes
  restore reassemble what xstate restores whole, and buys nothing measurable at 0.2 ms per blob.
- **Configurable retention (`runs.retain`), or a count cap per workflow.** Rejected: a count cap does not bound a busy
  workflow's disk and punishes a quiet one; a config key is owed only when a history surface (a list, a query) exists to
  use it, and none does — `jr2 runs` and the Console list live runs.
- **Build the Postgres store.** Rejected: the only thing it buys is an Orchestrator pod that reschedules without its
  volume, which is a storage-class question (a network RWO volume follows the pod) and belongs to the Orchestrator pod's
  own decision (R10), not to the store. Its cost is a dependency the owner operates, a second store in every test tier,
  and the asynchronous write above.

## Consequences

- ADR-0008 and ADR-0009 lose "Postgres opt-in" and `DATABASE_URL`; CONTEXT.md's Orchestrator persists "to sqlite on its
  volume". ADR-0007 points here for the store's durability.
- The Instance's volume gains `state.db-wal` and `state.db-shm` beside `state.db`.
- A `drifted` run (ADR-0030) is swept a week after the deploy that changed its Machine, not a week after it ended; a
  week is the time a human has to read it.
