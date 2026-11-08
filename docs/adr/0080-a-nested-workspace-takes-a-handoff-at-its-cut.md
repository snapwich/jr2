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
with no remote. A design panel wrote five prototypes of the surface, and a spike tested the transport on real files.

## Decision

### The surface

- **A Handoff is plain data: the parent cut's `WorktreeReady`.** `{ slot, path, branch, head }`, as a `ready` cut of a
  Worktree gives it ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). The parent Machine
  passes it to the nested Workspace through the door, as each other input. There is no `handoff()` Effect, no seal and
  no extra parent state.
- **The commit enters the nested Workspace only at its cut.** `worktree()` gets a third arm:

  ```ts
  { path: "/work/app/final", handoff, branch?: "fix/123" }   // a branch Worktree at the Handoff's commit
  ```

  The child's Workspace clones the real Repo, as each Workspace does, and its attach knows nothing of the Handoff. The
  cut makes a branch Worktree at `handoff.head`. The branch is `branch ?? handoff.branch`, so by default it has the
  parent's name. It tracks `origin/<branch>` when the clone holds that branch. `found` is `"handoff"`. A re-cut of the
  path with the same Handoff is `held`, and a re-cut with another Handoff is `refused`.

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
  - the child's clone has no local branch of that name at another commit.

  Each of these is the Agent's word, so each settles as `refused`, with a reason, and changes nothing. A bad Handoff
  never goes to `onError`
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)), and the Machine
  routes it, for example to `fail()`
  ([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)).

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
- Only `head` and its ancestors cross. The parent's other branches, its untracked and ignored files, its config and its
  caches stay in the parent Sandbox.

### The transport: a git bundle

- **The parent Sandbox writes a bundle of exactly the handed-off range**: `head` and the ancestors that the parent
  clone's remote-tracking refs do not hold (`git bundle create <file> <head> --not <remote-tracking refs>`). The source
  Harness writes it as it runs the cut: through the spawner, in the Sandbox's Landlock domain (ADR-0076), with jr2's
  cleared env, the cut's pinned config (no hooks, no fsmonitor, `core.commitGraph=false`, `core.multiPackIndex=false`,
  `core.alternateRefsCommand=true`, and the rest of the cut's set), a deadline, and a kill of the process group at the
  deadline. In the domain, the step reads only what an Agent of the parent can read itself. The deadline is necessary:
  in the spike, a FIFO that an Agent planted in the clone held git for ever.
- **The Orchestrator carries the file.** It already talks to every Harness
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). The child's cut asks for its Handoff. The Orchestrator
  finds the source in the ledger, never in the request, asks the source Harness for the bundle, and gives the file to
  the child's cut. jr2 bounds the size of a Handoff, and a larger one is `refused` with the bound in the reason.
- **The child's cut fetches from the bundle** into its own fresh clone, with `transfer.fsckObjects=true`, so git checks
  each object against its id before the clone holds it. Then it makes the branch at `head`.
- **The cut records its source.** The child cut's intent row keeps the resolved source (the run, the Workspace and the
  ledger row), so a restored run asks the same source, and the cut stays idempotent.
- **Two kinds of transport error.** When the source Harness answers that the commit, or a prerequisite of the bundle, is
  not there, the cut is `refused`. When the source Harness does not answer, the cut is `unknown`, and the Machine can
  cut again. When the child's clone does not hold a prerequisite of the bundle (for example, the remote was force-pushed
  after the parent fetched), the cut is `refused`, and the reason names the missing commit.
- **No server.** No process serves git between Sandboxes, no throwaway repository is made, no alternates point at
  another Sandbox, and no git protocol version is chosen. The bundle is one file, and the only file that leaves the
  parent Sandbox.

### Large files

- **Git LFS objects travel with the Handoff.** The bundle step also collects each Git LFS object that a bundled commit
  points to and that the parent clone holds. The Orchestrator carries them with the bundle.
- **The child checks each object's sha256 against its oid** before it puts the object in its clone's LFS store. git-lfs
  checks only the size of an object in the store, so without this check an object of the same size with other bytes
  checks out with exit 0. Then the cut's usual ask of the node cache gets the objects that the Handoff did not carry
  (ADR-0075). A push from the child uploads from its own LFS store, as each push does.
- The surface does not change.

### An Agent's git and a bare repository

A commit can hold a bare repository in its tree. In the spike, `git status` in a Worktree with an embedded bare
repository ran that repository's `core.fsmonitor`. So jr2 sets `safe.bareRepository=explicit` for each Agent process,
through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` in the domain's env (ADR-0076). With it, a
push, a clone or a fetch by path and `--git-dir` work, and `git -C bare.git` is refused with a message that names the
setting. jr2's own git already runs with a cleared env and its own config. jr2's entries take the place of the image's
own, so `jr2 up` warns, and does not refuse, when a Sandbox Image sets `GIT_CONFIG_COUNT`.

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
  read. A server is a protocol to police for the life of the Sandbox. A bundle is one file of exactly the range, which
  the domain writes and the child's fsck checks.
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
  rounds share one name, and a new round waits for the delete of the old one.
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
- Later, without a break: a per-run Repo Slot that takes its Binding from a Handoff, a review Machine in
  `@jr2/machines`, and a long-lived nested reviewer.
