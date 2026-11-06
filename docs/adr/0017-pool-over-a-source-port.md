# The run loop is a jr2 `pool` over a generalized source port

Third of the workflow-API redesign trio ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md),
[ADR-0016](0016-agent-turn-mechanics-are-internal.md); full record in
[docs/design/workflow-api/](https://github.com/snapwich/jr2/blob/71ebe36/docs/design/workflow-api/proposal.md)). The top
of every jr-shaped workflow — claim ready items, run one child per item under a cap, wake on push or poll, settle when
done — was ~90 lines of hand-rolled bookkeeping in the jr-parity exercise (`active[]`, `spawnChild`/`stopChild`,
`xstate.done.actor.*` casts, the discover/saturated/settling/idle choreography, and a comment-enforced "keep
`spawnChild` top-level or visualize goes blind" footgun). No xstate-ecosystem primitive exists for this (verified: the
canonical v5 pattern _is_ the hand-rolled loop), so jr2 ships one.

The webhook round of 2026-11-03 added the other half: work that starts from the outside. An alert service sends one
alert, and each alert needs one run of a triage Workflow. A forge labels an issue, and each labeled issue needs one run
of a ticket Workflow. A Hook ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md))
never starts a run itself. It reaches two things that exist: a Gate, which answers a run
([ADR-0011](0011-workflow-defined-events.md)), and a Source, which brings items. So this ADR gives the Source a push
half, lets a Pool's worker be a run of another Workflow, and lets such a Pool stand.

## `pool(worker, spec)` — a machine factory, like `workspace()`

`pool(worker, { source, itemId, cap, itemInput, onDrained, failures, standing })` returns a plain machine that owns
spawn-under-cap, stable child identity, typed completion collection (`DoneActorEvent<Output, string>` + the
`xstate.done.actor.*` wildcard — zero casts), `stopChild` bookkeeping, the Source's Gate, and the re-query timer. The
one top-level `spawnChild` lives in jr2's pool code, once — the visualize footgun is dissolved by construction, and
everything durable is a registered string src (xstate cannot persist inline-src children, which independently forces
this shape). The pool composes: it returns a plain machine and can itself be nested as a child. The typed idioms
(wildcard done events, `assertEvent`, outcome-in-context root output) ship as documented patterns regardless, so
outgrowing the pool means hand-rolling without penalty, not fighting a framework.

**The worker is a child Machine or a `dispatch(...)` slot, never a bare Workflow name.** A child Machine runs inside the
Pool's run, as it always did. A `dispatch` slot ([ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)) makes
each item a run of its own: `pool(dispatch("triage", { input: triageDoor, wait: true }), { … })`. The two worker kinds
differ in five places — a worker's defect, a cancel of the Pool, what `customize` reaches, the life of an item's key,
and where the Gates are — and each difference is one that ADR-0071 states between a child and a dispatched run. So they
belong to the worker kind, and the word `dispatch` at the call site shows them. `pool("triage", …)` would hide all five
behind a string, so jr2 does not offer it. Inside, one claim loop serves both kinds with two internal policies.

## The source port is generalized; Work Source is one adapter

The pool draws from a **Source** port in one of three forms:

- **Pull**: `next({ active, settled, input }) → item | null`, plus an optional `wake` event def (for `jr2 send`) and
  `pollEvery` (the set changes under the Pool). `input` is the Pool's input and `settled` holds the ids of the finished
  and failed items, so a Source can fan out over a plan with no state of its own.
- **Read**: `read`, an `http` Effect marked `idempotent: true` or a promise (`pool()` refuses another Effect,
  [ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md), as a Gate's look does),
  and `items`, which turns its answer into the items in order (by default the answer itself, when it is a list). The
  read's input is the Pool's input. It is the re-queried set, read through an Effect, so the read can spend a secret
  that the Instance Effector holds ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)), which
  a `next` in the Orchestrator cannot. A promise read holds no secret, and the default tier reads with one. A failed
  read gives no items.
- **Push**: `item`, a zod schema, and `hooks` whose handlers carry each item. Nothing can be read again: each item comes
  in a delivery, and the Pool holds it (below).

A pull or a read Source can hear a Hook too. Its `hooks` handlers give `reread()`: read the set again now. **When a
Source can read, the read is the truth**: a delivery only says "read again", and an item that lost its label while it
waited is not in the next read. A handler of a Source has the shape of a Gate's (by Hook kind, then event key) and reads
`{ payload, caller, delivery, input }`. It gives `reread()`, `carry(item)` or `skip(reason)`, and never a bare
`undefined`: a delivery that brings nothing has a reason that a person can read in the Hook's answer, the hook log and
`jr2 hooks`. A throw is a skip with the error as its reason. `skip` is for a Source's handlers only; a Gate's handler
gives an event or `undefined`. A verdict that the Source's form cannot take (`carry` from a pull or a read Source,
`reread` from a push Source) and an item that the `item` schema refuses are each a skip, with the reason. **An item
whose `itemId` throws or gives no id gets no worker, in each form of Source.** In a delivery to a push Source, it is a
skip with the reason. In a read, the read skips that item, with a `pool` mark `skipped` on the feed that says which item
and why, and it claims the rest. A read at each `pollEvery` finds the item again, so jr2 marks each such item one time
in a run's life. Else one item with no id would make each read give no items, with no mark, and no item of that Source
would start. A `next` gives one item at a time, so its item with no id ends the run `error`, and the streak below pauses
the Pool when that does not stop. Mechanically the push half is the Pool's `source` Gate, which heard only `wake`
before, so the Hook's fan-in reaches it as it reaches any open Gate (ADR-0011). A Source may also give
`reply(verdict, { caller })`: pure, from its own verdict to plain text or `undefined`, which the person who acted on a
chat service reads, and nobody else; a `skipped` text shows only when no other target gave one (ADR-0011). The verdict
is the line of `sources`, and for `held`, `existing` and `hold-full` also the parsed `item`. A paused Pool has no run,
so no `reply` runs for `paused`. The reply after the work is a plain `http` Effect of the Machine.

The claim loop has three paths: `next`, the read, and the held items. A `reread`, a `wake` or a settled worker that
comes during a read (or during a call of `next`) sets a latch, and the loop reads once more after that read, so no
change is lost. Reads coalesce: one read claims every free slot, and the loop does not read after each claim and each
settled item one by one. The Pool drops a known id before it claims, so a read that finds an active or settled item
starts nothing. For a Pool of runs, an item that started a run has one record of "settled": the store's key check
(below). An item that ended with no run (`start-refused`, `dispatch-error`, `unreachable`) has no row in the store, so
the Pool counts its key as known for the rest of its run's life: else the read that its own settle starts would claim it
again at once, with no pause and no end, and one item that the callee's door refuses would hold the Orchestrator's event
loop. The next run of the Pool (a hand-over or a resume) tries such an item again, so a publish that fixes the door or
the `itemInput` takes it. The Pool keeps no settled keys past its own run's life: it keeps the run and the status of
each item that ended in that life, which the bound of a standing run limits, and which a `next` reads as `settled`. A
`next` that gives an item whose run ended before gets that run (`existing`), whose wait ends at once, so the item
settles and is not asked for again.

tk's claim actor is one adapter; GLOSSARY.md's **Work Source** reframes as _the Source adapter for tickets_, and the
Ready-set doctrine (re-query, never materialize) survives as that adapter's semantics, not the primitive's. A Work
Source — `tk`, GitHub issues, Jira, a task queue — is a behavior port, not a canonical data schema: verbs like
`claimNext`, `updateStatus` and `comment`, each gated by a capability the adapter advertises. It owns the dependency
graph and hands out the Ready-set, the currently-unblocked items in dependency order, so the Machine never encodes a
dependency edge. The Ready-set mutates during execution — items can be reopened or created mid-run — so it is not a
static FIFO queue. An adapter can give both halves of a Source: its read and its Hook's handlers, so the mapping from
the service's data to an item is written once.

## A pushed item is held until the Pool claims it

- **The Pool holds each carried item in its run's blob**, in the order of arrival, until it claims it. An item that
  leaves for a worker is no longer held: the worker, by its key, is the record. The Hook's answer leaves after the save
  that records the item, so a `held` answer is durable.
- **The key check comes before the hold.** An item whose key a held item, an active worker, or a run of the worker's
  Workflow holds is `existing`, and the answer names the run when one holds it.
- **`hold` bounds the held items**, 1000 by default. Above it, the Hook's answer is 429 (for a chat command, 200 with a
  text that says why, ADR-0011) and the hook log keeps the delivery. The 1000 is not measured.
- **What a push loses**: a delivery while the Orchestrator is down, while no Assembly is current (503), while the Pool
  is paused (`paused`), and above `hold`. A read Source loses nothing, because the next read finds the item.
- **A 429 does not claim the delivery's id.** The hook log keeps it as `hold-full`, and a repeat is found only by a
  delivery that the door claimed (ADR-0011), so the service's send again is heard: a Gate that took it passes it over by
  the run's answers, and a Pool that holds its item answers `existing`.
- **A Source's verdict on a delivery** is one of `held`, `existing`, `hold-full`, `reread`, `skipped` and `paused`, and
  it goes in the delivery's outcome as a line of `sources` (ADR-0011).

## A Pool of runs, and a Pool that stands

A Pool whose worker is a `dispatch` slot keys each item's run by `itemId`, scoped to the callee Workflow
([ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)): every Pool, every hand-over and every `jr2 run` that
gives the same key for that Workflow gets the same run while its row lives, live and for `runs.retain` after it ends
([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md)). `cap` counts the live runs that
this Pool dispatched, so its slot must say `wait: true`: with `started` alone, the Pool cannot know when a run ends. A
run that ends in any way frees its slot. A run that ends `failed`, `error`, `cancelled`, `lost` or `drifted`, or a start
that the door refuses, is a failure of its item, and never the Pool's `error`: the run is not the Pool's child. A cancel
of the Pool never cancels its runs (ADR-0071), and `customize(pool, { agents })` reaches nothing in them
([ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)). The Pool spawns its slot with the item's id as
the spawn id, and the Effect sends that id as the key, not its ledger row id. The run's `dispatchedBy` gains `key`, and,
for a carried item, `hook: { name, delivery, onBehalfOf? }`, so `jr2 status` prints which Pool, key and delivery started
it. Neither is on the open band (ADR-0014): a key is the workflow's data. A run that a read claimed names no delivery:
the Pool's feed says why an item did or did not start, with a `pool` mark for each start (`started`), each end
(`settled`, with the run's status, `start-refused` or `dispatch-error`), each held item that a hand-over drops
(`carry-refused`) and each item of a read that has no id (`skipped`). A `wait` that the slot's timeout ends while the
run is still live (`status: "live"`) is sent again under its key, so the wait follows the run and `cap` still counts it.

**`standing: true` makes a Pool of runs stand.** It is two things:

- **Parking.** A standing Pool never ends by itself. It has no `drained` and no `deadlocked` end, no output and no
  `failures` mode. When it has no work it waits for a delivery, a `reread` or its `pollEvery`. An item that ends is a
  `settled` mark on the feed, with the run's status.
- **The standing run.** jr2 keeps one live run of the Workflow under the current Assembly
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)). Nobody starts it: jr2
  starts it at boot and at the publish that adds it, and `jr2 run` of it is refused, except to resume it (below). A
  dispatch to a standing Workflow is refused 409. jr2 **hands it over** to a new run at every publish, at drift, after
  `error` (with back-off), and when its blob passes its bound. At every publish, because the Assembly is one hash and a
  handler has no stamp of its own. The bound is 500 items taken or one day: each item taken is a dispatch, which keeps a
  row in the Effect ledger for the run's life (ADR-0067), about 217 bytes, so 500 is about 110 KB a save. The bound
  counts the items that the run took, not the keys that a hand-over carried to it: each carried key is sent again, so a
  count of the ledger's rows would hand a run with a `cap` at the bound over again at once. **A run at the bound in
  which no item that it took itself started a run is handed over as a run that ended `error` is**: after the back-off,
  and it counts in the streak below. An item that ends with no run (`start-refused`, `dispatch-error`, `unreachable`,
  `unknown`) is known only for its run's life (above), so a backlog of as many such items as the bound fills the bound
  again in each new run. A hand-over at once would then loop with no pause and no end, and would hold the event loop.
  jr2 ends that run `done`, with no `handedOverTo`, and starts the next run after the back-off. A run in which one item
  that it took started a run (or found its run under its key) is handed over at once, and the count starts again. A
  carried key does not count: the hand-over sends it again and it finds a run that an earlier run started, so a callee
  run that lives for hours would hide the loop for as long as it lives. While each item that the run took is still in
  flight, jr2 does not yet know, so it waits for the save of the first answer. The back-off before the hand-over after
  the `n`-th counted run in a row is 1 s, 4 s, then 16 s. The numbers are not measured. The hand-over carries the held
  items, parsed by the new Assembly's `item` schema (an item that does not parse is dropped, with a `carry-refused`
  mark), and the active keys: the new run sends each one again with `wait: true`, the door answers `existing`, and the
  wait follows that run, so `cap` still counts it. A held item is mapped by the new `itemInput`. A hand-over ends the
  old run `done`, and its record carries `handedOverTo: <new run id>`: a standing Pool has no output, so its stint is
  done. The start of the new run and the end of the old one are one synchronous step. A delivery that a Source hears
  across that step (its key lookup awaits the store) goes on to the new run's Source, so the door never claims a
  delivery that no run holds. jr2 keeps the **head** of each standing Workflow in a table of the store: its newest run,
  when that run started, how many counted runs in a row ended, and why it is paused. jr2 writes the head in the same
  step as the start. The sweep of rows older than `runs.retain`
  ([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md)) never deletes the run that a head
  names, so a paused Pool keeps its held items for as long as it is paused. A Workflow that a publish removes, or that
  no longer stands, gets no hand-over: its live run holds its Assembly and runs on, as any run does (ADR-0069), until a
  person cancels it. A standing run has no Caller: its record's `startedBy` is `{ kind: "jr2", why }`, with `why` one of
  `boot`, `publish`, `hand-over` and `resume`
  ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)).
- **A cancel is a pause.** `jr2 send <run> --event CANCEL` of a standing run ends that run `cancelled`
  ([ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)) and pauses its Workflow: jr2 starts it again at no boot and no
  publish until `jr2 run <workflow>` resumes it. `jr2 up` and `jr2 status` print the Pool as paused, with the number of
  items it holds. They read it from `GET /assembly` and from the answer of the publish, whose `standing` list gives each
  standing Workflow's state (`live`, `paused` or `waiting`), its run and its count of held items. It holds no key and no
  item, so it is on the open band with the held Assemblies ([ADR-0014](0014-observation-is-open-run-state-is-not.md)). A
  paused Pool has no live run: its held items and active keys stay in the blob of the cancelled run. A resume is a
  hand-over from that run, so the new run takes them and claims under `cap`, and a read Source reads again. The new run
  records the Caller of the `jr2 run` that resumed it as `resumedBy`. On the wire the resume is
  `POST /workflows/<workflow>/runs`, which answers `201 { runId, instanceId, resumed: true }`, and 409 while the
  Workflow is live or waits out a back-off. `jr2 run <workflow> --drop-held` (`?drop-held=true`) resumes with no held
  item, so a person can remove a poison item or a queue that they paused on purpose; a read Source then finds again what
  is still true. A delivery to a paused Pool gets `paused`, and nothing is held, so a push Source loses it and a read
  Source finds it at the resume. A delivery to a standing Pool in its back-off (no live run, and not paused) makes the
  door answer 503 (ADR-0011), so the service sends it again. **One rule counts a run in the streak**, for each end that
  hands over after the back-off: `error`, `failed` (a `fail()` of the Machine,
  [ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md), which jr2 treats as
  `error`) and the bound with no run started. A run in which an item that it took itself, not a carried key, started a
  run starts the count again, and is handed over after 1 s. Any other run counts. So a run that took only items that the
  callee's door refused, and then ended `error`, counts. After 3 hand-overs from counted runs in a row, jr2 pauses the
  Pool when the next counted run ends, so a poison item, or a backlog that the callee's door refuses, cannot loop
  without end. The pause says why: `errors` when the last run ended `error` or `failed`, and `bound` when it took its
  bound; `jr2 status` and the Orchestrator's log line name that end. The 3 is not measured. The Pool's context keeps the
  keys that the hand-over carried, so jr2 tells them from the items that the run took.

**What the load walk refuses**, with its fix in the message:

- `standing: true` on a Pool of child Machines: a child cannot be handed over.
- `standing: true` on a Pool that is not the top Machine of its Workflow: jr2 keeps one run for each standing Workflow,
  so the Workflow is the Pool. The fix is to move the Pool to its own file in `workflows/`.
- A Pool of runs that does not stand. A batch of runs (a Pool of runs that a Caller starts and that ends) is not offered
  now: its `itemId` is a key that lives for `runs.retain` past the run, so a second batch in that time does no work. To
  add it later does not break anything.
- A Pool of runs whose `dispatch` slot has no `wait: true`, or has a `target`: a foreign worker is not designed.
- A Pool of runs with no `cap`. The author must choose it; a Pool of child Machines keeps its default of 1.
- A push Source on a Pool that ends when it drains, which would end `drained` at once. The types refuse it too.
- A worker that is a bare Workflow name.

**What `jr2 up` prints and warns.** For each standing Pool, it prints the chain from each Hook that reaches it to the
callee: `sentry → alerts → triage`. It warns when two standing Pools dispatch to one Workflow: `cap` is per Pool, so one
issue with two labels can take a slot in each, and the caps add.

**The callee must end the level.** A read Source re-reads a level, such as "the open issues with the label `jr2`". When
the callee's run ends and the label stays, the key keeps the item from a second run while the run's row lives.
`runs.retain` after the run ended (30 days by default), the row is swept, and the next read starts the item again. So
the callee (or the person) removes the label. A drifted callee holds its key for `runs.retain`, and nothing starts that
item again without a person.

## Terminal triage is three-valued, surfaced as status

Forced by parking-is-retention (ADR-0012) plus workflows whose children park on gates (escalation, human review). It
holds for a Pool that does not stand:

- **drained** — source empty and all children settled → final, or the run ends `failed` when items failed (below);
- **deadlocked** — open-but-never-ready items with nothing progressing → surfaced distinctly (jr exit 2), not an
  indistinguishable idle poll, or the run ends `failed` when items failed (below);
- **waiting** — children parked in gates → the run stays open and the gates list is the "what needs me" surface (jr exit
  3).

The pool can make this call because it owns both the source and the children — the strongest single argument for the
primitive over an authored loop. Triage surfaces as run _status_ (feed, `jr2 runs`), not machine events; a
`pool.deadlock` event can be added if a workflow ever needs to react rather than a human.

## The pool catches a worker's Failure

A worker that fails ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)) ends
only its own item. The pool catches the Failure on `xstate.error.actor.*`, keeps its payload in `failures` by item id,
stops that worker, and claims again: the output is `{ status, items, failures }`. The pool is a kit-owned parent, so an
author cannot give it an `onError`; if it let the Failure go up, one lost `task` would end the whole run `failed`, and
the host would delete the Sandbox of each sibling, also one that waits at its `review` Gate with commits that it did not
push. That breaks parking-is-retention for work that did not fail. A defect in a worker still goes up and ends the run
`error`.

The option `failures: "fail" | "report"` says how a pool ends when one or more items failed. It catches each worker's
Failure in both modes, so one failed item never stops its siblings. With `"fail"`, the default, a pool that ends
`drained` or `deadlocked` with failures invokes `fail` with the reason `"<n> of <m> items failed"` and the detail
`{ status, items, failures }`, so the run ends `failed` and `jr2 run` exits 1. At either end no worker is live, because
a pool with a live worker parks, so the Failure deletes no sibling's Sandbox. With `"report"`, the pool ends `done` and
`failures` in its output says which items did not succeed: for a pool whose job is to try each item, where a failed item
is a correct answer. The default is `"fail"` because `done` means that the work succeeded (ADR-0073), and a CI loop must
not exit 0 while every item failed. The deadlock is the usual end of a dependency backlog with a failure: a Source over
a tracker keeps the failed item open, so its dependents never become ready. The `status` in the detail tells the two
ends apart, and the two details have one shape.

## Tests

The default e2e tier (`features/standing-pool.feature`) and `pool-sources.test.ts` prove the standing Pool of runs: a
push Source, the held items and `hold`, `cap`, `reread`, the latch and merged reads, a restart and a hand-over with no
item lost or started twice, a hand-over across a changed callee door, and the key per Workflow. They read with a
promise, because the default tier has no Instance Effector. The `@kind` tier proves a read through an `http` Effect.

## Considered options

- **An Intake**: a kit-shipped `intake({ routes })`, each `route({ start, input, hooks, look, cap })`, that jr2 keeps as
  a **Standing Workflow**. Rejected: it needs three concepts (Intake, route, Start) and two GLOSSARY terms, and reuses
  nothing that an author knows about a Pool, though it is a Pool inside. It writes the mapping from a delivery to a
  start twice, once in the handler and once in the look, and its look starts an issue that lost its label while it
  waited. One intake run serves every route, so its fault stops every route; a standing Pool for each Source keeps a
  fault in one Source.
- **A direct door**: a Hook that starts a run itself (`door()`, or a Listener's `startOn(machine, kind, …)`). Rejected:
  it is the smallest form for one alert, but it cannot grow. A cap, a read of a level, a queue and an answer after a
  start are each state over time, which a door does not have, and each needs a standing Machine. So an Instance gets two
  ways to start a run. It also makes a Hook more than a door that checks and decides nothing (ADR-0078).
- **A router that the author writes**: a hand-written standing Machine with `dispatch({ key })`, regions and a table of
  runs in flight. Rejected: about 90 lines of mechanism for 25 lines of intent. When a judge wrote one alert's router
  from it, the result had no hand-over and no routes for a child: its table went stale at each publish, and the first
  refused start faulted it. A run holds its Assembly, so a router keeps its old handlers after a publish; a router that
  ends `error` has no open Gate, so each later delivery reaches nothing; and a Kit bump drifts it and loses its backlog.
- **Two factories over one Source port**: `pool()` for children and batches, and a second factory for standing Pools of
  runs. Rejected: the split removes three rows from the table of differences, and costs a GLOSSARY term for the second
  factory, which is the Intake again.
- **A batch Pool of runs now.** Rejected for now, as above: no scenario needs it, and its key makes a second batch
  within `runs.retain` do nothing. It adds later without a break.
