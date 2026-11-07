@kind @lfs
Feature: Git LFS in a real pod

  A Repo that stores files with Git LFS, in a real Sandbox with the stock Harness: the node cache gets
  the objects that a pod asks for, by oid, from the LFS server that `.lfsconfig` names at the
  Binding's base (ADR-0051, ADR-0053). The attach and a cut get their commit's large files before they
  check out (ADR-0075), an Agent's own checkout asks through jr2's transfer agent, and a push uploads
  its large files before it moves the branch (ADR-0067). The seed serves an LFS server of its own
  (`steps/seed.ts`), and each scenario makes its own LFS repository on the seed. Only the model is
  scripted.

  Rule: a cut gets its commit's large files, and is refused, naming the file, when one cannot be had

    Scenario: a cut of a branch smudges the large file that its commit holds
      Given the kind instance is serving
      And an LFS repository whose branch holds a large file that main does not
      When the "lfs-cut" workflow cuts the branch
      Then the attach smudged the base's large file in default/
      And the cut is ready, and its Worktree holds the large file's bytes and not its pointer

    Scenario: a cut whose large file the LFS server does not hold is refused, naming the file
      Given the kind instance is serving
      And an LFS repository whose branch names a large file that the LFS server does not hold
      When the "lfs-cut" workflow cuts the branch
      Then the cut is refused, and its reason names the file

  Rule: an Agent's own checkout of another commit smudges, by an ask for each object

    The attach and the cut ask for the large files of the base's commit only. The older commit's file
    comes when git-lfs's smudge asks jr2's transfer agent for it.

    Scenario: an Agent checks out an older commit, and its large file holds that commit's bytes
      Given the kind instance is serving
      And an LFS repository with a large file in each of two commits on main
      When the Agent checks out the older commit in its Worktree
      Then the Agent's Worktree holds the older large file's bytes

  Rule: a push uploads its large files before it moves the branch

    Scenario: a push of a commit with a new large file uploads it, and the LFS server then holds it
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh with a large file on main
      When the Agent commits a new large file and the Machine pushes it
      Then the push is pushed, the remote holds the branch, and the LFS server holds the object

  Rule: the measurements

    How long a cold attach of large files takes, from the Sandbox's Ready to the body's first Gate, and
    how long a cut takes with an ask for its large file and with none. `JR2_LFS_COLD_MB` sets the base's
    size (64 MiB by default) and `JR2_LFS_CUT_MB` the branch's file (16 MiB by default). The numbers go
    to `features/.tmp/lfs-measure-<MiB>.json`.

    Scenario: a cold attach of large files, and a cut's ask for one
      Given the kind instance is serving
      And an LFS repository whose base holds large files of the size that JR2_LFS_COLD_MB names
      When the "lfs-cut" workflow cuts the branch
      Then the cold attach and the cut's ask are reported
