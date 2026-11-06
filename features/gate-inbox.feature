Feature: The Gate inbox
  ADR-0011, ADR-0078. `GET /gates` lists the open Gates across the live runs that the Caller may
  answer, oldest first, each with when it opened and never with the run's context. `jr2 gates`
  prints that list. A Caller's `answer` scope names whole Workflows, or single Gates of a Workflow
  (`{ workflow, gates }`): such a Caller sees and answers only those Gates, and a Gate's name is its
  invoke id. The door refuses a Gate name that no Machine of the Workflow has.

  Rule: the inbox lists the open Gates of every live run, oldest first, never a context

    Background:
      Given a fresh instance
      And the instance also has the "intake" workflow
      And the instance also has the "signoff" workflow
      And the orchestrator is serving

    Scenario: two runs' Gates, oldest first, and one Workflow's
      When I start "intake" with input '{"subject": "x"}'
      And I start the "signoff" workflow detached
      And I list the Gates
      Then the Gate list is exactly "intake:finish, signoff:L-1, signoff:S-1"
      And each Gate entry has its run, its Workflow, its accepted events, its meta and when it opened, and no context
      When I list the Gates with "--workflow signoff"
      Then the Gate list is exactly "signoff:L-1, signoff:S-1"

    Scenario: an answered Gate leaves the inbox
      When I start the "signoff" workflow detached
      And I answer Gate "L-1" with "clear"
      Then the command exits 0
      When I list the Gates
      Then the Gate list is exactly "signoff:S-1"
      When I answer Gate "S-1" with "pass"
      And I list the Gates
      Then the Gate list is exactly ""
      And the run's status shows "done"

  Rule: a Caller that may answer one Gate of a Workflow sees and answers that Gate only

    Background:
      Given a fresh instance
      And the instance also has the "signoff" workflow
      And the instance declares the Caller token "legal" with scopes '{"answer": [{"workflow": "signoff", "gates": ["legal"]}], "read": ["signoff"]}'
      And the instance declares the Caller token "ci" that may start and read "signoff"
      And the orchestrator is serving

    Scenario: the legal team's token lists and answers the legal Gate, and is refused the security Gate
      When I start the "signoff" workflow detached
      And the Caller "legal" lists the Gates
      Then the Gate list is exactly "signoff:L-1"
      And the Caller "legal" reads the run's Gates as exactly "L-1"
      When the Caller "legal" answers Gate "S-1" with "pass"
      Then the command exits 1
      And stderr says the Caller "token/legal" needs the "answer" scope for Gate "security" of Workflow "signoff"
      When the Caller "legal" answers Gate "L-1" with "clear"
      Then the command exits 0

    Scenario: a Caller with no answer scope cannot read the inbox
      When the Caller "ci" lists the Gates
      Then the command exits 1
      And stderr says the Caller "token/ci" has no "answer" scope for any Workflow

  Rule: the door refuses a Gate name that the Workflow does not have

    Scenario: a typo in a Gate name refuses the publish and lists the Workflow's Gates
      Given a fresh instance
      And the instance also has the "signoff" workflow
      And the instance declares the Caller token "legal" with scopes '{"answer": [{"workflow": "signoff", "gates": ["legall"]}]}'
      When the orchestrator boots and I publish the Assembly
      Then the publish is refused naming "Workflow \"signoff\" has no Gate \"legall\""
      And the publish is refused naming "\"legal\", \"security\""
