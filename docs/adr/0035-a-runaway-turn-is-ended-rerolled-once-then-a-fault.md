# A runaway turn is ended by the Harness, rerolled once, then a fault

[ADR-0016](0016-agent-turn-mechanics-are-internal.md) absorbed turn mechanics behind one terminal
`agent.fault { reason }` and named two fault classes: **infra** (the turn broke — provider retries in the Harness, then
fault) and **no-signal** (the turn ended without a menu pick — budgeted nudge in `agentRun`, then fault). Both assume
the turn ends. Production found the third case: a turn that never does. Two live `task-with-review` runs degenerated — a
reviewer handed an empty diff collapsed into ~100 byte-identical `grep` calls; a coder rewrote the same README
indefinitely after committing real work. Nothing bounded either: `agentRun` awaits settlement, `nudgeBudget` covers only
turns that end, and neither jr2's Harness nor the retired flue runtime ever capped steps.

The investigation ruled the refactor out as the cause. Replays of both failure shapes against the live endpoint —
including the exact empty-diff reviewer state — terminated 13/13 with max 2 consecutive identical calls, in both the
current bare-instructions prompt and the flue-shaped one. The degeneration is stochastic model tail behavior,
concentrated where a task gives the model nothing real to do. That shapes the design: the guard is liveness insurance
against a tail event, not a correctness mechanism, and the recovery that works is a fresh roll of the dice.

**Runaway** names what jr2 observed — the turn ran past the point where jr2 stops believing it will conclude — on the
same principle as "no-signal": fault classes are named for the observation, not the model's inner pathology.
"Degeneration" is the behavior the guard usually catches; the budget trigger also ends honest dithering that never
collapses into repetition.

## Decision

- **Detection lives in the Harness turn loop** (`turn.ts`) — the one seat that watches steps as they happen; the
  Orchestrator only sees the settlement, and a runaway never settles. Two triggers, both jr2-owned defaults with **no
  author surface** (ADR-0016: budgets are defaulted knobs): a **step budget** (initial 256; healthy turns peaked at 53
  on a trivial task, and an honest live bug-hunt burned 161 steps before exhausting its context) as the unconditional
  backstop, and **K consecutive byte-identical tool calls** (initial K=4; healthy max observed 2, the production loop
  ~100) as the early exit. If a surface is ever demanded, note it would be a Dial question (ADR-0018) — how hard to run
  this one Turn — but no workflow has needed one.
- **Tripping settles the Submission `failed` with `SettlementError.type: "runaway"`** and a legible message ("repeated
  an identical tool call 4 times", "exceeded 256 steps"). No fourth `SettlementOutcome`: `aborted` stays the ADR-0024
  sweep's word, and the typed error is what lets `agentRun` switch on the class without parsing prose.
- **`agentRun` retries once, as a fresh conversation, with the identical prompt.** The degenerate context is poisoned —
  a model that just emitted a hundred identical calls conditions on them, so a nudge into the same conversation rerolls
  loaded dice; the fresh session is ADR-0016's lossy handoff applied as recovery. The prompt carries no annotation:
  mechanism must not bleed into the one thing the workflow authored, and the failure being stochastic means the fix is
  the reroll, not different instructions. Budget 1 (a defaulted knob): a runaway retry costs an entire turn, and two
  independent rolls both running away is evidence the task itself is pathological — that belongs with the workflow's
  fault routing, not a third attempt.
- **A `session: "continue"` invocation gets no retry — straight to the fault.** The one recovery jr2 knows is a fresh
  conversation, and that is exactly what the author opted out of; jr2 does not invent a new conversation the workflow
  asked to continue. The fault routing decides what the history is worth.
- **Exhaustion emits the same single terminal `agent.fault { reason }`.** The workflow surface does not change; routing
  (park at a Gate, re-invoke at a higher Dial) stays workflow policy, and `task-with-review`'s existing `agent.fault`
  arm already handles it. Retry attempts surface as run-feed telemetry like nudge attempts.
- **The claims are proven in the ADR-0027 conformance suite** — a scripted provider that loops deterministically is the
  only tier that can produce a runaway on demand; it runs in the default `pnpm -r test` gate.

## Considered options

- **Windowed duplicate-fraction trigger** (catches A-B-A-B alternation early). Rejected for now: no observed instance,
  the step budget backstops it, and it is the only trigger with a plausible false positive — read → edit → read of the
  same path is an identical signature twice, legitimately.
- **Retry into the same conversation** (nudge-style). Rejected: the poisoned-context argument above; a nudge explains
  itself to a conversation that must continue, a runaway retry exists because the conversation must not.
- **Workflow-side detection.** Rejected: workflows speak vocabulary, not step counts (ADR-0015/0016), and the
  Orchestrator cannot see inside an unsettled turn without growing a new observation surface for mechanism.
- **A per-Agent or per-Turn knob now.** Rejected: greenfield, no evidence any turn needs a bound other than the default;
  adding surface first invites tuning before data exists.

## Consequences

- ADR-0016's taxonomy is three classes: infra, no-signal, runaway. Its "either budget exhausting emits the one terminal
  fault" sentence now reads across three budgets.
- A runaway that survives the reroll parks where `agent.fault` routes — for `task-with-review`, the `humanReview` Gate
  with the runaway reason in `meta`, Sandbox intact for inspection.
- The bound makes non-termination cost at most `(1 + retry) × step budget` instead of a context window; it does nothing
  for output quality — a no-op task still yields invented churn, which is task authoring, not mechanics.
