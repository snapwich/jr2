# A Menu is fixed for a conversation, and a Turn is told its Allowed picks

[ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md) derives what an Agent may pick from the invoking state's
transitions. Its config walk reads transition **keys** and nothing else, so a guard is invisible to it. Two failures
follow from where that answer is put.

**A pick that moves nothing reads as progress.** An event whose every transition is guarded false validates, reaches the
invoking state, and moves nothing. The receipt said _"the workflow is still in the state that asked for this turn"_ —
the same sentence a successful in-state move produces.
[ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md) exists because a receipt that says nothing
actionable gets answered by calling again.

**A tools block that changes bills the whole conversation again.** The first fix for the failure above narrowed the
tools block to what the guards would accept, per Submission. But provider prompt caches are prefix caches in the order
tools → system → messages: Anthropic invalidates every level when a tool definition changes, and vLLM and
OpenAI-compatible chat templates render the tools into the head of the prompt. Measured on the home-lab vLLM Instance
(2026-09-28, a 24.8k-token history): the next Turn with the same tools hit 24288 cached tokens; with one pick added, 0;
with the same picks reordered, 0. A continued conversation (`continue: true`, ADR-0057) changes state by design — a
coder in `implement` may `finish`, the same coder in `fix` may `finish` or `dispute` — so every such step prefilled the
whole history again. It also left the history calling tools the request no longer defined.

## Decision

- **The Menu is the whole of what an Agent can ever be offered in its Machine, and it is the tools block.** It is the
  union of the derived sets of every state that invokes an Agent of that name — the same scope as its continued
  conversation's id (ADR-0057). `jr2Setup.createMachine` derives it in ADR-0015's walk, in a fixed order, so it is
  byte-stable for every Turn of the conversation and for every fresh conversation of that Agent. The descriptions are
  the event defs' own and do not vary by state, so a def's description must hold at every writing of it the Agent can
  reach; the load warns where its writings on one path differ (ADR-0015).
- **What one Turn may pick is its Allowed picks**: the invoking state's derived set (its own, its ancestors' and its
  modes' picks — ADR-0015), narrowed to what the live Machine would currently accept **from this Agent**: xstate's
  selection for an event that carries the Agent's sender, a guard that reads the payload counted as passing, must move
  something, and every writing it selects must be the Agent's (ADR-0015). Read off the live snapshot, they follow the
  active mode as well as the guards; the Menu stays byte-identical in every mode. They are EMPTY while the Agent's state
  is not at Rest — something it started runs below it, or a timer holds — because every pick is refused then
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)); an outstanding pick's answer carries them
  read after the route. The surface serves both (`GET /agents/:iid/surface` → `menu` and `allowed`); the Harness
  presents `menu` as the tools block and states `allowed` in the Briefing's Turn part, after the Frame's prompt
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). It rides the newest message, so it never
  touches the cached prefix. The Briefing's standing part says how to read every such list: a pick is a call that the
  newest "Allowed now" lists, and each pick's answer says if the Turn is over.
- **The Orchestrator enforces, at delivery, and only there.** A pick while the Agent's state is not at Rest is refused
  before anything else, `finish` included (ADR-0024). A pick off the Menu is refused. A pick on the Menu is not refused
  before delivery: one inside the invoking state's derived set that the Machine does not take — a pick of another mode
  included — is delivered and answered `moved: false`; one that only another state of this Agent handles is answered
  `moved: false` whatever its arguments, and never reaches the Machine, because only a state the Agent does not own (a
  nested Agent's, a Gate's) could act on it there (ADR-0015). A pick whose selection, with its real payload, holds
  another party's writing — a mode and a sibling Gate's or nested Agent's state that write the same name, say — is
  answered `moved: false` the same way and does not reach the Machine (ADR-0015). Every answer carries `allowed`, read
  **after** the delivery, and the Harness renders it ("Allowed now: `finish`"). A `moved: false` pick outside `allowed`
  gets the **correction receipt** — "`<pick>` is not allowed in the workflow's current state, whatever its arguments.
  Your turn is not over. Do not repeat this call — pick one of the allowed tools." — because the state refused it and
  new arguments cannot help; one inside `allowed` was refused by a guard that read its payload, and its receipt says to
  change the arguments. The Harness does not pre-check: its list is as old as what it last read, and an in-state move
  (`moved: true, turnComplete: false`) can change the guards and the mode mid-Turn.
- **The Turn part is restated at a step boundary when the Allowed picks changed under the Agent.** A Gate's answer, an
  outside event or a child's settled invoke the Agent did not pick can move the Machine while the Agent works with its
  Working tools and picks nothing. So the Harness keeps the last Allowed-picks list the model read — the Turn part, then
  every receipt and refusal — and after each model answer's tool results reads the surface once and compares the two as
  sets. If they differ, it appends one message before the next model request: "The workflow's state changed since you
  last read the Allowed picks. Allowed now: …", in a `<jr2-turn>` block. The Agent's own pick is never restated, because
  its receipt already told the model. The read is one bounded attempt and a failure is silence; the next boundary asks
  again. Nothing is read or said after the Turn ended or after an abort. The Harness knows the Turn ended from a pick's
  answer (`turnComplete`, or a 404), not only from a read: under `continue: true` the next state re-registers the same
  address before the abort lands, so a read there would answer for the next Turn. An empty list is not restated to a
  model that stopped; the Orchestrator's wake asks it when a pick opens (ADR-0016's ask-again rule). The comparison is
  engine-neutral (`between-steps.ts`); only the placement is the engine's — pi's between-steps input (`steer`). An
  engine with no such input falls back to the next receipt. No route is added and no cap is set; the Orchestrator
  already serves the truth on `GET /agents/:iid/surface`.
- **Presentation stays in the Harness's neutral layer.** `menu.ts` renders the Allowed-picks text and every receipt; a
  presenter (`menu-tools.ts` for pi) only maps Menu items to its tool API and places the text it is handed. A second
  harness — one that takes MCP tools fixed per session and the prompt as text — needs a presenter, not a second Menu.

**The guard question is asked twice, because the two askings can see different things.**

- The Allowed picks: payload-blind, asked as the Agent's sender (`takesNow`, ADR-0015) — or `mayMove(invoker, name)`
  where no seat can be read (a plain `setup()` actor tree). The pick has not happened, so there are no arguments to
  judge.
- Delivery: `wouldMove(invoker, event)` and xstate's own selection on the real event. The validated payload and the
  sender are in hand, so the answer is exact.

**A guard that reads the pick is never hidden.** A guard like `({ event }) => event.verdict === "approved"` answers
`false` on a payload it was not given — by plain comparison against `undefined`, not by throwing. So the payload-blind
reading passes the event behind a Proxy that records any read outside `type` and `sender`, per guard, and trusts a
`false` only when the guard never looked. A guard that looked is allowed, and settled at delivery. This rests on xstate
handing a guard the object passed to `can()`, unspread — pinned by a test asserting a payload-reading guard stays
allowed. A future xstate that copies the event first would degrade this to allowing more, never less.

**Both readings fail open.** No invoker, or a guard that throws, reads as allowed. A wrong `true` costs one refused
pick; a wrong `false` tells an Agent its work is not wanted when the workflow would have taken it, and nothing recovers
from that.

**Absent `moved` is not `false`, and absent `allowed` is not empty.** The Harness ships as a stock image and the
Orchestrator (ADR-0027), so the two can skew. A surface without `menu` is read as today's narrowed list, presented as
tools.

**A Gate's accepted set stays whole; `acceptsNow` sits beside it.** `GET /runs/:id` lists each Gate's `accepts` — every
name it may ever send, with its schema, which drives a form — and `acceptsNow`, the same payload-blind question the
Allowed picks ask, asked as the Gate's sender (ADR-0011). Neither is filtered to empty into a fault: a Gate whose
`acceptsNow` is empty waits. A send the run would not take is refused 409 with `acceptsNow` (ADR-0013); a human reads
the Gate's `meta` and the refusal and can tell why, which is precisely what an Agent needs the Allowed picks for.

## Why the text comes after the prompt, and why refusal is not optional

Measured on the home-lab vLLM model (Qwen3.6-35B-A3B, 10 trials per cell, a prompt arguing for a pick the Turn did not
allow): with the whole Menu as tools and no statement, 0/10 first picks were allowed; with the Allowed picks stated
**ahead** of the prompt, 0/10 (thinking off) and 5/10 (on), whatever the wording; stated **after** it, 10/10 both. On a
weaker pull the statement alone sufficed. After one refusal naming the Allowed picks, 57 of 58 wrong picks recovered on
the next call. So the statement carries the everyday case, and the refusal is the net under it. Narrowing the tools
block was not perfect either: once the model invented a tool it had never been given.

## Considered options

- **Narrow the tools block per Turn** (this ADR's first form). Rejected: it breaks the prefix cache on every Menu
  change, and the history then calls tools the request no longer defines — which models are observed to call anyway.
- **Fix the tools per invoking state, drop guard narrowing.** Rejected: fixes the within-state case, not ADR-0057's
  cross-state `continue`.
- **The Machine's whole agent-audience vocabulary as the Menu.** Rejected: it offers picks only another Agent's states
  handle.
- **Put the Menu tools last.** Rejected: measured, a reordered tools block misses as completely as a changed one.
- **Mask at decode time** (OpenAI `allowed_tools`, logit masking). Deferred: it is provider-specific — Anthropic has no
  subset form, and changing `tool_choice` there drops the messages cache; vLLM's Chat Completions refuses it. The design
  must hold without it; where it is cache-safe, it can be added in the presenter.
- **Refuse the delivery outright when `moved` is false.** Rejected for a guard that says no: `deliver` is the single
  validation path behind both dialects, and the receipt already carries the distinction. A pick whose selection holds
  another party's writing is a different class — delivering it would run that party's writing — so it is answered like a
  pick off the invoking state's derived set, and never delivered.
- **Filter mid-Turn and push `list_changed`.** Rejected: nothing pushes to the Harness (ADR-0013), and a list that moves
  under an Agent invites the retry loop from the other direction.
- **The Orchestrator pushes the restated Turn part over a new route.** Rejected: pi appends only at a step boundary, so
  a push arrives no earlier than the Harness's read, and it needs a route that writes text into a conversation, change
  detection over every run, and a copy of what the model read that an Orchestrator restart loses.
- **Parse a JSON-text argument where the pick's schema declares an object** (pi's `prepareArguments`, before the engine
  validates). Rejected, measured: on the home-lab instrument writing a Chart
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)) about one call in three carried the object as a string, and
  0 of 89 such strings were JSON — each had its braces miscounted around a `{{...}}` reference — so the parse would have
  fired on none. A leniency that no run can show working is not kept on a hypothesis; a model that stringifies cleanly
  will show it in its own trials, and the ten lines come back with that number.
- **The Allowed picks on every Working-tool result.** Rejected: a statement repeated where nothing changed is one the
  model learns to skip.

## Consequences

- **One state can allow different picks as its context changes or its active mode changes; the Menu does not change.**
  The conformance tier asserts it: two Submissions with different Allowed picks send a byte-identical tools block
  (ADR-0027).
- **A restatement is appended, never rewritten.** Conformance asserts that each request of a Submission is a byte prefix
  of the next, with the tools and the system prompt unchanged, and that the restatement sits right after the model
  answer's last tool result.
- **A workflow expresses "not available yet" with a guard alone,** and the Agent is told so rather than finding a tool
  that silently does nothing.
- **`on: { X: {} }` — targetless and actionless — is never allowed,** matching xstate's `can()`.
- **The receipt declarations stay hand-synchronized** across `run-host.ts` and the Harness's `menu.ts`, now carrying
  `allowed` too — the cost of the packages not importing each other.
