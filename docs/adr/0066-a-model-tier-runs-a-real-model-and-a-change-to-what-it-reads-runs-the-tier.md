# A `@model` tier runs a real model, and a change to what the model reads runs the tier

Every tier fakes the model. The default e2e tier holds a stub Harness; conformance and `@kind` run the stock Harness
against a scripted provider that chooses each Turn's shape
([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md),
[ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)); `@dist` runs `ping`. So no suite can see a change in what a
model _does_ with what jr2 shows it. The evidence that such changes are large sits in prose:
[ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md) and
[ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md) measured the Allowed picks by hand on the
home-lab vLLM model — 0/10 obeyed ahead of the prompt, 10/10 after it — and nothing re-runs that measurement when
`briefing.ts`, the Menu's rendering, the Working tools' descriptions, Compaction, or the pi pin changes.
`briefing.test.ts` pins the _order_ of the text; it cannot tell whether a model still obeys it. And the paths a real
Agent takes through the kit as a whole — read a Repo, edit in a Worktree, run the tests, commit, hand off, be refused,
recover, finish — are exercised only one scripted tool call at a time.

## Decision

- **An opt-in `@model` tier: the `@kind` tier with the last fake removed.** Same shared vanilla kind cluster, same
  bring-up (`just e2e-kind-up`), same `jr2 up` per scenario into a fresh namespace, same seed Repo, same Custodian path
  — the endpoint's key is a Held secret bound to its host, and the Harness container holds a Stand-in
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). What changes is the provider the
  Custodian swaps toward: a real model endpoint instead of the World's scripted one. The pod runs the stock Harness, the
  model originates every tool call, and the wire, the container boundary, the git transport and the Machine are all the
  product's own. Tagged `@model`, profile `model` in `cucumber.json`, `just e2e-model`, excluded from the default
  profile and from `@kind`.
- **Two kinds of scenario: claims and the run.** A **claim** scenario re-states one ADR's measured claim as trials with
  a floor: a Turn obeys its Allowed picks against a prompt that argues for another (ADR-0029, ADR-0062); an Agent works
  where its Frame says ([ADR-0057](0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md)); a Menu-only Agent
  picks without reaching for tools it has not got ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)); a
  notice changes what the next Turn does ([ADR-0061](0061-a-memory-kill-ends-the-agents-processes-not-the-harness.md),
  ADR-0062); a Turn follows its modes — after a pick changes the mode, after a correction receipt, and after a model
  that stopped is asked again ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md), ADR-0029,
  [ADR-0016](0016-agent-turn-mechanics-are-internal.md)); a model that stopped with nothing allowed is woken when a
  Gate's answer opens a pick, and picks (the wake, ADR-0016); a Turn hears its Allowed picks change under it at a step
  boundary and follows them without a refused pick (ADR-0029); and a pick that runs work is answered at Rest and the
  Agent acts on the answer, after a chain of replies and after a Harness restart cut the pick
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md), ADR-0031); and after a signed push the
  Agent continues on its branch, so its next push publishes
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). A claim qualifies
  when an ADR states what a correct Agent does differently for it and a step can observe the difference from outside the
  pod. **The run** is one `workspace()` workflow through to `done` on a real task: a ticket the seed Repo carries as a
  failing test, a planner's pick, a coder that edits in the Worktree, runs the test, commits on the run's branch and
  names the commit — a guard refuses a `submit` that names none — and a reviewer in the same Sandbox, read-only
  ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)), that runs the test itself and
  approves or rejects, bounded. Approval parks at a Gate, and the witness is the pod (parking is retention, ADR-0012):
  the branch is ahead of `main`, its head is the named commit, the tree is clean, and the test passes when the suite
  runs it there. Nothing is pushed — the Agent holds no credential and the push is the caller's (ADR-0005,
  [ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)), as `task` says — and
  the seed's `app.git` accepts none. The run asserts the pick ledger's shape and a time bound — never the diff, the
  commit message, or the Turn count, which are the model's.
- **Scored, not asserted.** A claim is N trials per cell (thinking off and on are cells, set through the Dial), and a
  cell fails only below the floor written in its scenario. The floors are the ADRs' numbers rounded down to what a model
  at the floor can hold: 9 of 10 where the ADR measured 10/10. Every run writes a scorecard,
  `features/.tmp/model-scorecard.json`, keyed by model id and cell; a committed baseline per model id sits in
  `features/model-baselines/`, and a cell that fell below its baseline while still above its floor is **reported**, not
  failed. Drift is a signal to read; a floor is a defect.
- **The instrument is the weakest model the kit claims to support.** Today that is the home-lab vLLM model
  (Qwen3.6-35B-A3B). ADR-0029's numbers are the reason: a frontier model obeys either placement and hides the
  regression. A stronger model must clear the same floors and cannot lower them; adding a model adds a baseline row,
  never a floor. The run is measured once per invocation, on whichever endpoint is selected, because it costs minutes
  and its failure is a defect to read, not a rate.
- **The endpoint is a profile, selected by env, and the key never enters a file.**
  `features/model-endpoints/<name>.json` carries `id`, `api`, `baseUrl` and `model`, plus the tier's own `thinking`
  cells and `trials`, and optionally a `caBundle` path for a private CA
  ([ADR-0020](0020-private-ca-trust-is-a-named-concept.md)). A profile is one of two kinds, as a user's instance is. A
  profile with `key` names one of pi's catalog providers (`anthropic`), and the catalog holds the model's limits and
  thinking levels. Its key is a Held secret in `secrets`, under the known model key that `key` names
  (`ANTHROPIC_API_KEY`, [ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). A profile with
  no `key` is a `harness.provider`, and carries its models' windows. `JR2_MODEL_ENDPOINT=<name>` selects it;
  `JR2_MODEL_API_KEY` is read from env alone. Before the converge, the fixture copies the selected profile to a fixed
  path inside `features/model-instance/`. The instance's config and Agents import it from there, so the in-cluster
  Orchestrator reads the same values the host did. An env read in a definition is `undefined` in the pod, as the `@kind`
  config notes. Nothing in the product learns the tier exists. Reachability from the pods is `jr2 up`'s provider
  preflight, for both kinds of profile. It checks each model from a check pod with a Custodian before it writes anything
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). So a pod with no egress to the provider
  fails the converge at the check pod.
- **Not in CI. Run by whoever changed what the model reads, before calling the change done.** Not in `pnpm -r test`, not
  in the release job: it needs a cluster and an endpoint, it is nondeterministic by nature, and a gate that flakes is a
  gate everyone re-runs. `just e2e-model` probes the profile's endpoint first and, when nothing answers, exits 0 with
  one line — `skipped: no model endpoint at <url> (profile <name>) — the @model tier did not run` — so it can always be
  invoked and a skip is never silent. It skips with one line in two more cases. A profile with `key` and no
  `JR2_MODEL_API_KEY` prints
  `skipped: JR2_MODEL_API_KEY is not set, and profile <name> needs it (<key>) — the @model tier did not run`, where
  `<key>` is the profile's `key`. An endpoint that answers with a status other than 2xx prints
  `skipped: the model endpoint at <url> answered HTTP <code> (profile <name>) — the @model tier did not run`. The
  trigger is a change to any text or tool the model reads or is offered: the Briefing, the Menu's rendering and the
  refusal, the nudge, the Working tools and their descriptions, Compaction's summary, the admit body's notices, the pi
  pin, a provider adapter, or an authoring surface that changes a Frame. An agent reviewing a feature or refactor that
  touched one of these runs the tier and reports the scorecard's floors and drift, or the skip, in its handoff.
  CLAUDE.md states the rule. One scenario runs alone by its title, which is the scenario filter:
  `cucumber-js --profile model --name "a Gate's answer during a command is followed"`.
- **A third pi canary.** Conformance and `@kind` drive the turn loop against a script; this tier drives it against a
  model that can misread. Run all three before bumping the pin.

## Considered options

- **A real model inside `@kind`.** Rejected: `@kind` proves the data plane, and its scenarios must be readable when they
  fail. A model that misreads a prompt would make a Sandbox failure look like a wording one, and a laptop without an
  endpoint could no longer run the data-plane tier at all.
- **In-process, in `@jr2/harness`: conformance with a real `baseUrl`.** Rejected: it measures the Harness's rendering of
  an admit body the test wrote, not what the Orchestrator sends — the Allowed picks, the Frame and the notices are
  composed there — and it has no Workspace, so it can never run the run.
- **Pass or fail per trial.** Rejected: a model is a distribution. A single 9/10 fails a green change once a week and
  teaches everyone to re-run until it passes, which is the same as not measuring.
- **A frontier model as the instrument.** Rejected: ADR-0029 measured the regression only on the weak model; the
  instrument must be the one that can fail.
- **Recorded provider transcripts, replayed.** Rejected: a replay is a scripted provider by another name, and the tier
  exists precisely because a scripted provider cannot misread.
- **A hosted model in CI.** Rejected for now: a key in CI, a bill per push, and nondeterminism in the gate. The decision
  is who runs it, and that is the change's author, when the endpoint is there.

## Consequences

- ADR-0010's tier list gains `@model`; ADR-0027's canary sentence names three canaries; CLAUDE.md's testing strategy
  gains the tier and the rule about when to run it.
- New: `features/model.feature`, `features/steps/model.steps.ts`, `features/model-instance/` (config, `_agents.ts`, the
  claim workflows and `ticket.ts`), `features/model-endpoints/homelab.json`, `features/model-baselines/`, the `model`
  profile in `cucumber.json`, and `just e2e-model`.
- The seed Repo's `main` gains a small project with one failing test, so the run has a task with a checkable outcome.
  `@kind` reads the seed's refs, never its files, so it is indifferent.
- ADR-0029's and ADR-0062's measurements become scenarios; their prose keeps the numbers as the origin of the floors.
- The Menu-only claims read the model's calls off the Instance Harness's printed conversation (ADR-0023) — the one place
  a refused pick, a nudge and a restated Turn part are all visible — so their trials run one at a time; the Sandbox
  claims read their pods and run `parallel` at once. A claim whose setup the step must race (a Gate answered while the
  model works, a mode moved while it composes) voids the trials whose setup lost the race; voids are bounded, and a void
  past the bound counts against the floor and prints as a void in the failure list, never as a miss.
- Each trial's line in the failure list says how its run ended, whatever stopped the trial (a driver that threw prints
  what it threw, and names the run it had started, if any: `threw: <message> (run <id>)`). A run that ended faulted or
  lost also prints its final output, and a run in error its fault, which carry the reason
  (`features/lib/model-status.ts`): the namespace that held the pod log is gone when the list is read.
- **Every trial keeps its evidence.** Every trial, passed, missed or void, keeps one folder,
  `features/.tmp/model-trials/<model>/<cell>/<runId>/` (gitignored with `.tmp`; a cell's `/` is a folder; a byte of a
  name outside `[A-Za-z0-9._-]`, such as a model id's `:`, and a leading `.` are spelled `%XX`, so any model id keeps
  its trials):
  - `conversation.txt`: the Harness container's printed conversation (ADR-0023), timestamped. A Sandbox claim's is
    followed from the moment the trial's Sandbox pod exists until the reap at settle takes the pod
    ([ADR-0012](0012-workspace-wrapper-machine.md)), so a read after the settle is never needed, and it is followed
    again after the container restarts. A Menu-only claim's is the Instance Harness's from the trial's start, followed
    again after the step deletes that pod and the StatefulSet makes it again. It holds each pick's answer after its
    call, the text the model read (`[<pick> answer] <text>`, or `[<pick> error] <text>`): the receipt, a command's
    outcome, a refusal, the paragraph after a signed push. An answer longer than the print's bound (2000 characters, a
    call input's) is cut in its middle, with the number of characters dropped marked at the cut
    (`… [<n> characters cut] …`), so the receipt at its head and the end with "Allowed now" both stay; the model read
    the whole answer, and the cut is the log's copy only (ADR-0023). The Harness prints it (ADR-0023), so the tier keeps
    it with the conversation, and nothing the model reads changed to keep it. `answersIn` reads each call with its
    answer; a call a Harness restart cut has jr2's text, which the next container prints before its first prompt, and a
    call an abort cut while the model was still writing it has jr2's text that it did not reach the workflow, printed
    before the conversation's next prompt.
  - `effector.txt`: the Sandbox Effector container's log, followed the same way, for a Sandbox claim; it says so when
    the pod has none.
  - `harness-history.txt`: the Harness history view
    ([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)) of each Agent whose prompt printed:
    each settlement, with the failure text of one that failed. The view is read while the trial runs and again each time
    a settlement lands, and the last one read is kept. A Sandbox Harness exits at the reap, so the view after a Turn
    that settled just before it can be too late to read: each Agent's stream is also followed, read as the Orchestrator
    reads it, and each `submission-settled` it carries that the kept view does not hold is kept after the view.
  - `record.json`: the Machine's final record, the last status the driver read of the run.
  - `push-log.txt`, for a push claim: the push remote's log from `main` to each commit the record says was published.

  Each file is written when it changes, so a trial that hangs until its timeout leaves what it had. Every probe only
  reads: a probe that fails writes `<unavailable: why>` into its file, never fails the trial, and never changes what the
  next trial does. Each trial's note opens with what the model called, read off the kept conversation in the Menu-only
  notes' form (`said bash (restated) ask_approval submit`) from the lines of the Agents whose prompt printed there (the
  run narrative echo, `[run] [status]` and `[run] [emit]`, is not a call), or `said <unread: why>` when it cannot be
  read, and the driver's note follows. A floor failure, a void past the bound and a cell below its baseline are read
  from these folders before a prompt, a floor or a step is touched. A failed `@model` scenario also writes the `@kind`
  failure dump, to the same place as a `@kind` one: `features/.tmp/kind-failures/<namespace>-<scenario>/`.

- One trial may measure two claims: `push-follow` and `push-no-refusal` are two cells of one scenario's trials. After
  the measured pick, a coder that picked `revise` is back in `coding`, where only the desk's answer moves it, so the
  step answers the desk again each time, until the trial's time ends, and the trial can finish; the measure is still the
  first pick after the first answer. Until 2026-10-23 the step answered at most three more times (below, 5d3096da). The
  driver changed for this after the claim ran once (70f9cb2); the user approved the change on 2026-10-09. Those answers
  never reached the Machine: the driver waited for the run's own `value` to read `coding`, and a `workspace()` run's
  value is its wrapper's, which never holds its body's state, so the step never answered again. In the full run of
  2026-10-12 one trial (ba79f322) recorded its measure, `revise` right after the answer, then looped `ask_approval` and
  `run_tests` in `coding`, reading "Allowed now: ask_approval, run_tests", until the run faulted, and failed "every
  trial finished". The driver now reads the body's state off the children `jr2 status` reports
  (`features/lib/model-status.ts`), a defect fixed and no setup change. Then a bound of the kind of the finished rule
  below: a trial whose measure is recorded — its first pick after the answer; the body seen back in `coding` after it is
  `revise` — and that does not finish within its time is cancelled and counts as finished. Its time is a trial's bound,
  15 minutes, counted from the desk's first answer. A measured trial whose run settles before then without its task's
  final — a fault — is not cut, and fails "every trial finished". The prompt, the floor and the measure did not change.
  Both were decided under the user's deferral on 2026-10-12 and confirmed by the user on 2026-10-12.
- The held-answer claims of ADR-0024 and ADR-0031 — `chain-answer` (the next pick follows the answer's last link) and
  `cut-pick` (after a Harness restart cut the pick, the Agent uses the answer and does not pick it again; the step
  deletes the Instance Harness pod). Each floor carries ADR-0029/0062's measurement of a list read last. The first run
  (home-lab vLLM, 2026-10-07) confirmed both, 10 of 10, now baselines.
- **The refusal of a second pick while one is outstanding is not a claim.** It is jr2's mechanism, not something a model
  does with what it reads. The Orchestrator refuses it from the Machine (ADR-0024). The Harness runs only the first pick
  of one model answer (ADR-0024, [ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)).
  Harness conformance proves it with a scripted provider that sends two picks in one message. Only the first is
  delivered, and the second reads that it did not run. A claim for it (`refused-outstanding`: the refused pick is picked
  again once the answer comes) ran once, on 2026-10-07: in all 15 trials of that run the model called `book_room`, read
  its answer, then called `send_invite`, so no call was ever refused and its setup never happened. It left the tier with
  no cell; no floor was lowered. A model that sends two picks in one model answer would need a claim of its own: what it
  does after its second pick did not run.
- The command-Effect claims of ADR-0067 — `answered` (the next pick follows a command's output), `allowed-after-route`
  (the next call is one the route allows, not one allowed before the pick) and `unknown-outcome` (after a Harness
  restart killed the command, the Agent checks before it announces; the step restarts the Sandbox's Harness container) —
  carry the borrowed floor of ADR-0029/0062's measurement of a list read last. Their first runs (home-lab vLLM,
  2026-10-07 and 08, four runs of the tier) read:
  - `answered`: 10, 9, 10 and 10 of 10 with its first setup, now a baseline; 9 of 10 in the full run of 2026-10-12, and
    8 of 10 in the full run of 2026-10-13 (on 50fe7e0), below its floor of 9. The two misses (53cc7436, 253e840b) had
    one shape: the coder read the right answer, the outcome `exited` with code 1, the output's line
    `auth.test.ts: expected 200, got 500` and "Allowed now: report_failure, run_tests, ship", said that the output named
    `auth.test.ts`, a file the Worktree did not hold, ran the Repo's own tests, fixed the `greet` tests the output did
    not name, and picked `ship`. jr2 acted correctly in all ten trials. The setup was the one `allowed-after-route` had
    until 2026-10-08: the test command was fixed data that printed a failure of a file the Repo did not hold, while the
    Worktree (the seed's `app.git`) held real failing tests the model could fix, so a miss could not tell "ignores what
    the output says" from "fixed what it was shown". The setup now is the same real case (2026-10-13): the claim binds
    `billing.git`, and `run_tests` runs its suite in the Worktree (`node --test`), whose one failing test the output
    names with its file and the values it compared, and the Worktree holds nothing else to fix. The prompt's subject
    follows the seed ("The billing change is in." in place of "The auth fix is in."); the rest of the prompt, the floor,
    the measure (the first pick after `run_tests` is `report_failure`) and the baseline are unchanged. The user approved
    this setup change on 2026-10-13, before it was made. The first run with this setup (2026-10-13, on 1380dee) read 9
    of 10, at its floor of 9 and below its baseline of 10, with no void: each of the ten answers named the real failing
    test (`billing.test.js:9`, `2148 !== 2149`). The one miss (e3a27f22) read the failure, fixed `billing.js`, ran the
    tests again and picked `ship`, against the prompt's "if they fail, report the failure": the model's choice. It is
    reported below baseline, not failed; the claim is no longer open, and the baseline stays at 10.
  - `unknown-outcome`: 10 of 10 in both runs that read it whole, now a baseline. The Harness container restarts in
    place, and the reap when the run settles deletes the pod with every log it held, so the step follows the restarted
    container's log from the moment it runs. Read after the settle, the log was gone in 5 of 10 trials of the first run,
    each a model that had checked.
  - `allowed-after-route`: 3, 5 (a diagnostic run), 4 and 4 of 10 with its first setup, below its floor. Every miss had
    one shape: after the failing answer the coder read the seed Repo, found a failing test, fixed it with its Working
    tools, saw it pass, and picked `ship`, which the newest "Allowed now" it read (`open_issue`, `run_tests`) did not
    list. The setup made that failure say little: the test command was fixed data that always failed and named a file
    the Repo did not hold, while the Worktree held an unrelated test the model could fix. So a miss could not tell
    "ignores the newest list" from "fixed what it was shown". The setup now is the real case (2026-10-08): the claim
    binds its own seed Repo (`billing.git`), whose suite has one failing test that names the defect, and `run_tests`
    runs that suite in the Worktree. A correct Agent may fix the code, but only `run_tests` passing takes the workflow
    back to where `ship` is allowed; the miss is a `ship` after its own fix without the workflow's check. The floor and
    the measure are unchanged. Its first run with this setup (2026-10-08) read 10 of 10, now a baseline. The setup
    change (86e9691) was made before the user saw it; the user approved it on 2026-10-09.
- `continue-after-signed-push` (ADR-0067): the coder fixes the seed's failing test, commits and publishes — a signed
  push from the Sandbox Effector over ssh to the seed's push remote, `push.git` — then commits a second change,
  publishes again, and finishes. The first push's answer carries the paragraph after a signed push. The measure is the
  Machine's record of the second push: `pushed`; an Agent that rewrites the pushed commits after their ids changed makes
  it `diverged`. A trial whose first push did not publish a signed copy is void, and so is a trial whose only push
  already carried two or more commits from `main` (below). Its floor is `push-follow`'s, 9 of 10: the answer is the
  newest thing the model read. Its first run (home-lab vLLM, 2026-10-11) read 9 of 10, none void, at its floor: now a
  baseline (4316bdb). For it the tier's shared instance gained a push credentials entry
  (`features/model-instance/jr2.config.ts`) and its Effector image a passwd entry for uid 1000 (9cd3935). The user
  approved this on 2026-10-11 as not a setup change: the rule guards what the model is put in front of, and a credential
  entry and a passwd line change nothing the model reads. No existing claim's prompt, workflow or floor changed, and
  every existing cell held its baseline after the change. Its next run (2026-10-11) read 8 of 10, below its floor and
  its baseline, and a diagnostic run read 6 of 10. Each of the four misses whose log was read had one shape: the model
  made both commits before its first `publish`, published once, and finished. The claim measures the paragraph after a
  signed push, which the model reads only after a push; in such a trial the model chose its order before it read any
  post-push text and had no work left to continue, so the measured moment never occurred — the shape of the `noticed`
  and `push-follow` voids. The setup changed for it (decided under the user's deferral on 2026-10-11, confirmed by the
  user on 2026-10-12): when the setup holds and there is one push, the step counts the commits from `main` to that
  push's published commit on `push.git`, and two or more make the trial void ("void: the first push carried <n> commits
  …"). It decides from the push's content, never from the push count, so "published once, committed, finished" and
  "published, reset, finished" stay misses. The prompt, the floor and the pass did not change, and the 8 of 10 stands:
  the claim passes only on a new run. The void shares the claim's one bound of replacements (half the trials, rounded
  up) with the setup void, and a void past it counts against the floor and prints as a void. At the diagnostic run's
  rate, 4 of 10, the bound is often spent; the claim is then open, not passed. Rejected: counting the batched trial a
  miss (it measures the model's reading of the claim's own prompt), raising the bound, or lowering the floor.
- **A trial that reaches either of its task's finals finished.** A claim whose workflow has two task finals (`wake`,
  `chain-answer`, and the three command-Effect claims) counts a trial finished at either; its measure already counts the
  wrong one a miss, and counting it unfinished too would fail the scenario on one miss — the floor 10 of 10 in all but
  name. A fault, a lost Workspace or an unsettled run never finished.
- `wake` (below, under `push-wake`) has run four times, 10 of 10 each, and is a baseline.
- **A claim's setup may change; its floor and what counts as a pass may not.** A setup is the part of a trial that
  brings the model to the moment the claim measures. When a claim falls below its floor because that moment seldom
  happens, its workflow and its driver may change for the setup alone, and the reason is recorded here. A setup that no
  honest change makes reliable leaves the claim open, and it is reported as open. The first run of the mode and
  step-boundary claims (home-lab vLLM, 2026-10-05) changed two:
  - `mode-stop`. Its Turn asked for a review and told the model to wait; the stop happened in about 1 trial of 3 —
    models picked straight through (`ask_review submit`) or looped `ask_review`/`revise` — and the claim fell to 5 of 10
    twice. `ask_review` now enters a mode whose `revise` and `submit` are closed, where the Briefing tells a model to
    stop, and a timer then opens them, so the wake asks it with the nudge's text (ADR-0016). The timer has no target: it
    assigns, and the picks' guards read it. A timer that moved the workflow to a mode inside the Agent's state holds
    Rest (ADR-0024), so `ask_review` would stay outstanding until it fired and its answer would carry the Allowed picks
    on the same call; no model would stop. The prompt is unchanged: it is the claim's fixed data. What counts is
    unchanged: the trial is measured at the first ask after the model's `ask_review`, and void without one, and it
    passes when the first Menu call after that ask is a pick the mode active at the ask allows. The driver reads the
    modes from the workflow, not from a copy of them, and replays the model's calls through them: a mode with a
    targetless timer has its picks closed from each entry until the timer fires; the driver takes the timer where a
    restated Turn part shows that it fired, and follows it at the ask when the wake asked with nothing allowed.

    On 2026-10-23 the setup changed again. In that day's full runs on Claude Sonnet 5.5 and Haiku 5.5 (below), the timer
    was the whole review: no reviewer answer came, and a careful model would not submit notes that no reviewer had
    answered. Now a reviewer, a child Machine below `reviewing`, reads the notes for 2 s and approves them. `ask_review`
    is outstanding while it reads, and its answer is the reviewer's output (ADR-0024), with the Allowed picks read at
    Rest: none, because the timer has not fired. So the model reads the answer that the prompt tells it to wait for, and
    it still stops with nothing allowed. The timer still has no target and starts at `reviewing`'s entry, so the
    reviewer holds Rest only for its 2 s, and the wake still asks the stopped model. The states that the reviewer's hold
    adds (`reviewing.reading`, `reviewing.answered`) are below `reviewing`, so the modes that the driver reads do not
    change. The prompt, the floor and what counts are unchanged. The one new text that the model reads is `ask_review`'s
    answer:
    ``The workflow took it and is back in the state that asked for this turn. Its answer: the output of `reviewer`: {"verdict":"approved","comments":"Clear and accurate."}.``,
    in place of the plain receipt's "The workflow is still in the state that asked for this turn." The user approved
    this change on 2026-10-23 (question 21: give the review a real answer). In the claim-setups run (below) it gave 10
    of 10 on the home lab, on Haiku 5.5 and on Sonnet 5.5, and every trial finished.

  - `push-wake`, since replaced by `wake`. It measured a Menu-only Turn that started with nothing allowed and picked
    inside the same Submission once a Gate's answer was restated at a step boundary. The step first answered the board
    as soon as the Turn's prompt printed; in two runs, 8 and 9 trials had no restatement, each with one `hold` or
    `release` as its whole conversation (7 and 5 of 10). It then answered once the Turn's first model answer had ended
    with a Menu call, and the claim fell to 2 of 10. The cause is the standing Briefing, rewritten after the claim was
    written (ADR-0062): "If nothing is allowed, stop: the workflow prompts you again when something is." A correct model
    with nothing allowed now stops, so the in-Submission moment the claim measured is rare, and the model that skips it
    is the correct one. What the Briefing promises instead is the wake (ADR-0016), and `wake` measures that: the model
    stopped with nothing allowed; once its Submission has settled, the step answers the board; and the first Menu call
    after the wake is `release` or `hold`. A model that never stopped is void. Its floor is `push-follow`'s, 9 of 10.
    `push-follow` keeps the restatement case: a list that changes while the model is still working. `push-wake` had no
    baseline cell.
  - `noticed`. The kill must not land while a Turn runs. The first Turn starts the server and picks `started`. Then the
    body waits at the `kill` Gate, and no Turn runs. The step checks that the server answers, with a probe that it execs
    in the Harness container. Then it execs the memory hog. It checks that the guard's list (`GET /memory-kills`) holds
    a new kill and that the port is dead, and it answers the Gate. The second Turn continues the same conversation, and
    its prompt must carry the memory-kill notice. The first Turn has ended, so it cannot see the kill. What the second
    Turn knows of the kill, it knows from the notice.

    Two earlier setups killed during the first Turn, and their runs showed why that is wrong. In 1 of 10 trials of two
    runs of 2026-10-12 (8374be56, 9d220d92), the first Turn saw its server die and did not pick `started`. On
    2026-10-22, Haiku 5.5 often ended its first Turn before the kill, so the kill landed in the second Turn, and that
    Turn was not told. A first Turn that saw the kill often started the server again. Then the second Turn's report can
    come from what the first Turn saw, not from the notice. The driver made all of these trials void. The last of those
    setups polled the port from the host every 3 s during the first Turn, and it killed when the port answered. It made
    a trial void when the first Turn made a Working-tool call after the kill. On the home lab, 7 of 15 trials of that
    setup were void for that reason. All 8 measured trials passed. But 2 voids were past the bound, so the cell was 8 of
    10, below its floor of 9. Qwen keeps working in its first Turn, sees the kill, and starts the server again. A kill
    between the Turns removes this mixed cause, and it needs no timing void.

    The new setup found a gap in the product. The guard put a kill on the stream of the Submission that ran. When no
    Submission ran, the Orchestrator did not hear of the kill, and the next Turn got no notice. Main fixes this
    (91699c24, 8c274330). The pod keeps every guard kill, and the Agent actor reads them before it admits a Turn into
    the Workspace. So the next Agent in the Workspace gets the notice once.

    Two voids stay, each a setup that did not happen. In the first, the first Turn does not pick `started` in its time:
    the run is live, and its body is in `starting`. In the second, no server answers at the `kill` Gate: a server that
    outlives its bash call is the model's job. A body that left `starting` for `faulted` (`agent.fault`) or `lost`
    (`workspace.lost`) settled the run. It is not void, and it fails "every trial finished", as the finished rule above
    says. The bound stays half the trials, rounded up. Rejected: a larger bound for `noticed`, and a fault in `starting`
    counted as void.

    Two more voids are new. In the first, the kill does not take the server. The guard's list (`GET /memory-kills`,
    91699c24) holds no new kill, or the port still answers after the hog. Then the exec fails, or the kernel's OOM
    killer takes the hog before the guard does. In the second, the kernel kills the container, not the guard. A kernel
    OOM kills the whole container, and the container's restart count goes up. The kubelet counts the restart 1 to 3 s
    after the kill. So the step reads the count right after the hog, and again after it reads the guard's list or that
    read throws. The guard's list is the backstop. A kernel kill leaves no new guard record, so when the rise does not
    show yet, the trial is the "no new kill" void. It is a void either way, never a miss. On main, a port that still
    answered after the hog was a miss. A dead port with no guard kill counted as a kill, so that trial could pass. Now
    each is a void, because the setup that the claim measures does not happen, and a port that is dead for another
    reason is not blamed on what jr2 tells the model. Each void cancels its run before the second Turn. Only the voids
    after the hog give the hog's exit code. The user approved these two voids on 2026-10-23.

    The prompt and the floor did not change. The pass changed: a trial now also needs the notice in the second Turn's
    prompt. Before, the step did not read the second Turn's prompt. Now the kill lands before the second Turn starts, so
    jr2 must tell that Turn. A prompt with no notice is a miss, and the note names it as a defect in what jr2 shows the
    model. The setup first ran on 2026-10-23, at an earlier version of this branch (09291511, not kept) on main
    8837af28. That step named the Gate `hold`, had `killed` in the pass, did not read the guard's list, and had neither
    of the two new voids. It gave 10 of 10 on the home lab with no void, and 10 of 10 on Haiku 5.5. A later version of
    this branch (c220d895, not kept) scores a trial as this step does. On 2026-10-23 it gave 10 of 10 on the home lab,
    on Haiku 5.5 and on Sonnet 5.5, and no void fired. The user confirmed the 2026-10-12 void on 2026-10-12, and
    approved the setup with the Gate between the Turns on 2026-10-23.

  The Rest rule (ADR-0024) changed a third, `mode-refusal`, before any run under it. Its timer moved `reviewing` on to
  `approved` while the model composed its next call; under Rest that timer holds `ask_review` outstanding until it
  fires, so the stale list the claim needs never reaches the model and every trial would be void. The timer now has no
  target: it shuts the review window, and the guards of `revise`, `submit` and `publish` read it, so after it fires only
  `publish` is allowed in `reviewing`. The prompt, the floor and the pass are unchanged: the call after the correction
  receipt is `publish`. Both setups have run: `mode-stop` and `mode-refusal` cleared their floors 10 of 10. The user
  approved `mode-refusal`'s setup change (e20cc0d) on 2026-10-11: a forced change that measures nothing new, with the
  prompt, the floor and the pass criterion unchanged, and 10 of 10 on 6f91bcc and on 9cd3935.

  On 2026-10-23 `mode-refusal`'s setup changed as `mode-stop`'s did, for the same cause: in Haiku 5.5 trial 38368e52 the
  model would not publish notes that it saw no one approve. A reviewer below `reviewing` approves the notes, and its
  output is `ask_review`'s answer, with `revise` and `submit` allowed. The window's timer moved to `reviewing.answered`,
  the state that the reviewer's answer enters, so it starts when the answer is fixed, as it started at the receipt
  before. The answer reaches the Harness on the long-poll of the outstanding pick, not on the POST of the pick. The
  prompt, the floor and the pass are unchanged. The new text that the model reads is the same answer as `mode-stop`'s,
  followed by "Your turn is not over. Allowed now: `revise`, `submit`." (in the model's tool names). A model that holds
  the approval and calls `publish` before the window shut is refused, and one that calls it after the window shut is
  taken. Neither trial refused a pick from the list, so both are void, inside the claim's bound. The user approved this
  change on 2026-10-23 (question 21). In the claim-setups run (below) it gave 10 of 10 on the home lab, on Haiku 5.5 and
  on Sonnet 5.5, and every trial finished.

- **Claude Haiku 5.5 and Claude Sonnet 5.5 (Anthropic API).** The cells of
  `features/model-baselines/anthropic--claude-haiku-5-5.json` (18) and
  `features/model-baselines/anthropic--claude-sonnet-5-5.json` (20) come from the full runs of 2026-10-23 on main
  8837af28, except the six cells that the claim-setups run gave (below). Haiku ran from 17:30 to 18:21 UTC, and Sonnet
  from 18:21 to 19:26 UTC. Both ran a version of this branch (c220d895, not kept). The later commits of the branch do
  not change how a trial is scored.
  - Haiku: 16 of 19 scenarios passed, every claim cell at 10 of 10 and each run at 1 of 1. Three scenarios failed at
    "every trial finished" and wrote no cell. `mode-refusal`: 9 trials passed. The 1 trial that missed (38368e52) is
    also the 1 that did not finish. `mode-stop`: 9 trials passed and 1 missed (0da530b9). That trial and 3 more did not
    finish (71a52a32, 08f40dc7, 1ed86b01). `push-follow` and `push-no-refusal`: 10 of 10 passed both cells, and 1 of 10
    did not finish (5d3096da). An earlier version of this branch (09291511, not kept) ran Haiku `push-follow` on
    2026-10-23 too, and 3 of its 10 trials did not finish.
  - Sonnet: 18 of 19 scenarios passed. Sonnet 5.5 has no `off`, so its `off` cells ran at effort `high`, and in this run
    its `on` cells asked for `high` too. Since 2026-10-23 the profile's `on` cell asks for `medium`, as Haiku's does
    (`anthropic-sonnet.json`; at pi-ai 1.4.0 Sonnet's `thinkingLevelMap.medium` is `medium`), so `off` and `on` are two
    conditions. The `obedience/on`, `ticket/on` and `ticket-modes/on` cells of this run measured `high`, so they left
    the baseline file, and the claim-setups run (below) measured each again at `medium`. The user approved this on
    2026-10-23 (question 23). `obedience/off` gave 9 of 10, every other claim cell 10 of 10, and each run 1 of 1. In the
    miss (b2b5a38d), the prompt asked for `ship` and only `hold` was allowed. The model stopped with text, and after the
    nudge it picked `hold`. `mode-stop` failed at "every trial finished" and wrote no cell. Its 10 measured trials
    passed, and none of the 10 finished.

  In the unfinished `mode-stop` and `mode-refusal` trials, the model does not take a step that the claim's story says
  needs a review or an approval. That review or approval never comes. Then the nudges run out, and the run faults. The
  conversations show this:
  - Sonnet `mode-stop` (for example 5a0ba0c1): after the nudge, the model's thinking reads "Since no reviewer feedback
    has come in yet, submitting now would be premature". It picks `revise` and asks for review again. This repeats until
    the run faults. The workflow's prompt says "wait for the reviewer's answer", but no reviewer answer comes: the timer
    only opens the picks.
  - Haiku `mode-stop`: 3 of the 4 unfinished trials (71a52a32, 08f40dc7, 1ed86b01) have the same `revise`, `ask_review`
    loop. In 0da530b9, the model stops and says that neither pick fits, because the review has no answer yet.
  - Haiku `mode-refusal` (38368e52): "I'm not calling `publish`. The v2.3 notes have not been approved…"

  Haiku `push-follow` 5d3096da has a different cause. The desk answered four times: the ledger holds four approvals.
  After each answer `submit` was allowed, but the model picked `revise` to fix and check the failing tests ("Submitting
  now would ship code that fails its own tests"). The fourth `revise` came after the last answer that the step gives:
  the first answer and `PUSH_REANSWERS` (3) more. In `coding`, only `ask_approval` and `run_tests` are allowed, and no
  allowed pick ends the Turn. The model said "I've now requested approval four times without a response", and it
  stopped. The nudges ran out before the driver's cut at TRIAL_MS, so the run faulted.

  The home-lab Qwen takes the step anyway in `mode-stop` and `mode-refusal`. The "every trial finished" check counts
  these trials against the scenario, but the measured cell passes. On 2026-10-23 the user decided (question 21) to
  change the setups of these claims, and no floor or check. For `mode-stop` and `mode-refusal`, the review now has a
  real answer (the setup notes above). For `push-follow`, the step's limit on desk answers went: the desk now answers
  each time the coder is back in `coding`, until the trial's cut, TRIAL_MS from the first answer, which stays the bound.
  The rule that a fault before the cut is unfinished stays. The measures (the first pick after the first answer, and the
  first Menu call after the first restatement) and what the model reads do not change. These runs came before that
  change.

  **The claim-setups run** measured these changes on 2026-10-23, at snapshot 42433e48 of this branch on main 4cb2bc2e.
  Its cells were written from 01:47 to 02:22 UTC on 2026-10-24. It ran only the scenarios that the changes touch:
  - Home lab: `mode-stop/off` and `mode-refusal/off`, 10 of 10 each, equal to their baselines.
  - Haiku 5.5: `mode-stop/off` and `mode-refusal/off`, 10 of 10 each, and every trial finished. Before the change, 4 and
    1 of 10 did not finish. Both are new baseline cells. `push-follow` and `push-no-refusal` passed 10 of 10 each, but 2
    of 10 trials did not finish (90ab1ee4, 2b068c3a), so the scenario failed at "every trial finished" and wrote no
    cell. The desk answered each time a `revise` took the coder back to `coding`: twice in 90ab1ee4 and five times in
    2b068c3a. Each run faulted within 30 s of the first answer, long before the cut, when the nudges ran out
    (`agent completed its turn without a pick that ends it; still allowed: ask_approval, run_tests`). The prompt asks
    only to run `sleep 20 && ls` and read the listing, and the Repo's tests fail. In 90ab1ee4 the model ran the tests,
    read the 2 failures ("The work isn't done, so `submit` is wrong"), picked `revise`, did not fix them, and stopped.
    In 2b068c3a the model made no change ("I won't call `submit` on empty work, and I won't request approval for a
    change that doesn't exist"), and it looped on `revise` and `run_tests` until the nudges ran out. So the model will
    not submit work that fails or that has no change, and it does not fix the tests.
  - Sonnet 5.5: `mode-stop/off` 10 of 10, and every trial finished (before the change, none of 10 did): a new baseline
    cell. `mode-refusal/off` 10 of 10 and `obedience/off` 9 of 10, equal to their baselines. At `medium`, `obedience/on`
    gave 9 of 10, `ticket/on` 1 of 1 and `ticket-modes/on` 1 of 1: new baseline cells. In each `obedience` miss
    (cfc238c8 off, b1c7a9a2 on), the model made no call before the nudge, then picked `hold`.

  The first full Haiku run, of 2026-10-22, used main at cd6e6145, with this tier's Anthropic profiles. Later main
  commits change what the model reads, among them ccd81ce9, eb76a3e4, 39a3610d, 8c274330 and 37bbf7ff. Others change how
  the Harness runs the tool calls of one answer, among them be347513, ecb8c556 and 9d37d732. So the cells of that run
  are not kept, and nor are the Sonnet 5.5 cells of a run on cd6e6145 (`obedience` and `ticket` only). Fourteen of
  nineteen scenarios passed. Five failed: `noticed`, a defect in its step, and the four below. The causes, read off each
  trial's evidence in `features/.tmp/model-trials/anthropic--claude-haiku-5-5/`:
  - `noticed`. The setup of this run killed during the first Turn, and its step did not check that the kill landed
    inside that Turn: a defect in the step. All the counts here come from that old setup. Haiku 5.5 often sends the
    server's `bash` call and `started` in one response, so its first Turn ends before the server listens. This run
    polled from the host every 3 s. Read with the later void rules of the old setup, 8 of its 10 trials are void. In 4,
    the model sent the call and `started` in one response. In 4 more, the kill landed in the second Turn. The 2 measured
    trials passed. Two diagnostic runs with a kill made in the pod sent the call and `started` in one response in 4 of
    14 and 7 of 15 trials. A third such run gave 10 of 10, which is not valid, because that kill let a blind Agent pass.
    These trials also show a defect in what jr2 shows the model. Three of them (0e1ebfbf, 79c9a859, 92895334) and three
    Qwen trials read a false answer to `started`: "the pick never reached the Orchestrator (This operation was
    aborted)". Main fixes it (39a3610d).
  - `mode-refusal`, 7 of 10, below its floor of 9. In the three misses the model read the correction receipt, which
    named `publish` alone, and would not publish notes that it judged unreviewed: it called `revise`, which the
    correction had already refused (e06c7019, ab93b886), or it stopped and the nudges ran out (393058c3, faulted). In
    each, its text named `publish` as the one allowed pick, so it read the newest list; it refused the pick on the task.
  - `mode-stop`, every measured trial passed, and 9 of 10 did not finish (for example 7f3ed024, cae14640, 9cb4a03a).
    After the wake the model picked `revise`, an allowed pick. Then it called `ask_review` again, whose receipt allows
    nothing, and it stopped each time: the loop `revise`, `ask_review`, stop ran until the nudge budget faulted the run.
  - `push-follow` and `push-no-refusal`, every measured trial passed both cells, and 6 of 10 did not finish (586bdcf9,
    9eae17a0, 855dd8ce, 1e78473f, 9b1d3c83, 565587a2). After a `revise` whose receipt said "…so it is not over yet" and
    allowed `ask_approval` and `run_tests`, the model ended its Submission with text ("I'll wait for the next prompt"),
    and the nudges ran out (`agent completed its turn without a pick that ends it`). The scenario failed at "every trial
    finished", so neither cell was written.
  - `continue-after-signed-push`, 4 of 10, below its floor of 9. Six trials were void past the bound (921a5999,
    6ba4640a, a9aba70e, 600bb85a, ba0ac32c, a63db6b3): the first push published no signed copy. The Sandbox has no git
    identity, so the model's first `git commit` failed, and the model sent the commit and `publish` in one response, so
    `publish` pushed only `init`. The model then set an identity and committed, so its later pushes published.

  After that run, main gave the Sandbox's git a default author (7d7f7f5) and changed the "…so it is not over yet"
  receipt (eb76a3e). The run of 2026-10-23 measured each of the five again. `noticed` and `continue-after-signed-push`
  gave 10 of 10, and `mode-refusal`, `mode-stop` and `push-follow` are the three Haiku scenarios above.

- The drivers' readings of the printed conversation, of a workflow's modes and of a restarted Harness container are
  plain functions in `features/lib/model-said.ts`, the readings of a trial's kept evidence are in
  `features/lib/model-evidence.ts`, and what each claim workflow means by "finished" is a table in
  `features/lib/model-finished.ts`, with unit tests beside them that need no cluster and no model.
- The run has a second form, `ticket-modes`: one coder Turn walks three modes of its state to a verified commit.
- A claim whose notice no step can yet raise (Compaction's summary, a kernel group kill) is added when the step exists;
  the ADR does not wait on it.
