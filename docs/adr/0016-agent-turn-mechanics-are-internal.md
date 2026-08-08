# Agent-turn mechanics are j2-internal: ambient coordinates, host-side offsets, absorbed retries, fresh sessions

Second of the workflow-API redesign trio ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md) has the context;
full record in [docs/design/workflow-api/](../design/workflow-api/proposal.md)). `agentRun`'s consumer input shrinks to
workflow vocabulary — `{ agent, prompt }` plus opt-ins below — because everything else it used to take was j2 handing
the consumer values j2 already had. Each absorption follows, with what it deletes from `examples/coding/`.

The opt-ins include two optional dials, `model` and `thinkingLevel`
([ADR-0018](0018-instance-agents-are-definitions-j2-assembles-the-harness.md) draws the identity-vs-dial line and states
where each is validated). The **absorption principle is what admits them**: what this ADR absorbed was values j2 already
held and was handing back to the consumer to hand in again — mechanism wearing a consumer's clothes. A dial is the
opposite case: a genuine per-call choice that j2 cannot derive, because Agents are instance-scoped and only the invoking
workflow knows how hard this turn is. Both are serializable strings, so they ride the persisted child input; a restore
re-attaches to a Submission whose model is already fixed server-side and never re-resolves them.

## Ambient endpoint and sandbox (deletes the `turn()` helper and all handle threading)

`workspace()`'s `running` state co-invokes a registrar actor that records its handles in a `WeakMap<ActorRef, Handles>`;
`agentRun` walks `self._parent` to the nearest registered ancestor. Invoked-actor registration (not an entry action) is
what makes this restore-safe: invoked actors restart on snapshot restore, entry actions do not. Not under a workspace →
fail loudly, unless input carries an explicit `endpoint` (the dev-stub, workspace-less path). Body-facing workspace
handles are `{ workdir, repos, branch }` ([ADR-0012](0012-workspace-wrapper-machine.md)).

**[ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)'s token scoping survives and strengthens**: the registration
records the Sandbox resolved from the enclosing wrapper — the same deterministic `workspaceName()` the token was minted
for — so the consumer can no longer forget to pass it (the baba71f incident: `sandbox` omitted, every tool call 403'd,
fail-closed but silent). The parent chain resolves the _enclosing_ wrapper structurally, never a sibling's;
cross-feature event injection stays impossible.

## Offsets live in a host ledger (deletes `context.offsets` and the `agent.offset` event)

`agentRun` reports `iid → offset` through the run binding into a ledger persisted beside the snapshot in the same
`RunBlob` save. Iids are globally unique, so restore's recursive nested-context offset folding dies with the context
leg; restore still rewrites the child's persisted input ([ADR-0007](0007-durable-machine-state.md)'s invariant stands
verbatim — only the offset's location moved). The Harness wire does the heavy lifting
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)): `wait` reconnects from the admitted
offset, and `abort` is the deliberate terminal cancel ([ADR-0002](0002-duplex-streaming-actor.md)).

## Retries and nudges are absorbed; the workflow sees one terminal `agent.fault` (deletes the retry bookkeeping)

Two fault classes, deliberately not one knob ([ADR-0035](0035-a-runaway-turn-is-ended-rerolled-once-then-a-fault.md)
later adds the third: runaway):

- **Infra faults** (stream drop, pod restart, provider error): provider-stream retry lives inside the turn in the
  Harness, and `wait` reconnects indefinitely from the offset ledger; a dead Harness surfaces as a fault (ADR-0027).
- **No-signal** (the agent ends its turn without calling a menu tool — jr's dominant failure mode): the wire treats that
  as a normal completed turn, so recovery is a j2-owned budgeted re-prompt inside `agentRun` — absorbing ADR-0006's
  "forced final pick is a Machine-level re-prompt" into the actor.

Budgets are defaulted knobs, not Machine context. Exhaustion emits the single terminal `agent.fault { reason }`; where
it routes (escalation, a triage/investigator state) is workflow policy. Attempts surface as run-feed/visualize telemetry
projected to `{ child, attempt }` — no iids on the open observation feed
([ADR-0014](0014-observation-is-open-run-state-is-not.md) unchanged).

## Sessions are fresh by default; continuation is opt-in

jr's most deliberate design decision is the **lossy handoff** — every relaunch is a fresh session; revision coders read
the notes and the code, never the prior agent's conversation. That is the default: each `agentRun` invocation is a new
conversation. `session: "continue"` + `scope` opts into same-instance-id continuation: the iid derives from
`(run, enclosing child id, agent, scope)`; the per-invocation prompt lands as the next user turn; the tool menu still
re-derives from the invoking state (one conversation can travel across states). Mid-turn restore re-attaches the
in-flight turn in both modes — `session` governs only what a _new invocation_ means. `scope` is the one place
conversation identity legitimately needs a consumer word; it is not conventioned away. (This corrects
`examples/coding/`'s "same iid = jr's resume machinery, free" — an inversion of jr's actual semantics.)

A `continue` invocation onto a live iid does **not** fail loudly — it queues. The Harness accepts and queues: prompts
for one instance enter one per-instance queue in admission order, and a Submission is promoted only when it is the first
unsettled one for its conversation (ADR-0027 states this as j2's own semantics). A queued prompt waits behind work that
may never finish, which is why [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md) both ends the
turn and orders the abort ahead of the next `send`.

The minting doctrine — addresses are computed by j2, never by the workflow — covers gate ids too: a gate with no
authored id derives one from its actor path below the run root, through the same walk `mintIid` uses (`actorPath` in
registration.ts; ADR-0011). The two mint at different seats for a reason: iids must be minted in the input mapper
because minting has a random component (the fresh-session suffix) — the input is what persists — while a path-derived
gate id is deterministic from machine structure, so it is recomputed at every actor (re)start and is restore-stable by
construction. The mapper rule is about non-determinism, not a blanket rule about where ids are born.
