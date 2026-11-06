Feature: Kept conversations
  ADR-0023, ADR-0065. The Harness writes each entry of a conversation locally first, and sends
  batches to the Orchestrator during the Turn, through its Custodian, with its pod's control token
  and the slot. The Orchestrator keeps them in `conversations.db` for as long as it keeps the run,
  and each entry once. `GET /runs/:runId/conversations` lists a run's conversations; `jr2 logs`
  prints them as the Harness prints them, every Agent interleaved by time, or one Agent, and `-f`
  follows them.

  There is no pod here. The `review` fixture places its Turn in a pod by name, so the run's
  admission ledger names that pod and the slot, and the steps play that pod's Harness: they send
  each batch with the control token that the pod's Custodian puts in place of its Stand-in. A real
  Harness sends its conversation in the `@kind` tier.

  Background:
    Given a fresh instance
    And the instance also has the "review" workflow
    And the orchestrator signs its tokens with a key that this scenario holds
    And the instance declares the Caller token "ci" that may start and read "ping"
    And the orchestrator is serving
    And I start the "review" workflow against the stub harness in the pod "ws-review-0"

  Rule: the Harness's batches are kept once each, and jr2 logs prints them

    Scenario: a batch is kept, a batch sent again adds nothing, and jr2 logs prints the entries
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text                                   |
        | prompt | Do the work, then call request_review. |
        | text   | I will add the greeting.               |
        | bash   | $ ls                                   |
      Then the Orchestrator kept 3 entries
      When the Harness of pod "ws-review-0" sends the same batch again
      Then the Orchestrator kept 0 entries
      And the run lists one conversation of "coder" in the slot "root/coder", open
      When I read the run's conversations with jr2 logs
      Then jr2 logs prints the coder's entries in order
      When I read the run's conversations of "root/coder" with jr2 logs
      Then jr2 logs prints the coder's entries in order
      When I read the run's conversations of "coder" with jr2 logs
      Then jr2 logs prints the coder's entries in order

    Scenario: an Agent the run does not have is refused, naming the run's Agents
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text   |
        | prompt | Do it. |
      And I read the run's conversations of "reviewer" with jr2 logs
      Then the command exits 1
      And stderr names "root/coder"

    Scenario: a Caller with no read scope for the run's Workflow is refused
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text   |
        | prompt | Do it. |
      And the Caller "ci" reads the run's conversations with jr2 logs
      Then the command exits 1
      And stderr says the Caller "token/ci" needs the "read" scope for Workflow "review"

  Rule: only the Harness of the conversation's pod writes it

    Scenario Outline: a batch from any other token is refused
      When <who> sends a batch of the coder's conversation
      Then the batch is refused with <status>

      Examples:
        | who                                                | status |
        | the Instance token                                 | 403    |
        | the Harness of pod "ws-other-0"                    | 403    |
        | the Harness of pod "ws-review-0" as "root/planner" | 403    |

    Scenario: a batch for a run that the Orchestrator does not know is refused
      When the Harness of pod "ws-review-0" sends a batch for the conversation "r-nope/root/coder"
      Then the batch is refused with 404

  Rule: the conversation outlives the Turn and the run

    Scenario: after the run ends, the conversation is kept, a late batch is kept, and jr2 logs prints it
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text                     |
        | prompt | Do the work.             |
        | text   | Done. Asking for review. |
      And the agent calls "request_review" with summary "PR up"
      And I deliver "approve" to gate "review-1"
      Then the run's status shows "done"
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind                  | text                         |
        | request_review answer | Delivered: the turn is over. |
      Then the Orchestrator kept 1 entries
      And the run lists one conversation of "coder" in the slot "root/coder", not open
      When I read the run's conversations with jr2 logs
      Then jr2 logs prints the coder's entries in order
      And the command exits 0

  Rule: the conversation outlives the Orchestrator process

    Scenario: after a restart, jr2 logs prints the kept entries, and the restored run places a new batch
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text                     |
        | prompt | Do the work.             |
        | text   | I will add the greeting. |
      And the host-booted orchestrator restarts
      And I read the run's conversations with jr2 logs
      Then jr2 logs prints the coder's entries in order
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind | text               |
        | text | After the restart. |
      Then the Orchestrator kept 1 entries
      When I read the run's conversations with jr2 logs
      Then jr2 logs prints the coder's entries in order

  Rule: jr2 logs -f follows a conversation until the run ends

    Scenario: a followed conversation prints each new entry, and the follow ends with the run
      When the Harness of pod "ws-review-0" sends the coder's entries:
        | kind   | text         |
        | prompt | Do the work. |
      And I follow the run's conversations with jr2 logs -f while the coder says "a new line" and the run ends
      Then the command exits 0
      And jr2 logs prints the coder's entries in order
