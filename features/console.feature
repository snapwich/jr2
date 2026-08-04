@console
Feature: The Console in a real browser
  The browser tier (ADR-0010 as amended): a real Chromium, driven by playwright in library form,
  against the same per-scenario orchestrator fixture every other Rule uses — host-booted, no
  docker. Black-box like the rest of the suite, one band up: steps assert what a READER sees in
  the served page, never the page's internals. Tagged @console and excluded from the default
  profile exactly like @kind, because this tier needs a browser binary the everyday gate must not.

  Rule: tokenless, the Console is exactly today's observer
    ADR-0014/0032: the page as served is the open band — structure and observation, no credential
    in the bytes, and no control surface to even decline.

    Scenario: the shell loads, the diagram renders, and no control shows
      Given a fresh instance
      And the orchestrator is serving
      When I open the Console at "/workflows/ping"
      Then the diagram shows the state "responding"
      And the Console offers no start button
      And the Console offers no Attention tab

  Rule: the Instance token unlocks control, and a bad one does not
    ADR-0032: control is earned per tab. The token is validated with a guarded read; "live"
    reveals the control surface, anything else leaves the page exactly the observer it was.

    Background:
      Given a fresh instance
      And the orchestrator is serving

    Scenario: entering the Instance token reveals the control surface
      When I open the Console at "/"
      And I enter the Instance token
      Then the token badge reads "live"
      And the Console offers a start button for "ping"

    Scenario: a wrong token reads invalid and stays observer
      When I open the Console at "/"
      And I enter the token "not-the-token"
      Then the token badge reads "invalid"
      And the Console offers no start button

  Rule: a declared input schema becomes the start-run form
    ADR-0033: the machine declares what a run of it is started with; the Console renders that
    declaration as typed fields and the started run announces itself in the rail.

    Scenario: start a run from the schema-driven form
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the orchestrator is serving
      When I open the Console at "/workflows/intake"
      And I enter the Instance token
      And I open the start form for "intake"
      Then the start form offers a typed "subject" field
      When I submit the start form with "subject" set to "triage the queue"
      Then the rail lists a run of "intake"

  Rule: an open gate gathers as a card, and delivering it moves the run
    ADR-0032: the gate inbox is frame-triggered — a card is a re-fetched fact, and its emptying
    is the SERVER's next answer, never bookkeeping the page did after a delivery.

    Scenario: approve a parked run through its gate card
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness
      And the agent calls "request_review" with summary "PR up"
      When I open the Console at "/workflows/review"
      And I enter the Instance token
      Then the Attention drawer shows a gate card for "review-1"
      When I send "approve" from the gate card
      Then the rail shows the run as "done"
      And the gate inbox reads empty

  Rule: the fold icon folds a child subgraph; the box body only selects
    The ⊞/⊟ icon owns folding; a click anywhere on the box body draws the selected outline and
    nothing else — a reader inspecting a subgraph never collapses it under their own cursor.

    Scenario: clicking the body selects; clicking the icon folds
      Given a fresh instance
      And the instance also has the "workspaced" workflow
      And the orchestrator is serving
      When I open the Console at "/workflows/workspaced"
      Then the diagram shows a child-machine subgraph with states inside
      When I click the child-machine box body
      Then the child-machine box is selected and still unfolded
      When I click the child-machine fold icon
      Then the child-machine subgraph is folded shut
