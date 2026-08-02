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
      # The turn ends with the state that asked for it (ADR-0024). `humanReview` is the park that
      # keeps the Workspace, so nothing else would ever stop the Agent generating.
      And the stub Harness reports the Agent's turn settled as "aborted"

  Rule: a menu offers only what the Machine will currently accept
    ADR-0029. The VOCABULARY a state declares is static — it is what delivery validates against —
    but the guards on those transitions decide what the turn is actually offered. What a guard
    cannot answer before the Agent has picked its arguments is left on the menu and judged exactly
    on delivery, so a pick is never silently unavailable and never silently ignored.

    Background:
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving

    Scenario: a guard the menu can answer removes the tool
      When I start the "guarded" workflow against the stub harness with 0 attempts
      Then the agent's surface offers exactly "request_review"

    Scenario: the same workflow offers it once the guard is satisfiable
      When I start the "guarded" workflow against the stub harness with 1 attempts
      Then the agent's surface offers exactly "escalate, request_review"

    Scenario: a guard on the PICK is offered, then answered by the receipt
      When I start the "guarded" workflow against the stub harness with 0 attempts
      # Offered, because the guard reads arguments that do not exist until the Agent picks.
      Then the agent's surface offers exactly "request_review"
      When the agent calls "request_review" with summary " " and is told it moved nothing
      Then the run's status shows state "working"
      And the agent's surface offers exactly "request_review"

    Scenario: the same tool with arguments the guard accepts does move the run
      When I start the "guarded" workflow against the stub harness with 0 attempts
      And the agent calls "request_review" with summary "PR up"
      Then the run's status shows "done"

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

  Rule: a run is not resumed into a Machine that changed shape underneath it
    ADR-0030. A run is matched to its workflow by NAME, and the state outlives the image that wrote
    it — so a run parked when the orchestrator went down meets whatever the next deploy baked in.
    The snapshot names the Machine that wrote it; a mismatch is refused, kept, and announced. It is
    refused rather than merely warned about because xstate does not validate a restored state value:
    resumed into a chart missing that state, the run would simply carry on from nowhere.

    Scenario: editing a workflow refuses its parked runs instead of resuming them
      Given a fresh instance
      And the instance also has the "guarded" workflow
      And the orchestrator is serving
      And I start the "guarded" workflow against the stub harness with 0 attempts
      Then the run's status shows state "working"
      When the "guarded" workflow is replaced with the "guarded-reshaped" fixture and the orchestrator restarts
      Then the boot reports the run as drifted
      And the run reads as drifted, still parked at "working", and says why

  Rule: CANCEL ends a run, and ending it ends its Agents' turns
    ADR-0025. `j2 send --event CANCEL` is the human saying "abandon this". It is not a park: the
    run settles `cancelled` rather than staying restorable, and the Agent it was waiting on stops
    being asked — and stops answering.

    Scenario: cancelling a live run settles it and ends the turn it was waiting on
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness
      Then the agent's surface offers exactly "request_review"
      When I cancel the run
      Then the run's status shows "cancelled"
      And the agent's surface is gone
      And the stub Harness reports the Agent's turn settled as "aborted"
