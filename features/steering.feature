Feature: A Caller steers one Agent of a live run
  ADR-0002: a Steering message is free text from a Caller, or from the Machine, to one Agent slot of
  a run. The Agent hears it once, with no interrupt: its open Turn at the next step boundary, or the
  slot's next Turn in the same Machine instance. A held message retires, "not delivered", when its
  Machine instance ends. The run records each message with its author and its outcome.

  As in agent-and-gates.feature, the steps play the Agent's Harness over `/agents/<iid>/*`: there is
  no pod here, and the stub Harness never reads its surface. The real Harness's framing of a message
  by its author is checked by Harness conformance (ADR-0027), and what a real model does with it by
  the `@model` tier.

  Background:
    Given a fresh instance
    And the instance also has the "review" workflow
    And the orchestrator is serving

  Rule: the message reaches the slot it names, and the run records it

    Scenario: jr2 steer lists the slot, and the open Turn reads the message at its next step boundary
      When I start the "review" workflow against the stub harness
      Then jr2 steer lists the Agent slot "root/coder" as open and steerable
      When I steer "root/coder" with "Use the v2 API."
      Then jr2 steer said the open Turn hears it at its next step boundary
      And the agent's next surface read carries the Steering message "Use the v2 API." from the Caller "instance"
      And the run records the Steering message "Use the v2 API." as "held"
      When the agent's Harness acknowledges the Steering message
      Then the run records the Steering message "Use the v2 API." as "heard"

    Scenario: a slot that no live Machine instance holds is refused, naming the run's slots
      When I start the "review" workflow against the stub harness
      And I steer "coder" with "Use the v2 API."
      Then jr2 steer fails naming the slot "root/coder"

  Rule: a message that no Turn heard retires when its Machine instance ends

    Scenario: the Turn ends unread, the message waits, and the run's end retires it
      When I start the "review" workflow against the stub harness
      And I steer "root/coder" with "too late"
      And the agent calls "request_review" with summary "PR up"
      Then the run's status shows state "humanReview"
      And the run records the Steering message "too late" as "held"
      When I deliver "approve" to gate "review-1"
      Then the run's status shows "done"
      And the run records the Steering message "too late" as "not-delivered"
