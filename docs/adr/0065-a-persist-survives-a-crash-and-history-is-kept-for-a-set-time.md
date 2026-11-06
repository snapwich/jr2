# A persist survives a crash, and history is kept for a set time

Every transition of a run persists its whole snapshot (ADR-0007). The scaling review (R6) read the store and listed its
costs: `JSON.stringify` of the whole run, a synchronous upsert with an fsync on the event loop, a Pool's run as one blob
holding every worker, terminal rows never deleted, and `restore()` parsing every row before the server listens. It also
found the words "Postgres opt-in" in GLOSSARY.md, ADR-0008 and ADR-0009, with no such store in the code. Measured on the
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
  epoch bump (ADR-0057), an admission (ADR-0016) or an Effect's intent row (ADR-0067) be saved "at the write" — the
  intent row before its call leaves. A worker thread, an asynchronous driver or a network store would land the row after
  the next `invoke` fires, on every persist.
- **One blob per run stays.** The snapshot is a tree that xstate restores from its root, and one row keeps it atomic —
  with the ledgers beside it (admissions, epochs, notices, timers, outstanding picks, Effects); a Pool's cost at 40
  workers is 0.2 ms, so its workers do not become rows of their own. The Effect ledger keeps a row for every Effect the
  run started (ADR-0067), so a Machine that loops through an Effect grows its blob by one row per pass: id, kind and
  outcome. The output's tail is dropped once the save that carries the Effect's transition is on disk; a push row keeps
  its published commit, its source, its `squashed` and its sync's answer whole — every later push of its Repo Slot sends
  them as one of its pairs — and its bundle only while it is its Repo Slot's newest push and its sync did not finish —
  one bundle per Repo Slot at most. An outstanding pick's hold is the one place tails accumulate: its `chain` keeps
  every reply since the pick whole until the pick is answered, then it is dropped (ADR-0067).
- **`restore()` reads live rows only.** The store answers `WHERE status = 'live'`; terminal rows are not parsed at boot.
- **A finished run's row lives for `runs.retain`, 30 days by default.** `runs: { retain: "30d", volume: "5Gi" }` in
  `jr2.config.ts` sets it. `retain` is a duration of at least `1h`, with no upper limit, and the config load refuses a
  shorter one. It covers what jr2 keeps of an ended run: its row, its kept conversations
  ([ADR-0023](0023-the-harness-prints-the-conversation.md)) and the hook log (below). Every non-live status — `done`,
  `failed`, `error`, `cancelled`, `lost`, `drifted` — ages from its terminal write, and a sweep at boot and every hour
  deletes what is older, with the run's conversations. With no current Assembly (the Kit bump window,
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)), no `runs.retain` is
  bound, so this sweep waits for the first publish; the collection of Assemblies still runs. A `live` row is never
  swept: a run parked on a Gate for a month stays and is restored. Nor is the run that the head of a standing Workflow
  names ([ADR-0017](0017-pool-over-a-source-port.md)): a paused Pool keeps its held items in that run's blob for as long
  as it is paused. The setting exists because a history surface uses it: `GET /runs` lists ended runs,
  `jr2 runs --status` and the Console show them ([ADR-0009](0009-cli-and-instance-interface.md)), and `jr2 logs` reads
  an ended run's conversations. jr2 is still not the record of a run's results (a Machine sends its output where it
  belongs — a PR, a Source); the history is for a person who reads what a run did and why. A swept id frees its
  abbreviations (ADR-0009).
- **The state volume has a size, and a guard keeps it from filling.** `runs.volume` is the size of the Orchestrator's
  state volume claim, `5Gi` by default. It holds `state.db`, `conversations.db`, the Assemblies and the Charts. A claim
  grows only where its StorageClass allows expansion, and Kubernetes never makes one smaller. So `jr2 up` refuses a
  `runs.volume` that the config sets and that is smaller than the claim, or larger on a StorageClass that does not allow
  expansion (kind's local-path class does not), and names the class; the claim keeps its size. When the config does not
  set `runs.volume` and a claim exists, `jr2 up` keeps the claim's size, and prints one line that says so when that size
  is not the default, so an Instance whose claim is older than the default is not refused for a value that no one wrote.
  The guard measures the bytes of the files on the volume (both databases with their `-wal` files, the Assemblies and
  the Charts) against the smaller of the claim's size and the size that `statfs` gives, because a hostPath class such as
  kind's reports the node's disk and not the claim. The Orchestrator does not read the claim: `jr2 up` gives it the size
  that it applied, the kept size of a claim that no config names too, in the Deployment's env. It looks at each sweep
  and every minute. When the volume is more than 80% full by that measure, the sweep deletes the kept conversations of
  ended runs, the oldest run first, until the volume is below 80% again. The run rows stay, and each run whose
  conversations went is marked `conversation swept: no space`, which `jr2 logs` and the Console show in place of the
  conversation. A conversation of a live run is never swept for space. If the volume is still more than 95% full when no
  conversation of an ended run is left, the Orchestrator keeps no more entries and marks each open conversation cut, as
  at its cap ([ADR-0023](0023-the-harness-prints-the-conversation.md)), so the conversations never fill the volume.
- **The hook log keeps each Hook's delivery for `runs.retain`**, as a row of its own: the Hook, the delivery id, the
  body's digest and the outcome ([ADR-0011](0011-workflow-defined-events.md)). The repeat check reads it, so a repeat is
  found while the row is kept; a body caught and sent again with a new id after that passes the check, and a handler
  that compares the commit limits what it can do. A `slack` or `discord` delivery carries a signed timestamp, and jr2
  refuses one more than 300 seconds from its clock, so that replay fails for them
  ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)). A run's blob keeps its
  own `(delivery, gate)` pairs. A standing Pool's run is handed over before its Effect ledger makes its blob large:
  after 500 dispatches or one day ([ADR-0017](0017-pool-over-a-source-port.md)).
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
- **A fixed retention, like the Sandbox idle timeout.** Rejected: a list of ended runs and their kept conversations are
  a history surface, and how long a team reads its history is the team's decision, not jr2's.
- **A count cap per workflow.** Rejected: a count cap does not bound a busy workflow's disk and punishes a quiet one.
  The space guard bounds the disk, and it deletes only the conversations, which are the largest part; run rows stay.
- **An upper limit on `retain`.** Rejected: how long a team reads its history is the team's decision, and the space
  guard bounds the largest part, the conversations. What `retain` leaves to grow is the run rows and the hook log, which
  grow with the count of runs and deliveries; a team that keeps a long history of a busy Instance sets a larger
  `runs.volume`. A limit would refuse that team and bound nothing that the volume's size does not.
- **Build the Postgres store.** Rejected: the only thing it buys is an Orchestrator pod that reschedules without its
  volume, which is a storage-class question (a network RWO volume follows the pod) and belongs to the Orchestrator pod's
  own decision (R10), not to the store. Its cost is a dependency the owner operates, a second store in every test tier,
  and the asynchronous write above.

## Consequences

- ADR-0008 and ADR-0009 lose "Postgres opt-in" and `DATABASE_URL`; ADR-0008's Orchestrator persists its snapshots "to
  sqlite on its volume". ADR-0007 points here for the store's durability.
- The Instance's volume gains `state.db-wal` and `state.db-shm` beside `state.db`, and `conversations.db` with its own
  `-wal` and `-shm` (ADR-0023).
- A `drifted` run (ADR-0030) is swept `runs.retain` after the deploy that changed its Machine, not after it ended; that
  is the time a human has to read it.
- An idempotency key of a Pool item or a `dispatch` lives as long as its run's row
  ([ADR-0017](0017-pool-over-a-source-port.md), [ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)), so
  `runs.retain` is also how long a repeated key finds its run.
