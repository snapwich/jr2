Feature: Callers
  A Caller acts on an Instance from outside its Machines with a credential of its own, and does only
  what its scopes allow (ADR-0078). The CLI on a kube context is the Caller token/instance; with
  `--url` and `JR2_TOKEN` it sends any Caller's credential, and it is that Caller.

  Rule: a named Caller token acts within its scopes
    A CI job holds a named token with `start` and `read` on one Workflow. It starts and follows a
    run of that Workflow, and the Orchestrator refuses it a start of any other, naming the scope
    and the Workflow that the start needed.

    Scenario: a named token starts its Workflow and is refused another
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance declares the Caller token "ci" that may start and read "ping"
      And the orchestrator is serving
      When the Caller "ci" runs "ping" with message "hi"
      Then stdout is the terminal status with reply "pong: hi"
      And the command exits 0
      When the Caller "ci" starts "intake" with input '{"subject": "x"}'
      Then the command exits 1
      And stderr says the Caller "token/ci" needs the "start" scope for Workflow "intake"

  Rule: the run records the Caller that started it
    The Caller that starts a run is on the run's status, behind the token: `jr2 status` shows it to
    the operator, and the open observation of the run never carries it.

    Scenario: a run started by a named token says so on its status
      Given a fresh instance
      And the instance declares the Caller token "ci" that may start and read "ping"
      And the orchestrator is serving
      When the Caller "ci" runs "ping" with message "hi"
      And I check the status of that run
      Then the command exits 0
      And the run was started by the Caller "token/ci"
