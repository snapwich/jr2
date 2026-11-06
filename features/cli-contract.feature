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

  Rule: jr2 version reports what runs here and what is deployed, and never refuses
    ADR-0009 as amended. The report you paste into a bug: the copy that runs, the Instance's Kit
    version, and the orchestrator's own account of itself over `/healthz` — side by side, so the gap
    is the diagnosis. A REPORT verb: a table on stdout, `--json` the one object, exit 0 whatever it
    finds. This tier's instance lives under the checkout, so it resolves the workspace's own kit: the
    kit line is `ok` and the verdict is `same`. (The uninstalled and mismatched shapes, which every
    other Instance verb refuses under ADR-0056, are unit-tested as lines in `version.test.ts`.)

    Background:
      Given a fresh instance
      And the orchestrator is serving

    Scenario: the table names the CLI, the kit, and the orchestrator, all at one number
      When I ask for the version
      Then the command exits 0
      And the version table names this CLI and the serving orchestrator
      And the version table says the kit is this checkout's

    Scenario: --json is the same report as one object
      When I ask for the version as JSON
      Then the command exits 0
      And the version report's orchestrator is the CLI's own version

  Rule: jr2 completion prints a script, and the script's lookups answer from the command table and the deployment
    ADR-0009. `jr2 completion bash|zsh|fish` is a value verb: the script on stdout. On each TAB the
    script asks `jr2 completion __complete <words>`, which answers verbs, sub-verbs, flags and their
    values from the command table, and live run ids, Workflow names and a run's Agent slots from the
    Orchestrator.

    Scenario Outline: each shell gets its script
      When I ask for the <shell> completion script
      Then the command exits 0
      And stdout holds "<line>"

      Examples:
        | shell | line                                     |
        | bash  | complete -o default -F _jr2_complete jr2 |
        | zsh   | compdef _jr2 jr2                         |
        | fish  | complete -c jr2 -f -a '(__jr2_complete)' |

    Scenario: a shell that jr2 has no script for is a usage error
      When I ask for the powershell completion script
      Then the command exits 2

    Scenario: verbs, sub-verbs and flag values complete from the command table
      Given a fresh instance
      When I complete the words "wat"
      Then the completions are exactly "watch"
      When I complete the words "workspace "
      Then the completions are exactly "ls, shell, forward, rm"
      When I complete the words "runs --status en"
      Then the completions are exactly "ended"

    Scenario: run ids, Workflow names and Agent slots complete from the Orchestrator
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness
      When I complete the words "watch "
      Then the completions are exactly the run's id
      When I complete the words "run "
      Then the completions include "ping" and "review"
      When I complete the words "logs <run> "
      Then the completions are exactly "root/coder"
