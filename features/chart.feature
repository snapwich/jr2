Feature: a Machine lends its parts to a Chart
  ADR-0070. A Chart is a Machine written as data alone, and it runs only under a Chart wrapper:
  the Machine that declares an Open body, lends it parts by slot name, allows the models and the
  Workspace access of a Chart's own Agents, and sets the ceilings. A Chart mints its states, its
  events and its Agents, and borrows the rest. The door admits a Chart before anything runs, and a
  Chart it refuses is the Open body's OUTPUT, never its error (D-A).

  No cluster here: the `charted` and `planner` fixtures lend a stub Agent, and every Turn, lent or
  minted, admits against the stub Harness. A Chart names no url: the wrapper's door takes the
  endpoint, the wrapper passes it to the Open body, and the body places every Turn its Chart starts
  with it. The steps play each Agent's Menu over `/agents/<iid>/*`, and play an MCP for the Chart
  routes no verb has yet.

  Rule: a one-shot Chart runs under its Chart wrapper, and its Agents pick from its events

    Background:
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the orchestrator is serving

    Scenario: a Chart's picks move it, and the run settles with the Chart's output
      When I start "charted" against the stub harness with the "review-loop" Chart
      Then the Chart's "coder" was admitted with a prompt naming "Implement this task: add a greeting"
      And the Chart's "coder" has the Allowed picks "submit"
      And the run's body is in state "draft"
      And `jr2 status` says the run binds a Chart
      And the run's Machine lists the Chart's states "draft, review, shipped", and the wrapper's Machine does not
      When the Chart's "coder" picks "submit"
      Then the run's body is in state "review"
      And the Chart's "reviewer" has the Allowed picks "approve, revise"
      # `revise` is guarded by the lent `underLimit`, counts the round, and keeps the notes, which
      # the next prompt reads as `{{context.notes}}`.
      When the Chart's "reviewer" picks "revise" with notes "add a test"
      Then the run's body is in state "draft"
      And the Chart's "coder" was admitted with a prompt naming "Review notes so far: add a test"
      When the Chart's "coder" picks "submit"
      And the Chart's "reviewer" picks "approve"
      Then the run settles at "done" with the Chart's output '{"rounds":1}'

  Rule: the door refuses a Chart before the run starts
    A refusal is one report line per fault, each naming the path in the Chart and what is lent.
    By HTTP the start is a 422 with the report; the CLI relays it on stderr and exits 1.

    Background:
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the orchestrator is serving

    Scenario Outline: a Chart that names what is not lent, loops unguarded, or reads what nothing supplies
      When I start "charted" by HTTP with the "<chart>" Chart
      Then the start is refused with 422 and a report naming "<path>"
      And the start is refused with 422 and a report naming "<fault>"

      Examples:
        | chart     | path                      | fault                                                              |
        | bad-src   | states.lint.invoke.src    | is not a lent actor or an Agent of this Chart; lent: coder (Agent) |
        | unguarded | states.ping.always        | cycle (ping -> pong -> ping) has an unguarded edge                 |
        | dangling  | states.draft.invoke.input | context.notes is supplied by nothing                               |

    Scenario: jr2 run relays the door's refusal
      When I run "charted" with the "bad-src" Chart by the CLI
      Then stderr says the door refused the Chart for "charted" naming "linter"

  Rule: a planner whose Chart is refused reads the report as its pick's answer, and picks again
    D-A: the refusal is the Open body's output, so the planner's Chain carries it as a link, and
    the pick that carried the Chart is answered with it when the wrapper is back at Rest.

    Scenario: a refused Chart is answered to the planner; a corrected one runs
      Given a fresh instance
      And the instance also has the "planner" workflow
      And the orchestrator is serving
      When I start "planner" against the stub harness with a task
      And the planner picks "run_chart" with the "bad-src" Chart
      Then the pick's answer names "linter"
      And the run is back in "ready"
      When the planner picks "run_chart" with the "review-loop" Chart
      Then the run's body is in state "draft"
      When the Chart's "coder" picks "submit"
      And the Chart's "reviewer" picks "approve"
      Then the run's status shows "done"

  Rule: a named Chart is a Workflow under its wrapper
    A runtime Chart is `PUT /workflows/<wrapper>/charts/<name>`, kept on the Orchestrator's volume,
    and run as `<wrapper>/<name>` with the rest of the wrapper's door. A run holds its text, so a
    delete leaves a live run of it running.

    Background:
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the instance also has the "review" workflow
      And the instance also has the "planner" workflow
      And the orchestrator is serving

    Scenario: a runtime Chart is put, listed, run, kept across a restart, and deleted
      When I put the "review-loop" Chart as "charted/loop"
      Then the put answers 201 with origin "runtime"
      And `jr2 runs` lists "charted/loop (chart)" under its wrapper
      And the listing shows "charted/loop" inside its wrapper's entry, not beside it
      When I start "charted/loop" against the stub harness with a task
      Then the run's body is in state "draft"
      When the host-booted orchestrator restarts
      Then `jr2 runs` lists "charted/loop (chart)" under its wrapper
      And the run's body is in state "draft"
      When I delete the Chart "charted/loop"
      Then the answer is 204
      And `jr2 runs` does not list "charted/loop"
      When the Chart's "coder" picks "submit"
      Then the run's body is in state "review"

    Scenario: a Chart is refused with no Chart wrapper, with no Chart door, and when it does not admit
      When I put the "review-loop" Chart as "review/loop"
      Then the answer is 409 naming "is no Chart wrapper"
      When I put the "review-loop" Chart as "planner/loop"
      Then the answer is 409 naming "has no Chart door"
      When I put the "bad-src" Chart as "charted/bad"
      Then the answer is 422 naming "linter"

  Rule: a Chart file is the Assembly's own, and a publish re-admits every named Chart
    A Chart file that a publish breaks refuses the publish, naming the file. A runtime Chart that a
    publish breaks is someone else's: the publish lands, and the Chart is kept and listed unrunnable.

    Scenario: a Chart file runs by name, refuses a publish that breaks it, and a runtime Chart goes unrunnable
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the orchestrator is serving
      When I add the "review-loop" Chart as the Chart file "charted/sample" and publish
      Then the publish lists "charted/sample"
      And `jr2 runs` lists "charted/sample (chart file)" under its wrapper
      When I start "charted/sample" against the stub harness with a task
      Then the run's body is in state "draft"
      When I publish "charted" lending no "coder"
      Then the publish is refused naming "charted/sample.chart.json"
      When I remove the Chart file "charted/sample"
      And I put the "review-loop" Chart as "charted/loop"
      And I publish "charted" lending no "coder"
      Then the publish lands and names "charted/loop" unrunnable
      And the listing shows "charted/loop" unrunnable, naming "coder"
      When I start "charted/loop" by HTTP with a task
      Then the answer is 409 naming "cannot run"

  Rule: a Chart run restores with the text it holds
    D-B: the Chart's text and hash ride the Open body's own snapshot, and restore admits the text
    again against the parts its wrapper lends now. A text that no longer admits is drift, naming
    the body and the refusal.

    Background:
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the orchestrator is serving
      And I start "charted" against the stub harness with the "review-loop" Chart
      And the Chart's "coder" picks "submit"
      And the run's body is in state "review"

    Scenario: a parked Chart run resumes in its state, its Agent re-attached
      When the host-booted orchestrator restarts
      Then the run's body is in state "review"
      And the Chart's "reviewer" has the Allowed picks "approve, revise"
      And the stub Harness admitted the Chart's "reviewer" 1 time
      When the Chart's "reviewer" picks "approve"
      Then the run settles at "done" with the Chart's output '{"rounds":0}'

    Scenario: a Chart run whose held Assembly is edited on the volume to lend less drifts at restore
      When the orchestrator stops, the held Assembly's "charted" lends no "underLimit", and it boots
      Then the boot reports the run as drifted
      And the run's drift reason names the body "body" and "underLimit"
      And the run's Machine names the body "body" as a Chart it cannot draw, naming "underLimit"

  Rule: the Open body's ceilings bound a Chart

    Scenario: a Chart that never ends reaches its Turns ceiling
      Given a fresh instance
      And the instance also has the "charted" workflow
      And the orchestrator is serving
      When I start "charted" against the stub harness with the "endless" Chart
      Then the run settles at "ceiling" with the body's "turns" ceiling
