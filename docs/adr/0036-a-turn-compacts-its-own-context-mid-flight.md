# A turn compacts its own context mid-flight

The retired flue runtime compacted a conversation automatically; the
[ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md) rewrite dropped it without recording the
loss. `packages/orchestrator/src/config.ts` kept declaring `contextWindow` for a reader that no longer existed. This ADR
is the unrecorded regression, decided.

The failure is live, not projected. Run `588b0f5e` (`task-with-review`, a real bug hunt on a 131k window) investigated
for 161 tool calls at ~800 tokens each, filled the window, and ended mid-sentence with no menu pick. The no-signal
nudges then continued the SAME conversation with zero headroom: nudge 1 produced 0 tokens, nudge 2 produced one token,
the budget went dry, and the run took the terminal `agent.fault` to a humanReview park. Once a context is full every
conversation-continuing recovery is structurally futile — [ADR-0016](0016-agent-turn-mechanics-are-internal.md)'s nudge
ladder cannot work there. The endpoint clamped its output rather than erroring, so the observable shape is a truncated
`stopReason`, not a 400.

**The window filled MID-turn**, and that decides the seat. j2's shape is one long agentic turn per Submission
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)), so context grows exactly where pi
refuses to compact: `AgentHarness.compact()` throws unless the harness is idle. But the guard guards the **method**, not
the mechanism. pi's loop calls `prepareNextTurn` after every tool-result batch; `AgentHarness` answers it by flushing
pending session writes and rebuilding the entire context from `session.buildContext()`; and `buildContext` already
replays from the latest `compaction` entry. j2 constructs the Session. So a compaction entry appended at a step boundary
is honored by the next step, by pi's own design — mid-turn compaction needs no new pi seat and no fork.

**Compaction** enters the vocabulary as the cut itself, not the act of summarizing: what the model still sees, replaced
by a summary plus a retained tail.

## Decision

- **The seat is the `context` hook, and the write goes to the session.** The hook fires at the START of every provider
  request, and the Session is complete at that moment for two different reasons: after every later step
  `prepareNextTurn` has just flushed pending writes and rebuilt from it, and on a turn's FIRST request pi emits the
  prompt's `message_end` straight to the Session before the loop starts. It estimates context tokens against the model's
  `contextWindow`; over the threshold it runs pi's `prepareCompaction`/`compact`, appends the compaction entry to the
  Session, and returns the rebuilt messages, so the request that noticed is already compacted. Firing on a turn's first
  request is what rescues the nudge ladder: a nudge is a fresh admission on the same conversation (`actor.ts`), so it
  compacts before it asks. **One handler, not two**: pi's `emitHook` hands every handler the same untransformed event
  and keeps only the LAST non-`undefined` result, so registering a second `context` handler beside ADR-0027's
  abort-replay would silently discard it rather than chain onto it. The cut runs first and `settleAbandonedMessage` maps
  over whichever array will be sent — including a rebuilt one, since the Session stores an aborted assistant message
  verbatim.
- **The thresholds are j2-owned, derived, and have no author surface.** `reserve = max(16384, model.maxTokens)`, with
  flue's small-window floor (`reserve × 2 ≥ contextWindow → max(1024, contextWindow / 3)`); `keepRecentTokens` 20000.
  The derivation is deliberate: the threshold is checked BEFORE a request that may emit up to `maxTokens`, so a reserve
  smaller than one full response does not reserve anything. pi's flat 16384 and flue's `min(20000, maxTokens)` — which
  shrinks the reserve as the model gains room — are both wrong for the live rig's 32768. Values are stated in
  `compaction.ts`, beside the derivation that reads them, rather than inherited from pi's mutable
  `DEFAULT_COMPACTION_SETTINGS` — so a pin bump cannot move when compaction fires, and the shipped arithmetic is what
  the unit tier proves; `TurnDeps` carries test seams only, exactly like `stepBudget`. A model with no declared
  `contextWindow` resolves to 0 and **compaction is off** — said out loud here, because silently inert is how the
  original regression hid.
- **`contextWindow` is not a compaction knob.** It sits beside `maxTokens` in the provider spec as a fact about an
  endpoint j2 cannot enumerate. Compaction reads it. It stops being inert without becoming an author surface, and no new
  config field appears.
- **The summarizer is the Turn's own model and the Turn's own thinking level.** The model because a Dial says how hard
  to run this Turn ([ADR-0018](0018-instance-agents-are-definitions-j2-assembles-the-harness.md)) and mechanism
  inherits; a separate compaction model would need its own provider entry, its own boot validation, and its own
  unresolvable-model failure at the moment context is already full. The thinking level because overriding it would be
  half of that same argument — pi passes its own, and no evidence says otherwise yet. **The summarizer carries the
  Submission's abort signal**, so a sweep does not wait on a summary j2 no longer wants
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s promotion ordering); j2 must hold that
  signal itself, because `AgentHarness` drops the one pi's loop hands `transformContext`. **The retry budget is also
  j2's to state** (2): pi's `retry` argument is optional and omitting it means zero attempts past the first, and the
  Turn's own stream `maxRetries` never reaches this call — pi builds the summarizer's request options itself. A
  compaction that fails after those retries settles the Submission `failed` as an ADR-0016 **infra** fault — no new
  fault class: a legible compaction failure beats walking into an overflow that surfaces as truncation.
- **The retained tail is NOT stored on the compaction entry** — `firstKeptEntryId` alone, a deliberate divergence from
  pi's own `AgentHarness.compact()`. An entry carrying its tail makes pi's branch walk break AT that entry, so the next
  cut cannot find its `firstKeptEntryId` on the truncated path and keeps neither summarizing nor retaining the previous
  cut's tail: up to `keepRecentTokens` of the MOST RECENT work, deleted at every cut past the first. With
  `firstKeptEntryId` alone the walk stops there, the rebuilt context is identical, and the next cut can reach the tail
  and summarize it. pi stores the tail because its `compact()` is idle-only and manually invoked — one cut per
  conversation, where the defect cannot appear; j2's mid-turn regime cuts repeatedly on one conversation, so it must
  not.
- **Visible in the pod log, invisible on the wire.** The printer gets one line
  ([ADR-0023](0023-the-harness-prints-the-conversation.md)) — a reader of 161 tool calls needs the point where the agent
  stopped being able to see the first 120, or an agent that forgets what it read at step 20 reads as a defect. Nothing
  else: no `StreamEvent` type (the durable stream's one consumer is `wait`, and a compaction settles nothing), no
  history entry, nothing on the ADR-0014 open band. The asymmetry is the point — mechanics narrate, they do not surface.
  j2's history is unaffected by construction: it records what was said, while compaction changes only what the model
  sees, and pi's compaction entry is the durable record of the cut.
- **ADR-0035's runaway counters do not reset on compaction, and the compaction call is not a step.** The watch counts
  tool calls per Submission; compaction is a fact about tokens. A turn that compacts and continues is still spending its
  one step budget.
- **A tripped watch takes no cut at all.** pi has no signal check between a blocked tool batch and the next request, so
  the loop passes through this hook once more after a runaway trip — and the trip aborts pi's OWN controller, which the
  seat cannot reach. Without a gate that dead turn would run a full summarization on a full window for a request that is
  never sent: real tokens, an unbounded wait against the very liveness ADR-0035 exists to guarantee, and a `[compacted]`
  line that makes a killed turn read as a healthy one. Skipping beats cancelling — there is no round-trip to cancel.
- **The claims are proven in the ADR-0027 conformance suite**, where a scripted provider fabricates usage to cross the
  threshold without burning a real window; it runs in the default `pnpm -r test` gate.

## Considered options

- **Threshold at turn boundaries plus overflow-retry only** (flue's exact split: `checkCompaction` after each completed
  assistant message, and one compact-and-retry when a turn actually overflows). Rejected: it would not have saved run
  `588b0f5e`, whose window filled at step ~161 of a single turn. It rescues the nudges after the failure, not the
  failure.
- **A pure transform in the `context` hook, never touching the Session.** Rejected: no compaction record for the printer
  or the session, and the summary would have to be cached j2-side anyway to avoid an LLM call per step — which is
  `appendCompaction` reimplemented worse.
- **Wait for pi to call its own `shouldCompact()`, or to relax the idle guard.** Rejected on ADR-0027's grounds:
  `shouldCompact()` is exported with zero internal callers, the pin is exact, and the mechanism j2 needs already exists
  in the loop.
- **A compaction Dial, or a definition override** (flue accepted `reserveTokens`/`keepRecentTokens`/`model` per agent).
  Rejected: compaction is neither identity nor how-hard-to-run, so it is not a Dial (ADR-0018), and ADR-0016 puts
  budgets in j2's hands. Greenfield: no workflow has needed one.
- **A headroom check before each no-signal nudge** (fault fast when the window is full). Rejected: it needs a new wire
  field carrying token counts to a consumer that would use it for one branch, to guard a state compaction now prevents.
  The nudge's own first request compacts.

## Consequences

- `contextWindow` in the instance spec becomes live for the first time since ADR-0027.
- **ADR-0035's step budget of 256 is now the only bound on a productive turn.** Its justification weakened: it was set
  above an honest 161-step bug hunt that exhausted its context, and context exhaustion was the real ceiling. The number
  does not move here — there is no data from the far side of compaction — but the next reader raising it should know the
  backing changed.
- Compaction can make an agent re-read what it already read. That is duplicated work, not a runaway: K counts
  CONSECUTIVE identical calls, and a re-read after a summary is one call, not four. The two guards do not fight; a
  compacted turn is just less efficient than its transcript suggests.
- Inheriting the Turn's thinking level carries a known risk, recorded rather than designed against: pi budgets the
  summary at `min(0.8 × reserve, model.maxTokens)` and spends reasoning tokens from that same budget, so a high-effort
  turn on a small `maxTokens` can truncate its own summary. The trigger is named; if it is observed, the fix is a stated
  divergence, not a knob.
- ADR-0016's no-signal ladder assumed a turn that ends with room left. That was silently false at a full window and is
  now true by construction — so a nudge ladder observed dying with a full context again is evidence compaction failed,
  not evidence the ladder needs a gate.
- The degenerate edges resolve the same way: a tool result larger than the reserve leaves nothing worth cutting, and a
  `session: "continue"` invocation can arrive on a conversation already at the ceiling. Both compact, and if the context
  is still over, the turn fails as infra.
- A cut does not lower the reading that triggered it: pi estimates from the last valid assistant usage, and a cut
  RETAINS recent assistant messages, so the number survives the cut. When the request after a cut ends `error` or
  `aborted` it contributes no usage of its own and the next step would cut again on a context nothing has grown — a
  second summary over work the first already covered. A cut therefore requires assistant usage recorded AFTER the newest
  compaction entry.
- **The pi-bump surface grows, and it is the deepest j2 has taken on.** This leans on `prepareNextTurn` rebuilding the
  context from the Session each step, on `buildContext` replaying from the latest compaction entry, and on the branch
  walk stopping at `firstKeptEntryId` when the entry carries no tail — behavior pi documents in types but does not
  promise as a caller contract, and the tail divergence above is a bet against pi's own usage of its own API. The
  conformance suite is the canary (ADR-0027): it must assert the mid-turn cut and the SECOND cut's retention, not just
  the threshold arithmetic.
