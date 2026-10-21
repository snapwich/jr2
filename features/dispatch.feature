Feature: A run starts a run through a dispatch Effect
  ADR-0071. A `dispatch` slot starts a run of a registered Workflow as an act of its caller: a run of
  its own, with its own row in `jr2 runs`, its own cancel and its own life. With no target the
  Effect runs in the Orchestrator's own process and starts the run through the run host, with no
  wire and no token, which is the path this tier owns. The callee's row says who dispatched it, the
  caller's ledger row says which run it started, and the ledger row's id is the door's idempotency
  key, so a start sent twice is one run.

  The caller here is the `dispatcher` fixture and the callee is `intake`, which parks on its
  `finish` Gate until a step answers it. The `@kind` tier owns the other placement: a dispatch to an
  Orchestrator by url and token, from the Instance Effector.

  Rule: a run starts a run, and the callee names its caller
    `started` settles once the run host has accepted the run. `jr2 runs` lists the callee with
    `dispatchedBy`, and `jr2 status` says on stderr who dispatched it.

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance also has the "dispatcher" workflow
      And the orchestrator is serving

    Scenario: the dispatched run is live and listed, dispatched by its caller
      When the dispatcher starts with '{"target":"intake","subject":"from a watcher"}'
      Then the dispatcher settles "done" with the outcome "started"
      And `jr2 runs` lists the dispatched run as dispatched by the dispatcher's "intake" slot at depth 1
      And the dispatcher's output names the dispatched run
      And `jr2 status` of the dispatched run says it was dispatched by the dispatcher

  Rule: a wait settles with the callee's status and output
    With `wait`, the Effect settles when the callee's run ends, with its status in the store's own
    words and the callee Machine's output, which `GET /runs/<id>` serves for a settled run.

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance also has the "dispatcher" workflow
      And the orchestrator is serving

    Scenario: the caller waits, and settles when the callee ends
      When the dispatcher starts with '{"target":"wait","subject":"ticket-7"}'
      And the dispatched run's "finish" Gate takes the note "shipped"
      Then the dispatcher settles "done" with the outcome "settled"
      And the dispatcher's output is the dispatched run's: status "done", subject "ticket-7" and note "shipped"

    Scenario: a restart in the middle of the wait resumes it, and starts no second run
      When the dispatcher starts with '{"target":"wait","subject":"ticket-8"}'
      And the dispatched run is live
      And the host-booted orchestrator restarts
      And the dispatched run's "finish" Gate takes the note "after the restart"
      Then the dispatcher settles "done" with the outcome "settled"
      And the dispatcher's output is the dispatched run's: status "done", subject "ticket-8" and note "after the restart"
      And the dispatcher started exactly one run

  Rule: the two runs are independent
    A cancel of the caller stops its wait, never the run it started: the callee has its own cancel
    and its own life.

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance also has the "dispatcher" workflow
      And the orchestrator is serving

    Scenario: cancelling the caller leaves the callee live
      When the dispatcher starts with '{"target":"wait","subject":"ticket-9"}'
      And the dispatched run is live
      And I cancel the dispatcher
      Then the dispatcher's status is "cancelled"
      And the dispatched run is still live
      When the dispatched run's "finish" Gate takes the note "on its own"
      Then the dispatched run's status is "done"

  Rule: a door refusal is the Effect's output, not a fault
    The body may have come from a model, so the door's report must be able to reach it: the
    refusal settles as output, and the caller's Machine routes on it.

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance also has the "dispatcher" workflow
      And the orchestrator is serving

    Scenario: a body the door refuses settles as a 400 refusal naming the field
      When the dispatcher starts with '{"target":"bad"}'
      Then the dispatcher settles "done" with the outcome "refused"
      And the refusal has status 400 and its report names "subject"
      And no run of "intake" was started

    Scenario: a dispatch resolves against the current Assembly, and a callee it dropped is a 404 refusal
      The caller holds the Assembly it started under (ADR-0069); its dispatch is a new run, which
      starts under the Assembly current then.
      When the dispatcher starts with '{"target":"intake","hold":true}'
      And the dispatcher is parked on its "go" Gate
      And I publish an Assembly without "intake" and "dispatcher"
      And the dispatcher's "go" Gate is answered
      Then the dispatcher settles "done" with the outcome "refused"
      And the refusal has status 404 and its report names "intake"

  Rule: the publish door refuses a dispatch whose callee is not in the Assembly
    The walk resolves a same-Instance name in the Assembly and refuses a miss, naming the fix.

    Scenario: an Assembly that dispatches a Workflow it does not have is refused
      Given a fresh instance
      And the instance also has the "dispatcher" workflow
      When the orchestrator boots and I publish the Assembly
      Then the publish is refused naming 'workflow "dispatcher" dispatches "intake" which no Workflow in the Assembly has'

  Rule: the ledger row's id is the door's idempotency key
    A foreign caller sends it in the `jr2-dispatched-by` header, never in the body. The door answers
    a repeat with the run the key already started: 201 for a new run, 200 and `existing` for a
    repeat.

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the orchestrator is serving

    Scenario: two starts with one key are one run
      When I start "intake" twice by HTTP with one dispatch key from instance "ops"
      Then the first start answered 201 and the second 200 naming the same run as existing
      And `jr2 runs` lists exactly one run of "intake", dispatched from instance "ops"
