Feature: Agents and gates drive a run from outside
  The ADR-0011 mechanics tier, with no cluster: a workflow's agentRun admits against the
  fixture stub Harness and parks; the run is then driven entirely from outside — the agent's
  surface played over `/agents/<iid>/*`, the human played over the gates API. Each event lands
  on the state that invoked its actor; leaving the state destroys the surface.

  What plays the agent here is really its ADAPTER (ADR-0013): the Orchestrator speaks no MCP, and
  there is no pod in this tier to host it. A REAL Agent, in a real Sandbox, connecting over MCP to
  a real Adapter on localhost, is what the `@kind` tier proves.

  Rule: an agent's tool call transitions the state that invoked it

    Background:
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving

    Scenario: the agent surface serves exactly the invoking state's tools
      When I start the "review" workflow against the stub harness
      Then the agent's surface offers exactly "request_review"

    Scenario: an agent tool call moves the run
      When I start the "review" workflow against the stub harness
      And the agent calls "request_review" with summary "PR up"
      Then the run's status shows state "humanReview"
      And the agent's surface is gone

  Rule: a gate is an addressable resource on the run

    Background:
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness
      And the agent calls "request_review" with summary "PR up"

    Scenario: the run lists its open gate with schemas and meta
      Then the run's status lists gate "review-1" accepting "approve" with meta summary "PR up"

    Scenario: delivering an accepted event settles the run and destroys the gate
      When I deliver "approve" to gate "review-1"
      Then the run's status shows "done"
      And gate "review-1" is gone

    Scenario: an unaccepted event is rejected and the run does not move
      When I deliver "reject" to gate "review-1"
      Then the delivery is refused naming the accepted events
      And the run's status shows state "humanReview"
