# A nested Workspace takes a Handoff at its cut

The Sandbox is the security boundary
([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)). Inside one Sandbox the Agents
have free rein, and jr2 separates only their identities
([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). So a coder and a reviewer in
one Workspace are a quick loop, not an independent review: the coder can change each file, each object of the clone and
each Worktree that the reviewer reads. A final review that the author can trust needs a new Agent in a new Sandbox,
which sees the commit under review and nothing else of the coder's Sandbox.

A nested `workspace()` gives the new Sandbox: the body invokes it, and it ends when its parent stops it
([ADR-0012](0012-workspace-wrapper-machine.md)). Before this decision, the commit could reach it only through the
remote: the coder pushed its branch and the review cut the pushed commit. That publishes work before its review, and it
needs a push for each round. This decision carries the commit from the parent Sandbox to the nested one through jr2,
with no remote. A design panel wrote five prototypes of the surface. A spike tested a git server between the Sandboxes
on real files (Considered options), and a probe tested the bundle range.

## Decision

### The surface

- **A Handoff is plain data: the parent cut's `WorktreeReady`.** `{ slot, path, branch, head }`, as a `ready` cut of a
  Worktree gives it ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). The parent Machine
  passes it to the nested Workspace through the door, as each other input. There is no `handoff()` Effect, no seal and
  no extra parent state. `@jr2/orchestrator` exports `handoff`, the schema of a Handoff, for a door's input.
- **The commit enters the nested Workspace only at its cut.** `worktree()` gets a third arm:

  ```ts
  { path: "/work/app/final", handoff, branch?: "fix/123" }   // a branch Worktree at the Handoff's commit
  ```

  The child's Workspace clones the real Repo, as each Workspace does, and its attach knows nothing of the Handoff. The
  cut makes a branch Worktree at `handoff.head`. The branch is `branch ?? handoff.branch`, so by default it has the
  parent's name. It tracks `origin/<branch>` when the clone holds that branch. `found` is `"handoff"`. A re-cut of the
  path with the same Handoff is `held`, and a re-cut with another Handoff is `refused`. The child's Harness decides
  these from its own record of the path, as for each re-cut (ADR-0075): two rounds' nested Workspaces can share one
  Sandbox name ([ADR-0064](0064-a-workspace-waits-for-capacity.md)), so the run's ledger cannot tell their cuts apart.

- **The slot's `expect` applies to the child's branch**, as at a branch cut (ADR-0075). The Handoff's head sets what the
  branch holds, and `expect` says whether the name can exist. A push in the child publishes to the child's branch, and a
  Chart or a pick can name that branch through `branch`. With `expect: "new"`, the cut refuses a name that the remote
  has, so such a name cannot reach an existing branch. The door's rules for a lent cut (ADR-0075, "A Chart") thus hold
  for a cut at a Handoff too.
- **Each round leaves the state that invoked the last one.** A parent that leaves the state stops the nested Workspace,
  and the host deletes its Sandbox before the next round places one of the same name (ADR-0012, ADR-0064). A parent that
  invokes the nested Workspace again from the same state, in one transition (for example `reenter: true`), stops the old
  one and starts the new one in one step. The new one then takes over the old Sandbox, as a re-invoke after a caught
  defect does. Its cut with a new Handoff is `refused`, and its cut with the same Handoff is `held`: it gets the last
  round's Worktree, with the commits of the last reviewer. Such a round is not independent. So a Machine goes through
  another state between two rounds, for example the parent's coding state.

- **jr2 trusts no field of a Handoff.** A Handoff comes through a door, and a door's input can come from an Agent's pick
  or a Chart. So the cut finds the whole Handoff in the run's ledger, and refuses it when one fact does not agree:
  - the run is the child's own run. A dispatched run has its own ledger and no enclosing Workspace
    ([ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)), so a Handoff never crosses a dispatch;
  - the Workspace whose cut made the row encloses the child. The child's own Workspace, a sibling and a Workspace of
    another run are refused;
  - the source slot's Repo is the child slot's Repo;
  - a settled `ready` cut of `path` in that Workspace has `head` as its head. An earlier `ready` cut of the path is also
    good, so a Machine can hand off a commit on which the coder has since built: the author pins the publish to the
    reviewed commit (below);
  - `branch` is that row's branch. Without this check a Chart could forge `main`, and a signed push in the child would
    publish to `main`;
  - the child's branch is a name. A detached Handoff (`branch: null`) needs `branch` in the cut's input;
  - the child's clone has no local branch of that name at another commit. The child's Harness checks this one at the
    cut, as it checks each name of a cut (ADR-0075).

  Each of these is the Agent's word, so each settles as `refused`, with a reason, and changes nothing. A bad Handoff
  never goes to `onError`
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)), and the Machine
  routes it, for example to `fail()`
  ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)). These checks are for a
  Handoff of the right shape. The shape is checked where an Agent's value enters. The Menu checks a pick against its
  schema, so a pick's Handoff of the wrong shape never reaches the nested door. A Chart is different: the door checks
  only the literal parts of a Chart's `input` at its admission. It refuses a literal Handoff, so a Chart gives a Handoff
  only as a reference, such as `{ "$ref": "context.h" }`, which resolves at the invoke. A wrong shape there is that
  invoke's error, as for each input that a Chart lends ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)). A
  value of the wrong shape that a Machine's own mapper gives settles the cut `refused` when it starts.

- **What the ledger check holds, and what it leaves to the Machine.** The check holds that the commit is the head of a
  `ready` cut in an enclosing Workspace of the run, on that cut's branch. Which of those commits the child takes is the
  Machine's choice: a Handoff that a pick carries lets the Agent choose among them. The `branch` of the cut's input is
  not a ledger fact. It names the child's branch, as the `branch` of a branch arm does (ADR-0075), so a Machine that
  takes it from a pick or a Chart lets the Agent name the branch that a push in the child publishes to. The slot's
  `expect` limits that name, as for a branch arm: with `expect: "new"`, it cannot be a branch that exists. A slot with
  no `expect` limits nothing, and a Chart cannot use such a slot.

- **The cut is the only check.** `jr2 up` does not look at a door that takes a Handoff, and the Orchestrator does not
  look a Handoff up when the parent invokes the nested Workspace. A forged Handoff costs one Sandbox, and the cut
  refuses it.
- **One nested Workspace for each final round.** Each round invokes a new nested Workspace with the newest Handoff. What
  the final reviewer must know of earlier rounds comes in through the door as data, for example the notes of each round.
  The parent and the child end together: a parent that leaves the nested state stops the child, and the host deletes the
  child's Sandbox (ADR-0012).
- **The author chooses where to publish.** `push` stays available in every Workspace, the parent's and the child's.
  `push({ pin: true })` with `{ worktree, sha: handoff.head }` publishes exactly the reviewed commit, in either
  Workspace. jr2 adds no rule for a Worktree that a Handoff made.

### What the final reviewer sees

The child's Agents must not need to know jr2. In the child, git is ordinary:

- `/work/<slot>/default` is the Sandbox's own clone of the real Repo. `origin` is the real remote, which a fetch reaches
  through the node cache ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)).
  `git remote -v` shows only `origin`.
- The Worktree holds an ordinary local branch, at exactly `head`, with the parent's name. When `origin/<branch>` exists,
  `git status` shows ahead and behind.
- `git log` shows the parent Agents' commits, with their authors and messages.
- jr2 leaves no other remote, no `refs/jr2/*` ref and no `FETCH_HEAD`.
- Only `head` and its ancestors enter the child's clone, and only the Git LFS objects that their pointers name enter its
  LFS store. The parent's other branches, its untracked and ignored files, its config and its caches stay in the parent
  Sandbox.

### The transport: a git bundle

- **The parent Sandbox writes a bundle of the handed-off range**: `head` and the ancestors that the parent clone's
  remote-tracking refs do not hold. git writes no bundle for a bare sha, so the step names `head` by a ref in a git
  folder of its own whose alternates are the clone's objects, as the cut does (ADR-0075), and bundles that ref `--not`
  the clone's remote-tracking refs. The source Harness writes it as the cut does: through the spawner, in the Sandbox's
  Landlock domain (ADR-0076), with jr2's cleared env, the cut's pinned config (no hooks, no fsmonitor,
  `core.commitGraph=false`, `core.multiPackIndex=false`, `core.alternateRefsCommand=true`, and the rest of the cut's
  set), a deadline, and a kill of the process group at the deadline. In the domain, the step reads only what an Agent of
  the parent can read itself. The deadline is necessary: in the spike, a FIFO that an Agent planted in the clone held
  git for ever. The bundle is the parent domain's file, so jr2 trusts nothing in it: the child's cut takes from it only
  what the steps below let through.
- **The step also reads the files, as a stream.** In the same step, under the same deadline and kill, a process of the
  domain reads the bundle and each Git LFS object (below) and writes them to its stdout. The spawner sends that output
  to the source Harness as output frames, and the Harness pauses and resumes it as it sends on. The process opens only a
  regular file, so it does not read a FIFO, a device or a link to one. The Harness does not use the spawner's whole-file
  read for a Handoff, and it counts the bytes as they come (the bound, below). A read that an Agent's file holds ends at
  the deadline, as git does. The deadline is 300 s of the step's own time, from its start to its last byte. The clock
  stops while the Harness holds the step paused for a reader that is behind: a slow carry is not a fault of the parent's
  files, so it never makes the cut `refused`.
- **The answer is a stream of frames.** Each frame is one JSON line: a part's header (the bundle first, then each Git
  LFS object by its oid) with its size, `data` frames that hold the part's bytes, and one terminal frame: the end,
  "nothing to carry", `refused` with a reason, or `unknown`. The source Harness writes each frame in its own words from
  what the step wrote, and it ends the stream `refused` at the first header that is out of this form. An Agent can trace
  the step and change its output, so the Harness reads that output as the domain's data. A terminal frame can come
  between any two frames, so a refusal in the middle of a part still reaches the reader, and the parts before it are
  void.
- **An empty range carries nothing.** When a remote-tracking ref of the parent clone already reaches `head`, git writes
  no bundle (`Refusing to create empty bundle`). This occurs when the parent pushed the branch before the final review,
  or when the branch has no commit of its own. The bundle step finds this before it writes a bundle, and the source
  Harness answers "nothing to carry": no bundle and no Git LFS objects. The child's cut then takes `head` from its own
  clone after its fetch (ADR-0075), when the clone holds it, and the node cache gives the Git LFS objects. An Agent can
  set a remote-tracking ref of the parent clone to `head`, so the child's clone can lack `head`. The cut is then
  `refused`, and the reason names the commit.
- **The Orchestrator carries the files, and no route faces a Sandbox.** It already talks to every Harness
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). When it runs the child's cut Effect, the Orchestrator
  checks the Handoff of that Effect's input against the ledger and records the source on that cut's intent row. Then it
  uses two legs of the Harness wire, each behind the Harness bearer:
  - `POST /handoff` on the source Harness, with the path and the head of the ledger row. The source Harness runs the
    bundle step and answers with one stream: the bundle, then the Git LFS objects.
  - `PUT /handoffs/<id>` on the child's Harness, with the Effect's id, before the Orchestrator starts the cut's exec
    (`POST /exec/<id>`, [ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)).
    The Orchestrator streams the source's answer into it. The child's Harness writes the files to a folder of that cut
    through a process that the spawner starts in the child's domain and that stdin frames feed, so neither Harness holds
    the whole stream. The cut removes the folder when it settles.

  The two legs are one pipe: the Orchestrator reads a chunk of the source only when the child's leg took the last one,
  so it holds no whole part, and a slow child holds the source's step paused. The Orchestrator checks the source's
  stream as it reads it: each header is a JSON line of a bounded length, in the order of the form, and the bytes of each
  part are counted against its header. It writes each frame of the child's body itself, from the values that passed
  these checks, so the child gets only the parts and their end. A body that ends before its end frame is a carry that
  the Orchestrator ended, and the child keeps nothing of it. The child answers `{ landed: true }` when it holds the
  files. A second body for one Effect id replaces the files of the first.

  The Orchestrator asks the Harness of the source Workspace where it runs now, and only while that Workspace still
  encloses the child: a Workspace that no longer runs gives no Handoff, and the cut is then `unknown`.

  The child makes no request for a Handoff, so no credential of the child's domain reaches one: the Orchestrator sends a
  bundle only for the source that the cut's own intent row records, never for a cut that the Machine did not ask for.
  Only the child's Harness knows that a re-cut is `held`, so the Orchestrator carries the files for each cut at a
  Handoff, and a `held` re-cut does not read them.

- **One bound covers the bundle and its Git LFS objects together.** A Handoff is the parent Agents' files, and the
  Orchestrator serves each run of the Instance, so an Agent's file must not steer how much it carries. The bound is 1
  GiB. The bundle step adds the sizes before it writes the first part, and refuses a Handoff past the bound. The source
  Harness and the Orchestrator each stop the stream at the bound, and the cut is then `refused`, with the bound in the
  reason.
- **The child's cut takes only `head`'s closure, and git checks each object.** git before about 2.46 runs no fsck on a
  fetch from a bundle, whatever `transfer.fsckObjects` says, and a fetch from a bundle stores each object of the
  bundle's pack. So the cut does not fetch from the bundle. It refuses a bundle unless it has exactly one ref, at
  `head`. It unbundles into a git folder that it makes in the cut's own folder, whose alternates are the child clone's
  objects, so that git checks the bundle's prerequisites against the clone. It sets a ref at `head` there, and the clone
  fetches that ref over `file://` with `transfer.fsckObjects=true`. So only `head`'s closure enters the clone, and git
  checks each of its objects with fsck, also on git before 2.46 (a probe on git 2.39.5 refused a commit with a bad
  date). Then the cut makes the branch at `head`.
- **The cut records its source.** The child cut's intent row keeps the resolved source (the run, the Workspace and the
  ledger row), so a restored run asks the same source, and the cut stays idempotent.
- **Two kinds of transport error.** An error that the parent's files or the parent's clone cause is `refused`, with the
  reason, because a cut again meets the same files:
  - the source Harness answers that the commit, or a prerequisite of the bundle, is not there;
  - the bundle step passes its deadline (for example, at a FIFO that an Agent planted);
  - the bundle file is not a regular file;
  - the stream passes the bound;
  - the bundle has a ref that is not at `head`, or fsck refuses an object;
  - the child's clone does not hold a prerequisite of the bundle (for example, the remote was force-pushed after the
    parent fetched). The reason names the missing commit;
  - the range is empty, and the child's clone does not hold `head` after its fetch. The reason names the commit.

  A Git LFS object that is not a regular file in the parent clone, or whose size is not its pointer's, is left out of
  the stream, and the child asks the node cache for it, as for each object that the Handoff does not carry. A
  remote-tracking ref of the parent clone that names no commit is left out of the range's negatives.

  When the source Harness does not answer, the cut is `unknown`, and the Machine can cut again. A connection that never
  opened, to either Harness, is tried again a few times first (for about 4 s), because no byte of the carry left. The
  Orchestrator ends a carry after 360 s with no byte from the source: longer than the bundle step's deadline, so a step
  that the parent's files hold ends as `refused` and never as `unknown`. A carry that a slow child stalls for that long
  also ends `unknown`, which ends the source's stream and so kills the step. An HTTP error of either Harness, a source
  stream that ends before its last frame or is out of its form, and a child that does not answer `{ landed: true }` are
  `unknown` too. Any other fault of the carry is `unknown` as well, never the invoke's error: the parent's files can
  cause it.

  The carry only reads the source and replaces the child's files under one Effect id, so it can run again. When the
  child's Harness restarts and the Orchestrator sends the cut's start again, it carries the files again first, so a
  restart is never a `refused` for a commit that the clone does not hold. A restored run carries them again under the
  same id, from the source that the intent row keeps.

- **No server.** No process serves git between Sandboxes, no alternates point at another Sandbox, and no git protocol
  version is chosen. On the parent side, the only git folder that jr2 makes is the bundle step's, which holds one ref
  and reads the clone's objects through its alternates. The child's `file://` fetch runs in the child, between two
  folders of its own cut. The bundle and the Git LFS objects that its commits name (below) are the only files that leave
  the parent Sandbox.

### Large files

- **Git LFS objects travel with the Handoff.** The bundle step also collects each Git LFS object that a bundled commit
  points to and that the parent clone holds. A pointer is a blob of the range (a blob that the remote-tracking refs do
  not reach) that has the form of a Git LFS pointer: the step reads no `.gitattributes`, which an Agent writes. The
  object is the file of its oid in the clone's LFS store. The Orchestrator carries them with the bundle.
- **The child lands an object only when a pointer names it and its bytes match.** A pointer in a commit of the
  handed-off range (the commits that the fetch brought into the clone) must name the object's oid, and the object's
  sha256 must be its oid. The cut leaves out each other object. git-lfs checks only the size of an object in the store,
  so without the sha256 check an object of the same size with other bytes checks out with exit 0. Then the cut's usual
  ask of the node cache gets the objects that the Handoff did not carry (ADR-0075). A push from the child uploads from
  its own LFS store, as each push does.
- The surface does not change.

### An Agent's git and a bare repository

A commit can hold a bare repository in its tree. In the spike, `git status` inside the folder of a bare repository that
a commit holds ran that repository's `core.fsmonitor`. So jr2 sets `safe.bareRepository=explicit` for each Agent
process, through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` in the domain's env (ADR-0076).
With it, a push, a clone or a fetch by path and `--git-dir` work, and `git -C bare.git` is refused with a message that
names the setting. The git of the cut, the sync and the bundle step runs with jr2's cleared env and its own config. The
attach runs its git with the domain's env, and so with this entry: a clone and an `upload-pack` by path work under it.
jr2's entry goes after the image's own entries, so an image that sets `GIT_CONFIG_COUNT` keeps its entries, and jr2
needs to read no image.

## Example

The parent's quick loop ends at a reviewer's `pass`. Then each round of the final review is a new nested Workspace, and
the parent publishes the commit that the last round approved.

```ts
const finalInput = z.object({ handoff, earlier: z.array(z.string()) });
type FinalInput = Workspaced<z.infer<typeof finalInput>, "app">;
const finalTree = (c: FinalInput) => `${c.workspace.repos.app}/final` as const;

// In the nested Workspace's body:
cutting: {
  invoke: {
    src: "cut",
    input: ({ context }) => ({ path: finalTree(context), handoff: context.handoff }),
    onDone: [{ guard: ({ event }) => isReady(event.output), target: "reviewing" }, { target: "notCut" }],
  },
},

// In the parent's body. `handoff` is the `ready` output of a cut of the coder's Worktree.
finalReview: {
  invoke: {
    src: "finalReview", // workspace(finalBody, { input: finalInput, repos: { app } })
    input: ({ context }) => ({ handoff: context.handoff!, earlier: context.earlier }),
    onDone: [
      { guard: ({ event }) => event.output.outcome === "pass", target: "publishing" },
      { target: "coding", actions: assign({ earlier: ({ context, event }) => [...context.earlier, event.output.notes] }) },
    ],
  },
},
publishing: {
  invoke: { src: "publish", input: ({ context }) => ({ worktree: coderTree(context), sha: context.handoff!.head }) },
},
```

## Considered options

- **Serve the commit with git's smart HTTP.** The child's cut fetched through its Custodian and the Orchestrator from a
  throwaway bare repository in the source Harness, which `git upload-pack` served, at protocol v0. Rejected. The spike
  showed that protocol v2's `upload-pack` served any object of the store: another branch, a stash, a dangling blob. So
  the server had to hold to v0 and to a store of only `head`'s objects. The serving step also followed an
  `objects/info/alternates` that an Agent wrote, with the server's access, and carried a file that the Agent could not
  read. A server is a protocol to police for the life of the Sandbox. A bundle is one file, which the domain writes, and
  from which the child takes only `head`'s closure through fsck.
- **The child's cut fetches straight from the bundle**, with `transfer.fsckObjects=true`. Rejected. git before about
  2.46 runs no fsck on a fetch from a bundle: on git 2.39.5 (the `@kind` Sandbox image) and 2.43, a commit with a bad
  date landed with exit 0, and the same fetch over `file://` was refused. The fetch also stores each object of the
  bundle's pack, so a bundle with a second ref put that ref's objects in the child's clone, with no ref to them. A floor
  of git 2.46 in each Sandbox Image closes only the first of these, and it binds each image that an author brings.
- **A `handoff()` Effect that seals the Handoff in the parent.** Rejected. The ledger already holds each fact of a
  Handoff, so a seal gives no property that the lookup does not give. It adds an Effect, a state in each parent and a
  key to keep.
- **The Handoff at the child's Repo Binding**, so that the child's Repo Slot is bound to the Handoff in place of a
  remote. Rejected. A bad Handoff then fails the attach, which a Machine cannot route as a `refused` outcome, and an
  Agent's word must not reach `onError` (ADR-0067). The child's `origin` would also not be the real remote. At the cut,
  a bad Handoff is an ordinary `refused`.
- **One long-lived nested reviewer for all the rounds**, which gets each new Handoff as an event. Rejected for now. It
  changes the one-way composition of [ADR-0011](0011-workflow-defined-events.md) into a kept, two-way event channel. A
  final review is meant to be independent, and a long-lived Sandbox keeps the caches and the conversation of round 1. A
  re-cut with another Handoff is `refused` today, so this can come later with no break.
- **A push guard**: a push without `pin` from a Worktree that a Handoff made is `rejected` when the branch moved.
  Rejected. The author chooses where to publish, and `push({ pin: true })` with the reviewed `sha` already publishes
  exactly the reviewed commit. A rule for one kind of Worktree is one more rule to learn, for a case that the author
  closes with one option.
- **An early check**: `jr2 up` refuses a registered root whose door takes a Handoff, and the Orchestrator looks the
  Handoff up when the parent invokes the nested Workspace, before it places the pod. Rejected. The cut must check in any
  case. A check at the invoke can fail on an Agent's word, so it must be a Failure and not a defect in the placement
  (ADR-0073, ADR-0067): a second refusal path to save one Sandbox.
- **A Sandbox name that is unique for each invoke**, so that a second round cannot race the delete of the first round's
  pod. Rejected. A parent that invokes the same Machine again from the same state must give it the same name, so that a
  restored or re-invoked Workspace takes over its Sandbox ([ADR-0064](0064-a-workspace-waits-for-capacity.md),
  ADR-0073). The name comes from the actor path (ADR-0012), which tells the Workspaces of two Pool workers apart. Two
  rounds share one name. A round that the parent invokes after it left the invoking state waits for the delete of the
  old one. A round that the parent invokes again from the same state takes over the old Sandbox, so a Machine leaves the
  state between two rounds (Decision).
- **The coder pushes its branch, and a review Workspace cuts the pushed commit.** This needs no kit change. Rejected as
  the way to the final review: it publishes work before its review, it needs a push and a fetch of the remote for each
  round, and the Machine cannot keep the reviewed commit off the remote.
- **Trust git-lfs to check an object that the Handoff carries.** Rejected: git-lfs checks only the size. A reviewer
  showed that a planted object of the same size checks out with exit 0.

## Consequences

- An independent final review is one nested `workspace()` and one cut arm. The quick loop in one Workspace does not
  change.
- Each round costs a new Sandbox: a placement, a clone, an install of the dependencies, and a new conversation. A
  measured nested Sandbox was Ready about 3 s after its create.
- The commit messages and the files of the commit are the parent Agents' words, and they reach the final reviewer
  unchanged. They can try to persuade it. That is the review's job to see; the final reviewer runs the code in its own
  Sandbox, and the author decides what that Sandbox holds.
- A Handoff goes only down. A commit that the final reviewer makes stays in the child, and it is published only when the
  child pushes it.
- Each slot needs its own Handoff, door field and cut. A Handoff given to the cut of a slot that holds another Repo is
  `refused` at the cut.
- Later, without a break: a per-run Repo Slot that takes only its remote and its base from a Handoff (the commit still
  enters at the cut), a review Machine in `@jr2/machines`, and a long-lived nested reviewer.
