# A run starts a run through a `dispatch` Effect

[ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md) made composition `import` plus invoke, one run
and one run id, and rejected a run that starts a run "for no requirement that needs a second run id". The grill of
2026-10-20 brought the requirement: a long-running Machine that watches the outside (a poll of GitHub issues, a webhook
into a Gate) and, when something arrives, runs an existing Workflow on it, where that Workflow needs its own run: its
own row in `jr2 runs`, its own durability and cancel, its own Workspaces, a life that is not the watcher's, and perhaps
an Orchestrator that is not the watcher's. GitHub's `workflow_dispatch` through the API, an Argo Events sensor that
submits a Workflow, and Temporal's own advice for a child in another namespace (an Activity that starts a workflow
through the client) are all the same shape: a separate, independent run, started as an act of the caller. That is not
composition and does not replace it. The two uses stay two mechanisms.

## Decision

- **`dispatch` is a fourth Effect kind**, beside `command`, `http` and `push`
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)): an actor slot,
  `actors: { review: dispatch("review", { input?, wait?, target? }) }`, with a ledger row, at-most-once, stopped when
  its state exits, `fromPick` between a pick and it, and its output the answer to the pick that led to it. An Agent that
  "calls a workflow" is an ordinary pick whose state invokes the slot; nothing a model reads changes, so there is no
  `@model` claim. **The callee is named as `jr2 run` names it**, `review` or `task/review-loop`, a string constant on
  the slot and never an `arg()` a model fills: the name is authority, the input is data. A run needs a Workflow name
  (status, drift, the Console), so a registered Workflow is the only thing a dispatch can start, which is why a name is
  right here where ADR-0049 rejects it for a child: invoke-by-name resolves to a Machine inside the caller's run; a
  dispatch resolves to a run of its own. One slot per callee; a Machine that calls two Workflows declares two slots.
- **The invoke's input is the run's body, whole.** `input: ({ context }) => ({ ticket })` or
  `input: fromPick(review, ({ context }) => ({ repo: context.repo }))` is the JSON that `POST /workflows/<name>/runs`
  validates ([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)), the same body `jr2 run --input` sends. A
  one-shot Chart start is nothing special, `{ chart }` in the body; a named Chart is a name. Every knob is the slot's
  (`wait`, `target`, `input`), so a run-start option that arrives later is a slot option or a door field, never a
  wrapper around the body. Accepted with it: the pick's schema and the callee's door are two schemas the author keeps
  aligned, and the idiom is to derive one from the other (`reviewDoor.pick({ branch: true })`); the handoff is by
  reference, a url, a branch and a commit the callee's own Workspace clones, never a Worktree file, because the Effect
  runs where no Worktree is; no secret rides the body (GitHub's `secrets: inherit` has no counterpart: the callee's
  Assembly bound its own); `wait` is static, so a Machine that needs both forms declares two slots; the body is plain
  JSON; and the callee's host-injected fields (`instanceId`) are the callee's host's, written after the parse. `input`
  on the slot is an optional zod schema: the author's claim about the callee's door, which types the mapper and
  `fromPick` and is what `jr2 up` compares (below). Without it the mapper returns `unknown` and the door alone checks.
- **Two placements, read from the target, and the author writes none.** With no `target` the Effect runs in the
  Orchestrator's own process and starts the run through the run host and the ledger directly, no wire and no token: the
  Orchestrator holds the Instance token already
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)) and is the single writer of runs, so a
  start that went out through an Effector and back in over HTTP would carry a token for nothing. That is a fourth
  Placement, `orchestrator`, and this is the one Effect that has it. With a target,
  `target: { url, token: secret("ops-instance") }`, the Effect runs in the Instance Effector, which gains a `dispatch`
  kind, holds the token as an Effect secret and calls the foreign door; the url is an origin, scheme and host and a
  port, and a path, a query or userinfo in it is refused at build, since the Effector appends the door's path and the
  origin is what its fence (`effector.json`) names. A packaged Machine leaves it `target: open` and the composer binds
  the url and the token together, one Open part, with `customize(m, { effects: { task: { target: { url, token } } } })`
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)); `secret(open)` inside a
  target is refused, since the whole target is the part. Another Instance may run another Kit version, so the HTTP door
  is the only contract there. The token is the Instance token, which unlocks all control
  ([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)); a start-only token is a token kind of its own and
  is deferred.
- **Two settlements, `started` by default, and every outcome is output.** `{ outcome: "started", run }` settles when the
  Orchestrator accepts the run; the watcher goes round again. `wait: true` settles
  `{ outcome: "settled", run, status, output }` when that run ends, `status` in the store's own words (`done`, `failed`,
  `error`, `cancelled`, `lost`, `drifted`, [ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)) and `output` the callee
  Machine's (for `failed`, the Failure's `{ reason, detail }`,
  [ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)), which `GET /runs/<id>`
  serves for a run that is no longer live from this decision on (a live run serves `active` and no output). The slot's
  `timeout` bounds the whole Effect, the start alone or the start and the wait: 30 s by default without `wait`, 10 min
  with it, counted from the intent row's first write, so a restore never starts the bound over, and armed again in
  steps, so a bound past Node's 24.8-day timer holds. A run still live when it runs out settles `status: "live"`, the
  status the run had when the Effect stopped waiting: in-process the run host says it; in the Instance Effector the last
  poll must have read the run live, and a wait whose last poll got no answer is `unknown`. In-process the run host tells
  the wait through a settle hook keyed by the run id, not by its hosting, so a caller restored before its callee hears
  it when the callee settles, and hears `lost` or `drifted` when restore marks it so; foreign, the Instance Effector
  polls `GET /runs/<id>` every 5 s as a long-running Effect, which it keeps across an Orchestrator restart already, and
  a DELETE of the Effect ends that poll and never touches the run. No callback from the callee: a callback needs the
  callee to hold its caller's address and a token for it, which inverts the trust. A door refusal is OUTPUT,
  `{ outcome: "refused", status, report }`, with the door's status — 400 for bad input, 404 for a name the current
  Assembly lacks, 409 for an unrunnable named Chart or a key another Workflow's run holds, 422 for a Chart the door
  refuses, 413 for a start over the bytes an Effector reads, 0 when the Effector refused it before anything was sent —
  as a Chart refusal is ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)): the body may have come from a model,
  and the report must be able to reach it through the Chain. A target no replica could reach is
  `{ outcome: "unreachable" }`, output, as an `http` Effect's is (ADR-0067): nothing was started. The invoke's error is
  kept for defects: no run host or Effector, input that fails the slot's schema, a refused or malformed wire.
- **The two runs are independent.** Cancelling the caller never cancels the callee; the caller's end never ends it;
  leaving the state stops a wait and never the run; the callee's Workspaces are its own. Temporal's parent-close policy
  (`TERMINATE` by default, `REQUEST_CANCEL`, `ABANDON`) exists because a child there is both a run and a child, and its
  default bites on every continue-as-new of a long-lived parent; here the coupled case is `import`, so there is no
  policy. The link is a record. The callee's row carries `dispatchedBy { run, slot, effect, depth, instance? }`: the
  caller's run and slot, the caller's ledger row id (the idempotency key, below), the dispatched run's own depth in the
  chain, one below its caller and stated by the caller, so one meaning on the wire, in the binding and on the row, and
  for a foreign caller its Orchestrator's name as opaque text — its namespace, never an Instance ID, which names an
  Agent's conversation. The open band carries the routing (`run`, `slot`, `depth`, `instance`) and never the key, which
  names the caller's ledger and stays behind the token. The caller's ledger row carries the run it started, written to
  the intent row the moment the start's answer names it and kept past an abort, and the caller's status lists them as
  `dispatched [{ slot, run, at }]`, the chain's other direction. `jr2 runs` carries `dispatchedBy` after the id,
  `jr2 status` prints `dispatched by:` and `dispatched:` lines, and the Console shows both. The word is **dispatched
  by**. The callee reads nothing of its caller from its input: a Machine that wants to tell its callee something passes
  it as input like any caller.
- **A chain of dispatches is unbounded.** A run may dispatch a Workflow that dispatches another, or itself: a run that
  dispatches its own successor and ends is Temporal's continue-as-new, the honest way to keep a watcher's snapshot
  small, and a depth ceiling would refuse it. A runaway chain is a resource problem the cluster owner's quota and
  [ADR-0064](0064-a-workspace-waits-for-capacity.md)'s capacity wait bound; the depth on the row makes it readable. A
  depth ceiling is named and deferred beside ADR-0070's spend ceiling.
- **At-most-once across the wire, by construction.** ADR-0067 sends a start once where it may have arrived, and a
  foreign start whose answer was lost had an unknown outcome. The ledger row's id rides every start as an idempotency
  key, out of band — the `jr2-dispatched-by` header, the `dispatchedBy` record as JSON, never a body field the callee's
  door would have to reserve — and `POST /workflows/<name>/runs` asks the key before anything else, so a re-sent start
  answers its run even when the name would be refused now: 201 with the run for a new one, 200 with
  `{ runId, instanceId, existing: true }` for a repeat, 409 when a run of ANOTHER Workflow holds the key (the caller
  asked for one Workflow and would wait on a run of another), 400 when the header does not parse, and 500, never 404,
  for any other throw, since a foreign caller reads a 404 as "nothing was started" (ADR-0033 as amended). The key lives
  in the callee's blob, and the store copies it into a `dispatch_effect` column of its own at every save and indexes
  that, not an expression index over `json_extract`: SQLite's JSON parser refuses a blob nested about a thousand deep,
  and such an index would fail that row's save and every later open of the volume. A run restore marks `lost` keeps its
  row and its blob, so its key keeps answering; the weekly sweep
  ([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-a-week.md)) removes the key with the row, and a re-send
  after it starts a new run: known, and not guarded. In-process the ledger is consulted directly, through the same start
  under the same key, with the starts in flight held so two arrivals of one key before the first save are one run. So a
  dispatch is idempotent whatever its author writes: its intent row says `idempotent: true`, a restore that cannot tell
  whether its start arrived sends it again under its key with what is left of the bound, the Instance Effector sends a
  start whose answer was lost again under its key with backoff until the bound, and the Effector's rollout grace is
  never stretched by a dispatch's wait. Once the answer names the run, the intent row carries it, the Effector's
  `running` state carries it on the wire, and a restore with it starts nothing: it settles `started` at once, or resumes
  the wait. Without it a watcher double-starts a run after a restart, which a human notices as two pull requests. What
  it does not guard: a door at a Kit version before this decision ignores the header, so a re-send to it starts a second
  run, and neither the Effector nor the preflight can tell. A capability check is named and deferred.
- **`jr2 up` checks what it can see, and the severity follows who owns both sides.** For a same-Instance name the walk
  resolves it in the Assembly and REFUSES a miss, naming the fix: on the host, among the Machines and the Chart files,
  and a slashed name whose wrapper exists but whose Chart the host cannot see is a warning there, since a runtime Chart
  lives on the Orchestrator's volume alone; at the publish door, among all three, and there the miss refuses the
  publish. A dispatch of a runtime Chart under a wrapper the same publish adds takes two publishes, the wrapper first,
  then the Chart's PUT, then the dispatch, and the refusal says so. A Workflow is named by its filename stem, so a stem
  outside `[a-z0-9-]` is refused at load, naming the rename: `jr2 run`, the door's path and a `dispatch` slot name one
  set of Workflows. ADR-0067's "a pick param nothing reads" check runs at `createMachine`, before any callee is known,
  so it reads the slot's `input` schema's keys, and with no schema it reads nothing and skips; the Chart door, for a
  lent dispatch with no schema, takes any object. The walk then compares the slot's `input` schema, if given, with the
  callee's door and REFUSES a mismatch. For a foreign target it does `GET /workflows/<name>` from the host with NO
  token, since the route is open band ([ADR-0014](0014-observation-is-open-run-state-is-not.md)) and the token is the
  Effector's to carry, compares the served JSON Schema with the slot's schema the same way, and WARNS on no reach, a
  miss, a mismatch, an answer that is no Workflow detail or a redirect, never refuses: the other Instance may be down,
  reached only from inside its cluster, or published later, and a refusal would couple two Instances' publish order. The
  token's own refusal is a run's to answer. **A match is compatibility, one direction**: every required field of the
  door is in the slot's schema, required there too, with a compatible type, within the door's `enum`, `const` and
  bounds, and every field of the slot's schema exists in the door, since a plain zod door strips the rest silently; the
  slot's schema is read as what the driver sends (`io: "output"`, its defaults filled), the door as what it takes. It
  compares within the JSON Schema subset ADR-0070 names (`type`, `properties`, `required`, `items`, `enum`, `const`, the
  bounds); a schema that uses something outside it (`oneOf`, `$ref`) is reported "not compared", never guessed at, a
  warning at `jr2 up` which the publish door, with no warnings channel, drops. **A dispatch resolves at run time against
  the current Assembly**, as `jr2 run` does: a dispatched run is a new run and starts under the Assembly current then
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)), which may be newer than
  the caller's. A publish that keeps the caller and drops the callee is refused by the walk, as above; one that drops
  both leaves a live caller to answer `refused` with the 404's report when it dispatches; pinning a dispatch to the
  caller's Assembly would run a Workflow the Instance no longer publishes.
- **Tests.** The mechanics tier (socket-free, the stub Harness; `features/dispatch.feature`) owns the in-process path:
  the ledger row and the listing both ways, `wait` and the served output, restore mid-wait with one run, cancel of the
  caller with the callee live, the 400 and the 404 as output, the publish refusal of a miss, and two HTTP starts under
  one key as one run. One `@kind` scenario has the Instance dispatch to ITSELF by url and token, so the Instance
  Effector's foreign path, the key and the poll run with no second cluster, across an Orchestrator restart. No `@model`
  claim: the four new pick answer texts are rendered by the generic path every Effect's answer takes.

## Considered options

- **Keep ADR-0049 and compose.** `import` plus invoke, a `workspace()` nested where the callee needs its own Sandbox,
  and `pool()` for fan-out. It is still the answer for a coupled child. Rejected for this use because the callee cannot
  have its own row, its own cancel, a life past the caller's, or another Orchestrator.
- **A bare `http` Effect against the door.** Works today for a foreign Instance. Rejected: it puts the Instance token in
  the author's hands for the same-Instance case, gives `jr2 up` nothing to check, and has no idempotency key.
- **A sub-run as a child actor with its own id** (Temporal's child workflow). Rejected as ADR-0049 did: cross-run
  correlation and cancel propagation inside one actor tree, for a run that must be independent anyway.
- **A callback from the callee for `wait`.** Rejected above: it inverts who holds the token.
- **A depth ceiling, or a static refusal of self-dispatch.** Rejected above: both refuse continue-as-new.
- **The body wrapped as `{ input, options }`.** Rejected: it taxes every dispatch now for a run-start option the door
  has never had.
- **One `dispatch()` slot that takes the name as input.** Rejected: the name is authority and stays a constant.

## Consequences

- ADR-0049's "no sub-run" is restated, not reversed: a nested Machine is reached by `import`, never by name; a run that
  starts a run is a `dispatch`, by name, and the two are different uses. ADR-0067 gains the kind and a fourth Placement,
  `orchestrator`. ADR-0068's Instance Effector gains the `dispatch` kind, its stop route stops a dispatch's wait too,
  and its `running` state carries the run. ADR-0033's door gains an idempotency key.
- The GLOSSARY's **Effect** gains "or starts a run", and `_Avoid_: sub-run, child run, nested run, spawned run` for the
  relation, which is **dispatched by**; its **Effector** and **Instance Effector** entries name the in-process exception
  and the new kind.
- `RunStatus` gains `output` for a run that is no longer live, `dispatchedBy` and `dispatched`; `RunObservation` the
  routing of both, without the key.
- An Open body may lend a `dispatch` slot as it lends any Effect (`lends.effects`), so a Chart can start a run of a
  Workflow its wrapper chose; the Chart fills the body only.
- Deferred, named: a start-only token; a depth ceiling; a capability check for a door that ignores the key.
