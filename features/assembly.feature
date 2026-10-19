Feature: An Instance publishes its Assembly, and the Orchestrator serves the current one
  ADR-0069: the Orchestrator is a Kit image, and `jr2 up` publishes the Instance's Assembly to it
  over `PUT /assembly`, behind the publish token. The host-booted fixture publishes through the
  same door: the Orchestrator never loads the folder it was started in. A restart boots from the
  `current` pointer on the state volume, and publishes nothing.

  Rule: a publish makes an Assembly current, and the Orchestrator names it by one hash

    Scenario: a publish lists the Workflows, and /assembly, /healthz and `jr2 status` agree on the hash
      Given a fresh instance
      And the orchestrator is serving
      Then the publish listed the scaffold's Workflows
      When I ask the orchestrator for its Assembly
      Then the current Assembly is the one published, named by the hash /healthz reports
      And `jr2 status` names the current Assembly

    Scenario: a restart keeps the current Assembly
      Given a fresh instance
      And the orchestrator is serving
      When I ask the orchestrator for its Assembly
      And the host-booted orchestrator restarts
      Then the current Assembly has the hash it had before the restart

    Scenario: a second publish of the same bytes is unchanged
      Given a fresh instance
      And the orchestrator is serving
      When I publish the Assembly again
      Then the door answers that the Assembly is unchanged

  Rule: the door refuses what it must not import, and the old Assembly keeps serving

    Scenario: the Instance token does not publish
      Given a fresh instance
      And the orchestrator is serving
      When I publish the Assembly with the Instance token
      Then the door refuses it with 403 naming the publish token

    Scenario: an Assembly for another Kit version is refused, naming both numbers
      Given a fresh instance
      And the orchestrator is serving
      When I publish the Assembly naming Kit version "0.0.0-other"
      Then the door refuses it with 409 naming "0.0.0-other" and this Orchestrator's Kit version

    Scenario: a Workflow with no `export const machine` is refused, and the old Assembly still serves
      Given a fresh instance
      And the orchestrator is serving
      When I add a workflow "broken" that exports no machine and publish
      Then the door refuses it with 422 naming the missing `machine` export
      And the Orchestrator still serves the Assembly it served before

  Rule: a run whose Workflow a publish reshaped is drifted at the next boot

    Scenario: publish v1, start a run, publish v2 with another shape, restart: the run is drifted
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      And the host-booted orchestrator restarts
      Then the boot reports the run as drifted
