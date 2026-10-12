# An Effect is an actor slot, and runs at most once unless marked idempotent

An Effect is work a Machine does outside itself. A Machine already runs Agents and Gates as actors (ADR-0049); work such
as running the tests had no place of its own, so an author either asked an Agent to do it (and trusted its word) or
wrote a raw xstate promise that a restart ran again. jr2 builds three kinds: `command`, run a program in the Workspace;
`http`, call a URL — with a JSON or text body, or a Worktree file as its body; and `push`, push the Workspace's branch
to its Repo Slot's Binding. An Effect that holds a secret runs in an Effector
([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). A `command` whose env names a secret —
the credentialed `command` — runs there too, its child confined (below).

## Decision

- **An Effect is an actor slot beside `agent()`.** `actors: { tests: command(["pnpm", "test"]) }`, invoked as
  `src: "tests"`, with an `onDone` that routes on its output. xstate gives the rest: the Effect stops when its state
  exits, its input persists with the snapshot, a `src` typo is a compile error, and `.provide()` is the unit-test seam.
  The slot carries its parts as plain data — kind, placement, timeout; a `command`'s argv, Repo Slot and the secrets its
  env names; an `http` Effect's method, fixed host, the names of the secrets it names and whether its body is a Worktree
  file; a `push`'s `pin`, `sign`, `squash` and `force` — which `jr2 up` prints and the Machine doc carries, read without
  running anything. A packaged Machine may leave an `http` url (whatever its body) or a `command`'s argv Open (`open` in
  its place), and the name of one secret its auth, a header or a command's env names (`secret(open)`; never in a url),
  for the composer to bind once with `customize(machine, { effects: { <slot>: { url } | { argv } | { secret } } })` —
  one object with both keys for an Effect with two Open parts
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)); the slot then carries the
  Effect built again with the bound parts, and an Effect still Open runs nothing: its state's `onError`. An Effect
  written inline (`invoke: { src: http({...}) }`) is refused at build and at load, with the slot form in the message:
  xstate gives it a generated key that moves when a state is renamed, so the ledger, the report and the Machine doc
  would name it by a number, and `customize()` — `provide`, keyed on `actors` — could not reach it. The same rule holds
  for `agent()` and `workspace()` (ADR-0049): a Part is a key of `actors`, and every Effect kind is one (the brand
  `isEffect` reads).
- **Between a pick and its work: `fromPick`, `paramsOf`, `answer`.** All optional; a plain mapper is legal.
  `fromPick(def, fill)` is the `input` of a state a pick enters: the pick's params flow into the Effect's input by name,
  `fill` returns only what the Machine adds, and the sum is checked against the Effect's input type — the security
  boundary in one expression (what the Agent supplies, what the Machine adds). The type check catches a missing or
  mistyped key; it accepts an extra one, so the load walk refuses a param that is no key of the input (below). An Open
  argv's input is one string per key, so the type check catches neither for it: a slot the bound argv names that the
  input does not supply faults when the Effect starts (ADR-0054). `paramsOf(event, def)` reads the same params for a
  plain mapper. `answer(({ context, event, chain }) => …)` is an xstate action that sets what the Agent reads when its
  pick is answered (ADR-0024); `chain` is every reply since the pick, oldest first, each a link typed by its slot
  (`{ kind: "output", src, output }`) or by the Machine's events (`{ kind: "event", event }`); its order and length are
  not typed. A link is a reply from outside the Machine; the events it sent itself are skipped. The value is JSON on the
  wire and in the hold; one with no JSON form sets nothing. An `answer` shapes only the pick of the Agent whose state it
  is written below (on a state's entry or exit, or on a transition of a state, at or below that Agent's state). On a
  transition below no Agent's state, and as one action object written below two Agents' states, it shapes the pick of
  the Agent whose event took the transition — the sender of a pick, or the Agent whose pick started the child whose done
  event it is — and the other Agent's pick keeps its default answer; on an entry or an exit below no Agent's state it
  sets nothing (ADR-0024). A child's error is no link, and by default the Agent is not told (ADR-0024); an author who
  wants it told writes `answer(...)` on the `onError` route. An Effect never takes that route for an outcome: every
  outcome is output.
- **argv, never shell text.** Each entry is one argument; `arg("x")` is one argument filled from the invoke's input. The
  Harness spawns `argv[0]` with no shell. `sh -c` is the author's explicit choice, in the argv, and its result is not a
  trusted verdict.
- **Placement follows the kind and what it names; it is never authored.** A `command` that names no secret, an `http`
  Effect whose body is not a Worktree file, and a `push` each have one place: the Harness container, the Instance
  Effector, and the Sandbox Effector of the Workspace whose body invokes it. A `command` that names a secret, and an
  `http` whose body is a Worktree file, are placed in that Sandbox Effector — the command runs there with its child
  confined (below). There is no `placement:` key and no kind per placement: naming a secret places a command, and the
  body places an `http` — one name per thing, so there is no `upload` kind beside it (ADR-0068).
- **A `command` that names no secret runs in the Harness container of its Workspace's Sandbox**, as a child of the
  Harness process: the Agent's user, the Sandbox Image's tools, the same Stand-ins as the Agent's `bash` (ADR-0059), and
  no credential of its own. The Harness serves it on `/exec/:id`, behind the same bearer as every Harness route
  (ADR-0058); the Instance Harness holds no Workspace and refuses it (ADR-0031). Outside a `workspace()` a command is
  refused at invoke. Its cwd is a Repo Slot's Worktree: the one slot, or the slot it names (`slot`); several and none
  named is refused (ADR-0051).
- **Every outcome is output**: `exited | timeout | killed | unknown` for a `command` (`killed` with the signal that
  ended it; a stopped credentialed command's is `exited` with the stop's signal, D1);
  `response | unreachable | refused | unknown` for an `http` Effect; `pushed | rejected | diverged | unknown` for a
  `push`. A command not found is `exited` 127. A start over the bytes an Effector reads (ADR-0068) is sent nowhere and
  settles as its kind's own outcome — an `http` `refused`, a `push` `rejected` at stage `start` (nothing pushed), a
  credentialed `command` `exited` 127 with the reason in its tail, the Effector's own form for a command that could not
  start — since an Agent's param (a squash message, an argv part) can reach the bound; a path segment that is `.`, `..`
  or empty, and a file body's path that is a symlink, leaves the Worktree, is absolute, is a FIFO or has more than one
  link, are `refused` with nothing sent — an Agent's param can cause each. `onError` is only a jr2 or config defect: no
  Workspace, an argv slot with no value, an input that misses the definition's schema, no Effector to send to, an Open
  part nobody bound.
- **An `http` Effect is a definition plus one function.**
  `http({ method, url, headers?, auth?, input?, request?, body?, timeout?, maxBody?, idempotent? })`. The url's scheme
  and host are literal — a secret, named with `secret("name")`, may sit only in its path, through the `text` template,
  and one after a `?` or a `#` is refused when the Machine loads — so the host is fixed by the definition and never a
  param. A url left Open is fixed by the composer's `customize()` instead, once and before any run, under the same rules
  (ADR-0054); a file body does not change that rule. `auth` is `bearer(secret(…))`, `basic(user, password)` or a `text`.
  A secret the auth or a header names may be `secret(open)`, whose name the composer binds once in the same way; one in
  the url is refused. `request(input)` returns the run's part alone: `path` segments and a JSON or text body. So an
  Agent's param reaches a path segment or a body, never the host, a header or a secret. It runs in the Instance
  Effector, which builds the request and holds the secrets (ADR-0068); the Orchestrator signs the call and holds none.
  Its body may instead be a Worktree file, `body: file(path, { slot?, segments?, contentType? })`: the file's path
  relative to the Repo Slot's Worktree (the one slot, or the one `slot` names), and the url's path segments — each a
  value or a function of the input; no `request` is written beside it, since `file()` carries the run's part. Such an
  `http` is placed in the Sandbox Effector of the Workspace whose body invokes it, and `jr2 up` refuses one that no
  `workspace()` invokes, where no Worktree exists to read. It is sent with `PUT`, `POST` or `PATCH`. The Sandbox
  Effector opens the file with `openat2` beneath the work root — `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`,
  `RESOLVE_NO_MAGICLINKS`, `RESOLVE_NO_XDEV`, non-blocking — then `fstat`: a symlink at any component (one that stays
  inside included), `..`, an absolute path, a FIFO, a directory and a file with more than one link are refused, in
  words, as output. The content type is `file()`'s `contentType` or a `content-type` header of the definition's, not
  both: a definition with both is refused when the Machine loads ("write one of them", as for `auth` beside an
  `authorization` header). With neither it is `application/octet-stream`. A later body form (a multipart file and
  fields) is one more body on `http`, never a kind.
- **A credentialed `command`: `command(argv, { env: { NAME: secret("x") | secret("x").path }, pin? })`.** Naming a
  secret is what places it: it runs in the Sandbox Effector of the Workspace whose body invokes it, with no `placement:`
  key — and so does an env that names `secret(open)`, whose name the composer binds (ADR-0054). Its child runs as the
  Effector's uid beside the Effector's key, the secrets it does not name and the push credentials, and its argv may run
  a file the Agent wrote, so the Effector confines the child with Landlock before `execve` (ADR-0068): it may read and
  run the image's system paths, read and write its own scratch (its `HOME` and its `TMPDIR`; never `/tmp`, which every
  child would share), and read the secret files it names — nothing else. A node whose kernel cannot confine it runs
  none: the Effector of a Workspace that holds one does not become ready there, and the provision fails naming the node
  (ADR-0068). It runs against one commit: the Agent's branch tip when it starts, or — with `pin` — the commit the
  Effect's input names (`{ sha }`, one a Gate approved). That commit is checked out into a fresh scratch of the Effect's
  own by the push's import procedure (below), so the Agent's uncommitted edits are never seen; the answer carries
  `dirty: true` beside the output when the Worktree held some (a status in jr2's clean repository over a copy of the
  Worktree's index, against the Worktree's own HEAD — never the pin, so the commits the Agent made after an approved one
  are not edits — read as data; when it cannot tell, it says dirty). The child's env is what the author named — a
  secret's value, or its file's path — plus `PATH`, `HOME` and `TMPDIR`, and nothing else; `PATH` is the Effector
  container's own, as its image set it (the tools are the author's), and `argv[0]` is looked up there; `HOME` and
  `TMPDIR` are the scratch's, and the scratch is removed once the outcome is read. Its output is scrubbed as it streams,
  before it is cut to its tail (ADR-0068). The Agent's files are the author's choice to run — a tool's plugins, a
  `local-exec`, a `credential_process` — so "no program the Agent's files name runs" is not claimed for it. Its claims
  are three: the Agent never reads or spends the secret (a container it cannot exec in, and a child confined from the
  files of every other secret and of the Effector's key), the tool sees a pinned commit and not the live Worktree, and
  the output is scrubbed. Landlock governs files, not `connect()`, and a GPG-signed push holds the signing key on a
  `gpg-agent` socket while it signs; so the Sandbox Effector never runs the two at once: one lock over two classes,
  `gpg` and `command`, and a waiter that settles timed out past its own timeout (ADR-0068). A Workspace may hold both.
- **A `push` pushes the Workspace's branch to its Repo Slot's Binding**, from the Sandbox Effector, with no input:
  `push({ pin?, sign?, squash?, force?, slot?, timeout? })`. Its credential is the push credential of the
  `git.credentials` entry the Repo Slot's url falls under (ADR-0051): the provision matches the url the run binds —
  static, per-run or `customize()`-bound, one path — and names that entry's push Secret on the Sandbox, and the
  Effector, which holds only the entries named there, matches the push's url as the fence does. git never runs with the
  Agent's repository as its repository: each call makes a new bare repository in the Effector's scratch, configured by
  jr2 under a cleared environment; it reads the Agent's branch as data (a loose ref or `packed-refs`, opened beneath
  with no symlink, bounded); it imports the Agent's objects as data — one `pack-objects` over the Agent's object store
  with a deadline (a FIFO in place of an object blocks an open forever), `index-pack --strict`, and a connectivity check
  — borrowing only from the node's Repo cache; and it pushes `<commit>:refs/heads/<branch>` to the Binding url, never to
  a remote of the Agent's config, and never to a local path (git's local transport runs that repository's config and
  hooks, and a path in the pod can be the Agent's own repository; only the binary's tests can allow one). So no config,
  hook, attribute or program of the Agent's runs; a test plants each in the Agent's repository and proves none ran. A
  token goes Basic over https through a credential helper only — an `http://` url with a token is `rejected` with
  nothing sent — and the helper is the Effector binary (`effector git-credential`), which reads the token's file when
  git asks for the Binding's own host over https and answers nothing for any other; the clean repository follows no
  redirect, so neither the push nor the token reaches an origin outside the entry; an ssh key is copied into the call's
  directory (a Secret mount's mode is one ssh refuses), with `known_hosts` checked strictly. The commit is pinned when
  the push starts: the Agent's branch tip, or with `pin` the commit the input names (`{ sha }`); the Effector's first
  answer names it, and it is written to the intent row. A pinned commit the Agent pruned fails the import and is never
  substituted. `squash` makes one commit with the input's `{ message }`, on the published base: the Agent's tree, its
  author line and date, the Machine's message. It is a new commit, so it needs a committer. With `sign`, the signer is
  the committer, as for every signed copy. Without it (signing is optional, and `squash` is an option of its own), the
  matching `git.credentials` entry's `committer: { name, email }` commits it, at the Effector's clock — or, when the
  entry names no committer, its `sign` field's name and email. `jr2 up` refuses `squash` without `sign` only when the
  matched entry has neither `sign` nor `committer`, naming both fixes (a `committer`, or a signed push and its `sign`
  field), and the provision refuses it the same way for a slot the run or a `customize()` binds. `force` replaces what
  the remote holds.
- **`sign`: nothing unsigned leaves.** The Effector re-creates the Agent's commits, each signed with the entry's `sign`
  key — ssh (`ssh-keygen -Y sign`) by default, GPG allowed; a GPG key with a passphrase is refused, by name. The author
  line, its date included, stays the Agent's; the committer is the entry's name and email at the Effector's clock. The
  new commits are found by ancestry: the published tip must be an ancestor of the Agent's tip. When it is not, a
  read-only fallback pairs the published commits with the Agent's — `pair`, the newest of the ledger's pushes whose
  published commit is the remote's tip (its published commit and its source), then `cherry`, each published commit after
  the merge base paired with one Agent commit by a stable patch-id, author line and message (a merge by its tree and its
  non-first parents as mapped by the pairs made before it, the rule the map below keys a merge by) — and when nothing
  pairs cleanly the push is `diverged` and nothing is pushed — with `force` too: `force` replaces a remote branch that
  moved, and never stands in for a pairing. One case is neither: a squash push whose published tip is this squash's
  exact image — the source's tree, author line and encoding, the Machine's message, as its one parent the newest pair's
  published commit (on a first push, the merge base with the base), the committer name and email of jr2's squash
  committer (the signer with `sign`, else the entry's `committer`, below), and with `sign` a signature that verifies
  against the slot's signing key — is this push's own commit, sent again by a restore after the Effector lost it while
  the push in flight had no settled row; it settles `pushed`, `unchanged`, with the sync bundle and its own `squashed`.
  A full comparison of those fields, not a pairing. Dates and signature bytes are not compared: the restore sends the
  push at a later clock, and a signature need not be deterministic. A tip with this squash's tree, parent, author line
  and message under another committer, or with `sign` and no signature that verifies against the slot's key, is not
  jr2's own: the push is `rejected`, with no sync bundle and nothing pushed, and its reason says which. Then, on every
  push and before anything is signed, the same map runs over the new commits, oldest first, and a commit that has a
  published twin is replaced by that twin in the rewritten history; only the unmapped commits are signed. The twin is a
  ledger pair, taken as it is — each names the one exact commit a push published for its source, a signed copy or a
  squashed commit; the pairs of every push of the Repo Slot are read, each only while the remote still holds its
  published commit, the newest push's when two name one source — or else a published commit after the commit's merge
  base with the remote's tip, each taken once, that has the commit's cherry key, read with the commit's parents as
  mapped so far (a merge of the Agent's own side branch keys on the published copies of its non-first parents), and is a
  faithful image of it: the commit's tree, and as parents the commit's own parents as mapped so far. Every commit the
  remote lacks must be one the call signed, or the push is `diverged`. `pushed` carries the published commit, its
  source, what the remote held before, how the new commits were found (`ancestry | pair | cherry`), `unchanged` when the
  remote already held it, `squashed: signed | unsigned` when the published commit is one squashed commit (absent for
  signed copies; it names what the published commit is, not what the push's options ask for: a commit the call made is
  named by its options, and the published tip that an earlier push made, which `pair` or `cherry` maps, by that push's
  own `squashed`, which its pair carries), and — whenever the published commit is not the Agent's own — the published
  commits as a bundle for the sync step (`git bundle create` of the published tip, with the Agent's tip as its
  prerequisite: the new commits, and the trees and blobs git adds beside them, which the Agent's store may already
  hold). A push that publishes nothing new carries one too: when `pair` or `cherry` maps the published tip itself (a
  restore that sends a pinned push again, a push after a sync that did not finish), or the published tip is this
  squash's own (a restore that sends a squash push again), the Agent's branch still holds its own commits. The bundle
  never reaches the Machine. A push sends every pair the ledger holds for its Workspace and Repo Slot — one branch on
  one remote — oldest push first (`pairs`, omitted when there is none): each push that published, with its published
  commit, its source and its `squashed`; the Effector stays stateless. The pair stands for the published tip only while
  the remote still holds that push: a remote that moved past it (another writer) is paired by `cherry` or is `diverged`,
  never grafted onto. The Agent is never told to rebase: a rebase repair loses a reworded message and duplicates empty
  commits and merges. A published commit is never signed twice, for every signer and key type: a side branch the Agent
  made before the push and merges later carries the unsigned original of a commit the remote holds signed, which
  ancestry calls new, and the map replaces it by its twin — a merge the Agent made before the first push included, and,
  through the ledger's pairs, a side branch made before a squash and merged by any later push, whose commits the
  squashed commit stands for: the squash's pair maps its source to the squashed commit however many pushes came after
  it, so a side branch merged by one push and a branch made on it merged by the next publish only what is new. The pair
  maps a squash's SOURCE only, and that is a named limit: a side branch made at an earlier commit of the squashed range
  publishes the commits it descends from as signed copies beside the squashed commit. Those commits were never
  published, none is signed twice, and the trees are the Agent's; such a commit has no faithful twin, and mapped to the
  squashed commit the push would publish a false diff. The committer date stays the Effector's clock; a deterministic
  re-sign (the Agent's committer date) was rejected, since it rests on one key type's property, not GPG's or ECDSA's. A
  key alone does not pair: a commit the Agent reverts and applies again with cherry-pick has the key of the first one,
  and the first one's published copy has older parents, so paired with it the push would offer that older copy as the
  new tip — `rejected` as non-fast-forward without `force`, a rewind of the remote with it. The faithful image is the
  rule; the cherry fallback keeps its own, that the last paired commit holds the published tip's tree. The map's cost is
  bounded by the push's size.
- **The sync: after every push whose published commit is not the Agent's own, the Agent's branch moves to it** — signed
  copies, or one squashed commit, signed or not; the decision keys on `published` ≠ `source`, never on `sign` — in the
  Harness container (`POST /sync`, behind the Harness bearer, ADR-0058), from the bundle the Effector wrote, which the
  Orchestrator relays — never a shared volume: the Worktree stays read-only on the credentialed side. Under a cleared
  environment and a config that names no hook, no fsmonitor, no alternate-refs command and no maintenance, the Harness
  verifies and unbundles the bundle (objects only), checks that the published tip is a commit with the source's tree (it
  reads no signature), answers `busy` when a rebase of the branch, or a merge, cherry-pick, revert or sequence in a
  worktree whose HEAD is the branch, is in progress, and otherwise copies each commit the Agent made after the source as
  its raw object with only its parents changed, then moves the branch with one `git update-ref <new> <old>` — a
  compare-and-swap, tried again from the new tip at most 3 times — so files, index, HEAD and stash do not change. Its
  answer is a field of the push's output beside the outcome: `sync: synced | already | skipped | busy | not-synced`,
  with `syncReason` when it moved nothing (a push that published the Agent's own commit is `skipped`, with no call and
  no bundle; every other push is synced, one that published nothing new included, so a plain push of the slot after a
  squash is a fast-forward of the squashed commit). A Harness that cannot be reached answers `not-synced`; the push
  stays `pushed`. When the last push of a Repo Slot answered `busy` or `not-synced`, jr2 runs its sync again before that
  slot's next push, in that slot's Worktree and with that push's bundle, which its row keeps until a sync finished or a
  newer push of the slot published. The push never trusts the sync's answer: the Agent owns its repository and can move
  the branch at any time, so the next push derives everything again from the remote and the Agent's objects. After such
  a push the Agent reads, beside the output, what moved — signed copies of its commits with new ids, or its commits
  squashed into one commit, named "signed" only when it is — and that jr2 moved its branch to it, or did not and why;
  that its files, index and stash did not change; and that amending, rebasing or resetting the pushed commits makes the
  next push `diverged`. The Harness keys that paragraph on a synced push whose published commit is not the Agent's, and
  its words on `squashed`.
- **The process group ends with the exec.** Each exec leads its own group; its timeout, a kill, and its top process's
  exit each SIGKILL the group, so nothing that stays in the group outlives it. In the Harness container a descendant
  that leaves the group (`setsid`) is not killed; it holds no credential. A credentialed command's descendant cannot
  leave: its Effect's keeper and the Sandbox Effector are subreapers, and every process an Effect started, a `setsid`
  escapee included, is killed and reaped before the Effect settles, while a live command's daemon is not another
  Effect's to kill (ADR-0068). A descendant that keeps the output open does not hold the outcome. A bounded tail
  (default 4096 characters) is the output; the full stream goes to the run's feed (Instance-token band).
- **A write-ahead ledger; no second fire the author did not mark.** One row per Effect in the run's blob (ADR-0007,
  ADR-0065): an `intent` row saved at the write, with the snapshot that holds the Effect, before the request leaves; a
  `settled` row with the output, saved at the write just before the transition it drives and kept by the save that
  carries that transition, so a restart that loses the transition's save still delivers the output and runs nothing. On
  restore: settled → the output is delivered; no row → nothing was sent, so it starts; intent → per kind. A `command`
  that names no secret re-attaches to the exec by id, or settles `unknown` when the Harness no longer knows it (it
  restarted); it is never run again by jr2: it runs the Agent's code, which may spend a Stand-in. A `push` intent row
  names its Sandbox and, once the Effector's first answer names it, the pinned commit: a restore asks the Effector for
  the id and follows it, and when the Effector no longer holds it the push is sent again with only that commit — never
  the Agent's tip now — because its run is a function of the commit and its credential, what the intent row records;
  with no commit recorded it settles `unknown`. A credentialed command follows the push's rule: its intent row names its
  Sandbox and, once the first answer names it, the pinned commit, and one the Effector lost is sent again with only that
  commit, since its run is a function of (commit, argv, secrets). An `http` intent row names its placement — the
  Instance Effector, or the Sandbox of a file-body `http` — and no replica: the Effect asks every replica of that
  Effector for its id and follows the one that holds it; when none does, it is sent again only when the author marked it
  `idempotent`, and any other settles `unknown`. Retry is the author's choice — a route back into the state, or
  `idempotent` for a call that carries its own idempotency key or only reads. No row is dropped: each settled or aborted
  row keeps the Effect's id, kind and outcome for the run's life, the record of what the run's Effects did. A settled
  row's output tail is dropped once the save that carries its transition is on disk; the full stream is on the feed. An
  `http` response's body and headers are its tail: the row keeps the outcome, the status, the content type and the size,
  and the settled line on the feed carries the whole response. A `push` row keeps its Repo Slot, its published commit,
  its source, its `squashed` and its sync's answer whole — every later push of its Workspace and Repo Slot sends them as
  one of its pairs, and the newest push's sync, when it did not finish, runs again — and drops git's words; it drops its
  bundle once its sync answered `synced`, `already` or `skipped`, and keeps it while the sync is `busy` or `not-synced`
  only as long as it is the newest push of its Repo Slot that published, because the sync that runs again moves the
  branch from it and only the newest push's sync runs again. Once a newer push of the slot published, the older row's
  bundle goes at the next save: one bundle per Repo Slot at most. So an Effect in a loop grows the ledger by one short
  row per pass, never by its tails. One exception, bounded by one pick: while a pick is outstanding, its hold keeps the
  `chain` whole, tails included, because an `answer` action may read it after a restore; a loop below the Agent's state
  then grows the hold by one tail per pass. The hold drops its chain when the pick is answered.
- **A start is sent once where it may have arrived.** A Harness runs one id once only within its own process; a
  restarted Harness knows no id. So the Orchestrator sends a start again only when it certainly never left (the
  connection was refused, the name did not resolve). Any other failure — a reset, a 5xx, no answer — may follow a start
  the Harness ran: the Orchestrator reads the exec by id instead, follows it when the Harness knows it, and settles
  `unknown` when it does not. It then sends a kill for that id, which keeps a start still on the wire from running. An
  `http` start follows the same rule over the Effector's replicas: one that was never reached, or that answered it is
  stopping (it starts nothing then), is sent to another; any other failure asks every replica first, and the restore
  rule above decides when none holds it. A replica that stops answering for an Effect it was followed on — gone, or
  restarted — is the same case.
- **D1: an Effect is stopped when its state exits.** A `command` that names no secret: the exec's group is killed. The
  kill is sent again until the Harness keeps it, for at most the command's timeout (past it the Harness's own timer has
  ended the group); a kill that never reaches it is said on the feed. A fast exit can send the kill while the start is
  still on the wire: the Harness keeps a kill of an id it does not know, and the start that arrives after it runs
  nothing. A credentialed `command`: when its actor stops before its process ends — the state exits, or the run is
  cancelled — the Orchestrator sends one `DELETE /effects/<id>` on the Effect's own path to its Sandbox Effector, signed
  like every Effector request (ADR-0068), so nothing in the Harness container can send it. The Effector sends SIGTERM to
  the command's process group, waits 5 s, then sends SIGKILL, and runs its settle loop (ADR-0068's subreaper rule), so
  no process the command started outlives it; the Effect settles `exited` with the signal the stop sent last — SIGTERM,
  or SIGKILL past the wait — and, when the program caught SIGTERM and exited, with its code too. What the DELETE answers
  is said on the feed after the abort's line: "its Sandbox Effector stopped it: exited with SIGTERM", or that the stop
  did not reach the Effector and the command may run until its timeout. A run that has ended (a cancel, a final state)
  has no feed: the line goes to the Orchestrator's log, as does a kill that never reached a Harness. The abort goes to
  the ledger (`aborted`, saved with the transition that exited the state — a cancel's final save carries it) and the
  feed, "outcome unknown"; the Machine does not get it — the state that asked has left. An `http` Effect has no stop
  route: its state's exit stops the polling, and the abort goes to the ledger and the feed the same way, "the Effector
  may still send it; outcome unknown". The Effector finishes the call and drops an outcome nobody reads. A file-body
  `http` and a `push` have none either: each is one request that ends on its own, and one a state exit cut runs on in
  the Sandbox Effector to its end; the abort says "the Sandbox Effector may still run it; outcome unknown". Two stops
  are not exits: the host parking the run (`hostStopping`, ADR-0024) and an Orchestrator shutdown (it stops no actor).
  Neither stops a command; the Effect then re-attaches on restore, or settles `unknown`. There is no "finally": cleanup
  is a state.
- **Must-finish is a pattern.** An Effect that must not be cut goes in its own state, whose only exit is its `onDone`,
  and that state handles the ancestor's events itself.
- **No fire-and-forget form.** Two patterns keep D1: an Effect in its own state; or a second invoke with no `onDone`
  beside the state's work — it fires on state entry, a fast exit can cut it, and below an Agent's state it holds Rest
  until it settles. `spawnChild` is not used for an Effect: it is not stopped on exit, it runs again on restore, and it
  is orphaned after a final state — each breaks D1 or the ledger.
- **Rest counts an Effect like any child.** A running Effect below an Agent's state holds the Agent's pick (ADR-0024); a
  settled Effect with no `onDone` is Rest. An Effect is not a long-lived invoke, and the load walk does not warn on one.
- **The load walk checks what a pick hands an Effect** (ADR-0015): a pick param nothing reads — per state, so any invoke
  of the state may read it, a second invoke beside the Effect included (with `fromPick`, one that is no key of the
  Effect's input and that `fill` does not read; a guard on the entering transition and an `assign` count as reads; a
  pick enters what an eventless `always` moves on to; across an `after`, only a guard or `assign` before the timer reads
  it; a Gate's event is no pick and is not checked) and a `fill` that overwrites a param are refused; code the probe
  cannot or does not run — a mapper that throws in it, an action other than an `assign` — and a pick that targets a
  history state that may enter an Effect's state are a warning; a state below an Agent's state that invokes something
  and that nothing enters is refused; and an `answer` on an entry or an exit below no Agent's state, which shapes no
  pick, is a warning that names the Agent states it could be moved under. An Open argv's slots are unknown when the
  Machine is built, so every param counts as read by it then; `customize()` runs the pick-param check again when it
  binds the argv, refuses there a param the bound argv does not read, and gives the bound Machine the warnings the walk
  gives for that argv (ADR-0054).

## Considered options

- **Run every command in the Sandbox Effector.** Rejected: a command that names no secret runs the Workspace's own code
  with the Sandbox Image's tools and the Agent's user, and gains nothing from a container the Agent cannot reach. Only a
  command that names a secret is placed there, because a tool that signs with its credential (`terraform apply`, `aws`
  with SigV4) cannot be given a Stand-in (ADR-0059); there its child is confined from the Effector's mount (above).
- **A `placement:` key on a command.** Rejected: naming a secret is the placement, and a key could disagree with it.
- **A trailer on each signed commit naming its source.** Rejected: forges show it, and the map must be read off every
  published commit or an unsigned one leaks; ancestry, the sync and the read-only fallback need no stored map.
- **Take a command as a shell string.** Rejected: an Agent's param in a string is a shell injection.
- **Repeat a command whose outcome is unknown.** Rejected for a command that names no secret: it may have acted (a push
  from a script, a spent Stand-in), and its run is the live Worktree's, which no row records. The Machine gets `unknown`
  and decides. A credentialed command runs against a pinned commit its intent row holds, so a restore that found no
  Effect sends it again with that commit (above).
- **Sync through a volume the Effector writes and the Harness container reads.** Rejected: the Worktree is read-only on
  the credentialed side so that nothing there is a channel into the Agent's container; the bundle rides the
  Orchestrator's one call instead.
- **Tell the Agent to rebase onto the published commits.** Rejected: measured on a real repository, a rebase repair
  loses a reworded message, drops a re-applied commit, and duplicates empty commits and merges.
- **A fire-and-forget Effect (`spawnChild`, or a flag).** Rejected for the reasons above; nothing the Machine starts may
  outlive the state that asked for it.
- **An `upload()` kind beside `http({ body: file() })`.** Rejected: two spellings of one Effect, and a kind that, not a
  body, decided the placement. One kind, `http`, whatever its body.

## Consequences

- A command a Harness restart cut settles `unknown`; the stream before the restart is on the feed.
- An Orchestrator restart mid-command gives one run: the restored Effect reads the exec from its current end and settles
  with its output.
- An `http` call an Orchestrator restart caught in flight gives one send: the restored Effect finds it on the replica
  that holds it. One the Effector lost gives `unknown`, or a second send when it is `idempotent`.
- A push the Orchestrator restart caught in flight gives one push of the pinned commit; one the Effector lost is pushed
  again with that commit alone. A credentialed command the Effector lost runs again with its pinned commit, so its tool
  can run twice against one commit.
- A squash push sent again takes as its own only a remote tip that jr2's squash committer could have made: another
  writer's copy of the squash is `rejected`, never synced. The committer name and email are text anyone can write, so an
  unsigned squash's own commit is told from a copy by its content and that text alone; a signed one's also by a
  signature that only the slot's key makes.
- A state exit stops a credentialed command where it runs, and not a file-body `http` or a `push`: the Effector's stop
  route is the command's alone (ADR-0068), so for those two D1 holds for the Machine — it does not get the output — and
  not for the outside world. The stop is sent once: a DELETE that reaches the Effector before the command's start (a
  fast exit while the start is still on the wire) finds no Effect, and the command then runs to its end or its timeout.
- The Orchestrator reaches a Sandbox Effector by a headless Service the provision writes beside its key, owned by the
  Sandbox CR (`fx-` in place of the Sandbox name's `ws-`): its name resolves to the pod's own address, the one each
  request is signed for (ADR-0068), and it publishes that address while the pod is not ready, so a restore can ask the
  Effector for an Effect while the Harness beside it restarts. The operator's Service names the Harness's port only and
  is unchanged.
- The `@kind` tier pushes to a remote of its own: the seed's sshd serves a push remote, and the tier's scenarios push
  signed over ssh and verify the published commit with the signing key as the one allowed signer, read the Agent's
  branch and Worktree after the sync, and push again after the Agent amended the pushed commit (`diverged`). A token
  push over https has no remote there. Its credentialed-command scenarios read the secret from env and from its file,
  scrubbed, say `dirty` over an uncommitted edit, show a child of the child denied the Effector's key, and show a
  command whose state exited gone from the Effector container.
