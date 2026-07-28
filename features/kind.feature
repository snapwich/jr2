@kind
Feature: a workspace() run drives a real Sandbox on kind
  ADR-0012: a Workspace is ALWAYS a real Sandbox — there is no stubbed workspace mode — so this is
  the one tier where the data plane is real: the operator's Sandbox CR, a pod running the Harness
  image, the instance's read-only repos volume, a git worktree inside the pod, and the Harness
  endpoint the body's agent is admitted against.

  It is also the only tier where the AGENT is real in the way that matters (ADR-0013): the pod
  originates its own tool calls. The dev Harness image carries a scripted persona which, on every
  submission, connects an MCP client to the Adapter on `localhost` and calls a tool from the menu
  the Machine registered for that turn. Nothing here plays the agent from the host. What is still
  faked is the LLM — the prompt names the tool instead of a model choosing it; the wire, the
  container boundary, and the tool call are real.

  This tier is opt-in (`@kind`, excluded from the default suite) because it needs infrastructure:
    just e2e-kind-up      # a vanilla kind cluster + locally built kit images (operator, adapter, dev Harness)
    just e2e-kind
  Bring-up is the product's own path (ADR-0010/0019): each scenario runs `j2 up` into a fresh
  namespace of the shared cluster — nothing is instance-bound to the cluster itself.

  Rule: the wrapper provisions a real Sandbox, attaches the worktree, and destroys it on final

    Scenario: the body works in a real worktree, and its Sandbox is reaped when it finishes
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's body settled as "finished"
      And the run's Sandbox is destroyed

  Rule: a live Sandbox survives an orchestrator restart, and the run re-attaches to it

    Scenario: restore re-attaches to the same Sandbox at the same endpoint
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the orchestrator restarts
      # Same CR (never re-provisioned) at the same endpoint: the port-forward is derived from the
      # Sandbox name, so the endpoint persisted in the snapshot is still the one that works.
      Then the run's Sandbox is the same one, at the same endpoint
      # And the Agent still reaches its Machine: its Adapter's token outlives the process that
      # minted it, so a turn played after the restart still lands (ADR-0013).
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's Sandbox is destroyed

  Rule: a Sandbox reaped while the orchestrator is down is never silently re-provisioned

    Scenario: the restored body is told its workspace is lost
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the orchestrator stops
      And the run's Sandbox is reaped behind its back
      And the orchestrator starts again
      # The reconcile probe found the CR gone and delivered `workspace.lost` INTO the body, whose
      # policy settled it. The unpushed commits are gone; resuming would have been a lie.
      Then the run's body settled as "lost"
      And no Sandbox was re-provisioned for the run

  Rule: the Agent's only control-plane peer is the Adapter on localhost
    ADR-0013. The Agent reaches its Machine through a process it can talk to but whose credential
    it cannot read. Nothing else in the pod can deliver — which is what makes "the Agent never
    steers the workflow" enforced rather than advertised.

    Scenario: the tool call originates inside the pod and drives the Machine
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox runs the Adapter beside the Harness
      # The pod dials out; the host dials nothing. The persona connected to the Adapter on
      # localhost, was served this state's menu, and called from it — and the Machine moved.
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's body settled as "finished"

    Scenario: the Harness container cannot deliver to the Orchestrator itself
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      # `local()` tools give the Agent code execution in the Harness container, which shares the
      # pod's network namespace — so it CAN reach the Orchestrator, address and all. It simply has
      # no credential: the Sandbox token is delivered into the Adapter container only.
      When the Harness container posts "finish" straight to the Orchestrator
      Then the delivery is refused as unauthorized
      And the run has not settled

  Rule: an Agent's turn ends when the state that asked for it stops waiting
    ADR-0024. Leaving an `agentRun` invoke means "I am no longer interested in this answer", so the
    submission behind it is ended — at the Harness, which is the only place that end is observable
    (the Orchestrator is already gone by then, by construction). The `handoff` workflow parks
    WITHOUT settling, so the Workspace survives the whole scenario: that is the shape where an
    un-ended turn would still be a live writer in the worktree the Machine believes is idle.

    Scenario: the pick that moves the Machine ends the turn behind it, and the next turn survives
      Given the kind instance is serving
      When I start the "handoff" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's body is in "coding"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's body is in "shipping"
      # Both submissions the `coding` state carried — the inert one it was admitted with, and the
      # scripted one that ended it — are over on the pod, not merely forgotten by the Orchestrator.
      And the Harness reports 2 of the Agent's turns settled as "aborted"
      # …and the turn `shipping` asked for is NOT among them, on the SAME instance id. The abort was
      # ordered ahead of it (flue queues per instance), so it never settled work that had not run.
      When the Agent in the Sandbox calls "ship" with summary "ok"
      Then the run's body is in "parked"
      And the Harness reports 4 of the Agent's turns settled as "aborted"
      And the run's Sandbox is still there
