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
  [ADR-0016](0016-agent-turn-mechanics-are-internal.md)); and a Turn hears its Allowed picks change under it at a step
  boundary, follows them without a refused pick, and picks inside the same Submission when a Gate's answer opens a pick
  while it works (ADR-0029). A claim qualifies when an ADR states what a correct Agent does differently for it and a
  step can observe the difference from outside the pod. **The run** is one `workspace()` workflow through to `done` on a
  real task: a ticket the seed Repo carries as a failing test, a planner's pick, a coder that edits in the Worktree,
  runs the test, commits on the run's branch and names the commit — a guard refuses a `submit` that names none — and a
  reviewer in the same Sandbox, read-only
  ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)), that runs the test itself and
  approves or rejects, bounded. Approval parks at a Gate, and the witness is the pod (parking is retention, ADR-0012):
  the branch is ahead of `main`, its head is the named commit, the tree is clean, and the test passes when the suite
  runs it there. Nothing is pushed — the Agent holds no credential and the push is the caller's (ADR-0005,
  [ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)), as `task` says — and
  the seed accepts none. The run asserts the pick ledger's shape and a time bound — never the diff, the commit message,
  or the Turn count, which are the model's.
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
  `features/model-endpoints/<name>.json` carries what `harness.provider` already takes — `api`, `baseUrl`, `models` with
  their windows — plus the tier's own `thinking` cells and `trials`, and optionally a `caBundle` path for a private CA
  ([ADR-0020](0020-private-ca-trust-is-a-named-concept.md)). `JR2_MODEL_ENDPOINT=<name>` selects it; `JR2_MODEL_API_KEY`
  is read from env alone. Before the converge, the fixture copies the selected profile to a fixed path inside
  `features/model-instance/`, and the instance's config and Agents import it from there — so the in-cluster Orchestrator
  reads the same values the host did (an env read in a definition is `undefined` in the pod, as the `@kind` config
  notes). A hosted provider is the same shape with a different `api`; nothing in the product learns the tier exists.
- **Not in CI. Run by whoever changed what the model reads, before calling the change done.** Not in `pnpm -r test`, not
  in the release job: it needs a cluster and an endpoint, it is nondeterministic by nature, and a gate that flakes is a
  gate everyone re-runs. `just e2e-model` probes the profile's endpoint first and, when nothing answers, exits 0 with
  one line — `skipped: no model endpoint at <url>` — so it can always be invoked and a skip is never silent. The trigger
  is a change to any text or tool the model reads or is offered: the Briefing, the Menu's rendering and the refusal, the
  nudge, the Working tools and their descriptions, Compaction's summary, the admit body's notices, the pi pin, a
  provider adapter, or an authoring surface that changes a Frame. An agent reviewing a feature or refactor that touched
  one of these runs the tier and reports the scorecard's floors and drift, or the skip, in its handoff. CLAUDE.md states
  the rule.
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
  past the bound counts against the floor.
- One trial may measure two claims: `push-follow` and `push-no-refusal` are two cells of one scenario's trials.
- The held-answer claims of ADR-0024 and ADR-0031 — `chain-answer` (the next pick follows the answer's last link),
  `refused-outstanding` (a pick refused while another was outstanding is picked again after the answer) and `cut-pick`
  (after a Harness restart cut the pick, the Agent uses the answer and does not pick it again; the step deletes the
  Instance Harness pod). Each floor carries ADR-0029/0062's measurement of a list read last, and the refusal's carries
  ADR-0029's recovery after one refusal. The first run (home-lab vLLM, 2026-10-07) confirmed two: `chain-answer` 10 of
  10 and `cut-pick` 10 of 10, now baselines. `refused-outstanding` is open: its setup is a model that makes both calls
  in one message, and in all 15 trials of each of three runs the model made them one after the other, so no trial
  reached the refusal the claim measures.
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
    Rest (ADR-0024), so `ask_review` would stay outstanding until it fired and its answer would carry the open picks on
    the same call; no model would stop. The prompt is unchanged: it is the claim's fixed data. What counts is unchanged:
    the trial is measured at the first ask after the model's `ask_review`, and void without one, and it passes when the
    first Menu call after that ask is a pick the mode active at the ask allows. The driver reads the modes from the
    workflow, not from a copy of them, and replays the model's calls through them: a mode with a targetless timer has
    its picks closed from each entry until the timer fires; the driver takes the timer where a restated Turn part shows
    that it fired, and follows it at the ask when the wake asked with nothing allowed.
  - `push-wake`. The step answered the board as soon as the Turn's prompt printed. In two runs, 8 and 9 trials had no
    restatement, each with one `hold` or `release` as its whole conversation: the answer had landed before the model's
    first pick, so the pick was taken and nothing needed restating. Five were replaced as void and the rest counted
    against the floor (7 and 5 of 10). The step now answers once the Turn's first step has ended with a Menu call, so a
    later step boundary must carry the change. The pass is unchanged: the first Menu call after the restatement is
    `release` or `hold`, with no ask before it.

  The Rest rule (ADR-0024) changed a third, `mode-refusal`, before any run under it. Its timer moved `reviewing` on to
  `approved` while the model composed its next call; under Rest that timer holds `ask_review` outstanding until it
  fires, so the stale list the claim needs never reaches the model and every trial would be void. The timer now has no
  target: it shuts the review window, and the guards of `revise`, `submit` and `publish` read it, so after it fires only
  `publish` is allowed in `reviewing`. The prompt, the floor and the pass are unchanged: the call after the correction
  receipt is `publish`. Both setups have run: `mode-stop` and `mode-refusal` cleared their floors 10 of 10.

- The drivers' readings of the printed conversation and of a workflow's modes are plain functions in
  `features/lib/model-said.ts`, with unit tests beside them that need no cluster and no model.
- The run has a second form, `ticket-modes`: one coder Turn walks three modes of its state to a verified commit.
- A claim whose notice no step can yet raise (Compaction's summary, a kernel group kill) is added when the step exists;
  the ADR does not wait on it.
