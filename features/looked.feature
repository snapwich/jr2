Feature: a Gate looks for the fact that it waits for

  A Gate slot's look (ADR-0011) reads the fact that the Gate waits for: once after the Gate opens,
  again every `every` while it is open, and again after a restore. So a fact that came before the
  Gate opened, while the run waited, or while the Orchestrator was down all come to the same read.
  This tier has no Instance Effector, so the `looked` fixture's read is a promise that reads a file.

  Rule: the look gives the Gate's event when the fact is there, and the run takes it with no Caller

    Background:
      Given a fresh instance
      And the instance also has the "looked" workflow
      And the orchestrator is serving

    Scenario: a fact that is there before the Gate opens moves the run at once
      Given the fact says "approved"
      When I start the "looked" workflow over the fact
      Then the run's status shows "done"
      And no Caller answered the run

    Scenario: a fact that comes while the Gate is open moves the run at the next look
      Given the fact says "pending"
      When I start the "looked" workflow over the fact
      Then the run's status shows state "inReview"
      When the fact comes to say "approved"
      Then the run's status shows "done"

    Scenario: a fact that comes while the Orchestrator is down moves the run after the restore
      Given the fact says "pending"
      When I start the "looked" workflow over the fact
      Then the run's status shows state "inReview"
      When the host-booted orchestrator stops
      And the fact comes to say "approved"
      And the host-booted orchestrator boots again
      Then the run's status shows "done"
