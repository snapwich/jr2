@kind @lfs
Feature: Git LFS in a real pod

  A Repo that stores files with Git LFS, in a real Sandbox with the stock Harness: the node cache gets
  the objects that a pod asks for, by oid, from the LFS server that `.lfsconfig` names at the
  Binding's base, never from what a pod names (ADR-0051, ADR-0053). The attach and a cut get their
  commit's large files before they check out (ADR-0075), an Agent's own checkout asks through jr2's
  transfer agent, and a push uploads its large files before it moves the branch (ADR-0067). The seed
  serves an LFS server of its own, and its ssh seat speaks the pure SSH protocol (`steps/seed.ts`).
  Each scenario makes its own LFS repository on the seed. Only the model is scripted.

  Rule: a cut gets its commit's large files, and is refused, naming the file, when one cannot be had

    Scenario: a cut of a branch smudges the large file that its commit holds
      Given the kind instance is serving
      And an LFS repository whose branch holds a large file that main does not
      When the "lfs-cut" workflow cuts the branch
      Then the attach smudged the base's large file in default/
      And the cut is ready, and its Worktree holds the large file's bytes and not its pointer

    Scenario: a cut whose large file the LFS server does not hold is refused, naming the file, and changes nothing
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

  Rule: the LFS server of an ask is the one that `.lfsconfig` names at the Binding's base, never one that the pod names

    The Orchestrator puts the Binding's base in each mark, and ignores a base that the pod sends. So
    an Agent that sends its own base in an ask, or checks out a branch whose `.lfsconfig` names
    another LFS server, cannot point the cache agent at that server: the cache agent asks the
    Binding's base's server, which does not hold the object, and the checkout fails.

    Scenario: an Agent that names another base in its own ask and checks out a branch whose .lfsconfig names another server gets nothing from that server
      Given the kind instance is serving
      And an LFS repository with two commits on main, and a branch whose .lfsconfig names another LFS server that holds its large file
      When the Agent names that branch as the base of its own ask to the Custodian, and checks the branch out in its Worktree
      Then the cache agent asked the Binding's base's LFS server for the branch's object, and the other LFS server got no request

  Rule: a push uploads its large files before it moves the branch

    The push checks with a download batch that the server holds each object, and takes an object that
    the server holds with no local copy, also from a server that gives an upload action for an object
    that it holds (the batch API lets a server do so). An LFS server that speaks only the pure SSH
    protocol (git-lfs-transfer) serves both ways: the cache agent downloads from it, and the push
    uploads to it and checks it after the upload.

    Scenario: a push of a commit with a new large file uploads it, and the LFS server then holds it
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh with a large file on main
      When the Agent commits a new large file and the Machine pushes it
      Then the push is pushed, the remote holds the branch, and the LFS server holds the object

    Scenario: a push of a pointer whose object only the LFS server holds is pushed, with no upload
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh whose LFS server gives an upload action also for an object it holds, and a large file that only that server holds
      When the Agent commits that file's pointer with no local copy, and the Machine pushes it
      Then the push is pushed, and the LFS server got no upload

    Scenario: an LFS server that speaks only the pure SSH protocol gets a push's large file
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      And an LFS repository over ssh whose LFS server speaks only the pure SSH protocol, with a large file on main
      When the Agent commits a new large file and the Machine pushes it
      Then the push is pushed, the remote holds the branch, and the LFS server holds the object
      And the attach got the base's large file, and the cache agent, the upload and the check after it spoke git-lfs-transfer

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
