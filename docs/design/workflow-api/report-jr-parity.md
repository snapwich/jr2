# jr parity report — ground truth from /home/richs/.local/share/jr

Sources: `scripts/justfile` (start-work lines 690–1775, signal 1959, task-diff/commits, me/approve/request-changes,
merge-all, rebase-feature, notes --after, with-lock), `CLAUDE.md`, `docs/workflow.md`, `claude/.claude/agents/jr/*.md`
(coder, code-reviewer, architect-reviewer, investigator, rebaser), `claude/.claude/prompts/jr/subagent-task.md`,
`templates/`. Compared against `/home/richs/repos/j2/default/examples/coding/workflows/coding.ts`.

## 1. Behavior spec — observable jr semantics, one sentence each

Classification tag per item: **[P]** pure workflow policy (consumer authors), **[M]** orchestrator mechanics (j2
absorbs), **[A]** ambiguous.

### Work model & discovery

1. **[P]** Work is a two-level ticket hierarchy: features (one worktree = one branch = one PR) containing a linear chain
   of tasks; the feature ticket depends on all its children, so it becomes "ready" exactly when the chain completes
   (`verify-tickets` enforces linearity + no cross-feature task deps).
2. **[A]** Discovery is a re-queried ready-set (`tk ready` each loop pass), never a materialized queue; the ticket store
   is the single durable source of truth and the orchestrator is fully restartable from it. (Policy: what "ready" means;
   mechanics: the requery/spawn/collect loop — brief decision 6.)
3. **[P]** Launchability is routed by ticket assignee: tasks assigned to `jr:coder`/`jr:code-reviewer` launch that
   persona, human-assigned tasks are silently skipped, features launch the architect only when assigned
   `jr:architect-reviewer`, human-assigned features are the human gate.
4. **[M]** At most `JR_MAX_CONCURRENT` (default 3) subagents run at once; discovered work beyond the cap waits for a
   slot.
5. **[M]** One agent per worktree at a time, enforced by a PID-symlink lock keyed on the feature worktree name, with
   stale-lock cleanup by PID liveness at startup (coding.ts makes this structural: one sequential body per feature — the
   right absorption).
6. **[P]** Worktree/branch names derive from the feature ticket: `external-ref` (preserving case) or ticket id, plus a
   title slug.
7. **[P]** Stacked features: a feature depending on an open upstream feature branches off the upstream's branch; if the
   upstream is closed and its branch deleted, base falls back to the feature's `base:<branch>` tag or `origin/HEAD`.
8. **[P]** Multi-repo: a feature's `repo:<name>` tag selects which repo gets the worktree; tasks inherit the feature's
   repo.
9. **[M]** Worktree creation fetches origin, resolves/falls back the base ref, creates branch + worktree, and deploys
   agent configs into it; failure to create escalates the ticket rather than crashing the run.

### Task lifecycle

10. **[P]** Coder implements a task, marks it in-progress, commits with `Tk-Task: <id>` trailers (so reviewers find the
    task's commits, rebased or not), logs decisions as ticket notes, and signals `requesting-review`.
11. **[P]** On `requesting-review` the orchestrator reassigns the ticket to the code-reviewer and launches it
    immediately (not via the ready-set).
12. **[P]** Reviewer `approved` closes the task; `changes-requested` reassigns to coder and relaunches — a fresh coder
    that reads the review notes + code, deliberately without the original implementation context.
13. **[P]** Review rounds are capped at `JR_REVIEW_ROUNDS` (default 5) `changes-requested` verdicts, counted from
    durable ticket notes since the last reset point; at the cap the ticket escalates.
14. **[P]** The code-reviewer round counter resets on each orchestrator run start and on approval; the architect's round
    counter persists across runs (only resets on APPROVED).

### Feature lifecycle

15. **[P]** When all child tasks close, the feature becomes ready and the architect reviews the full branch diff for
    cross-task coherence and acceptance-criteria coverage.
16. **[P]** On architect `changes-requested`, the _architect itself_ reopens or creates tasks and re-chains deps via tk;
    the orchestrator does nothing but let discovery find the reopened tasks.
17. **[P]** On architect `approved`, the feature is assigned to `human`, ticket state is committed as a git checkpoint,
    and the terminal bell rings; with `--no-human-review` the feature auto-closes instead (crash-safe: a restart
    auto-closes any human-assigned feature it finds).
18. **[P]** Human `approve` validates all children are closed then closes the feature (unblocking downstream features);
    human `request-changes` adds a `[human] CHANGES REQUESTED: <feedback>` note and reassigns the feature to the
    architect, who decides what to reopen on the next run.
19. **[P]** Merging is out-of-band after the run: `merge-all` merges closed feature branches into their bases in
    dependency order, atomically via a temp branch, handling squash + stacked-branch rebases, cleaning up worktrees;
    `rebase-feature` (with an opus `rebaser` persona for conflicts) refreshes downstream stacks.

### Signals & handoff

20. **[A]** All agent→orchestrator communication is a typed signal vocabulary (`requesting-review`, `approved`,
    `changes-requested`, `escalate`, `resume`, `rebase-complete`) — the vocabulary is policy, the transport (atomic
    `just signal` writes a `[signal:agent]` note AND prints a parseable block) is mechanics.
21. **[M]** The orchestrator parses signals primarily from ticket notes, fenced to notes after the last
    `[orchestrator] Run started` marker, so stale signals from prior runs are never re-dispatched and stdout corruption
    cannot lose a signal.
22. **[P]** Handoff between agents is intentionally lossy: incoming agents get only the ticket description + notes + the
    actual code — never the prior agent's conversation (design goal: reviewers come in fresh; revision coders don't
    defend the original approach).
23. **[P]** Note conventions carry routing meaning: task notes are for the next agent on the same task, feature notes
    for sibling tasks and the architect; notes are auto-prefixed `[$JR_AGENT]`.

### Failure handling

24. **[M]** Every agent launch is time-boxed (`JR_AGENT_TIMEOUT`, default 60 min) and its exit code captured; an exit
    without a valid signal (timeout 124/137 or any crash) enters the no-signal path — this is jr's most exercised
    failure mode and it is never silent.
25. **[A]** No-signal exits are triaged by a synchronous investigator persona (haiku, read-only, ≤5 turns, 600s timeout)
    given the session-JSONL tail (50 KB), ticket notes, and worktree diff (30 KB); it returns `resume` (optionally with
    a one-line steering nudge injected into the next prompt) or `escalate` with a diagnosis. (Budgeted auto-resume =
    mechanics per brief decision 5; the judgment call + nudge is a policy hook jr found valuable.)
26. **[M]** Resumes are budgeted per ticket per run (`JR_RESUME_BUDGET`, default 3, counted from crash/timeout notes
    since Run started); once exhausted, no-signal exits escalate without invoking the investigator.
27. **[P]** A "resume" is a _fresh Claude session_ (new session id every launch) whose prompt is the base task prompt
    plus a "Resumed Task" header with only the ticket notes added since the previous session's timestamp (from
    `session-history.jsonl`) — jr never re-attaches a conversation, by design (see item 22).
28. **[P]** Escalation is per-ticket and non-halting: reassign to `human`, add an
    `[orchestrator] Escalated to human: <reason>` note, ring the bell, keep running sibling work, and list all
    escalations in the end-of-run summary.
29. **[P]** Escalation triggers: agent `escalate` signal (with `ENV BLOCKER` / `SCOPE DISCOVERY` note conventions),
    review-round cap, resume-budget exhaustion, investigator escalate/timeout/no-valid-signal, worktree-creation
    failure, unparseable rate-limit line.
30. **[P]** Escalated work is recoverable: the worktree and branch persist untouched, and the coder persona has an
    explicit post-escalation re-entry protocol (verify the blocker is fixed, escalate again immediately if not) for when
    a human resolves the blocker and re-runs.
31. **[M]** Rate limits are handled deterministically, not via the investigator: parse the reset time from the literal
    limit message, note it on the ticket (the note is the cross-restart source of truth), drain in-flight agents, sleep
    until reset + 5 min, resume; deferrals don't consume resume budget; an unparseable reset line escalates so parser
    drift is visible.

### Run lifecycle & surfacing

32. **[A]** The run _terminates_ with meaningful exit codes: 0 = backlog empty, 2 = finished with escalations or
    deadlock, 3 = features awaiting human review (3 wins over 2), 130 = interrupted — the run is a batch job a human or
    cron reacts to, not a resident service. (Policy: terminal conditions; mechanics: how status is surfaced.)
33. **[M]** Deadlock is detected and surfaced: open tickets exist but none are ready and nothing is running → exit 2
    rather than spinning forever.
34. **[M]** The terminal bell rings on every event needing eventual human attention (escalation, feature ready for
    review, rate-limit sleep/wake, run end); `just me` lists everything assigned to `human` with suggested actions.
35. **[M]** Observability: every launch appends `{ticket, agent, session, worktree, pid, ts}` to sessions.jsonl /
    session-history.jsonl; `just watch` tails live agent transcripts; Ctrl-C snapshots the descendant PGID tree,
    releases locks, and TERM/KILLs cleanly.
36. **[M]** Agent launching mechanics: cwd = the worktree, `JR_AGENT` env set, model read from persona frontmatter,
    prompt assembled from the shared `subagent-task.md` template + project-level (`_`) and per-repo extensions; persona
    files themselves are similarly base+extension merged per project/repo.
37. **[M]** Agents can serialize access to shared resources via `just with-lock <resource> <cmd>` (flock).

### JR\_\* knobs (all env, all defaulted)

`JR_MAX_CONCURRENT`=3, `JR_REVIEW_ROUNDS`=5, `JR_RESUME_BUDGET`=3, `JR_AGENT_TIMEOUT`=3600s, `JR_NO_HUMAN_REVIEW`=0,
`JR_RATE_LIMIT_MAX_SLEEP_S`=0 (uncapped), `JR_PROJECT_DIR`, `JR_OUTPUT_DIR`, `CLAUDE_CMD` (test seam), `JR_AGENT` (set
by orchestrator, read by `just signal`/`add-note`).

## 2. coding.ts vs jr

### (a) jr behaviors coding.ts drops or distorts

- **DISTORTED — context continuity is inverted.** coding.ts's conceit ("same iid = same conversation = jr's resume
  machinery, free", line 36 + `iid()`/`turn()`) misreads jr: jr launches a **fresh session on every relaunch**
  (`uuidgen` per launch in `launch()`; `session-history.jsonl` only selects a resume _prompt_ — log line literally says
  "Fresh session (prior: …)"), and fresh context is a stated **design goal** (CLAUDE.md "Intentional context
  isolation"). coding.ts's coder keeps one conversation per task across review rounds — the opposite policy. The
  redesign must let the workflow _choose_ fresh-vs-continue per transition; "same iid = same conversation" (brief
  decision 2) is fine as mechanism, but the coding workflow should mostly choose _fresh_.
- **DISTORTED — escalation destroys work.** jr escalation leaves the worktree + branch intact for human inspection and
  post-escalation re-entry (items 28, 30); coding.ts's `escalated` state runs `escalateTicket` then reaches final, which
  by teardown-by-wrapper destroys the Sandbox and unpushed commits. This is a _semantic_ loss, not merely a durability
  loss: the human's escalation workflow is "look at the worktree". Needs park-or-push before final.
- **DISTORTED — architect round accounting.** coding.ts increments `archRounds` on human `request_changes` (line 393)
  and never resets it on approval; jr counts only architect `CHANGES REQUESTED` notes since the last APPROVED (human
  rework starts a fresh cycle). A feature ping-ponging with the human could spuriously exhaust the cap. Conversely jr's
  coder-counter reset per orchestrator run is accidental (see (c)); coding.ts's per-task-claim reset is the cleaner
  intent.
- **DROPPED — investigator triage + steering nudge** (declared: "v1 = blind retry"). jr's resume is not blind: a cheap
  judgment (resume vs escalate, with diagnosis or nudge injected into the next prompt) sits between failure and retry.
  With brief decision 5 absorbing the retry budget: where does the consumer plug a triage/nudge hook, and what carries
  the diagnosis into the escalation note?
- **DROPPED — no-signal detection & agent time-boxing.** coding.ts has `agent.fault` but no modeling of an agent that
  _ends its turn_ without firing an event, nor of `JR_AGENT_TIMEOUT`. Brief decision 5's auto-nudge should explicitly
  cover "turn ended, no event".
- **DROPPED — rate-limit backpressure** (declared: infra). Preserve the observable semantics: pause-not-escalate, no
  retry-budget consumption, survives restart, sleep is surfaced.
- **DROPPED — deadlock detection.** jr exits 2 when open tickets exist but none ready and nothing runs; coding.ts
  `settling → idle` re-polls forever, indistinguishable from a healthy park.
- **DROPPED — end-of-run semantics** (exit 0/2/3, escalation summary, `just me`). Replaced by parked states +
  `emit("attention")`; the j2 run needs an equivalent queryable "what needs a human" surface (the gates list mostly is
  it) and a real terminal outcome.
- **DROPPED — stacked features & base-branch resolution.** `Ticket.baseRef` is "resolved by the tk actor" (sketch) but
  the upstream-feature-branch logic (item 7), ghost/rebase handling, and merge-all are gone; merge/rebase are declared
  out (PR-based, forge merges) — reasonable, but stacked _in-flight_ features (B branches off A's unmerged branch) has
  no story in the PR model.
- **DROPPED** — ticket-state checkpoint commits (17), multi-repo (`repos: [{name: "app"}]` hardcoded), prompt/persona
  extension layering (36), human-approve validation (children closed), `--no-human-review` autonomous mode, `with-lock`
  (37).

### (b) coding.ts additions jr never had (invented while designing the API)

- `offsets` map, `agent.offset` handler, attach-vs-prompt branch, `turn()`/`iid()` — durability plumbing; brief decision
  2 deletes.
- `endpoint`/`sandbox`/`instanceId` threading + the 20-line `WorkspaceHandles` alias apologia (line 132) — brief
  decision 3 deletes.
- `retriesLeft`/`spendRetry`/`hasRetryBudget`/`retryOrEscalate`/`reenter` — retry accounting in context; jr kept it in
  notes, j2 absorbs (brief decision 5).
- `export const events` manifest + `EventFrom` unions + names-not-defs in `tools:` — brief decision 7 deletes.
- **`stalled` state + `resume` gate** — no jr analog; a chain blocked on a human-assigned task simply never surfaces in
  `tk ready` and the run ends. It exists to keep the Sandbox alive, i.e. a workaround for teardown-on-final; if
  escalation parking is solved, reconsider whether `stalled` earns its place.
- **`openingPr`** — jr never pushes or opens PRs (human reviews the local worktree; merge-all merges locally).
  Deliberate redesign, probably right for sandboxes, but it is new policy, not parity.
- `workReady` push gate + 30s idle poll — jr has no push seam; belongs to the pool-over-source primitive (brief decision
  6).
- `workspace.lost` — genuine new sandbox requirement, correctly routed to escalate.
- Top-machine bookkeeping: `active`/`completed`/`escalated` arrays, spawnChild-placement footgun comment, `stopChild` +
  `xstate.done.actor.*` casts, `claimedFeature` cast, root-`output` forwarding cast — spawn-under-cap/collect mechanics
  the pool primitive should absorb.
- Two-step finals (`escalated → escalatedDone`) to sequence an async action before final — shape noise.

### (c) jr's own accidental complexity (simplifiable while fulfilling the goal)

- **Signals-as-note-grep**: `just signal` sentinel notes, `parse_signal` grep, Run-started fencing,
  `count_review_rounds`/`count_resumes` by counting note lines — workaround for "bash can't receive structured events
  from a background process". Typed events + durable context fulfill the goal directly; but the fencing/reset semantics
  were load-bearing (stale-signal immunity, per-run vs per-cycle counters) and must be reproduced deliberately.
- **session-history.jsonl + resume prompts + `notes --after`**: reconstruction machinery for "what changed since last
  session" — exists only because orchestrator memory dies with the process. Keep the _policy_: a relaunched agent is
  told it's a re-entry and gets the note delta.
- **Worktree symlink locks + stale-PID cleanup + BUSY_WORKTREES**: invariant is "one agent per feature"; sequential
  per-feature body is the honest encoding (coding.ts got this right).
- **Rate-limit stdout parsing** (regex on the human-facing limit message + DST math + 5-min buffer +
  unparseable-escalation): brittle by admission; goal is provider-backpressure pause — infra.
- **Exit-code protocol (0/2/3, "3 wins over 2")**: encodes "what needs the human" in a process exit; queryable
  gates/status make it unnecessary — but keep a terminal "backlog empty" outcome (jr runs end).
- **Per-run reset of the coder review counter**: a restart grants 5 fresh rounds — artifact of note-counting, not
  intent; per-cycle counter in durable context is the cleaner fulfillment.
- **Feature-depends-on-all-children readiness trick**: encodes "architect goes when the chain is done" in the dep graph
  so `tk ready` surfaces it; machine structure says it directly (coding.ts got this right).
- **stow/rsync .claude deployment, persona/prompt extension merging, ARG_MAX byte-truncation, PGID-tree cleanup, fzf
  watch**: host-CLI mechanics that vanish under j2 (provisioning, run feed, visualize).
- **merge-all + rebase-feature + rebaser persona (~700 lines)**: consequence of keeping merges local; PR-based redesign
  deletes it. Residual gap: stacked-branch refresh after upstream merge.
- **Investigator prompt assembly** (find session JSONL by uuid, truncate, embed diff): mechanics; a durable run +
  telemetry should make failure context cheap for any triage hook.

## 3. Classification summary

| Behavior                                                                           | Class                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Ticket hierarchy, linear chains, assignee routing (1, 3, 6–8)                      | Policy                                                  |
| Coder→reviewer→architect→human pipeline, immediate reviewer handoff (10–12, 15–18) | Policy                                                  |
| Review-round caps + reset semantics (13, 14)                                       | Policy (counter storage = mechanics)                    |
| Fresh-context vs continued-conversation per handoff (22, 27)                       | Policy — needs an API affordance                        |
| Escalation targets, non-halting, re-entry, worktree survival (28–30)               | Policy (park/teardown = mechanics hook)                 |
| Human gate semantics, --no-human-review, approve validation (17, 18)               | Policy                                                  |
| PR vs merge-all, stacked branches (7, 19)                                          | Policy (redesigned in coding.ts)                        |
| Ready-set discovery, spawn-under-cap, completion collection (2, 4)                 | Ambiguous → pool primitive (brief 6)                    |
| Signal transport, validation, stale-signal immunity (20, 21)                       | Mechanics                                               |
| Worktree/sandbox provisioning, locking, teardown (5, 9)                            | Mechanics                                               |
| No-signal detection, time-boxing, retry/nudge budget (24, 26)                      | Mechanics (brief 5)                                     |
| Investigator judgment + nudge (25)                                                 | Ambiguous — consumer triage hook on j2's fault path     |
| Rate-limit pause/resume (31)                                                       | Mechanics                                               |
| Terminal outcomes, deadlock, "what needs me" surface (32–34)                       | Ambiguous — terminal states policy, surfacing mechanics |
| Sessions log, watch, cleanup, prompt assembly (35–37)                              | Mechanics                                               |

## 4. Top decision-relevant risks for the API proposals

1. Conversation-continuity convention (same iid = same convo) must not become the _default_ for review-round relaunches
   — jr's fresh-context handoff is its most deliberate design decision.
2. Final-state-means-teardown conflicts with jr's escalation model; escalated features need a park-or-push affordance
   that doesn't reintroduce consumer-managed teardown.
3. "Agent ended turn without firing an event" must be in j2's absorbed fault set (jr's dominant failure mode), with an
   optional consumer triage/nudge hook whose diagnosis reaches the escalation route.
4. Round/retry split: j2 absorbs _infra_ retries, but review rounds are policy counters needing durable context —
   trivial once offsets plumbing is gone, but reset semantics (on approval / new cycle, not per-restart) must be
   explicit.
5. A jr run terminates; a coding.ts run parks forever. The pool primitive should support "source drained → final" and
   surface deadlock (open-but-never-ready work) distinctly from healthy parking.
