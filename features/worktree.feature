@kind @worktree
Feature: Worktrees in a real pod

  Each way that a Machine uses a Worktree (ADR-0075), in a real Sandbox with the stock Harness, the
  real cut on the runtime volume, the real ext:: fetch through the node cache, and a real push remote.
  Only the model is scripted.

  Rule: each scenario runs to its end in a pod

    Scenario Outline: scenario <id>
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      When the worktree scenario "<id>" runs
      Then the worktree scenario "<id>" held

      Examples:
        | id |
        | s1 |
        | s2 |
        | s3 |
        | s4 |
        | s5 |
        | s6 |
        | s7 |
        | s8 |
        | s8b |
        | s9 |
        | removed |

  Rule: a cut survives a kill and a dead remote

    A kill stops a cut in the middle: its folder and its admin entry exist, and the entry has no index yet.
    A dead remote is a repository that is gone after the attach.

    Scenario Outline: <what>
      Given the kind instance is serving
      When the worktree scenario "<id>" runs
      Then the worktree scenario "<id>" held

      Examples:
        | id           | what                                                                        |
        | kill-cut     | a kill of the cut's processes, then the next cut repairs it                 |
        | kill-harness | a kill of the Harness, then the cut goes again under its id                 |
        | dead         | a dead remote, then a held name is cut `stale` and a new name is `refused` |

  Rule: the measurements

    Scenario Outline: concurrent coders on a large repo, a moving remote, the real coalescer (<coders>)
      Given the kind instance is serving
      When the Worktree load runs with <coders> coders for 90 seconds
      Then the Worktree load is reported

      Examples:
        | coders |
        | 4      |
        | 8      |
