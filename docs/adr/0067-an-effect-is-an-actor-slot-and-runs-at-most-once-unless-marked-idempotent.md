# An Effect is an actor slot, and runs at most once unless marked idempotent

An Effect is work a Machine does outside itself. A Machine already runs Agents and Gates as actors (ADR-0049); work such
as running the tests had no place of its own, so an author either asked an Agent to do it (and trusted its word) or
wrote a raw xstate promise that a restart ran again. jr2 builds four kinds: `command`, run a program in the Workspace;
`http`, call a URL; `upload`, send a Worktree file to a URL; and `push`, push the Workspace's branch to its Repo Slot's
Binding. An Effect that holds a secret runs in an Effector
([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).

## Decision

- **An Effect is an actor slot beside `agent()`.** `actors: { tests: command(["pnpm", "test"]) }`, invoked as
  `src: "tests"`, with an `onDone` that routes on its output. xstate gives the rest: the Effect stops when its state
  exits, its input persists with the snapshot, a `src` typo is a compile error, and `.provide()` is the unit-test seam.
  The slot carries its parts as plain data — kind, placement, timeout; a `command`'s argv, Repo Slot and the secrets its
  env names; an `http` or `upload` Effect's method, fixed host and the names of the secrets it names; a `push`'s `pin`,
  `sign`, `squash` and `force` — which `jr2 up` prints and the Machine doc carries, read without running anything. An
  Effect written inline (`invoke: { src: http({...}) }`) is refused at build and at load, with the slot form in the
  message: xstate gives it a generated key that moves when a state is renamed, so the ledger, the report and the Machine
  doc would name it by a number, and `customize()` — `provide`, keyed on `actors` — could not reach it. The same rule
  holds for `agent()` and `workspace()` (ADR-0049): a Part is a key of `actors`, and every Effect kind is one (the brand
  `isEffect` reads).
- **Between a pick and its work: `fromPick`, `paramsOf`, `answer`.** All optional; a plain mapper is legal.
  `fromPick(def, fill)` is the `input` of a state a pick enters: the pick's params flow into the Effect's input by name,
  `fill` returns only what the Machine adds, and the sum is checked against the Effect's input type — the security
  boundary in one expression (what the Agent supplies, what the Machine adds). The type check catches a missing or
  mistyped key; it accepts an extra one, so the load walk refuses a param that is no key of the input (below).
  `paramsOf(event, def)` reads the same params for a plain mapper. `answer(({ context, event, chain }) => …)` is an
  xstate action that sets what the Agent reads when its pick is answered (ADR-0024); `chain` is every reply since the
  pick, oldest first, each a link typed by its slot (`{ kind: "output", src, output }`) or by the Machine's events
  (`{ kind: "event", event }`); its order and length are not typed. A link is a reply from outside the Machine; the
  events it sent itself are skipped. The value is JSON on the wire and in the hold; one with no JSON form sets nothing.
  An `answer` shapes only the pick of the Agent whose state it is written below (on a state's entry or exit, or on a
  transition of a state, at or below that Agent's state); one written below no Agent's state may shape any Agent's. A
  child's error is no link, and by default the Agent is not told (ADR-0024); an author who wants it told writes
  `answer(...)` on the `onError` route. An Effect never takes that route for an outcome: every outcome is output.
- **argv, never shell text.** Each entry is one argument; `arg("x")` is one argument filled from the invoke's input. The
  Harness spawns `argv[0]` with no shell. `sh -c` is the author's explicit choice, in the argv, and its result is not a
  trusted verdict.
- **Placement follows the kind and what it names; it is never authored.** A `command` that names no secret, an `http`
  Effect with no Worktree file, and an `upload`, a `push` and a `command` that names a secret each have one place: the
  Harness container, the Instance Effector, and the Sandbox Effector of the Workspace whose body invokes it. There is no
  `placement:` key: naming a secret is what places the command (ADR-0068).
- **A `command` that names no secret runs in the Harness container of its Workspace's Sandbox**, as a child of the
  Harness process: the Agent's user, the Sandbox Image's tools, the same Stand-ins as the Agent's `bash` (ADR-0059), and
  no credential of its own. The Harness serves it on `/exec/:id`, behind the same bearer as every Harness route
  (ADR-0058); the Instance Harness holds no Workspace and refuses it (ADR-0031). Outside a `workspace()` a command is
  refused at invoke. Its cwd is a Repo Slot's Worktree: the one slot, or the slot it names (`slot`); several and none
  named is refused (ADR-0051).
- **Every outcome is output**: `exited | timeout | killed | unknown` for a `command`;
  `response | unreachable | refused | unknown` for an `http` or `upload` Effect;
  `pushed | rejected | diverged | unknown` for a `push`. A command not found is `exited` 127; a path segment that is
  `.`, `..` or empty, and an upload's path that is a symlink, leaves the Worktree, is absolute, is a FIFO or has more
  than one link, are `refused` with nothing sent — an Agent's param can cause each. `onError` is only a jr2 or config
  defect: no Workspace, an argv slot with no value, an input that misses the definition's schema, no Effector to send
  to.
- **An `http` Effect is a definition plus one function.**
  `http({ method, url, headers?, auth?, input?, request?, timeout?, maxBody?, idempotent? })`. The url's scheme and host
  are literal — a secret, named with `secret("name")`, may sit only in its path, through the `text` template, and one
  after a `?` or a `#` is refused when the Machine loads — so the host is fixed by the definition and never a param.
  `auth` is `bearer(secret(…))`, `basic(user, password)` or a `text`. `request(input)` returns the run's part alone:
  `path` segments and a JSON or text body. So an Agent's param reaches a path segment or a body, never the host, a
  header or a secret. It runs in the Instance Effector, which builds the request and holds the secrets (ADR-0068); the
  Orchestrator signs the call and holds none.
- **A credentialed `command`: `command(argv, { env: { NAME: secret("x") | secret("x").path }, pin? })`.** It runs in the
  Sandbox Effector, against one commit: the Agent's branch tip when it starts, or — with `pin` — the commit the Effect's
  input names (`{ sha }`, one a Gate approved). That commit is checked out into a fresh scratch of the Effect's own by
  the push's import procedure (below), so the Agent's uncommitted edits are never seen; the answer carries `dirty: true`
  beside the output when the Worktree held some (a status in jr2's clean repository over a copy of the Worktree's index,
  read as data; when it cannot tell, it says dirty). The child's env is what the author named — a secret's value, or its
  file's path — plus `PATH` and `HOME`, and nothing else; `HOME` is the scratch's, and the scratch is removed once the
  outcome is read. Its output is scrubbed (ADR-0068). jr2 claims three things for it, not the push's fourth: the Agent
  never reads or spends the secret (a container it cannot exec in); the tool sees a pinned commit, not the live
  Worktree; the output is scrubbed. The Agent's files are the author's choice to run — a tool's plugins, a `local-exec`,
  a `credential_process` — so "no program the Agent's files name runs" is not claimed for it.
- **An `upload` is an `http` definition whose body is a Worktree file.**
  `upload({ method?, url, headers?, auth?, input?, file, contentType?, slot?, timeout?, maxBody?, idempotent? })`:
  `file(input)` returns the file's path relative to the Repo Slot's Worktree (and path segments, as `request` gives
  them). The Sandbox Effector opens it with `openat2` beneath the work root — `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`,
  `RESOLVE_NO_MAGICLINKS`, `RESOLVE_NO_XDEV`, non-blocking — then `fstat`: a symlink at any component (one that stays
  inside included), `..`, an absolute path, a FIFO, a directory and a file with more than one link are refused, in
  words, as output. A file-body `http` uses the same opener. The method defaults to `PUT`, the content type to the
  definition's or `application/octet-stream`.
- **A `push` pushes the Workspace's branch to its Repo Slot's Binding**, from the Sandbox Effector, with no input:
  `push({ pin?, sign?, squash?, force?, slot?, timeout? })`. Its credential is the push credential of the
  `git.credentials` entry the Binding falls under (ADR-0051), which the Effector matches as the fence does. git never
  runs with the Agent's repository as its repository: each call makes a new bare repository in the Effector's scratch,
  configured by jr2 under a cleared environment; it reads the Agent's branch as data (a loose ref or `packed-refs`,
  opened beneath with no symlink, bounded); it imports the Agent's objects as data — one `pack-objects` over the Agent's
  object store with a deadline (a FIFO in place of an object blocks an open forever), `index-pack --strict`, and a
  connectivity check — borrowing only from the node's Repo cache; and it pushes `<commit>:refs/heads/<branch>` to the
  Binding url, never to a remote of the Agent's config. So no config, hook, attribute or program of the Agent's runs; a
  test plants each in the Agent's repository and proves none ran. A token goes Basic through a credential helper only,
  and the helper is the Effector binary (`effector git-credential`), which reads the token's file when git asks; an ssh
  key is copied into the call's directory (a Secret mount's mode is one ssh refuses), with `known_hosts` checked
  strictly. The commit is pinned when the push starts: the Agent's branch tip, or with `pin` the commit the input names
  (`{ sha }`); the Effector's first answer names it, and it is written to the intent row. A pinned commit the Agent
  pruned fails the import and is never substituted. `squash` (built with `sign` only) makes one commit with the input's
  `{ message }`; `force` replaces what the remote holds.
- **`sign`: nothing unsigned leaves.** The Effector re-creates the Agent's commits, each signed with the entry's `sign`
  key — ssh (`ssh-keygen -Y sign`) by default, GPG allowed; a GPG key with a passphrase is refused, by name. The author
  line, its date included, stays the Agent's; the committer is the entry's name and email at the Effector's clock. The
  new commits are found by ancestry: the published tip must be an ancestor of the Agent's tip. When it is not, a
  read-only fallback pairs the published commits with the Agent's — `pair`, the ledger's last push (its published commit
  and its source), then `cherry`, each published commit after the merge base paired with one Agent commit by a stable
  patch-id, author line and message (a merge by its tree and non-first parents) — and when nothing pairs cleanly the
  push is `diverged` and nothing is pushed. Every commit the remote lacks must be one the call signed, or the push is
  `diverged`. `pushed` carries the published commit, its source, what the remote held before, how the new commits were
  found (`ancestry | pair | cherry | force`), `unchanged` when the remote already held it, and the signed commits as a
  bundle (commit objects only) for the sync step; the bundle never reaches the Machine. The Agent is never told to
  rebase: a rebase repair loses a reworded message and duplicates empty commits and merges. A side branch the Agent made
  before the push and merges later is signed again, so a duplicate signed commit can be published — with an ssh key too,
  because the committer date is the Effector's clock and a second signing is a second commit.
- **The process group ends with the exec.** Each exec leads its own group; its timeout, a kill, and its top process's
  exit each SIGKILL the group, so nothing it started outlives it. A bounded tail (default 4096 characters) is the
  output; the full stream goes to the run's feed (Instance-token band).
- **A write-ahead ledger; no second fire the author did not mark.** One row per Effect in the run's blob (ADR-0007,
  ADR-0065): an `intent` row saved at the write, with the snapshot that holds the Effect, before the request leaves; a
  `settled` row with the output, saved at the write just before the transition it drives and kept by the save that
  carries that transition, so a restart that loses the transition's save still delivers the output and runs nothing. On
  restore: settled → the output is delivered; no row → nothing was sent, so it starts; intent → per kind. A `command`
  re-attaches to the exec by id, or settles `unknown` when the Harness no longer knows it (it restarted); it is never
  run again by jr2: it runs the Agent's code, which may spend a Stand-in. A credentialed command re-attaches to its
  Sandbox Effector by id, or settles `unknown`, and is never run again. A `push` intent row names its Sandbox and, once
  the Effector's first answer names it, the pinned commit: a restore asks the Effector for its id and follows it, and
  when the Effector no longer holds it the push is sent again with only that commit — never the Agent's tip now; with no
  commit recorded it settles `unknown`. An `upload` follows the `http` rule. An `http` intent row names its placement
  and no replica: the Effect asks every replica of that Effector for its id and follows the one that holds it; when none
  does, it is sent again only when the author marked it `idempotent`, and any other settles `unknown`. Retry is the
  author's choice — a route back into the state, or `idempotent` for a call that carries its own idempotency key or only
  reads. No row is dropped: each settled or aborted row keeps the Effect's id, kind and outcome for the run's life, the
  record of what the run's Effects did. A settled row's output tail is dropped once the save that carries its transition
  is on disk; the full stream is on the feed. An `http` response's body and headers are its tail: the row keeps the
  outcome, the status, the content type and the size, and the settled line on the feed carries the whole response. A
  `push` row keeps its published commit and its source whole — the next push reads them as its pair — and drops its
  bundle and git's words. So an Effect in a loop grows the ledger by one short row per pass, never by its tails. One
  exception, bounded by one pick: while a pick is outstanding, its hold keeps the `chain` whole, tails included, because
  an `answer` action may read it after a restore; a loop below the Agent's state then grows the hold by one tail per
  pass. The hold drops its chain when the pick is answered.
- **A start is sent once where it may have arrived.** A Harness runs one id once only within its own process; a
  restarted Harness knows no id. So the Orchestrator sends a start again only when it certainly never left (the
  connection was refused, the name did not resolve). Any other failure — a reset, a 5xx, no answer — may follow a start
  the Harness ran: the Orchestrator reads the exec by id instead, follows it when the Harness knows it, and settles
  `unknown` when it does not. It then sends a kill for that id, which keeps a start still on the wire from running. An
  `http` start follows the same rule over the Effector's replicas: one that was never reached, or that answered it is
  stopping (it starts nothing then), is sent to another; any other failure asks every replica first, and the restore
  rule above decides when none holds it. A replica that stops answering for an Effect it was followed on — gone, or
  restarted — is the same case.
- **D1: an Effect is stopped when its state exits.** The exec's group is killed. The kill is sent again until the
  Harness keeps it, for at most the command's timeout (past it the Harness's own timer has ended the group); a kill that
  never reaches it is said on the feed. A fast exit can send the kill while the start is still on the wire: the Harness
  keeps a kill of an id it does not know, and the start that arrives after it runs nothing. The abort goes to the ledger
  (`aborted`, saved with the transition that exited the state — a cancel's final save carries it) and the feed, "outcome
  unknown"; the Machine does not get it — the state that asked has left. An `http` Effect has no cancel route: its
  state's exit stops the polling, and the abort goes to the ledger and the feed the same way, "the Effector may still
  send it; outcome unknown". The Effector finishes the call and drops an outcome nobody reads. Two stops are not exits:
  the host parking the run (`hostStopping`, ADR-0024) and an Orchestrator shutdown (it stops no actor). The Effect then
  re-attaches on restore, or settles `unknown`. There is no "finally": cleanup is a state.
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
  history state that may enter an Effect's state are a warning; and a state below an Agent's state that invokes
  something and that nothing enters is refused.

## Considered options

- **Run every command in the Sandbox Effector.** Rejected: a command that names no secret runs the Workspace's own code
  with the Sandbox Image's tools and the Agent's user, and gains nothing from a container the Agent cannot reach. Only a
  command that names a secret runs there, because a tool that signs with its credential (`terraform apply`, `aws` with
  SigV4) cannot be given a Stand-in (ADR-0059).
- **A `placement:` key on a command.** Rejected: naming a secret is the placement, and a key could disagree with it.
- **A trailer on each signed commit naming its source.** Rejected: forges show it, and the map must be read off every
  published commit or an unsigned one leaks; ancestry, the sync and the read-only fallback need no stored map.
- **Take a command as a shell string.** Rejected: an Agent's param in a string is a shell injection.
- **Repeat a command whose outcome is unknown.** Rejected: it may have acted (a push from a script, a spent Stand-in).
  The Machine gets `unknown` and decides.
- **A fire-and-forget Effect (`spawnChild`, or a flag).** Rejected for the reasons above; nothing the Machine starts may
  outlive the state that asked for it.

## Consequences

- A command a Harness restart cut settles `unknown`; the stream before the restart is on the feed.
- An Orchestrator restart mid-command gives one run: the restored Effect reads the exec from its current end and settles
  with its output.
- Not built: an `answer` that may shape two Agents' picks while both are outstanding at once — one written below no
  Agent's state, or one action object written below two Agents' states. Which pick it shapes is not decided; today it
  sets nothing, and each pick keeps its default answer.
- An `http` call an Orchestrator restart caught in flight gives one send: the restored Effect finds it on the replica
  that holds it. One the Effector lost gives `unknown`, or a second send when it is `idempotent`.
- A push the Orchestrator restart caught in flight gives one push of the pinned commit; one the Effector lost is pushed
  again with that commit alone.
- Not built: the Sandbox Effector in a real pod. The Effector binary runs every Sandbox kind, and the Orchestrator
  builds each start from the Workspace's handles and keeps the ledger above, but the Orchestrator does not yet add the
  `effector` container at provision, `jr2 up` writes no `jr2-effector-<workspace>` Secret and makes none of the push
  refusals of ADR-0051, and the Orchestrator has no address for a Sandbox Effector: the Sandbox's Service names the
  Harness's port only, and a request is signed for the pod's own address. Until then a Sandbox kind faults at invoke,
  naming this.
- Not built: the sync step that moves the Agent's branch to the signed commits after a signed push, and the text the
  Agent reads after one.
- Owed, not built: an Open argv bound by `customize()`.
