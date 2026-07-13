@kind
Feature: a workspace() run drives a real Sandbox on kind
  ADR-0012: a Workspace is ALWAYS a real Sandbox — there is no stubbed workspace mode — so this is
  the one tier where the data plane is real: the operator's Sandbox CR, a pod running the Harness
  image, the instance's read-only repos volume, a git worktree inside the pod, and the Harness
  endpoint the body's agent is admitted against. What is NOT real is the LLM: the Sandbox runs the
  dev Harness image (the wire-compatible stub), and the scenarios play the agent themselves over
  its MCP surface — exactly as the mechanics tier does.

  This tier is opt-in (`@kind`, excluded from the default suite) because it needs infrastructure:
    just e2e-kind-up      # dev Harness image + the cluster whose repos/ mount is baked at creation
    just operator-run     # the Sandbox operator, in another shell (until a deployable image lands)
    just e2e-kind

  Rule: the wrapper provisions a real Sandbox, attaches the worktree, and destroys it on final

    Scenario: the body works in a real worktree, and its Sandbox is reaped when it finishes
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      And the agent's MCP surface offers exactly "finish"
      When the agent calls "finish" with summary "ok"
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
      And the agent's MCP surface offers exactly "finish"
      When the agent calls "finish" with summary "ok"
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
