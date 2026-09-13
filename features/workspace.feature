Feature: workspace() runs need the instance's cluster
  ADR-0012: workspaces are ALWAYS real Sandboxes — there is no stubbed workspace mode. Whether an
  instance has a data plane at all is read off its registered Machines (ADR-0051): a Machine that
  composes a Sandbox needs one, and nothing else does. A host-booted process outside any cluster
  has none either way, so a workspace() run there must fail loudly and pointedly (a durable fault
  on the run, naming the fix), never hang. The happy path (a real Sandbox on kind) is the @kind
  tier.

  Rule: the data plane exists exactly when a registered Machine composes a Sandbox

    Scenario: an instance whose Machines compose no Sandbox reports no data plane
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
