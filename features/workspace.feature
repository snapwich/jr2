Feature: workspace() runs need the instance's cluster
  ADR-0012: workspaces are ALWAYS real Sandboxes — there is no stubbed workspace mode. A deployed
  Orchestrator always wires its data plane, because a publish can bring the first workspace()
  (ADR-0069); `jr2 up` still decides from its walk whether to DEPLOY the operator and the cache
  agent (ADR-0051). A host-booted process outside any cluster has no data plane, so a workspace()
  run there must fail loudly and pointedly (a durable fault on the run, naming the fix), never
  hang. The happy path (a real Sandbox on kind) is the @kind tier.

  Rule: the data plane exists exactly when the Orchestrator runs in a cluster

    Scenario: a host-booted instance reports no data plane
      Given a fresh instance
      And the orchestrator is serving
      When I ask for the instance's status
      Then it reports no data plane

  Rule: without a cluster, a workspace() run faults pointedly

    Scenario: the run errors and its fault names the missing cluster
      Given a fresh instance
      And the instance also has the "workspaced" workflow
      And the orchestrator is serving
      When I start the "workspaced" workflow detached
      Then the run faults mentioning "no Sandbox backend"
