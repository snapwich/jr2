Feature: The CLI contract
  Cross-cutting guarantees a user's shell relies on: exit codes that mean something, and a dev server
  that advertises then cleans up its address. Each Rule runs against its own isolated instance.

  Rule: errors map to exit codes
    0 ok, 1 runtime error, 2 usage — so scripts can branch on `$?`.

    Scenario: a run-control verb with no orchestrator exits 1
      Given a fresh instance
      When I list the runs
      Then the command exits 1
      And stderr reports an error

    Scenario: an unknown command exits 2
      When I run an unknown command
      Then the command exits 2
      And stderr reports an unknown command

  Rule: dev advertises then cleans up its address
    `j2 dev` writes `.j2/dev.json` while serving so the run-control verbs can attach, and removes it on
    a clean exit so a stale address never points at a dead server.

    Scenario: dev writes dev.json while serving
      Given a fresh instance
      When the orchestrator is serving
      Then .j2/dev.json points at the live url

    Scenario: SIGINT removes dev.json
      Given a fresh instance
      And the orchestrator is serving
      When the orchestrator receives SIGINT
      Then .j2/dev.json is removed
