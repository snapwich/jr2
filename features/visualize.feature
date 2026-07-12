Feature: Visualizing a workflow's Machine
  `j2 visualize <workflow>` opens a browser page, served by the orchestrator itself, that renders the
  workflow's Machine. The verb attaches to the running orchestrator, prints the page URL as its one
  machine-readable result, and leaves the server's lifecycle alone.

  Rule: the visualizer is reachable through a serving orchestrator
    Every orchestrator carries its own visualizer: the page and the Machine's structure are plain HTTP
    routes, so `j2 visualize ping --no-open | jq -r .url` yields a working address.

    Background:
      Given a fresh instance
      And the orchestrator is serving

    Scenario: visualize prints the page URL
      When I visualize "ping"
      Then the command exits 0
      And stdout is a visualizer url for "ping"
      And the visualizer page is served at that url
      And the Machine structure is served for "ping"

    Scenario: visualizing an unknown workflow exits 1
      When I visualize "nope"
      Then the command exits 1
      And stderr lists the available workflows
