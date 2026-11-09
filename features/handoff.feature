@kind @handoff
Feature: The Handoff loop in real pods

  A coder and a quick reviewer work in one Workspace. The final review of the coder's commit runs in
  a nested Workspace: a new Sandbox, with a new Agent, which takes the commit as a Handoff at its cut
  (ADR-0080). The parent Harness bundles the handed-off range in the parent Sandbox's domain, the
  Orchestrator carries the bundle and the Git LFS objects that it points to, and the child's cut
  fetches the commit with fsck into its own clone. The run's one Repo is a per-scenario LFS
  repository of the seed over ssh, which both Workspaces bind and the deploy key pushes to
  (`steps/seed.ts`). The `handoff` workflow is in `kind-instance/workflows/handoff.ts`. Only the
  model is scripted.

  Rule: a final review in a nested Workspace takes the coder's commit as a Handoff, and the reviewed commit is published

    Scenario: two rounds of the final review, each in a new nested Workspace, and the parent publishes the reviewed commit, not a later one
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh for the Handoff loop, whose branch the remote has
      When the coder and the quick reviewer loop, a final reviewer asks for changes, a new final reviewer passes the new commit, and the coder commits again
      Then each final reviewer saw ordinary git: the parent's branch, tracking origin's, at the Handoff's commit, with the parent's commits and only origin
      And the coder's large file reached each nested Workspace with its bytes, while no LFS server held it
      And the second round ran in a new Sandbox, at a new Handoff, with the first round's notes
      And the parent pushed exactly the reviewed commit and not the coder's later commit, and the LFS server holds the large file

    Scenario: the nested Workspace publishes the commit that it reviewed
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh for the Handoff loop, whose branch the remote does not have
      When the coder and the quick reviewer loop, and the final reviewer passes the commit in the nested Workspace, which pushes it
      Then the final reviewer saw ordinary git: the parent's branch with no upstream, at the Handoff's commit, with the parent's commits and only origin
      And the coder's large file reached each nested Workspace with its bytes, while no LFS server held it
      And the nested Workspace pushed the Handoff's commit, and the LFS server holds the large file

  Rule: a Handoff that the run's ledger does not hold is refused at the nested cut, and the author routes it

    A Handoff comes through a door, so a pick or a Chart can write each of its fields. The cut finds
    the whole Handoff in the run's ledger: a head that no cut read, or a branch that is not the cut's,
    is `refused`, never `onError`.

    Scenario: a forged head and a forged branch are each refused, and nothing is published
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh for the Handoff loop, whose branch the remote does not have
      When the coder names a commit that no cut read, and the parent hands off that head, and then the branch main
      Then each nested cut is refused with its reason, the nested body routes it, and main on the remote did not move
