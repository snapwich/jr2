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

  Rule: a run holds the Assembly it started under, so a publish that reshapes its Workflow strands nothing
    ADR-0069. A run restores inside the Assembly its snapshot names, not the current one, so a
    publish never meets a parked run: the run resumes under the Machine that wrote it, and a new
    run starts under the current Assembly. A run that is live holds its Assembly on the volume;
    an Assembly no live run holds and that is not current is collected (ADR-0039) at the next
    publish, boot or hourly sweep.

    Scenario: publish v1, start a run, publish v2 with another shape, restart: the run resumes under v1
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      And the host-booted orchestrator restarts
      Then the run resumes under the first Assembly, at state "working"
      And the orchestrator lists the first Assembly as held by the run, and the current one by no run
      And `jr2 status` names the current Assembly first, then the first Assembly held by 1 live run
      And a new "guarded" run starts under the current Assembly, at state "implementing"

    Scenario: a run finishes, and its Assembly is collected at the next publish
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      Then the first Assembly is on the volume
      When I cancel the run
      Then the run's status shows "cancelled"
      When I publish a third Assembly
      Then the publish collected the first and second Assemblies, and they are gone from the volume
      And the orchestrator no longer lists the first Assembly as held

    Scenario: a run finishes, and its Assembly is collected at the next boot
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      And I cancel the run
      Then the run's status shows "cancelled"
      When the host-booted orchestrator restarts
      Then the boot collected the first Assembly, and it is gone from the volume
      And the orchestrator no longer lists the first Assembly as held

  Rule: a boot with no current Assembly restores nothing, and the first publish restores the runs it left
    ADR-0069. With no current Assembly no config applies, so a run that reached a provision would
    fault, and in the Kit bump window every held Assembly is still at the old Kit version. So the
    boot leaves every live run untouched and announces it as waiting; the first publish that lands
    restores each run inside the Assembly its snapshot names.

    Scenario: the current Assembly is gone, a run under a held one waits, and the next publish resumes it
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      And the current Assembly is removed from the volume and the orchestrator restarts
      Then the boot reports the run as waiting, and serves no current Assembly
      And the run reads as live, still parked at "working", under the first Assembly
      And `jr2 status` answers while no Assembly is current
      When I publish the Assembly again
      Then the run resumes under the first Assembly, at state "working"
      And the run is in the runs list

  Rule: a run whose Assembly the volume lost is refused, kept, readable and announced
    ADR-0069, ADR-0030. Drift is "the Orchestrator can no longer read what it saved". Here the
    Assembly the snapshot names is not on the volume, so there is no Machine to resume the run
    into. The run is refused, its snapshot is kept, it stays readable, and the boot announces it.
    The other forms of drift (an Assembly published for another Kit version, an Assembly that does
    not load, a Machine of another shape inside one Assembly) are claims of the orchestrator's
    instance and run-host tests, not of this Rule.

    Scenario: an Assembly the volume lost drifts the runs that held it
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When I publish the "guarded-reshaped" fixture as the "guarded" workflow
      And the first Assembly is removed from the volume and the orchestrator restarts
      Then the boot reports the run as drifted
      And the run reads as drifted, still parked at "working", and says its Assembly "is not on the volume"
      And the run is absent from the runs list
