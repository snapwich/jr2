Feature: The CLI contract
  Cross-cutting guarantees a user's shell relies on: exit codes that mean something, and run ids you
  can abbreviate. Each Rule runs against its own isolated instance.

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

  Rule: a run id may be abbreviated to a unique prefix
    Git's short hashes, for run ids: a prefix addresses the run, resolved against settled runs as well
    as live ones — the paste-from-a-log case. Too short to be a question is a usage error.

    Background:
      Given a fresh instance
      And the orchestrator is serving

    Scenario: an abbreviated id addresses a settled run
      When I run "ping" with message "hi"
      And I check the status of that run by its first 8 characters
      Then stdout is the terminal status with reply "pong: hi"
      And the command exits 0

    Scenario: a too-short abbreviation exits 2
      When I check the status of run id "ab"
      Then the command exits 2
      And stderr says the run id is too short
