@console
Feature: The Console in a real browser
  The browser tier (ADR-0010 as amended): a real Chromium, driven by playwright in library form,
  against the same per-scenario orchestrator fixture every other Rule uses — host-booted, no
  docker except for the login's issuer (@dex). Black-box like the rest of the suite, one band up:
  steps assert what a READER sees in the served page, never the page's internals. Tagged @console
  and excluded from the default profile exactly like @kind, because this tier needs a browser
  binary the everyday gate must not.

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
    ADR-0032: control is earned per tab. The token is validated with `GET /whoami`; "live"
    reveals what its scopes allow, anything else leaves the page exactly the observer it was.

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

  Rule: the Machine's seats say who may send what, per state
    ADR-0015: the load walk computes each party's seat, the Machine's doc carries it, and the
    Console shows it beside the diagram — the same lines `jr2 up` prints. Structure, so tokenless.

    Scenario: the review workflow shows its Agent's seat and its Gate's
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator is serving
      When I open the Console at "/workflows/review"
      And I open the seats
      Then the seats show "review.working" as "agent:coder" sending "request_review"
      And the seats show "review.humanReview" as "gate" sending "approve"

  Rule: the page shows only what the Caller's scopes allow
    ADR-0032, ADR-0078: the page asks `GET /whoami` what its credential may do, and renders a
    control only where a scope opens it. A token that may answer one Workflow gets that Workflow's
    Gate cards and no start button. The nav names who the page acts as.

    Scenario: a token that may only answer sees the Gate card and no start button
      Given a fresh instance
      And the instance also has the "review" workflow
      And the instance declares the Caller token "approver" that may answer "review"
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness
      And the agent calls "request_review" with summary "PR up"
      When I open the Console at "/workflows/review"
      And I enter the Caller token "approver"
      Then the Console acts as "token/approver"
      And the Attention drawer shows a gate card for "review-1"
      And the Console offers no start button

  Rule: a person logs in at the Instance's issuer
    ADR-0032, ADR-0078: the Console logs a person in with OIDC (the code flow with PKCE, as a
    public client) against an issuer the config offers a login at, and sends the JWT as it sends a
    typed token. The scopes come from the person's groups. Dex runs in a container, so this
    scenario also needs docker.

    @dex
    Scenario: a login gives the page the person's scopes, and signing out gives them back
      Given a fresh instance
      And a Dex issuer is running
      And the instance offers a login at that issuer, where the group "authors" may start, answer and read every Workflow
      And the orchestrator is serving
      When I open the Console at "/workflows/ping"
      And I log in at the issuer
      Then the Console acts as "kilgore@kilgore.trout"
      And the token badge reads "live"
      And the address is "/workflows/ping"
      And the Console offers a start button for "ping"
      When I sign out
      Then the Console offers no start button

  Rule: the inbox is the Gates that GET /gates gives this Caller, each with when it opened
    ADR-0011, ADR-0032, ADR-0078: the Gate cards come from the Gate inbox, so a Caller whose
    `answer` scope names one Gate of a Workflow sees that Gate's card and no other.

    Scenario: a token that may answer the legal Gate sees its card, and not the security Gate's
      Given a fresh instance
      And the instance also has the "signoff" workflow
      And the instance declares the Caller token "legal" with scopes '{"answer": [{"workflow": "signoff", "gates": ["legal"]}], "read": ["signoff"]}'
      And the orchestrator is serving
      And I start the "signoff" workflow detached
      When I open the Console at "/workflows/signoff"
      And I enter the Caller token "legal"
      Then the Attention drawer shows a gate card for "L-1"
      And the gate card for "L-1" says when it opened
      And the Attention drawer shows no gate card for "S-1"

  Rule: the rail lists the selected Workflow's ended runs under its live runs
    ADR-0032: with `read`, the rail shows the runs that `GET /runs?status=ended` lists for the
    Workflow, each with its status, under a heading.

    Scenario: a run that ended is listed as ended, with its status
      Given a fresh instance
      And the orchestrator is serving
      And I run "ping" with message "hi"
      When I open the Console at "/workflows/ping"
      And I enter the Instance token
      Then the rail lists the ended runs of "ping" under their heading
      And the rail shows the run as "done"

  Rule: the bottom drawer shows an Agent's conversation
    ADR-0023, ADR-0032: closed, the bottom drawer is a tab for each Agent slot of the selected run,
    with a dot while a Turn is open. Open, it shows the slot's kept conversation, and follows it.

    Scenario: the coder's tab opens its conversation, and a new entry appears in it
      Given a fresh instance
      And the instance also has the "review" workflow
      And the orchestrator signs its tokens with a key that this scenario holds
      And the orchestrator is serving
      And I start the "review" workflow against the stub harness in the pod "ws-review-0"
      And the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text                     |
        | prompt | Do the work.             |
        | text   | I will add the greeting. |
      When I open the Console at "/workflows/review"
      And I enter the Instance token
      And I select that run in the rail
      Then the bottom drawer has a tab for "root/coder" with a live dot
      When I open the bottom drawer tab "root/coder"
      Then the conversation shows "I will add the greeting."
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind | text           |
        | text | A second line. |
      Then the conversation shows "A second line."
