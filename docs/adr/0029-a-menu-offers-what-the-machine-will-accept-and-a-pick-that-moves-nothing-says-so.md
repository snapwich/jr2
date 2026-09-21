# A menu offers what the Machine will accept, and a pick that moves nothing says so

[ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md) derives an Agent's menu from the invoking state's
transitions: the consumer names no tools, and `jr2Setup.createMachine` walks the config appending the derived names to
each `agentRun` invoke's input. That derivation reads transition **keys** — `Object.keys(node.on)` — and nothing else. A
guard is invisible to it.

So an event whose every transition is currently guarded false is on the menu anyway. The Agent calls it. The delivery is
well-formed, validates, and reaches the invoking state's mailbox, where no transition accepts it. Nothing moves, the
registration survives, and [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s receipt reports
`turnComplete: false` — rendered as _"The workflow is still in the state that asked for this turn, so it is not over
yet."_ Which is true, and is the same sentence a **successful** in-state move produces.

That is the failure. The Agent is told the workflow is waiting on it, having just done the one thing the workflow
declined; ADR-0024 exists because a receipt that says nothing actionable gets answered by calling again, and this is
that receipt wearing a status line. The two outcomes it cannot distinguish are "you made progress, keep going" and "that
did nothing, stop doing it".

## Decision

**The vocabulary stays static; the surface becomes live.** ADR-0015's config walk is unchanged and still authoritative
for what a state may accept — it is the validation scope, and `resolveAccepts` still fails at invoke time on a name
outside the workflow. What changes is that `RunHost.agentSurface` now asks the guards before listing. The registration
carries `invoker` — `self._parent`, captured where the registration is created, which is exactly the machine ADR-0015
derived the menu from. Nothing about authoring moves: a workflow names no tools before this and names none after.

**The question is asked twice, because the two askings can see different things.**

- `mayMove(invoker, name)` — the menu. The pick has not happened, so there are no arguments to judge.
- `wouldMove(invoker, event)` — delivery. The validated payload is in hand, so the answer is exact.

**A guard that reads the pick is never hidden.** This is the whole reason `mayMove` is not just `snapshot.can({type})`.
A guard like `({ event }) => event.verdict === "approved"` answers `false` on a payload it was not given — not by
throwing, which would be catchable, but by plain comparison against `undefined`. Naive filtering would delete the
Agent's only tool and strand the run. So `mayMove` passes the event behind a Proxy that records any read outside `type`,
and trusts a `false` only when the guard never looked. A guard that looked is offered, and settled at delivery.

That this works rests on xstate handing a guard the object passed to `can()`, unspread — verified against the pin, and
pinned by a test asserting a payload-reading guard **stays** on the menu. A future xstate that copies the event first
would trip the trap on everything and degrade this to offering more, never less.

**Both readings fail open.** No invoker, or a guard that throws, reads as legal. The failure modes are not symmetric. A
wrong `true` offers a tool that does nothing — the behavior before this ADR, and now recoverable, because the receipt
says so. A wrong `false` tells an Agent its work was rejected when the workflow would have taken it, and nothing
recovers from that.

**The receipt gains `moved`.** A third claim beside `delivered` and `turnComplete`, and independent of both: a pick can
move the Machine within the invoking state (`moved: true, turnComplete: false`). The Adapter renders `moved: false`
first, ahead of the turn-status prose, because it is the thing the Agent can act on — and tells it explicitly not to
repeat the call unchanged.

**Absent `moved` is not `false`.** The Adapter ships as a stock image and the Orchestrator as the instance image
(ADR-0027), so the two can skew. Read strictly, an Orchestrator too old to send the field would make every receipt on
the happy path read as a rejection — the cry-wolf failure [ADR-0026](0026-a-turn-that-is-over-has-an-empty-menu.md)
already paid for once.

**Gate accepted-sets are not filtered.** Agent menus only. A gate whose accepts filtered to empty would hit `gate.ts`'s
empty-set throw and fault the run, and the case for filtering is weaker: a human at a gate reads its `meta` and can tell
why an option did nothing, which is precisely what an Agent cannot do.

## Considered options

- **Filter with plain `snapshot.can()`.** Rejected: it deletes payload-guarded tools from the menu, which is a worse
  failure than the one being fixed — the Agent cannot proceed at all, and nothing tells it why.
- **Only filter events whose def has an empty input schema**, so a payload-blind check is always complete. Rejected: it
  is safe but declines the motivating case. `escalate({ reason })` guarded on `context.attempts > 0` is exactly the
  shape this ADR exists for, and it carries a payload.
- **Declare a doctrine instead — "guards that gate menu visibility must read context, not the event".** Rejected: it is
  the correct guidance and useless as a mechanism. The failure is silent, the rule is invisible at the call site, and
  the Proxy makes the machine enforce what the doctrine could only ask for.
- **Diff the snapshot before and after delivery** to detect a no-op. Rejected: `can()` with the payload answers the same
  question directly, and an assign-only transition changes context without changing `value`, so the diff would need to
  know which differences count.
- **Refuse the delivery outright when `moved` is false** rather than delivering and reporting. Rejected: `deliver` is
  the single validation path behind both dialects, and short-circuiting it would move validation ordering for the sake
  of a distinction the receipt already carries.
- **Filter mid-turn and push `list_changed`.** Rejected: the Adapter rebuilds the surface per MCP connection and the
  Harness re-lists per Submission, so the filter lands at turn boundaries for free — and a menu that moves under an
  Agent that already read it invites the same retry loop from the other direction.

## Consequences

- **A tool that appears is one the Machine would act on**, up to arguments. What remains offered-but-refusable is
  exactly the set a guard judges by payload, and that set now answers itself on delivery.
- **A workflow can express "this is not available yet" with a guard alone**, and the Agent sees the consequence rather
  than a tool that silently does nothing.
- **`on: { X: {} }` — targetless and actionless — drops off the menu**, matching xstate's `can()`. A handler that
  neither targets nor acts is not a handler. No such handler exists in the repo today; the behavior is pinned by a test.
- **The menu is now a function of context**, so two turns of one conversation (`continue: true`) can legitimately see
  different menus. That was already true across states; it is now true within one.
- **Two receipt declarations stay hand-synchronized** across `run-host.ts` and `adapter.ts`. Unchanged by this ADR, and
  now carrying one more field — the cost of the packages not importing each other.
