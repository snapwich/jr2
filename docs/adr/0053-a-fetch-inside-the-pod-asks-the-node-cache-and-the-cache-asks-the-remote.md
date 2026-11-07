# A fetch inside the pod asks the node cache, and the cache asks the remote

[ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md) made the node cache the only thing that
fetches from a remote, and left one consequence standing: stale stays stale from inside the pod until the interval or
the next attach. The only ask a cache agent understood was a pod's birth — `asked` is the newest pod's creation time,
and a Sandbox is `Ready` once its caches were fetched after its CR was created. Nothing after birth could ask: no CLI,
no route out of the pod, no body primitive. The grill of 2026-09-13 took the concrete case — a human pushes a fix to
`master`, the coder at `request_changes` must rebase onto it now, and the human in the User Container of the same pod
wants the same commit — and found that a five-minute interval is not a freshness model, it is the absence of one. **How
a fetch inside a pod reaches the remote, and who may ask** is one decision.

## Decision

- **`origin`'s fetch url is a command, not a path.** The attach sets it to git's built-in `ext::` transport, an absolute
  program on the runtime volume with the Repo's identity as its argument:

  ```
  ext::/opt/jr2/bin/jr2-upload-pack %S github.com/acme/app
  ```

  Git runs the program and bridges stdio, so the program owes no remote-helper protocol: it asks for a fetch, waits for
  the landing, then execs `git upload-pack /repos/<key>` and gets out of the way. Git speaks its ordinary protocol and
  prints its ordinary output; refs update once, at the end. What the caller sees is a fetch on a slow handshake, never
  an early return and never a partial state. `git fetch`, `git pull`, `git ls-remote origin`, and `git fetch --dry-run`
  all pass through it, so every fetch inside a pod is a fetch of the remote's now. `git archive --remote=origin` is the
  one other read git asks a remote for, and the program serves it the same way — the same ask, then `git upload-archive`
  against the same cache — because the path url served it and a decision about fetching may not quietly take it away.
  Nothing else in git talks to a remote, so `status`, `log`, and `rebase` stay local. The push url is unchanged: the
  Binding's own spelling, the caller's own credential, never the Agent's (ADR-0005).

- **The ask rides the Sandbox CR and reaches the agent through the pod.** The program asks the Custodian on `localhost`
  (`POST /fetch`, with the fetch token's Stand-in — a constant, because the User Container gets no env); the Custodian
  puts the fetch token in place of the Stand-in, on this route alone and asks the Orchestrator for THIS pod's Sandbox
  (`POST /sandboxes/<name>/fetch` — the program cannot name another,
  [ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)); the Orchestrator patches one
  annotation on the Sandbox CR, per Repo key, timestamp value — the Lease's shape, an annotation the Orchestrator
  writes. The operator copies it onto the pod as it copies everything else the pod needs from the CR, and the cache
  agent's `asked` becomes the later of the pod's creation and its ask for that key. Demand stays read off pods alone.
  The mark is a coalescer: however many fetches are in flight before one lands, the remote is fetched once, and a fetch
  that started before the ask does not satisfy it — the agent stamps `lastFetched` with the attempt's start, which is
  what makes that true.
- **The landing is reported on the Sandbox, standing and per key.** The verdict the operator already computes on the way
  to `Ready` — fresh, stale with git's error, or still cloning, per Repo, against the CR's creation — becomes a standing
  entry on the Sandbox status computed against the later of creation and the ask. `Ready` itself stays as it was:
  sticky, once per pod life. The Orchestrator's route waits on that entry — a Sandbox watch event, never a poll
  ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)) — then answers the Custodian, which answers the program.
  One wait, and it is the wait an attach already makes.
- **The scope is the fetch token's scope, and no seat gains a credential.** The fetch token is valid on the fetch route
  alone, and the control token is not valid there
  ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). A Sandbox may ask for the
  caches it mounts and nothing else; the remote is reached by the cache agent with the Repo CR's `secretRef`, the
  credential that cloned the cache. The pod holds none before and none after. The Menu is untouched — a fetch is not
  something the Agent _says_, it is something it _does_ — and no Machine declares anything: the ability is ambient in
  every Workspace pod, the way Working tools are, and absent on the Instance Harness, which mounts no Repo.
- **Freshness degrades, absence does not, and the caller is told.** A remote fetch that fails or outruns the on-demand
  budget lets the program fall through to the objects the cache holds — ADR-0051's stance for attach — and writes one
  line to stderr, which git passes through verbatim:
  `warning: jr2: remote fetch failed (<git's error>); serving the cache as of <lastFetched>`. A fetch's budget is the
  cache agent's on-demand number for a fetch; the program's wait is that plus watch slack, and the program owns no
  timeout of its own. An LFS ask has its own budget of ten minutes in the cache agent, and the Orchestrator waits that
  plus watch slack. A cut reads that line too: its output carries the line in `stale`, and the cut uses what the clone
  holds. A branch name that the clone does not hold is then `refused`, because the remote cannot confirm that it is new
  ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)).
- **One fetch at a time in a clone.** All Worktrees of a clone share `refs/remotes/origin/*`, and git updates a ref only
  if it still holds the value that the fetch read. So two fetches that overlap on a moved remote can fail with
  `cannot lock ref`. The failure does no harm, but it costs a Turn. So the program takes a per-clone lock after the ask,
  so a dead remote does not make coders wait in line. `git upload-pack` can end before the fetch writes its refs: that
  happens when a pack moves. In a shared clone, git often keeps the connection open to the end. The lock must last to
  the end of the fetch in both cases, so a small child process that the program leaves watches the fetch and holds the
  lock. ADR-0075 holds the measurements.
- **Every seat that holds the checkouts holds the program.** The fetch url lives in the shared `default/.git/config`, so
  a seat without the program has checkouts whose `git fetch` dies. That is ADR-0005's own argument for `/repos` — half
  of one exception, not a second — applied once more: the pod's `/opt/jr2` volume is mounted read-only into the User
  Container beside `/repos`. `ext::` names the program by absolute path, so the seat needs no PATH and jr2 injects no
  env; the program is a static binary, the `work-acl` rule (ADR-0037), because it executes on a libc jr2 does not
  control. A human in the User Container gets the same `git fetch` as the Agent, with no credential of their own; the
  human `exec`'d into the Harness container already had it.
- **A large file is fetched as a commit is.** A Repo that stores files with Git LFS needs nothing from the Machine or
  the image. The attach writes git-lfs's filter into the clone's config by absolute path, to a static git-lfs on the
  runtime volume, with no `git lfs install`. It also writes git-lfs's four hooks (`post-checkout`, `post-commit`,
  `post-merge`, `pre-push`), each calling that git-lfs by absolute path, where the clone has no such hook: git-lfs
  writes a missing hook itself, and its hook calls `git lfs` on PATH, which fails in a seat with no git-lfs on PATH. A
  hook that is there stays, so a user's own hook is kept. A smudge reads the cache's `lfs/objects` through the clone's
  alternate. A miss goes to jr2's standalone transfer agent, beside git-lfs on the volume. The agent asks for those
  objects by oid on the path that a fetch's ask takes (the Custodian, then the Orchestrator, then the cache agent),
  waits for the landing, and gives git-lfs a copy of each one. The cache agent downloads them with the Repo CR's
  `secretRef` (ADR-0051). So any checkout in the pod's `/work` works, of any commit, as it does in a clone with no LFS.
  A credentialed `command` is the exception: it runs on the Sandbox Effector's own scratch checkout, where each large
  file is its pointer (ADR-0067). One ask names 1 to 256 objects. An attach asks for the objects of the Binding's base
  before it checks out `default/`, and a cut asks for its commit's. The cut's ask gets what is left of its Effect's
  `timeout` ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). An object that the remote
  cannot give and the cache does not hold fails git-lfs's checkout, with jr2's line on stderr. A cold attach can
  download for longer than one HTTP request may wait, so `POST /attach` answers 202 while the attach runs, and the
  Orchestrator asks again with the same body until it ends.
- **Names.** `fetch` is what an Agent, a human, and a cache do; `refresh` is what the interval does and stays on
  `refreshInterval`; an _ask_ is the mark, the word the agent and the operator already use. The url carries the Repo's
  identity, never the cache key — a key is a derived directory name, never chosen by a human (ADR-0004), and not the
  name a human should read in `git remote -v`.
- **What stays.** An attach still fetches before it runs, because a creation is an ask. The interval still runs, so a
  cold attach and `jr2 status` stay honest without anyone asking. There is no CLI verb: the human who wants the fetch is
  in the pod, where `git fetch` is the verb, and the mark makes a `jr2` verb additive if a caller outside the pod ever
  needs one.

## Considered options

- **The run asks** — a body primitive before a Turn, or on `request_changes` re-entry, the way attach asks on entry.
  Rejected as the only path: it covers what the author foresaw and nothing an Agent discovers mid-Turn. Not foreclosed:
  the mark is the substrate, and a body primitive that sets it is additive.
- **A Menu pick** (`need_fresh`, declared with `defineEvent`, a `fetching` state the pick transitions to). Rejected: a
  Turn boundary per fetch, an author opt-in per state, and a transition for something that moves the Machine nowhere. A
  fetch is not part of a Machine's Vocabulary.
- **A named Menu tool** (`mcp__jr2__fetch` beside the Menu's events). Rejected: the model must learn a tool and remember
  to call it before the verb it already knows, and a human at a shell gets nothing from it.
- **Shorten the interval.** Rejected: polling per node per Repo, and the latency is still the interval.
- **The ask on the Repo CR.** Rejected: every node holding the cache fetches, and the wait must then name a node.
- **The cache agent reads Sandbox CRs.** Rejected: two sources of demand where one exists, and a new RBAC grant for the
  DaemonSet, to save one copy the operator makes for every other field.
- **A `jr2::` remote helper found on PATH.** Rejected: PATH is env, the User Container gets none (ADR-0005), and an owed
  image line where `ext::` costs nothing but a longer line in `git remote -v`.
- **The human's credentialed fetch pushed into the cache.** Rejected: the cache is read-only in the pod by design, the
  structural half of the gc invariant (ADR-0004). And moot: with this decision the human's own credential is not needed
  for a fetch at all.
- **Fail the fetch when the remote fails.** Rejected: attach chose availability (ADR-0051), and the Agent's `git fetch`
  would become less reliable than today, where it always succeeds against the cache.

## Consequences

- ADR-0051 is rewritten in place: "stale stays stale from inside the pod" is retired; a stale attach is stale until the
  next fetch anyone inside the pod runs. ADR-0005 is rewritten in place: "`git fetch origin` reads the node cache" is
  now "asks the node cache", the User Container mounts `/opt/jr2` read-only beside `/repos`, and "nothing injected"
  narrows to the seat's process — no env, no command, no probe. ADR-0004's refresh section gains the in-pod ask.
- The runtime volume carries a second static binary, and so a jr2 program is present in every seat of every Workspace
  pod, User Container included. It also carries git-lfs and the LFS transfer agent.
- git-lfs copies each object that it smudges into the clone's own `.git/lfs/objects`, and the cache is on another mount,
  so a pod's disk holds each checked-out large file two times. That disk is `/work`'s, which is not part of the Size
  that the Workspace states ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)).
- A fetch inside a pod is a remote round trip through the node agent, seconds rather than milliseconds. Every git
  command that fetches pays it; none that does not.
- The cache agent serves a Repo's git asks and its LFS asks one at a time, and it works on at most four Repos at once.
  While it downloads large files for one pod, a fetch that another pod on that node asks for the same Repo can run out
  of its budget and land `stale`. Four such downloads at once hold the agent, so a fetch of any Repo on that node waits.
- The Sandbox status grows a standing per-key Repo entry; the Custodian carries one loopback route for it; the
  Orchestrator gains a Sandbox-token route. No new credential, no new watch in the cache agent, no git knowledge in the
  operator beyond the timestamp comparison it already makes.
- The rewind gotcha vanishes: a human who fetched around the cache with their own credential advanced a remote-tracking
  ref the Agent's next cache fetch forced back. Nobody fetches around the cache now.
- The Harness `bash` tool's own timeout still bounds a fetch the way it bounds any slow command.
