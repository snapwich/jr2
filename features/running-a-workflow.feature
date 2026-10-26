Feature: Running a workflow
  The everyday loop: boot an instance, run a workflow, and observe it. Each Rule is one acceptance
  criterion and runs against its own isolated instance + orchestrator.

  Rule: a run streams activity and prints its terminal result
    `jr2 run` blocks and attaches by default — human-readable status on stderr, the one machine-readable
    terminal RunStatus on stdout — so `jr2 run ping` informs a person while `jr2 run ping | jq` yields data.

    Background:
      Given a fresh instance
      And the orchestrator is serving

    Scenario: ping replies pong
      When I run "ping" with message "hi"
      Then the run reaches "done" on stderr
      And stdout is the terminal status with reply "pong: hi"
      And the command exits 0

    Scenario: detach prints only the runId
      When I run "ping" detached
      Then stdout is a bare runId
      And the command exits 0

  Rule: a Machine that invokes fail ends its run failed, and a parent can catch the Failure
    ADR-0073. A final state means `done`. A Machine ends work that did not succeed with `fail()`:
    the Failure goes up through each parent Machine, an `onError` that `isFailure` guards catches
    it, and an uncaught one ends the run `failed`, with the reason and the detail as its output.
    `jr2 run` exits 0 only for `done`, so CI can read a failed run from the exit code.

    Background:
      Given a fresh instance
      And the instance also has the "failing" workflow
      And the instance also has the "recovering" workflow
      And the orchestrator is serving

    Scenario: an uncaught Failure ends the run failed with its reason, and jr2 run exits 1
      When I run "failing" to its end
      Then the run reaches "failed" on stderr
      And stderr says "failed: the check did not pass"
      And stdout is the terminal status "failed" with output '{"reason":"the check did not pass","detail":{"failed":2}}'
      And the command exits 1

    Scenario: a parent catches the Failure of its child with isFailure, and its run ends done
      When I run "recovering" to its end
      Then stdout is the terminal status "done" with output '{"caught":"no plan fits the ticket"}'
      And the command exits 0

  Rule: live and settled runs are observable
    A still-running workflow shows up in `jr2 runs`; a settled one is read through to the store by
    `jr2 status`. (The instant `ping` scaffold can't stay live, so this Rule also serves a `loop`.)

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: runs lists a live run
      When I start the "loop" workflow detached
      And I list the runs
      Then the run appears in the runs list

    Scenario: status reads a settled run through
      When I run "ping" with message "hi"
      And I check the status of that run
      Then the status is "done"
      And the reply is "pong: hi"

  Rule: logs replays a run's status, and follows a live one until it settles
    ADR-0009. `jr2 logs <runId>` re-attaches to the run's feed: the orchestrator replays the current
    status on attach, so even a settled run answers with where it ended. `-f` keeps streaming
    deltas and returns on its own once the run is no longer active — the verb for watching a run
    someone else started, or one `run --detach` let go of.

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: logs on a settled run prints its terminal status once
      When I run "ping" with message "hi"
      And I read the logs of that run
      Then stdout is the terminal status with reply "pong: hi"
      And the command exits 0

    Scenario: logs -f on a live run returns when the run settles
      When I start the "loop" workflow detached
      And I follow the logs of that run while it is cancelled
      Then the last status printed is "cancelled"
      And the command exits 0
