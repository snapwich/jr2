Feature: a Hook's delivery answers a Gate

  A Hook (ADR-0078) is a door for one outside service, at `POST /hooks/<name>`. Its verifier checks
  that a delivery comes from the service; then the kind reads it, the door parses its payload, finds
  a repeat by its id and its digest, and gives it to the open Gates whose handlers hear its kind and
  event key (ADR-0011). The `forge` fixture's review Gate hears four kinds, one for each verifier
  and Slack. This tier has no Instance Effector, so the `mac` check and the follow-up post go to a
  fake one that the scenario serves.

  Background:
    Given a fresh instance
    And the instance also has the "forge" workflow
    And the instance declares a Hook for each verifier
    And the orchestrator is serving
    And I start the "forge" workflow for the pull request "https://gitlab.example.com/pr/7"
    And the run's status shows state "inReview"

  Rule: a token Hook compares the digest of its header, and its delivery answers the Gate

    Scenario: the right token delivers, and the run records the Hook as the Caller
      When GitLab sends the delivery "gl-1" that "ann" approved "https://gitlab.example.com/pr/7" to the Hook "gitlab"
      Then the outcome delivered "approve" to the run
      And the run was answered by the Hook "gitlab" on behalf of "ann"

    Scenario: a wrong token gets 401, and the run waits
      When GitLab sends the delivery "gl-1" with a wrong token to the Hook "gitlab"
      Then the door answers 401
      And the run's status shows state "inReview"

    Scenario: a Hook reaches only the Workflows that its may.answer names
      When GitLab sends the delivery "gl-1" that "ann" approved "https://gitlab.example.com/pr/7" to the Hook "elsewhere"
      Then the outcome delivered nothing
      And the run's status shows state "inReview"

  Rule: the door parses the payload before the repeat check, and finds a repeat by its id and its digest

    Scenario: a payload that the parse refuses is 200, reaches no Gate, and is parsed again when it comes again
      When GitLab sends the delivery "gl-2" with an approval that has no url to the Hook "gitlab"
      Then the outcome says the parse refused the "gitlab" payload "merge_request.approved"
      When GitLab sends the delivery "gl-2" with an approval that has no url to the Hook "gitlab"
      Then the outcome says the parse refused the "gitlab" payload "merge_request.approved"
      And the run's status shows state "inReview"

    Scenario: a delivery that comes again is seen, and the log keeps both
      When GitLab sends the delivery "gl-3" that "ann" approved "https://gitlab.example.com/pr/9" to the Hook "gitlab"
      Then the outcome delivered nothing
      When GitLab sends the delivery "gl-3" that "ann" approved "https://gitlab.example.com/pr/9" to the Hook "gitlab"
      Then the outcome says the delivery was seen
      And `jr2 hooks gitlab` shows the lines "seen, delivered"

  Rule: an ed25519 Hook checks the signature over the timestamp and the body, within 300 seconds

    Scenario: a PING gets its PONG, and a signed command answers the Gate
      When Discord sends a PING
      Then the door answers 200 with the body "{\"type\":1}"
      When Discord sends the command "i-1" by "u-42" to approve "https://gitlab.example.com/pr/7"
      Then the person reads "https://gitlab.example.com/pr/7 is approved by u-42." in Discord's ephemeral answer
      And the run was answered by the Hook "discord" on behalf of "u-42"

    Scenario: another key, or a time out of the window, gets 401
      When Discord sends the command "i-2" signed by another key
      Then the door answers 401
      When Discord sends the command "i-3" signed 600 seconds ago
      Then the door answers 401
      And the run's status shows state "inReview"

  Rule: a mac Hook's check goes to the Instance Effector, which holds the secret

    Scenario: a ping is a handshake, and a signed review answers the Gate
      When GitHub sends a ping
      Then the door answers 200
      When GitHub sends the delivery "gh-1" that "bo" approved "https://gitlab.example.com/pr/7"
      Then the outcome delivered "approve" to the run
      And the Instance Effector checked the raw body of the review
      And the run was answered by the Hook "github" on behalf of "bo"

    Scenario: a review signed with another secret gets 401
      When GitHub sends the delivery "gh-2" signed with another secret
      Then the door answers 401
      And the run's status shows state "inReview"

  Rule: a person reads the answer to a chat command or click, in the kind's envelope

    Scenario: a Slack command gets the Gate's reply as an ephemeral text
      When Slack sends the command "t-1" by "U1" with the text "approve https://gitlab.example.com/pr/7"
      Then the person reads "https://gitlab.example.com/pr/7 is approved by U1." in Slack's ephemeral answer
      And the run was answered by the Hook "slack" on behalf of "U1"

    Scenario: a Slack command that reaches nothing gets the door's own text
      When Slack sends the command "t-2" by "U1" with the text "approve https://gitlab.example.com/pr/8"
      Then the person reads "Nothing in jr2 waits for this now." in Slack's ephemeral answer
      And the run's status shows state "inReview"

    Scenario: a Slack click gets an empty 200, and its reply goes to its response_url after the answer
      When Slack sends the click "t-3" by "U2" on approve "https://gitlab.example.com/pr/7" with the response url "https://hooks.slack.com/actions/T1/1/x"
      Then the Instance Effector posts "https://gitlab.example.com/pr/7 is approved by U2." to "https://hooks.slack.com/actions/T1/1/x"
      And the run was answered by the Hook "slack" on behalf of "U2"
