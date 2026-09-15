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

  Rule: a payload the workflow's declared input refuses is refused at the door
    ADR-0033. A Machine declares the input a run of it starts with; the orchestrator judges the
    payload against that declaration before any run exists, and the CLI relays the verdict — the
    workflow by name and what the schema expected — as a runtime error, exit 1. Nothing was started,
    so there is no run to read.

    Scenario: a run started with a payload the schema rejects exits 1 naming the field
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the orchestrator is serving
      When I start "intake" with input '{"subject": 5}'
      Then the command exits 1
      And stderr refuses the input for workflow "intake" naming "subject"
