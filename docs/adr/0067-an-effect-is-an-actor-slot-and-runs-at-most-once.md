# An Effect is an actor slot, and runs at most once

An Effect is work a Machine does outside itself. A Machine already runs Agents and Gates as actors (ADR-0049); work such
as running the tests had no place of its own, so an author either asked an Agent to do it (and trusted its word) or
wrote a raw xstate promise that a restart ran again. jr2 builds one kind now: `command`, run a program in the Workspace.

## Decision

- **An Effect is an actor slot beside `agent()`.** `actors: { tests: command(["pnpm", "test"]) }`, invoked as
  `src: "tests"`, with an `onDone` that routes on its output. xstate gives the rest: the Effect stops when its state
  exits, its input persists with the snapshot, a `src` typo is a compile error, and `.provide()` is the unit-test seam.
  The slot carries its parts as plain data — kind, argv, timeout, Repo Slot — which `jr2 up` prints and the Machine doc
  carries, read without running anything.
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
- **argv, never shell text.** Each entry is one argument; `arg("x")` is one argument filled from the invoke's input. The
  Harness spawns `argv[0]` with no shell. `sh -c` is the author's explicit choice, in the argv, and its result is not a
  trusted verdict.
- **A `command` runs in the Harness container of its Workspace's Sandbox**, as a child of the Harness process: the
  Agent's user, the Sandbox Image's tools, the same Stand-ins as the Agent's `bash` (ADR-0059), and no credential of its
  own. The Harness serves it on `/exec/:id`, behind the same bearer as every Harness route (ADR-0058); the Instance
  Harness holds no Workspace and refuses it (ADR-0031). Outside a `workspace()` a command is refused at invoke. Its cwd
  is a Repo Slot's Worktree: the one slot, or the slot it names (`slot`); several and none named is refused (ADR-0051).
- **Every outcome is output**: `exited | timeout | killed | unknown`. A command not found is `exited` 127 — an Agent's
  param can cause it. `onError` is only a jr2 or config defect: no Workspace, an argv slot with no value.
- **The process group ends with the exec.** Each exec leads its own group; its timeout, a kill, and its top process's
  exit each SIGKILL the group, so nothing it started outlives it. A bounded tail (default 4096 characters) is the
  output; the full stream goes to the run's feed (Instance-token band).
- **A write-ahead ledger; no second fire.** One row per Effect in the run's blob (ADR-0007, ADR-0065): an `intent` row
  saved at the write, with the snapshot that holds the Effect, before the request leaves; a `settled` row with the
  output, saved at the write just before the transition it drives, so a restart that loses the transition's save still
  delivers the output and runs nothing. On restore: settled → the output is delivered; intent → re-attach to the exec by
  id, or settle `unknown` when the Harness no longer knows it (it restarted); no row → nothing was sent, so it starts. A
  command is never run again by jr2: it runs the Agent's code, which may spend a Stand-in. Retry is the author's choice
  — a route back into the state. A row is kept only while the saved snapshot holds its Effect running: the save of the
  transition a `settled` row drives drops it — or, for an Effect with no `onDone` that settles in place, the save that
  holds the done child — and the save after an `aborted` row's own drops that one, so a Machine that loops does not grow
  its blob.
- **A start is sent once where it may have arrived.** A Harness runs one id once only within its own process; a
  restarted Harness knows no id. So the Orchestrator sends a start again only when it certainly never left (the
  connection was refused, the name did not resolve). Any other failure — a reset, a 5xx, no answer — may follow a start
  the Harness ran: the Orchestrator reads the exec by id instead, follows it when the Harness knows it, and settles
  `unknown` when it does not. It then sends a kill for that id, which keeps a start still on the wire from running.
- **D1: an Effect is stopped when its state exits.** The exec's group is killed. The kill is sent again until the
  Harness keeps it, for at most the command's timeout (past it the Harness's own timer has ended the group); a kill that
  never reaches it is said on the feed. A fast exit can send the kill while the start is still on the wire: the Harness
  keeps a kill of an id it does not know, and the start that arrives after it runs nothing. The abort goes to the ledger
  (`aborted`) and the feed, "outcome unknown"; the Machine does not get it — the state that asked has left. Two stops
  are not exits: the host parking the run (`hostStopping`, ADR-0024) and an Orchestrator shutdown (it stops no actor).
  The Effect then re-attaches on restore, or settles `unknown`. There is no "finally": cleanup is a state.
- **Must-finish is a pattern.** An Effect that must not be cut goes in its own state, whose only exit is its `onDone`,
  and that state handles the ancestor's events itself.
- **No fire-and-forget form.** Two patterns keep D1: an Effect in its own state; or a second invoke with no `onDone`
  beside the state's work — it fires on state entry, a fast exit can cut it, and below an Agent's state it holds Rest
  until it settles. `spawnChild` is not used for an Effect: it is not stopped on exit, it runs again on restore, and it
  is orphaned after a final state — each breaks D1 or the ledger.
- **Rest counts an Effect like any child.** A running Effect below an Agent's state holds the Agent's pick (ADR-0024); a
  settled Effect with no `onDone` is Rest. An Effect is not a long-lived invoke, and the load walk does not warn on one.
- **The load walk checks what a pick hands an Effect** (ADR-0015): a pick param nothing reads (with `fromPick`, one that
  is no key of the Effect's input and that `fill` does not read; a guard on the entering transition and an `assign`
  count as reads; a pick enters what an eventless `always` moves on to) and a `fill` that overwrites a param are
  refused; code the probe cannot or does not run — a mapper that throws in it, an action other than an `assign` — and a
  pick that targets a history state that may enter an Effect's state are a warning; and a state below an Agent's state
  that invokes something and that nothing enters is refused.

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
- Not built: an `answer` in a Machine where two Agents have a pick outstanding at once. Which pick it shapes is not
  decided; today it sets nothing, and each pick keeps its default answer.
- Owed, not built: Effect kinds beyond `command`, and an Open argv bound by `customize()`.
