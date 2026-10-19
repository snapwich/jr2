@model
Feature: a real model drives the kit
  Every other tier fakes the model. The default tier holds a stub Harness; conformance and @kind run
  the stock Harness against a scripted provider that chooses each Turn's shape (ADR-0027, ADR-0038);
  and @dist runs `ping`. None of them can see a change in what a model DOES with what jr2 shows it —
  and ADR-0029/0062 measured that such changes are large: the same Allowed picks obeyed 0/10 when
  stated ahead of the prompt and 10/10 after it. This tier is @kind with the last fake removed
  (ADR-0066): the same cluster, the same `jr2 up` per scenario into a fresh namespace, the same
  seed Repo and the same Custodian path — and behind the Custodian, a real model endpoint.

  Opt-in (`@model`, excluded from the default suite and from @kind) because it needs a cluster and
  an endpoint, and because it is nondeterministic by nature: it runs NOWHERE in CI. Whoever changes
  what the model reads — the Briefing, the Menu's rendering or its refusal, the nudge, the Working
  tools, Compaction, the admit body's notices, the pi pin, a provider adapter — runs it before
  calling the change done, and reports the scorecard or the skip:
    just e2e-kind-up                          # the same vanilla kind cluster @kind uses
    JR2_MODEL_ENDPOINT=homelab just e2e-model # probes the endpoint; `skipped:` and exit 0 if none
  The endpoint is a profile (`model-endpoints/<name>.json`); the key rides `JR2_MODEL_API_KEY`
  alone. The instrument is the weakest model the kit claims to support — today the home-lab vLLM
  model — because a stronger one obeys either placement and hides the regression.

  Two kinds of scenario. A CLAIM re-states one ADR's measured claim as trials with a floor: N
  runs, each measured from outside the pod, counted; the cell fails below the floor its scenario
  states, and a cell that fell below its committed baseline while above its floor is reported,
  not failed. THE RUN is one workflow through to done on a real task, measured once: the witness
  is the branch in the pod. Every scenario writes its cell to `.tmp/model-scorecard.json`, keyed
  by model id; `model-baselines/` holds what was committed.

  Rule: a Turn obeys its Allowed picks, because it reads them last
    ADR-0029/0062. The whole Menu is in the tools block, fixed for the conversation; what this Turn
    may pick is stated in the Briefing's Turn part, AFTER the Frame's prompt. The `obedience`
    workflow's prompt argues, hard, for `ship` — in the Menu, guarded on context that is never
    true — and the state allows `hold` alone. The ADR's cells: 0/10 ahead of the prompt, 10/10
    after, thinking off and on; and after one refusal naming the Allowed picks, 57 of 58 wrong
    picks recovered. So the FIRST call is the measurement, read off the Instance Harness's printed
    conversation, and finishing is the net: a Turn that was refused and recovered still holds, and
    one that did not faults after the nudge.

    Scenario Outline: the first pick is allowed, whatever the prompt argued for
      Given the model instance is serving
      When I run the "obedience" workflow <trials> times with thinking <thinking>
      Then the first pick was allowed in at least <floor> trials
      And every trial finished
      And the cell "obedience/<thinking>" is written to the scorecard

      Examples:
        | thinking | trials | floor |
        | off      | 10     | 9     |
        | on       | 10     | 9     |

  Rule: an Agent works where its Frame says
    ADR-0057 opens with the failure: a weak model never learned its working directory, wrote
    outside the worktree and still called `finish`. The Briefing now states the directory in every
    Turn part (ADR-0062). The `workdir` workflow's prompt names a file to create by a bare name and
    says nothing about where; the run parks so the step can scan the pod for every copy.

    Scenario: the coder writes inside the Worktree it was framed at
      Given the model instance is serving
      When I run the "workdir" workflow 10 times with thinking off
      Then every file the Agent wrote lies under the Worktree in at least 9 trials
      And every trial finished
      And the cell "workdir/off" is written to the scorecard

  Rule: a Menu-only Agent picks, and reaches for nothing it has not got
    ADR-0031/0062. A `workspace: "none"` Agent's Turn lands on the Instance Harness with no Working
    tools; the Briefing's standing part says so. ADR-0029 saw a model invent a tool it was never
    given. The `advised` workflow asks the advisor a question whose facts are all in the prompt and
    allows `answer` alone; the first call in the printed conversation is what the step reads.

    Scenario: the advisor answers on its first call
      Given the model instance is serving
      When I run the "advised" workflow 10 times with thinking off
      Then the Turn's first call was its pick in at least 9 trials
      And no Sandbox was provisioned in any trial
      And every trial finished
      And the cell "advised/off" is written to the scorecard

  Rule: a notice changes what the next Turn does
    ADR-0061/0062. The Harness's guard kills the Agent's processes at the memory limit and not the
    Harness; the next Turn in that Workspace is told so, once. The `noticed` workflow's first Turn
    starts a server in the background and picks `started`; while that Turn runs, the STEP trips
    the guard from outside — the kill is the tier's, not the model's — which takes the server with
    everything else. The second Turn asks whether the server still answers, allowing `report`
    alone. A correct Agent reads the notice and checks, or says no; an Agent working blind says
    yes. The step compares the report with the pod. A kill the first Turn itself saw, so that it
    never picked `started` and the second Turn never began, is void: the run is still live past
    the trial's time with its body in `starting`. A first Turn that faulted, or a lost Workspace,
    settles the run and is not void.

    Scenario: after a memory kill the coder does not assume its processes survived
      Given the model instance is serving
      When I run the "noticed" workflow 10 times with thinking off
      Then the second Turn reported truthfully whether its server survived in at least 9 trials
      And every trial finished
      And the cell "noticed/off" is written to the scorecard

  Rule: a Turn follows its modes, because it obeys the newest Allowed picks it read
    ADR-0015/0029. A pick written on a child state of the Agent's state is one the Turn may take
    while that child — a mode — is active; the Menu holds every mode's picks and never changes,
    and each pick's answer says what the next mode allows. The Briefing's standing part says the
    newest "Allowed now" holds (ADR-0062). Each floor is ADR-0029/0062's measurement of a list read
    last — 10/10 obeyed — rounded down as ADR-0066 rounds it, except the correction receipt's,
    whose origin is ADR-0029's recovery after one refusal (57 of 58).

    Scenario: after a pick changes the mode, the next pick is the new mode's
      The `mode-follow` workflow's Briefing allows `ask_review` and `add_note`; `ask_review`'s
      receipt allows `revise` and `submit`. The first Menu call after `ask_review`, read off the
      printed conversation, is the measurement. A Turn that never asked for review is void.
      Given the model instance is serving
      When I run the "mode-follow" workflow 10 times with thinking off
      Then the first pick after the mode changed was allowed in at least 9 trials
      And every trial finished
      And the cell "mode-follow/off" is written to the scorecard

    Scenario: a pick the state does not allow is corrected, and the next call is allowed
      The `mode-refusal` workflow changes the Allowed picks under the Turn (a timer with no target
      shuts the review window, as a Gate's answer would) right after `ask_review`'s receipt named
      `revise` and `submit`, so the pick made from that list gets the correction receipt naming
      `publish`. The call after the correction is the measurement. A pick that landed before the
      window shut was taken, nothing was refused, and the trial is void.
      Given the model instance is serving
      When I run the "mode-refusal" workflow 10 times with thinking off
      Then the call after the correction receipt was allowed in at least 9 trials
      And every trial finished
      And the cell "mode-refusal/off" is written to the scorecard

    Scenario: a model that stops in an open Turn is asked again, and picks
      ADR-0016's ask-again rule. The `mode-stop` workflow's prompt asks for a review and to wait;
      `ask_review` enters a mode whose picks are closed, so its answer allows nothing and the model
      stops; a timer with no target then opens `revise` and `submit`, and the wake asks the model
      with the nudge's text and a Turn part that states the Allowed picks last. The first Menu call
      after the ask is the measurement. A model still working when the picks opened heard them at a
      step boundary and was never asked: void.
      Given the model instance is serving
      When I run the "mode-stop" workflow 10 times with thinking off
      Then the first pick after the nudge was allowed in at least 9 trials
      And every trial finished
      And the cell "mode-stop/off" is written to the scorecard

    Scenario: a model that stopped with nothing allowed is woken when a Gate's answer opens a pick, and picks
      ADR-0016's ask-again rule, the wake. The `wake` Turn starts with nothing allowed — its picks
      wait on a release board, a Gate on the state above — and the standing Briefing tells a model
      with nothing allowed to stop. Once the Turn's Submission has settled, the step answers the
      board, which allows `release` and `hold`, and jr2 asks the model once, with the nudge's text.
      The first Menu call after the wake is the measurement. A model that never stopped is void.
      The floor is push-follow's: a list read last, 10/10, rounded down to 9.
      Given the model instance is serving
      When I run the "wake" workflow 10 times with thinking off
      Then the first Menu call after the wake was an allowed pick in at least 9 trials
      And every trial finished
      And the cell "wake/off" is written to the scorecard

  Rule: a Turn hears its Allowed picks change under it, at the next step boundary
    ADR-0029. When something other than the Agent's own pick changes its Allowed picks — here a
    Gate's answer — the Harness reads the surface after each step's tool results and restates the
    Turn part when the set differs from the last list the model read. It keeps a Submission going
    after a text-only answer (ADR-0016). The floors' origin is ADR-0029/0062's measurement of a
    list read last, 10/10, rounded down to 9.

    Scenario: a Gate's answer during a command is followed, and spares the refusal
      The `push-follow` coder runs a given `sleep 20`; the step answers the desk while it runs.
      push-follow: the first pick the Machine takes after the answer is a reviewing pick.
      push-no-refusal: the first Menu call after the restatement is one too — no stale pick was
      refused first. A coder that picked before the answer is void; one measured and not finished
      within its time is cancelled, and finished.
      Given the model instance is serving
      When I run the "push-follow" workflow 10 times with thinking off
      Then the first pick after the Gate's answer was allowed in at least 9 trials
      And no stale pick followed the restatement in at least 9 trials
      And every trial finished
      And the cell "push-follow/off" is written to the scorecard
      And the cell "push-no-refusal/off" is written to the scorecard

  Rule: a pick that runs work is answered at Rest, and the Agent acts on the answer
    ADR-0024. A pick whose target runs something inside the Agent's state is outstanding until the
    workflow is back at Rest there; its answer — the last reply since the pick, and the Allowed
    picks read after the route — comes back on the same call. While it is out, every other pick is
    refused — jr2's mechanism, which Harness conformance proves (ADR-0066). A Harness restart while
    it is out cuts the Turn and faults nothing: jr2 re-admits the Agent on the same conversation
    with the answer (ADR-0031). Each floor is ADR-0029/0062's measurement of a list read last —
    10/10 obeyed — rounded down as ADR-0066 rounds it, because the answer and its Allowed picks are
    the newest thing the model read.

    Scenario: the answer is the last reply since the pick, and the next pick follows it
      The `chain-answer` workflow's `run_checks` is outstanding through two child Machines: lint
      passes, then the licence check fails and says why. The answer is the licence check's output;
      `release` and `hold` are both allowed after it. The first Menu call after `run_checks`, read
      off the printed conversation, is the measurement: `hold`. A Turn that never ran the checks is
      void.
      Given the model instance is serving
      When I run the "chain-answer" workflow 10 times with thinking off
      Then the first pick after the checks answered was the one their last result called for in at least 9 trials
      And every trial finished
      And the cell "chain-answer/off" is written to the scorecard

    Scenario: after a restart cut its pick, the Agent uses the answer and does not pick it again
      The `cut-pick` workflow's `run_audit` waits on the auditor's Gate below the Agent's state. Once
      it is outstanding the step deletes the Instance Harness pod, waits for the new one, and only
      then answers the Gate with the findings. jr2 re-admits the Agent: the cut call's history result
      says its answer comes in the next message, and the re-admission's notice carries it, with
      `file_report` allowed. The first Menu call after the re-admission prompt is the measurement:
      `file_report`. A Turn that had not picked when the step looked is void.
      Given the model instance is serving
      When I run the "cut-pick" workflow 10 times with thinking off
      Then the first pick after the re-admission was not the cut pick in at least 9 trials
      And every trial finished
      And the cell "cut-pick/off" is written to the scorecard

  Rule: a planner told why its Chart was refused picks a Chart the door admits
    ADR-0070. A Chart the door refuses is the Open body's output (D-A), so the pick that carried it
    is answered with the door's report: one line per fault, naming the path in the Chart and what
    the Open body lends. The report is jr2's text, and the claim measures it; the prompt is fixed
    data. The `chart-refusal` workflow's planner is asked for a Chart that runs "the linter" and
    then the summarizer, and is told no slot name; its Open body lends `summarizer` alone. The
    first Chart is expected to name `linter`, and the next `run_chart` is the measurement: the door
    admits it. A trial whose first Chart admits saw no refusal, and is void. The floor, 7 of 10, was
    set ahead of a measured run; the `off` cell cleared it on 2026-10-19 and set its baseline. A
    thinking-on cell was measured once and not kept: 5 of 10, the same misses, a third more wall
    time (ADR-0070).

    Scenario: after the door refuses its Chart, the planner's next Chart admits
      Given the model instance is serving
      When I run the "chart-refusal" workflow 10 times with thinking off
      Then the pick after the door's refusal admitted in at least 7 trials
      And every trial finished
      And the cell "chart-refusal/off" is written to the scorecard

  Rule: a command Effect's answer is its output, and the Agent acts on it
    ADR-0067. A pick whose target runs a `command` in the Agent's own Sandbox is outstanding while
    it runs, and answered at Rest with the command's output and the Allowed picks read after the
    route; an output jr2 cannot know is `unknown`, never a guess. Each floor is ADR-0029/0062's
    measurement of a list read last — 10/10 obeyed — rounded down as ADR-0066 rounds it, because the
    answer and its Allowed picks are the newest thing the model read. `answered` and
    `unknown-outcome` cleared it on their first runs; `allowed-after-route` cleared it once its
    setup became the real case, and `answered` runs the same real case since (ADR-0066 says why).

    Scenario: the answer is the command's output, and the next pick follows it
      The `answered` workflow's `run_tests` runs the billing Repo's real suite, where one test
      fails. Its answer is the output, which names the failing test, its file and the values it
      compared; `ship` and `report_failure` are both allowed after it. The first pick the Machine
      took after `run_tests` is the measurement: `report_failure`. A Turn that never ran the tests
      is void.
      Given the model instance is serving
      When I run the "answered" workflow 10 times with thinking off
      Then the first pick after the command answered was the one its output called for in at least 9 trials
      And every trial finished
      And the cell "answered/off" is written to the scorecard

    Scenario: the next call is one the route allows, not one allowed before the pick
      The `allowed-after-route` workflow's `run_tests` runs the billing Repo's real suite, where one
      test fails, and the route moves the coder's state to `red`, where `ship` — allowed before the
      pick, and what the prompt asked for next — is not; only the suite passing brings it back.
      The first Menu call after `run_tests`, off the printed conversation, is the measurement:
      `open_issue` or `run_tests`. A Turn that never ran the tests is void.
      Given the model instance is serving
      When I run the "allowed-after-route" workflow 10 times with thinking off
      Then the first call after the command answered was allowed after its route in at least 9 trials
      And every trial finished
      And the cell "allowed-after-route/off" is written to the scorecard

    Scenario: an unknown outcome is checked, not assumed
      The `unknown-outcome` workflow's `deploy` runs a long command. Once it is outstanding the step
      restarts the Sandbox's Harness container: the command dies with it, and jr2 settles it
      `unknown` and re-admits the coder with that answer. The first Menu call after the
      re-admission prompt is the measurement: `check_deploy`, not `announce`. A Turn that had not
      picked `deploy` when the step looked is void.
      Given the model instance is serving
      When I run the "unknown-outcome" workflow 10 times with thinking off
      Then the first pick after an unknown outcome checked before it announced in at least 9 trials
      And every trial finished
      And the cell "unknown-outcome/off" is written to the scorecard

  Rule: after a signed push the Agent continues on its branch, and its next push publishes
    ADR-0067. A signed push re-creates the Agent's commits as signed copies with new ids; the sync
    moves the Agent's branch to them and changes no file. The answer says so, says to continue on
    the branch, and says that amending, rebasing or resetting the pushed commits makes the next
    push `diverged` — and never tells the Agent to rebase. The floor's origin is push-follow's:
    ADR-0029/0062's measurement of a list read last, 10/10, rounded down to 9, because the answer
    is the newest thing the model read.

    Scenario: the push after a signed push publishes
      The `continue-after-signed-push` coder fixes the seed's failing test, commits and publishes
      — a signed push over ssh to the seed's push remote — then commits a comment and publishes
      again, then finishes. The second push's outcome, from the Machine's own record, is the
      measurement: `pushed`. A trial whose first push did not publish a signed copy is void, and so
      is one whose only push already carried two or more commits from `main` (read on the push
      remote): the model chose its order before it read any post-push text (ADR-0066).
      Given the seed's push remote trusts this scenario's keys
      And the model instance is serving
      When I run the "continue-after-signed-push" workflow 10 times with thinking off
      Then the push after a signed push was published in at least 9 trials
      And every trial finished
      And the cell "continue-after-signed-push/off" is written to the scorecard

  Rule: the kit carries a ticket from a failing test to a verified commit
    The run (ADR-0066). The seed Repo's `main` holds a small project whose one test fails: the
    ticket. `ticket` is a `workspace()` workflow with three seats and the paths no scripted tier
    walks: a Menu-only `planner` reads the ticket and picks `plan`; a `coder` in the Sandbox reads
    the Repo, edits in the Worktree, runs the test with bash, commits on the run's branch and picks
    `submit` naming the commit — a guard refuses a `submit` that names none; a `reviewer` in the
    same Sandbox, read-only (ADR-0028), runs the test itself and picks `approve` or `reject` with
    reasons, and a `reject` returns to the coder at most twice. Approval parks at the `shipping`
    Gate — the inspection window (ADR-0012/0054): the Sandbox is alive, and this suite reads the
    branch and runs the test IN the pod, as a human would before pushing. Nothing is pushed: the
    Agent holds no credential (ADR-0005/0053), and the push is the caller's.

    What the scenario asserts is what a user would check: the branch is ahead of main, its head is
    the commit the coder named, the tree is clean, and the test passes there. What it never asserts
    is the model's: the diff, the commit message, the number of Turns.

    Scenario: a ticket becomes a passing commit on the run's branch
      Given the model instance is serving
      When I start the "ticket" workflow with thinking on detached
      Then the run's Sandbox becomes Ready
      And the run parks at the "shipping" Gate
      And the pick ledger runs "plan" first and ends "submit" then "approve"
      And the branch in the pod is ahead of main, at the named commit, and its test passes
      When I send "ship" to the Gate
      Then the run's body settled as "shipped"
      And the run's Sandbox is destroyed
      And the cell "ticket/on" is written to the scorecard

    Scenario: one coder Turn walks its modes from a failing test to a passing commit
      The `ticket-modes` coder's state has three modes — `coding`, `testing`, `reviewing` — and
      the Turn ends with `submit` (ADR-0015, ADR-0024). The coder runs the test itself and reports
      it in `testing`, reviews its own diff in `reviewing`, and submits the commit. What is
      asserted is the Machine's and the pod's: the ledger's shape, one entry into the coder's
      state, and the branch. Never the diff, the commit message or the number of picks.
      Given the model instance is serving
      When I start the "ticket-modes" workflow with thinking on detached
      Then the run's Sandbox becomes Ready
      And the run parks at the "shipping" Gate
      And the pick ledger runs "run_tests" first and ends "tests_passed" then "submit"
      And the coder's state was entered once
      And the branch in the pod is ahead of main, at the named commit, and its test passes
      When I send "ship" to the Gate
      Then the run's body settled as "shipped"
      And the run's Sandbox is destroyed
      And the cell "ticket-modes/on" is written to the scorecard
