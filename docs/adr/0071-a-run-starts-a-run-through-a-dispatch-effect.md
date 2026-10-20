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
  start that went out through an Effector and back in over HTTP would carry a token for nothing. With a target,
  `target: { url, token: secret("ops-instance") }`, the Effect runs in the Instance Effector, which holds the token as
  an Effect secret and calls the foreign door; a packaged Machine leaves it `target: open` and the composer binds it
  with `customize(m, { effects: { task: { target } } })`
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)). Another Instance may run
  another Kit version, so the HTTP door is the only contract there. The token is the Instance token, which unlocks all
  control ([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)); a start-only token is a token kind of its
  own and is deferred.
- **Two settlements, `started` by default.** `{ outcome: "started", run }` settles when the Orchestrator accepts the
  run; the watcher goes round again. `wait: true` settles `{ outcome: "settled", run, status, output }` when that run
  ends, `status` in the store's own words (`done`, `cancelled`, `faulted`, `lost`,
  [ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)) and `output` the callee Machine's. In-process the run host tells
  it; foreign, the Instance Effector polls `GET /runs/<id>` as a long-running Effect, which it keeps across an
  Orchestrator restart already. No callback from the callee: a callback needs the callee to hold its caller's address
  and a token for it, which inverts the trust. A door refusal, 400 for bad input, 404 for a name the current Assembly
  lacks, 409 for an unrunnable Chart, is OUTPUT, `{ outcome: "refused", report }`, as a Chart refusal is
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)): the body may have come from a model, and the report must
  be able to reach it through the Chain. A dead target is the invoke's error, as an `http` Effect's is.
- **The two runs are independent.** Cancelling the caller never cancels the callee; the caller's end never ends it;
  leaving the state stops a wait and never the run; the callee's Workspaces are its own. Temporal's parent-close policy
  (`TERMINATE` by default, `REQUEST_CANCEL`, `ABANDON`) exists because a child there is both a run and a child, and its
  default bites on every continue-as-new of a long-lived parent; here the coupled case is `import`, so there is no
  policy. The link is a record: the callee's row carries `dispatchedBy { run, slot }` (an opaque id for a foreign
  caller) and the chain's depth, the caller's ledger row carries the run it started, and `jr2 runs`, `jr2 status` and
  the Console show the chain both ways. The word is **dispatched by**. The callee reads nothing of its caller from its
  input: a Machine that wants to tell its callee something passes it as input like any caller.
- **A chain of dispatches is unbounded.** A run may dispatch a Workflow that dispatches another, or itself: a run that
  dispatches its own successor and ends is Temporal's continue-as-new, the honest way to keep a watcher's snapshot
  small, and a depth ceiling would refuse it. A runaway chain is a resource problem the cluster owner's quota and
  [ADR-0064](0064-a-workspace-waits-for-capacity.md)'s capacity wait bound; the depth on the row makes it readable. A
  depth ceiling is named and deferred beside ADR-0070's spend ceiling.
- **At-most-once across the wire.** ADR-0067 sends a start once where it may have arrived, and a foreign start whose
  answer was lost had an unknown outcome. The ledger row's id rides every start as an idempotency key, out of band (a
  header, never a body field the callee's door would have to reserve), and `POST /workflows/<name>/runs` accepts it and
  answers with the existing run on a repeat (ADR-0033 as amended). In-process the ledger is consulted directly. Without
  it a watcher double-starts a run after a restart, which a human notices as two pull requests.
- **`jr2 up` checks what it can see, and the severity follows who owns both sides.** For a same-Instance name the walk
  resolves it in the Assembly (a Machine, a Chart file or a runtime Chart) and REFUSES a miss, naming the fix; reads the
  callee's door's keys as what the Effect reads, for ADR-0067's "a pick param nothing reads" check; and compares the
  slot's `input` schema, if given, with the callee's door and REFUSES a mismatch. For a foreign target it does
  `GET /workflows/<name>` with the token, as the model-provider preflight does, compares the served JSON Schema with the
  slot's schema the same way, and WARNS on no reach, a miss or a mismatch, never refuses: the other Instance may be down
  or published later, and a refusal would couple two Instances' publish order. **A match is compatibility, one
  direction**: every required field of the door is in the slot's schema with a compatible type, and every field of the
  slot's schema exists in the door, since a plain zod door strips the rest silently. It compares within the JSON Schema
  subset ADR-0070 names (`type`, `properties`, `required`, `items`, `enum`, `const`, the bounds); a schema that uses
  something outside it (`oneOf`, `$ref`) is reported "not compared", never guessed at. **A dispatch resolves at run time
  against the current Assembly**, as `jr2 run` does: a dispatched run is a new run and starts under the Assembly current
  then ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)), which may be newer
  than the caller's. A publish that drops the callee does not refuse for a live caller, and the dispatch then answers
  `refused` with the 404's report; pinning a dispatch to the caller's Assembly would run a Workflow the Instance no
  longer publishes.
- **Tests.** The mechanics tier (socket-free, the stub Harness) owns the in-process path: the ledger row, `wait`, the
  refused output, the idempotency key at the door, restore mid-wait. One `@kind` scenario has the Instance dispatch to
  ITSELF by url and token, so the Instance Effector's foreign path, the poll and the key run with no second cluster.

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
  starts a run is a `dispatch`, by name, and the two are different uses. ADR-0067 gains the kind and a placement that is
  in-process. ADR-0033's door gains an idempotency key.
- The GLOSSARY's **Effect** gains "or starts a run", and `_Avoid_: sub-run, child run, nested run, spawned run` for the
  relation, which is **dispatched by**.
- An Open body may lend a `dispatch` slot as it lends any Effect (`lends.effects`), so a Chart can start a run of a
  Workflow its wrapper chose; the Chart fills the body only.
- Deferred, named: a start-only token; a depth ceiling.
