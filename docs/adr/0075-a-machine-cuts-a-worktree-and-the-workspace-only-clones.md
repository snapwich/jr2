# A Machine cuts a Worktree, and the Workspace only clones

`workspace()` made one branch Worktree for each Repo Slot from `spec.branch`, and one detached Worktree from
`spec.reviewSha`. So `spec` collected kinds of Worktree, a slot that is only read got a Worktree that no Agent used, and
a Machine could not run two coders in one clone, retry a review in a clean folder, or name a branch after its plan. Now
the Workspace only clones. A Worktree is a folder that a Machine names and makes with a kit Effect, `worktree()`.

The layout and the branch order follow the conventions that [gwtmux](https://github.com/snapwich/gwtmux) defined: jr2
does not call gwtmux and does not depend on it. Three designs were built on real files, attacked, and judged: a design
with the path as the reference (this one), a design with the branch as the reference, and a design with no step that
makes a Worktree. A prototype of the chosen design passed 62 of 62 `@kind` scenarios in real pods.

## Decision

### The Workspace

- **The Workspace clones.** `spec`, `workspace.branch` and `workspace.review` go. `workGroup` is an option of
  `workspace()`: `workspace(body, { workGroup: 2000 })`.
- **A handle is the slot's folder, and not a Worktree.** `context.workspace.repos.app` is `/work/app`.
- **`default/` stays on the Binding's base.** A branch is attached, and a tag or a commit is detached. With no base, it
  is the Repo's default branch. A slot that is only read needs nothing more: an Agent reads `/work/<slot>/default`. No
  work happens in `default/`, and a cut of the branch that it holds is `refused`, and the reason names
  `/work/<slot>/default`.
- **The author chooses how many Agents work in a Workspace.** The rule "one Agent at a time" goes. Agents in one
  Worktree share git as people in one checkout do. Each coder that needs its own branch gets its own Worktree of the one
  clone.
- **`/work/.jr2/` is reserved for jr2.** A Repo Slot name cannot start with `.`. An Agent can write under `/work`, so
  nothing there is a record that jr2 trusts.

### `worktree()`

```ts
worktree();                       // a local branch, then origin (tracked), then new
worktree({ expect: "new" });      // refuse a branch that exists
worktree({ expect: "existing" }); // refuse a branch that does not exist, and make nothing

{ path: "/work/app/fix", branch: "docs/123", from?: "v3" }  // a branch Worktree
{ path: "/work/app/review", detach: sha }                   // forced and cleaned on each cut
{ path: "/work/app/final", handoff, branch?: "docs/123" }   // in a nested Workspace, a branch at a Handoff (ADR-0080)

{ outcome: "ready", slot, path, branch: string | null, head, found, stale? }
{ outcome: "refused", reason }  // nothing changed
{ outcome: "unknown", reason }
```

- **The path is the reference, and the Machine knows it before the cut.** It is exactly `/work/<slot>/<name>`, with one
  segment that is not `default` and starts with neither `.` nor `-`. So a door word or a planner's word does not become
  a folder tree, and a `run` branch and a `run/a` branch never need nested folders.
- **`branch` is required unless `detach` or `handoff` is given.** The branch is read from the cut's record, never from
  the folder or from HEAD. A Machine can use one word for both. The rule can relax after v1, and the reverse is a break.
- **A cut resolves a branch in one order, after a fetch:** a local branch, then `origin/<branch>` with tracking, then a
  new branch from `from` or the Binding's base with no upstream. `found` says which: `local`, `remote` or `none`. A path
  that a cut already made needs no fetch, and `found` is `held`. A detached cut says `commit`. A cut at a Handoff says
  `handoff`; it takes the commit from the parent Sandbox and checks the Handoff against the run's ledger
  ([ADR-0080](0080-a-nested-workspace-takes-a-handoff-at-its-cut.md)).
- **A failed fetch degrades.** `stale` carries ADR-0053's warning, and the cut uses what the clone holds. A name that
  the clone does not hold is `refused`, because the remote cannot confirm that it is new.
- **`expect` is static**, so a Chart cannot change it. The string can grow. A boolean cannot, and its absent value and
  its `false` would mean different things.
- **A cut runs on the `command` machinery**: a kit program in the Harness container, no new wire kind, marked
  idempotent. A cut at a Handoff adds two legs on the Harness wire, which carry the Handoff's files to the child's
  Harness before its exec starts (ADR-0080). Each thing that an Agent's word can cause settles as `refused`, and never
  as `onError` (ADR-0067). A cut writes a record before it changes git, so `refused` changes nothing and the next cut in
  the clone repairs a killed cut. So does a cut that adds again a Worktree whose folder an Agent removed: its record
  says so before the add, and the next cut removes the half-made folder and adds it again. Under the lock, a cut also
  removes the folder in `TMPDIR` that a killed cut of the same clone left. It never removes a folder that its record
  does not name. A re-cut that disagrees with the first cut is `refused`. Cuts of one clone are serialized by a lock.
- **A cut writes a Worktree's files from a git folder of its own.** The cut runs as the uid of the Workspace's Agents,
  so they write the clone's config and `info/` folder, and each Worktree's config, index and HEAD. Each of these changes
  what a checkout writes, and none is in a diff
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)): a filter that a config file names (also in
  an include, a conditional include, or a Worktree's own config), `info/attributes`, `core.worktree`, a sparse checkout,
  a skip-worktree or assume-unchanged bit, an index whose stat data an Agent made the same as a changed file's, and the
  ignore and attributes files of a `HOME` (`~/.config/git/ignore`, read also with no global config). So the cut checks
  out from a git folder that it makes for that cut, which takes its config, HEAD and index from no file of the clone,
  and then gives that index to the Worktree. It reads no ignore or attributes file of a `HOME` (`core.excludesFile` and
  `core.attributesFile` are `/dev/null`). The objects are the clone's (`alternates`), and an Agent writes them too
  (below). The one filter that this checkout runs is jr2's Git LFS filter, set by `-c` with git-lfs and jr2's transfer
  agent at their absolute paths on the runtime volume, and with `lfs.storage` at the clone's LFS store. This transfer
  agent asks for nothing (`jr2-lfs transfer --no-ask`), because the cut asked for the commit's large files before the
  checkout (below): a large file that no store holds at the checkout makes the cut `refused`, naming the file. The git
  folder's alternates also name the node cache's object store that the clone borrows from, because git-lfs reads the
  large files beside each alternate and does not follow an alternate's own alternates
  ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)). A cut refuses a
  Worktree whose `.git` names another admin folder, and one whose own git works in another folder (a `core.worktree`):
  each later git of an Agent there would read that other folder.
- **A detached cut is forced from its own record** and cleaned with `-ffd`, from the same git folder. Its index starts
  at the commit that the cut last wrote there, which the record keeps, and not at the Worktree's HEAD, which an Agent
  sets. So a file that the new commit removed goes. Before the checkout, each `.gitattributes` that is not in that
  commit goes (`clean -ffdx` with that pathspec), because a `.gitattributes` in the work tree changes the bytes that the
  checkout writes (`eol`, `working-tree-encoding`, `ident`). Ignored files stay, by each `.gitignore` in the Worktree,
  also one that the commit does not have, because a reviewer runs the tests (ADR-0028): a folder that ignores itself
  with its own `.gitignore` (a Python `.venv`, a `.pytest_cache`, a `.mypy_cache`) is the reviewer's tools, and stays
  from round to round. So a `.gitignore` that an Agent wrote keeps what it ignores too (a limit, below). A rule in the
  clone's `info/exclude` or in a config keeps nothing. Each context file and skill that pi reads (`AGENTS.override.md`,
  `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, and what is in a `.pi/skills` folder) in any folder of the
  Worktree goes also when it is ignored (`clean -ffdx` with those pathspecs), because an ignored context file is in no
  diff. A tracked file stays. git does not go into a nested repo that is ignored.

  Only a detached cut is forced and cleaned: a branch Worktree that a cut made is given back as it is (`held`), with the
  work in it.

- **A cut needs a Repo Slot.** `jr2 up` and the invoke refuse `worktree()` under a Workspace with no Repo Slot, as they
  refuse a `push` (ADR-0051).
- **A cut gets its commit's large files first.** After the fetch and before it changes git, a cut asks the node cache
  for each Git LFS object of its commit
  ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)). An object that the
  cache does not hold and cannot get makes the cut `refused`, and the reason names the file. The ask gets what is left
  of the Effect's `timeout` less one minute for the checkout, so an object that does not come in time also makes the cut
  `refused`, naming the file, and never ends the Effect at its `timeout`. When no time is left, no ask goes, and the
  refusal says that the Effect's timeout left no time to ask for the file. With `worktree()`'s default of `"10m"` and a
  fetch that spends its two budgets, the ask has 6.5 minutes. With a remote that is down and every object held, the cut
  is `ready` with `stale`.
- **A cut checks out no submodule.** A submodule's folder stays empty. A Machine that works in a submodule's code binds
  that Repo as its own Repo Slot.
- **v1 has no kit removal.** The docs give a `command` that runs `git worktree remove`.

### What names a Worktree

```ts
coder:   { prompt, cwd: "/work/app/fix" }          // required under Repo Slots
publish: { worktree: "/work/app/fix", sha }        // push
test:    { worktree: "/work/app/fix" }             // command
send:    { name: "r.md", worktree: "/work/app/fix" } // http with a file body
```

- **`cwd` and `worktree` are required under Repo Slots.** A Workspace that only clones has no Worktree for a default to
  name, and `/work` is the wrong default: an Agent's search hits `default/`, and a relative write lands outside each
  Worktree. That is the incident in ADR-0057. A Turn that wants `/work` states it. A Workspace with no Repo Slot, and an
  Agent with `workspace: "none"`, need no `cwd`.
- **`push` has no `to` and no `branch` in its input.** It keeps its static `slot`. The Orchestrator finds the cut's
  settled row in the run's ledger, by the path and this Sandbox, and tells the Effector which branch to publish. An
  Agent can change all of git in the pod, and it cannot change that row. With a read of HEAD, `git switch main` would
  publish `main`. With an input key, a Chart could aim at any remote branch. A push with no row, a row of another slot,
  or a detached Worktree is `rejected` at stage start. The ledger key is (slot, branch). The local name equals the
  remote name, so an Agent, a Gate and a person in the pod all see the real branch.
- **A `command` that names a secret and an `http` file body need the same row.** A path alone does not name the target
  of a credential.
- **A bad Worktree does not add an outcome.** A `command` settles `exited` 127 with the reason in its tail, and an
  `http` file body settles `refused`.
- **A compile error catches a wrong slot.** `Workspaced` types a handle as the literal `/work/<slot>`, and `jr2Setup`
  maps the body's slots to each Worktree input. The compile check is a help and the guarantee is at run time. It sees
  the slot and the first character of the name, under `jr2Setup`, on a literal path. It does not see a path held as
  `string`, a plain `setup()`, a `repos: open` Machine, or a body that is generic in its slots. A helper must return
  `as const`.

### A Chart

- A cut lent to a Chart must state `expect`, and a Chart reads it with the kit guard `jr2.ready`.
- The door refuses `expect: "existing"` beside a lent force push, because together they let a Chart force-push any
  existing branch that `default/` does not hold.
- The cut checks `expect` in the Agents' domain, and a process of that domain can write the cut's answer (ADR-0076). So
  the push checks `expect: "new"` again where no Agent writes: the first push of the run to the branch of such a cut
  goes with an empty lease (`--force-with-lease=refs/heads/<branch>:`, and no `+`), and the remote refuses it when it
  holds the branch. The push is then `rejected`, and the remote does not change. A later push of the run to that branch
  goes as before. The ledger row of the cut keeps the slot, the path and the branch that the Orchestrator sent, and only
  the head of the answer (ADR-0067). These two rules also hold for a cut at a Handoff, whose `branch` a Chart can give:
  the cut applies the slot's `expect` to the child's branch
  ([ADR-0080](0080-a-nested-workspace-takes-a-handoff-at-its-cut.md)).
- The door refuses a `cwd` that is a slot's folder.
- A Chart's payload has no `pattern`, so a Chart cannot state the branch rule, and the cut refuses a bad name. A
  hand-written Machine's pick param uses the kit schema `branchName`, so a bad name is refused at the Menu. The cut and
  the push share that rule. Names with `@`, `#` or `+` are refused, as the Effector refuses them.

### Output and the walk

- **Every Effect outcome is open.** `worktree()`, `push`, `command`, `http` and `mcp` each hold a stand-in member in
  their union, so that no author can write an exhaustive check. A later outcome is then no break.
- **The load-time walk refuses an Effect's `onDone` with no unguarded last arm.** A type cannot see a missing arm, and
  with no match a run stays in that state and shows no fault.

### Fetches in one clone

All Worktrees of a clone share `refs/remotes/origin/*`. A `git fetch` updates a ref only if it still holds the value
that the fetch read, so two fetches that overlap on a moved remote can fail with
`cannot lock ref … is at <sha> but expected <sha>`. The failure does no harm: the ref is already newer, and a second
fetch works. But it costs a Turn, so `jr2-upload-pack` takes a per-clone lock and keeps it until the fetch ends. It
takes the lock after it asks the node cache, so a dead remote does not make coders wait in line. The program execs
`git upload-pack`. That process can end before the fetch writes its refs: that happens when a pack moves. In a shared
clone, git often keeps the connection open to the end. The lock must last to the end of the fetch in both cases, so a
small child process that watches the fetch holds it, and ends when the fetch ends. The child watches the `git fetch`
process and not its parent, because `git remote-ext` ends with the connection.

A cut keeps its own lock, and fetches under it. A fetch waits only for a fetch: a cut can wait for the fetch lock, and
nothing that holds the fetch lock waits for a cut, so the two cannot deadlock. A fetch waits at most 30 s in line, then
runs with no lock, because the lock only helps and must not fail a fetch.

| Measured                                                               | 4 coders              | 8 coders |
| ---------------------------------------------------------------------- | --------------------- | -------- |
| Real pod, `ext::` path, 90 s, moving remote, no lock                   | 29% of fetches failed | 39%      |
| Local, no lock                                                         | 8%                    | 11%      |
| Local, `core.filesRefLockTimeout=5000`                                 | 8%                    | 11%      |
| Local, lock for the connection only                                    | 3%                    | 4%       |
| Local, lock held to the end of the fetch                               | 0%                    | 0%       |
| Real pod, same load, lock held to the end of the fetch: failed fetches | 0 of 349              | 0 of 725 |
| Real pod, same load, with the lock: fetch p95                          | 1066 ms               | 1078 ms  |
| Real pod, same load, with the lock: cut p95                            | 4289 ms               | 8256 ms  |

Git's lock timeout does not help, because no lock is busy: the compare fails. If the wait under the lock is too long in
a pod, jr2 drops this lock and adds a `@model` claim that an Agent runs the fetch again.

### Smaller rules

- **A Pool's `next` reads `{ active, settled, input }`.** `input` is the Pool's input and `settled` holds the ids of the
  finished and failed items, so a Source can fan out over a plan with no state of its own.
- **A wrapper's door is parsed under a parent too**, so a parent that passes less than a `workspace()` or a `pool()`
  requires fails (ADR-0033).
- **A Sandbox delete waits for its pod**, because a retry can take the name of a pod that is still going away
  (ADR-0021).
- **An Agent's commits on a side branch are not published**, and `found` says `held`. A warning field can follow after
  v1.
- **`jr2 status <run>` shows each path and branch.** `jr2 workspace ls` shows only Sandboxes, because it reads cluster
  labels.

## Example

A coder, a detached reviewer, and a signed push of the commit that the reviewer read. The reviewer has its own folder,
which each round forces to the commit and cleans.

```ts
type BodyInput = Workspaced<{ prompt: string; branch: string }, "app">;
const coderTree = (c: BodyInput) => `${c.workspace.repos.app}/work` as const;
const reviewTree = (c: BodyInput) => `${c.workspace.repos.app}/review` as const;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: BodyInput & { reviewed?: string } },
  actors: {
    coder: agent({ model, instructions: "You fix the bug. You commit the fix." }),
    reviewer: agent({ model, workspace: "read", instructions: "You review one commit. You change nothing." }),
    cut: worktree(),
    publish: push({ sign: true, pin: true }),
  },
}).createMachine({
  initial: "cutting",
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "coding" }, { target: "notCut" }],
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.prompt, cwd: coderTree(context), continue: true }),
      },
      on: { finished: "reading" },
    },
    // A cut is idempotent, so it also reads a Worktree. `head` is the tip of the branch, whatever HEAD the coder left.
    reading: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: coderTree(context), branch: context.branch }),
        onDone: [
          {
            guard: ({ event }) => isReady(event.output),
            target: "detaching",
            actions: assign({ reviewed: ({ event }) => readyOf(event.output).head }),
          },
          { target: "notCut" },
        ],
      },
    },
    detaching: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: reviewTree(context), detach: context.reviewed! }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "reviewing" }, { target: "notCut" }],
      },
    },
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({ prompt: `Review ${context.reviewed}.`, cwd: reviewTree(context) }),
      },
      on: { pass: "publishing", revise: "coding" },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: coderTree(context), sha: context.reviewed! }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "coding" }],
      },
    },
    done: { type: "final" },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
  },
});
```

Concurrent coders in one clone. A Pool in the body runs one worker for each task, and each worker cuts its own Worktree.
The body cuts its merge target first, so a name conflict is refused before a coder works. Then it merges each branch, in
one clone with no fetch, and pushes once.

```ts
const taskTree = (c: WorkerInput) => `${c.workspace.repos.app}/task-${c.id}` as const;
const mergeTree = (c: BodyInput) => `${c.workspace.repos.app}/merge` as const;

// In the worker:
cutting: { invoke: { src: "cut", input: ({ context }) => ({ path: taskTree(context), branch: `task/${context.id}` }) } },
coding: { invoke: { src: "coder", input: ({ context }) => ({ prompt: context.title, cwd: taskTree(context) }) } },

// In the body:
cutting: { invoke: { src: "cut", input: ({ context }) => ({ path: mergeTree(context), branch: context.branch }) } },
working: { invoke: { src: "coders", input: ({ context }) => ({ tasks: context.tasks, workspace: context.workspace }) } },
merging: {
  invoke: {
    src: "merge", // command(["git", "merge", "--no-edit", arg("branch")])
    input: ({ context }) => ({ branch: `task/${context.left[0]!}`, worktree: mergeTree(context) }),
  },
},
publishing: { invoke: { src: "publish", input: ({ context }) => ({ worktree: mergeTree(context) }) } },
```

## Considered options

- **The branch as the reference: `worktree({ slot, branch })`, with the path as output.** Rejected. The path is known
  only after the cut, so each later state reads it from context, and a Chart needs an output read. `/` in a branch must
  map to a folder. S1 cost 29 more lines against 8 for this design, and its attack found three fatal faults.
- **No step: a Worktree named as data, made on first use.** Rejected. A Turn has no route for a refused cut, and that is
  the fault of its central idea. A planner's typo becomes a Turn that cannot start. It saves lines in the hard
  scenarios, and it saves nothing in the common one.
- **The name is the local branch.** Rejected. A door word then reaches a path, a slash needs a mapping, and `run` beside
  `run/a` collides.
- **`to` on `push`.** Rejected for v1: no scenario needs it, and it can be added with no break. A name chosen after the
  work needs a cut first.
- **`push` reads HEAD.** Rejected. An Agent can move HEAD.
- **`default/` always on the Repo's default branch.** Rejected. An Agent would read the wrong version of a pinned
  handbook with no sign, and a read-only slot is a reason for this design.
- **`cwd` defaults to `/work`.** Rejected, as ADR-0057 rejected it.
- **A bad path goes to `onError`.** Rejected by ADR-0067: an Agent's param can cause it.
- **Check out in the Worktree's own git, with each filter that the clone's config names turned off.** Rejected. A filter
  in a Worktree's own config, in an include or in a conditional include for a branch is not in that list, and a config
  that an Agent changes between the list and the checkout is not either. The list does not stop a `core.worktree`, a
  skip-worktree bit or an index whose stat data matches a changed file. The cut's own git folder reads none of these.
- **A re-cut removes each `.gitignore` that the commit does not have**, so that only the commit's own rules keep an
  ignored file. Rejected. It also removed each folder that ignores itself with its own `.gitignore` (a Python `.venv`, a
  `.pytest_cache`, a `.mypy_cache`), so the reviewer installed its tools again at each round. The cut cannot tell such a
  folder from one that an Agent hid, and the Agents of one Sandbox have free rein over its files (ADR-0028).

## Consequences

- After v1, these are additive: a removal Effect, a sparse checkout, a new Worktree source, `to`, a relaxed `branch` or
  `cwd`, a later outcome, durable output under `/work/.jr2/` or on its own mount, and submodules.
- Park and restore can only restore all of `/work`. A restore from the remote alone cannot work: settled cuts do not run
  again, and unpushed work is gone. v1 does not promise that form.
- A packaged Machine with two slots still needs a static `slot` on its `push`.
- A kill of the cut's node process alone can leave `git worktree add` running after the cut's lock frees, because git
  does not inherit the lock.
- The fetch lock's holder ends as an orphan, so PID 1 must reap it. A User Container whose PID 1 does not reap keeps one
  more zombie for each fetch there: 50 fetches left 50, beside the 52 that git leaves by itself with no jr2 program.
- A kill in the short `update-ref` step leaves a stale ref lock, and no cut removes it. So that name stays `refused`.
- The cut's own git folder is in the domain's `TMPDIR`, and the Agents run as the same uid in the same domain. So an
  Agent's process that runs during a cut can write that folder: a race with one cut, not a file put there before it.
  Inside the Sandbox the Agents have free rein (ADR-0028), so jr2 accepts it.
- A `.gitignore` that an Agent writes in another Agent's review Worktree keeps the files that it ignores through a
  re-cut, and no `git status` there shows them. The cut cannot tell such a file from a `.venv`'s own `.gitignore`.
  Inside the Sandbox the Agents have free rein over the files (ADR-0028), so jr2 accepts it. Such a file does not reach
  a system prompt: the cut removes an ignored context file or skill, and the project context leaves out an ignored one
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). An independent review runs in a nested
  Workspace, which takes the commit as a Handoff ([ADR-0080](0080-a-nested-workspace-takes-a-handoff-at-its-cut.md)).
- Each re-cut of a detached Worktree writes each file of the commit again, because the cut does not trust the stat data
  of the Worktree's index.
- The cut trusts the clone's objects. Each Agent of the Workspace can write the clone's object folder, and git does not
  check an object's content against its id when it reads it. So an Agent that rewrites an object, or a pack index
  (`.idx`) that points an id at another object, changes what each later cut writes and what each Worktree's git reads.
  The cut and the sync read no commit-graph and no multi-pack-index (`core.commitGraph=false`,
  `core.multiPackIndex=false`): an Agent can write either one with no object rewritten, and git 2.56 then checks out
  another tree for a commit. The git that `jr2-lfs fetch` starts in the cut reads neither one, and no attributes file of
  the cut's `HOME`. It runs in the clone, so it reads the clone's `info/attributes`: an Agent that writes a rule there
  changes which large files the cut asks for. The cut's checkout asks for none, so a large file of the commit that the
  fetch did not ask for makes the cut refused. The cut also trusts the clone's `info/attributes`, the clone's LFS store
  and the clone's `objects/info/alternates`. git-lfs checks an object in the store by its size only, so an Agent that
  puts other bytes of the same size there changes the large file that a cut writes. An alternate that an Agent adds
  gives the cut's git folder more objects to read. Inside the Sandbox the Agents have free rein (ADR-0028), so jr2
  accepts these. What leaves the Sandbox is checked where it lands: a cut at a Handoff takes only the handed-off
  commit's closure into the clone, checks each of its objects with fsck, and lands only a large file that a pointer of
  the range names and whose sha256 is its oid (ADR-0080).
- Several Agents now share one Sandbox (concurrent coders, or a reviewer beside a coder), and so do the workers of a
  Pool in one clone. They share the one Harness and `/work`. Only the Harness process holds the control credential, and
  each process it starts in `/work` runs confined, so no Agent's code can act as another Agent
  ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)).
- This change alters the Frame, the Chart briefing and the door's refusal text. The full `@model` run read 18 of 19
  scenarios. `chart-refusal/off` read 6 of 10, below its floor of 7, and each miss failed at the Menu's validation,
  before the door, on the JSON-string Chart that ADR-0070 records. Run alone, two runs on each side at one time, `main`
  read 8 and 8 of 10, and this change read 9 and 7 of 10. So this change does not lower the cell. The floor stays, and a
  full run can miss it.
