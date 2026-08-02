# A snapshot names the Machine it was written under

[ADR-0007](0007-durable-machine-state.md) persists a run's snapshot so a restarted Orchestrator resumes it.
[ADR-0008](0008-orchestrator-as-deployed-app.md)/[ADR-0019](0019-one-converging-command-against-the-current-context.md)
bake workflows into the instance image, while the state PVC outlives every rollout. And a persisted run is matched to
its workflow by **filename stem** — `this.workflowDefs.get(blob.workflow)`.

Those three facts compose into a hole. Park a run at a Gate, edit `workflows/task.ts`, `j2 up`. The name still resolves.
The def found under it is a different Machine. Nothing checks, and — this is the part that decides the shape of the fix
— **xstate does not validate a restored state value.** A snapshot whose `value` names a state the new chart does not
have does not throw: `createActor` accepts it and the run starts with `value: undefined`, carrying on from nowhere.
There is no downstream check to fall back on. Either restore refuses, or nothing does.

## Decision

**Every save stamps the shape of the Machine that wrote it; every restore compares before interpreting.** `RunBlob`
gains `machine`, a 12-hex digest — the same width `j2 up`'s content hash uses, and for the same reason: it is read by
people in error messages more often than by code. A mismatch is refused before `reconcile`, because proving a Sandbox is
alive for a run that cannot be read is wasted work.

**The digest covers restorability, not behavior.** It is built from `machine-doc.ts`'s traversal — already deterministic
(states sorted by `order`), JSON-pure, provider-independent, and descending into invoked and spawned child machines —
projected down to the facts a snapshot has to agree with:

- state ids, keys, types, nesting, and which child is `initial`;
- each state's invokes by `id` **and** `src` (the id is the key in the persisted `children` map, so re-attach depends on
  it — the most easily missed of the three, and a reason a `src`-only hash would not do);
- every transition as `source|event|targets`, **sorted**, so reordering `on:` keys is not drift.

Deliberately excluded: guard bodies, actions and assigns, prompts, descriptions. Editing a guard changes what a run does
_next_; it does not make the snapshot unreadable. The alternative — any edit to a workflow strands its parked runs — is
defensible in the abstract and unusable in practice: it makes `j2 dev`'s reload a migration event and prompt-tuning a
stop-the-world operation. **Drift means "I can no longer read what I saved," not "something changed."**

**Absent means drift.** A blob written before the stamp existed cannot be vouched for, and the point is to never
interpret one that cannot be. Greenfield, so a stale local `.j2/state.db` is deleted, not migrated.

**A drifted run is refused, kept, and readable.** Not `markLost`: that nulls the snapshot, and `read()` returns
undefined for a null blob, so `j2 status <id>` would answer `no run "<id>"` — a refusal indistinguishable from a run
that never existed, on precisely the run a human most needs to look at. `drifted` is its own status, the snapshot is
untouched, and `RunStatus` gains `reason`, which nothing on any HTTP route surfaced before. The refusal names the
workflow and both digests.

**A throw during restore is a different claim from drift, and is not recorded as one.** Drift is durable — the Machine
will still have changed on the next boot. A `reconcile` failure is a kubectl blip, and condemning a run for it would
make a transient fault permanent (or, via `markLost`, throw the snapshot away). Those rows are left `live` for the next
boot to retry, reported through `onRestoreError`, and counted separately as `failed`.

**One unresumable run is one run.** The restore loop is sequential, and a throw used to reject `restore()`, which
rejects `startInstance`, which crash-loops the pod — taking every _later_ run in the store down with it, unrestored.
Each run is now handled independently.

**The boot announces what it did not resume.** `restore()` returns `{ reattached, lost, drifted, failed }`, and the
entrypoint puts the last three on its announce line. Resumed runs are routine and stay quiet. Without this, `drifted` is
reachable only by asking after a run id nobody knows to ask about.

## Considered options

- **Hash the workflow module source, or the whole config including guards and actions.** Rejected — see above. Maximal
  safety at the cost of making every workflow edit a migration.
- **Reuse `J2_CONTENT_HASH`**, which `j2 up` already computes and injects. Rejected: it is a digest of the whole staged
  bundle, so it moves on a lockfile bump, a README edit, or a kit upgrade — constant false drift — and it is absent
  under `j2 dev` entirely.
- **Topology plus named guards** (`setup()` keys and named functions). Rejected: inline arrows collapse to `"inline"` in
  the doc and would stay invisible, so the coverage is uneven in a way no one could predict from reading a workflow.
- **A `machine_snapshots` schema column.** Rejected: `init()` is a single `CREATE TABLE IF NOT EXISTS` with no migration
  mechanism, so a new column would silently not appear on an existing PVC. The blob is versioned by being JSON.
- **Warn and resume anyway.** Rejected: there is no safe interpretation to fall back on. xstate resumes a missing state
  as `undefined` rather than failing, so a warning would be the only signal, on a run already running wrong.
- **Fold the workflow name into the digest.** Rejected: restore resolves the def by name first, so a rename never
  reaches the comparison — it would only make a rename look like a shape change on a run that no longer resolves at all.

## Consequences

- **Editing a workflow strands its parked runs, by design.** Draining before a shape-changing deploy is now a real
  operational step. `j2 dev`'s reload is unaffected for logic edits, which is the common case, and in-flight runs
  already keep the definition they started on.
- **There is no migration path.** A drifted run can be read and cancelled; it cannot be adapted onto the new Machine.
  That is deliberate for now — a migration story needs a way to express what a state maps to, which nothing here does.
- **A drifted run is not in `j2 runs`**, which lists only the live registry. It is reachable through the announce line
  and `j2 status <id>`. If stranded runs become common enough to browse, the listing is where that belongs.
- **The digest is only as complete as the walk.** A state running `enqueueActions` can spawn children no static analysis
  recovers (`machine-doc.ts`'s `opaqueStates`); the opacity is folded into the hash, but what it hides is not. Drift
  inside such a subtree can go unnoticed.
- **`fingerprintOf` is memoized per machine object**, as `vocabularyOf` is — `persist` runs on every snapshot microtask,
  and a dev reload's fresh machine object correctly gets a fresh entry.
