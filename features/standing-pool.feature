Feature: a Hook brings items to a standing Pool of runs

  A Hook (ADR-0078) never starts a run. It reaches a Pool's Source through the Pool's `source` Gate
  (ADR-0017): a handler carries an item (`carry`), asks the Source to read again (`reread`), or
  brings nothing (`skip`). A standing Pool of runs holds each carried item in its run's blob and
  claims it under `cap`: one run of the callee Workflow per item, keyed by the item's id in that
  Workflow. jr2 keeps the Pool's run: it starts it at the publish, keeps it at a restart, hands it
  over at the next publish, and a cancel pauses it until `jr2 run` resumes it. The alert service's Hook has a `token` verifier; the Discord Hook has `ed25519`. The read
  Source reads with a promise, because this tier has no Instance Effector.

  Background:
    Given a fresh instance
    And the instance declares the alert service's Hook and a Discord Hook

  Rule: a push Source starts one run per alert, and a repeat starts nothing

    Background:
      Given the instance also has the "alerts" workflow
      And the instance also has the "triage" workflow
      And the orchestrator is serving
      And the standing Pool "alerts" runs

    Scenario: each alert starts one run; a repeat delivery, a repeat alert, a low level and a wrong token start nothing
      When the alert service sends the alert "4471" at level "error" as delivery "d-1"
      Then the answer is 200 and the Source verdict is "held" with key "alert-4471"
      And the live "triage" runs have the keys "alert-4471"
      And the "triage" run with the key "alert-4471" names the delivery "d-1" of the Hook "sentry"
      When the alert service sends the alert "4471" at level "error" as delivery "d-1"
      Then the answer says that the delivery was seen before
      When the alert service sends the alert "4471" at level "error" as delivery "d-2"
      Then the answer is 200 and the Source verdict is "existing" with key "alert-4471"
      When the alert service sends the alert "4472" at level "warning" as delivery "d-3"
      Then the answer is 200 and the Source verdict is "skipped"
      When the alert service sends the alert "4473" with a wrong token
      Then the Hook's answer is 401
      And the store holds exactly 1 "triage" runs, one for each key

    Scenario: a restart with live runs and held items loses nothing and starts nothing twice
      When the alert service sends 10 different alerts
      Then 8 "triage" runs are live and the "alerts" Pool holds 2 items
      When the host-booted orchestrator restarts
      Then the same 8 "triage" runs are live and the "alerts" Pool holds 2 items
      When 2 of the live "triage" runs finish
      Then 8 "triage" runs are live and the "alerts" Pool holds 0 items
      And the store holds exactly 10 "triage" runs, one for each key

    Scenario: a publish hands the run over with its held items; a cancel pauses the Pool until `jr2 run` resumes it
      When the alert service sends 10 different alerts
      Then 8 "triage" runs are live and the "alerts" Pool holds 2 items
      When another Workflow is published beside it
      Then jr2 handed the "alerts" run over: the old run ended done, and the new run was started for a "hand-over"
      And the same 8 "triage" runs are live and the "alerts" Pool holds 2 items
      When the "alerts" run is cancelled
      Then `jr2 status` prints the "alerts" Pool as paused with 2 held items
      When the alert service sends the alert "4480" at level "error" as delivery "p-1"
      Then the answer is 200 and the Source verdict is "paused"
      When `jr2 run alerts` resumes the Pool
      Then the new "alerts" run was started for a "resume", names the Caller that resumed it, and holds 2 items
      And the same 8 "triage" runs are live and the "alerts" Pool holds 2 items
      And `jr2 run alerts` is refused while the Pool is live

  Rule: a delivery makes a read Source read again; one run per issue, at most 2 live

    Background:
      Given the fake issue API has no issues
      And the instance also has the "issues" workflow
      And the instance also has the "ticket" workflow
      And the orchestrator is serving
      And the standing Pool "issues" runs

    Scenario: the read is the truth, and an issue whose run ended is not started again
      Then the live "ticket" runs have the keys ""
      When the fake issue API has open labeled issues 12, 13 and 14
      And Discord sends the command "recheck" as interaction "i-1"
      Then the person reads "jr2 reads the open issues again." in the Discord answer
      And the live "ticket" runs have the keys "issue-12,issue-13"
      When the live "ticket" run with the key "issue-12" finishes
      Then the live "ticket" runs have the keys "issue-13,issue-14"
      When Discord sends the command "recheck" as interaction "i-2"
      Then the live "ticket" runs have the keys "issue-13,issue-14"
      When Discord sends the command "approve" as interaction "i-3"
      Then the person reads "skipped: /approve is not for the issues Pool." in the Discord answer
      And the store holds exactly 3 "ticket" runs, one for each key

  Rule: a burst of 50 deliveries in about one second

    Background:
      Given the instance also has the "burst" workflow
      And the instance also has the "quick" workflow
      And the orchestrator is serving
      And the standing Pool "burst" runs

    Scenario: each delivery starts a run within the cap; none is lost, and none starts twice
      When the alert service sends 50 different alerts in about one second
      Then every answer is 200 with the Source verdict "held"
      And all 50 "quick" runs end, one for each key, with never more than 4 live at once
      And the store holds exactly 50 "quick" runs, one for each key
