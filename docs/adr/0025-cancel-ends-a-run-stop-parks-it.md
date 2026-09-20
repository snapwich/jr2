# CANCEL ends a run; stopping one parks it

`jr2 send <run> --event CANCEL` advertises "abandon a live run" (`cli.ts:29`), and
[ADR-0009](0009-cli-and-instance-interface.md) calls it the run-level infra interrupt. It was neither. The route called
`RunHost.stop()`, which stops the actor and **deliberately leaves the stored status `"live"`** — the tracked-run guard
drops the scheduled save — so the next `restore()` picks the run back up where it left off. A human abandoned a run and
it came back on the next orchestrator restart.

That was already wrong; [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md) made it load-bearing.
Its one exception — the ending that must NOT end the Agent's turn, because ADR-0007's restore re-attaches to those
submissions — is keyed on `RunHost.stop()`. And in a deployed Orchestrator that method has **exactly one caller: the
CANCEL route** (process shutdown stops no actors; the other callers are tests simulating a restart). So the exception
carved out for "the Orchestrator ending a run for its own reasons" was being spent, in production, on a human saying
"stop". Cancel a run and its Agents kept generating, in a Workspace nothing was watching.

## Decision

- **Two verbs, because there are two meanings.**
  - `RunHost.stop(runId)` — **park**: stop hosting the run here, keep it `"live"` and restorable, leave the submissions
    alive. ADR-0024's exception, unchanged. The teardown primitive, and the seam an orchestrator restart is simulated
    through.
  - `RunHost.cancel(runId)` — **end**: stop the actor with no exception flag, so every live `agentRun` invocation ends
    its Agent's turn (ADR-0024), then persist the run **terminal**. `POST /runs/:id/events {CANCEL}` calls this one.
- **Ending the turns and refusing to restore are ONE decision, not two.** A cancelled run that came back would re-attach
  from the admission ledger to submissions that settled `aborted`; `settle` would reject `submission_aborted` and fault
  a run whose Agents were stopped on purpose. Abort and restorability are incompatible, which is exactly why ADR-0024
  made its exception the whole method rather than a per-call flag.
- **The terminal status is `cancelled`** — a run-lifecycle word. xstate reports a stopped actor as `"stopped"`, which is
  mechanism, not an outcome. So the **store row is the authority on the run's lifecycle and the snapshot on the
  Machine's**: `read()` prefers the row unless it still says `"live"`. A cancelled run stays readable — `jr2 status`
  reports `cancelled` plus the state it was in when it was cancelled — and `restore()` skips it, because it skips
  everything that is not `"live"`.
- **`stop()` stays public with no production caller, and is deliberately not on the wire.** It is correct, it is what
  the durability suite drives, and it is what a future graceful shutdown should call. What nobody asked for is a
  user-facing "park this run" verb.
- **A cancelled run's Sandbox is not destroyed.** The wrapper's `teardown` is a STATE, entered when the body reaches
  final; an actor stop skips it. That matches a faulted run ([ADR-0012](0012-workspace-wrapper-machine.md)'s
  destroy-less terminal): cancelling is precisely when a human wants to exec in and see what happened, and the
  operator's idle GC reaps the pod on its own.

## Considered options

- **Flip ADR-0024's flag on the CANCEL route and change nothing else.** The obvious one-liner, and wrong: the run stays
  restorable, so the abort's only lasting effect is an `agent.fault` after the next restart.
- **Redefine CANCEL as "stop hosting" and document it honestly.** Rejected: it contradicts the CLI's own help text and
  ADR-0009/0011's "interrupt", and a park verb is not what anyone reaches for `--event CANCEL` to do.
- **Reuse `markLost`.** Rejected: `lost` means the live world went away underneath a run we wanted to keep (restore's
  reconcile probe). A cancelled run is not lost, and conflating them makes both statuses unreadable — the reason
  `markLost` also clears the snapshot, which a cancelled run must keep.
- **Have `cancel` destroy the Workspace too.** Rejected above: silent cleanup destroys the evidence.

## Consequences

- **`jr2 send --event CANCEL` now does what it says**, including on the Agents: their turns end with the run.
- **A cancelled run is readable but not resumable.** Nothing in the kit resumes one today anyway — `stop()` was the only
  path back, and nothing called it.
- **The mechanics tier owns this contract** (ADR-0010): a real CLI CANCEL against a real Orchestrator, asserting the run
  settles `cancelled` and the stub Harness reports the turn settled `aborted`. The `@kind` tier is unchanged — the
  cluster adds nothing to a claim about run lifecycle.
