Feature: workspace() runs need the instance's cluster
  ADR-0012: workspaces are ALWAYS real Sandboxes — there is no stubbed workspace mode. An
  instance whose j2.config.ts lists no `repos` (the data-plane switch, ADR-0031) must fail a
  workspace() run loudly and pointedly (a durable fault on the run, naming the fix), never hang.
  The happy path (real Sandbox on kind) is the deferred kind e2e tier.

  Rule: without a Sandbox backend, a workspace run faults pointedly

    Scenario: the run errors and its fault names the missing cluster
      Given a fresh instance
      And the instance also has the "workspaced" workflow
      And the orchestrator is serving
      When I start the "workspaced" workflow detached
      Then the run faults mentioning "no Sandbox backend"
