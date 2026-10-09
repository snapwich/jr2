# An Effect is an actor slot, and runs at most once

An Effect is work a Machine does outside itself. A Machine already runs Agents and Gates as actors (ADR-0049); work such
as running the tests had no place of its own, so an author either asked an Agent to do it (and trusted its word) or
wrote a raw xstate promise that a restart ran again. jr2 builds two kinds now: `command`, run a program in the
Workspace, and `http`, call a URL from the Instance Effector
([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).

## Decision

- **An Effect is an actor slot beside `agent()`.** `actors: { tests: command(["pnpm", "test"]) }`, invoked as
  `src: "tests"`, with an `onDone` that routes on its output. xstate gives the rest: the Effect stops when its state
  exits, its input persists with the snapshot, a `src` typo is a compile error, and `.provide()` is the unit-test seam.
  The slot carries its parts as plain data — kind, placement, timeout; a `command`'s argv and Repo Slot; an `http`
  Effect's method, fixed host and the names of the secrets it names — which `jr2 up` prints and the Machine doc carries,
  read without running anything.
- **Between a pick and its work: `fromPick`, `paramsOf`, `answer`.** All optional; a plain mapper is legal.
  `fromPick(def, fill)` is the `input` of a state a pick enters: the pick's params flow into the Effect's input by name,
  `fill` returns only what the Machine adds, and the sum is checked against the Effect's input type — the security
  boundary in one expression (what the Agent supplies, what the Machine adds). The type check catches a missing or
  mistyped key; it accepts an extra one, so the load walk refuses a param that is no key of the input (below).
  `paramsOf(event, def)` reads the same params for a plain mapper. `answer(({ context, event, chain }) => …)` is an
  xstate action that sets what the Agent reads when its pick is answered (ADR-0024); `chain` is every reply since the
  pick, oldest first, each a link typed by its slot (`{ kind: "output", src, output }`) or by the Machine's events
  (`{ kind: "event", event }`); its order and length are not typed. A link is a reply from outside the Machine; the
  events it sent itself are skipped. The value is JSON on the wire and in the hold; one with no JSON form sets nothing.
  An `answer` shapes only the pick of the Agent whose state it is written below (on a state's entry or exit, or on a
  transition of a state, at or below that Agent's state); one written below no Agent's state may shape any Agent's. A
  child's error is no link, and by default the Agent is not told (ADR-0024); an author who wants it told writes
  `answer(...)` on the `onError` route. An Effect never takes that route for an outcome: every outcome is output.
- **argv, never shell text.** Each entry is one argument; `arg("x")` is one argument filled from the invoke's input. The
  Harness spawns `argv[0]` with no shell. `sh -c` is the author's explicit choice, in the argv, and its result is not a
  trusted verdict.
- **A `command` runs in the Harness container of its Workspace's Sandbox**, as a child of the Harness process: the
  Agent's user, the Sandbox Image's tools, the same Stand-ins as the Agent's `bash` (ADR-0059), and no credential of its
  own. The Harness serves it on `/exec/:id`, behind the same bearer as every Harness route (ADR-0058); the Instance
  Harness holds no Workspace and refuses it (ADR-0031). Outside a `workspace()` a command is refused at invoke. Its cwd
  is a Repo Slot's Worktree: the one slot, or the slot it names (`slot`); several and none named is refused (ADR-0051).
- **Every outcome is output**: `exited | timeout | killed | unknown` for a `command`;
  `response | unreachable | refused | unknown` for an `http` Effect. A command not found is `exited` 127, and a path
  segment that is `.`, `..` or empty is `refused` with nothing sent — an Agent's param can cause either. `onError` is
  only a jr2 or config defect: no Workspace, an argv slot with no value, an input that misses the definition's schema,
  no Effector to send to.
- **An `http` Effect is a definition plus one function.**
  `http({ method, url, headers?, auth?, input?, request?, timeout?, maxBody?, idempotent? })`. The url's scheme and host
  are literal — a secret, named with `secret("name")`, may sit only in its path, through the `text` template, and one
  after a `?` or a `#` is refused when the Machine loads — so the host is fixed by the definition and never a param.
  `auth` is `bearer(secret(…))`, `basic(user, password)` or a `text`. `request(input)` returns the run's part alone:
  `path` segments and a JSON or text body. So an Agent's param reaches a path segment or a body, never the host, a
  header or a secret. It runs in the Instance Effector, which builds the request and holds the secrets (ADR-0068); the
  Orchestrator signs the call and holds none.
- **The process group ends with the exec.** Each exec leads its own group; its timeout, a kill, and its top process's
  exit each SIGKILL the group, so nothing it started outlives it. A bounded tail (default 4096 characters) is the
  output; the full stream goes to the run's feed (Instance-token band).
- **A write-ahead ledger; no second fire.** One row per Effect in the run's blob (ADR-0007, ADR-0065): an `intent` row
  saved at the write, with the snapshot that holds the Effect, before the request leaves; a `settled` row with the
  output, saved at the write just before the transition it drives and kept by the save that carries that transition, so
  a restart that loses the transition's save still delivers the output and runs nothing. On restore: settled → the
  output is delivered; no row → nothing was sent, so it starts; intent → per kind. A `command` re-attaches to the exec
  by id, or settles `unknown` when the Harness no longer knows it (it restarted); it is never run again by jr2: it runs
  the Agent's code, which may spend a Stand-in. An `http` intent row names its placement and no replica: the Effect asks
  every replica of that Effector for its id and follows the one that holds it; when none does, it is sent again only
  when the author marked it `idempotent`, and any other settles `unknown`. Retry is the author's choice — a route back
  into the state, or `idempotent` for a call that carries its own idempotency key or only reads. No row is dropped: each
  settled or aborted row keeps the Effect's id, kind and outcome for the run's life, the record of what the run's
  Effects did. A settled row's output tail is dropped once the save that carries its transition is on disk; the full
  stream is on the feed. An `http` response's body and headers are its tail: the row keeps the outcome, the status, the
  content type and the size, and the settled line on the feed carries the whole response. So an Effect in a loop grows
  the ledger by one short row per pass, never by its tails. One exception, bounded by one pick: while a pick is
  outstanding, its hold keeps the `chain` whole, tails included, because an `answer` action may read it after a restore;
  a loop below the Agent's state then grows the hold by one tail per pass. The hold drops its chain when the pick is
  answered.
- **A start is sent once where it may have arrived.** A Harness runs one id once only within its own process; a
  restarted Harness knows no id. So the Orchestrator sends a start again only when it certainly never left (the
  connection was refused, the name did not resolve). Any other failure — a reset, a 5xx, no answer — may follow a start
  the Harness ran: the Orchestrator reads the exec by id instead, follows it when the Harness knows it, and settles
  `unknown` when it does not. It then sends a kill for that id, which keeps a start still on the wire from running. An
  `http` start follows the same rule over the Effector's replicas: one that was never reached, or that answered it is
  stopping (it starts nothing then), is sent to another; any other failure asks every replica first, and the restore
  rule above decides when none holds it. A replica that stops answering for an Effect it was followed on — gone, or
  restarted — is the same case.
- **D1: an Effect is stopped when its state exits.** The exec's group is killed. The kill is sent again until the
  Harness keeps it, for at most the command's timeout (past it the Harness's own timer has ended the group); a kill that
  never reaches it is said on the feed. A fast exit can send the kill while the start is still on the wire: the Harness
  keeps a kill of an id it does not know, and the start that arrives after it runs nothing. The abort goes to the ledger
  (`aborted`, saved with the transition that exited the state — a cancel's final save carries it) and the feed, "outcome
  unknown"; the Machine does not get it — the state that asked has left. An `http` Effect has no cancel route: its
  state's exit stops the polling, and the abort goes to the ledger and the feed the same way, "the Effector may still
  send it; outcome unknown". The Effector finishes the call and drops an outcome nobody reads. Two stops are not exits:
  the host parking the run (`hostStopping`, ADR-0024) and an Orchestrator shutdown (it stops no actor). The Effect then
  re-attaches on restore, or settles `unknown`. There is no "finally": cleanup is a state.
- **Must-finish is a pattern.** An Effect that must not be cut goes in its own state, whose only exit is its `onDone`,
  and that state handles the ancestor's events itself.
- **No fire-and-forget form.** Two patterns keep D1: an Effect in its own state; or a second invoke with no `onDone`
  beside the state's work — it fires on state entry, a fast exit can cut it, and below an Agent's state it holds Rest
  until it settles. `spawnChild` is not used for an Effect: it is not stopped on exit, it runs again on restore, and it
  is orphaned after a final state — each breaks D1 or the ledger.
- **Rest counts an Effect like any child.** A running Effect below an Agent's state holds the Agent's pick (ADR-0024); a
  settled Effect with no `onDone` is Rest. An Effect is not a long-lived invoke, and the load walk does not warn on one.
- **The load walk checks what a pick hands an Effect** (ADR-0015): a pick param nothing reads — per state, so any invoke
  of the state may read it, a second invoke beside the Effect included (with `fromPick`, one that is no key of the
  Effect's input and that `fill` does not read; a guard on the entering transition and an `assign` count as reads; a
  pick enters what an eventless `always` moves on to; across an `after`, only a guard or `assign` before the timer reads
  it; a Gate's event is no pick and is not checked) and a `fill` that overwrites a param are refused; code the probe
  cannot or does not run — a mapper that throws in it, an action other than an `assign` — and a pick that targets a
  history state that may enter an Effect's state are a warning; and a state below an Agent's state that invokes
  something and that nothing enters is refused.

## Considered options

- **Run a command in an Effector container.** Rejected: a command runs the Workspace's own code, which the Agent wrote;
  it needs the Sandbox Image's tools and the Agent's user, and it must hold no secret the Agent could not.
- **Take a command as a shell string.** Rejected: an Agent's param in a string is a shell injection.
- **Repeat a command whose outcome is unknown.** Rejected: it may have acted (a push from a script, a spent Stand-in).
  The Machine gets `unknown` and decides.
- **A fire-and-forget Effect (`spawnChild`, or a flag).** Rejected for the reasons above; nothing the Machine starts may
  outlive the state that asked for it.

## Consequences

- A command a Harness restart cut settles `unknown`; the stream before the restart is on the feed.
- An Orchestrator restart mid-command gives one run: the restored Effect reads the exec from its current end and settles
  with its output.
- Not built: an `answer` that may shape two Agents' picks while both are outstanding at once — one written below no
  Agent's state, or one action object written below two Agents' states. Which pick it shapes is not decided; today it
  sets nothing, and each pick keeps its default answer.
- An `http` call an Orchestrator restart caught in flight gives one send: the restored Effect finds it on the replica
  that holds it. One the Effector lost gives `unknown`, or a second send when it is `idempotent`.
- Owed, not built: Effect kinds beyond `command` and `http`, and an Open argv bound by `customize()`.
