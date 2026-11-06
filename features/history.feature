Feature: Run history
  ADR-0009, ADR-0065. `GET /runs` lists the live runs and, on request, the ended runs that jr2 keeps
  (`runs.retain`, 30 days by default). Each run is a summary, never its context. The newest start
  is first, and a cursor gives the next page. `jr2 runs` reads every page and prints the summaries
  as one array. A Caller with `read` on some Workflows sees only their runs.

  Rule: the status filter chooses live runs, ended runs, or a list of statuses

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: live by default, ended on request, and all of them newest first
      When I start the "loop" workflow detached
      And I run "ping" with message "hi"
      And I list the runs
      Then the runs list is exactly "loop"
      When I list the runs with "--status ended"
      Then the runs list is exactly "ping"
      When I list the runs with "--status all"
      Then the runs list is exactly "ping, loop"

    Scenario: a list of statuses chooses each of them, and nothing else
      When I start the "loop" workflow detached
      And I cancel the run and it ends
      And I run "ping" with message "hi"
      And I list the runs with "--status cancelled"
      Then the runs list is exactly "loop"
      When I list the runs with "--status done,cancelled"
      Then the runs list is exactly "ping, loop"

  Rule: a summary names the run, never its context

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: an ended run's summary has its start, its end and the Assembly it ran under
      When I run "ping" with message "hi"
      And I read the ended runs over HTTP
      Then each summary has only the summary fields
      And the summary of that run has a start, an end and the current Assembly, and 0 open Gates

  Rule: a page is at most the limit, and its cursor gives the next page

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: three ended runs read two at a time
      When I run "ping" with message "one"
      And I run "ping" with message "two"
      And I run "ping" with message "three"
      Then the 3 ended runs read 2 at a time come in 2 pages, newest first, each run once

  Rule: a query the Orchestrator cannot read is refused, naming what it cannot read

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario Outline: a bad filter is a 400 that names it
      When I read the runs over HTTP with "<query>"
      Then the read is refused with 400 naming "<named>"

      Examples:
        | query           | named     |
        | status=finished | finished  |
        | since=yesterday | yesterday |
        | limit=0         | limit     |

    Scenario: jr2 runs relays the refusal
      When I list the runs with "--status finished" expecting a refusal
      Then the command exits 1
      And stderr names "finished"

  Rule: a Caller reads only the runs of the Workflows it may read
    Scenario: a token with read on ping does not see the loop's runs
      Given a fresh instance
      And the instance also has a long-running workflow
      And the instance declares the Caller token "ci" that may start and read "ping"
      And the orchestrator is serving
      When I start the "loop" workflow detached
      And I cancel the run and it ends
      And I run "ping" with message "hi"
      And the Caller "ci" lists the runs with "--status all"
      Then the runs list is exactly "ping"

  Rule: the config keeps ended runs for a set time, and refuses a time it cannot keep
    ADR-0065: `runs: { retain, volume }`. `retain` is at least 1h and has no upper limit; `volume` is a
    storage quantity. The door refuses an Assembly whose config it cannot read.

    Background:
      Given a fresh instance
      And the instance also has a long-running workflow
      And the orchestrator is serving

    Scenario: a config that keeps runs for 90 days publishes
      When the instance's config sets runs to '{ retain: "90d", volume: "10Gi" }'
      And I publish the Assembly again
      Then the publish lands

    Scenario Outline: a time or a size that jr2 cannot keep refuses the publish
      When the instance's config sets runs to '<runs>'
      And I publish the Assembly expecting a refusal
      Then the publish is refused naming "<named>"
      And the publish is refused naming "<why>"

      Examples:
        | runs                  | named       | why                       |
        | { retain: "30m" }     | runs.retain | shorter than 1h           |
        | { retain: "forever" } | runs.retain | is not a duration         |
        | { volume: "lots" }    | runs.volume | is not a storage quantity |
        | { keep: "30d" }       | runs.keep   | not a field               |
