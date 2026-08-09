# Proposal: the simplified j2 workflow API

Synthesis of the grill session (2026-07-13) + four research reports: `report-jr-parity.md`, `report-j2-internals.md`,
`report-xstate.md`, and `report-flue.md`. Exhibit: `coding-rewrite.ts` (~200 lines vs 681; zero mechanism residue).

Two of those inputs were removed from this directory after their subject was superseded. `report-flue.md` studied how j2
used flue; [ADR-0027](../../adr/0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md) retired flue, so its
findings no longer apply and ADR-0027 records the conclusion in more detail. `coding-rewrite.ts` drafted the rewrite;
the rewrite landed as `examples/coding/workflows/jr.ts`, which is the version to read.

## TL;DR

The consumer surface shrinks to **six statically-imported names**:

| Export                      | Consumer writes                                                 | j2 owns                                                                                                                      |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `defineEvent`               | name, description, zod input, optional `audience` restriction   | validation, transport, delivery, tool/gate derivation                                                                        |
| `j2Setup`                   | context/input/output types, event defs, own actors/guards       | mechanism event types in the union, pre-registered `agentRun`/`gate`, vocabulary attachment (manifest dies), typo validation |
| `agentRun` (pre-registered) | `{ agent, prompt }` (+ optional `session: "continue"`, `scope`) | endpoint, sandbox, iid, tools, offsets, infra retries, no-signal nudges                                                      |
| `gate` (pre-registered)     | `{ gate, meta }`                                                | accepted set (derived), registration lifecycle, HTTP surface                                                                 |
| `workspace(body, spec)`     | repos + branch mapping                                          | Sandbox CR lifecycle, teardown-on-final, reconcile, `workspace.lost`                                                         |
| `pool(worker, spec)`        | source, cap, item mapping, drained policy                       | spawn-under-cap, child identity, typed completion collection, wake/poll, deadlock detection                                  |

Everything deleted from coding.ts: `offsets` + `agent.offset` + attach-vs-prompt; `turn()`/`iid()`;
`endpoint`/`sandbox`/`runIid` threading; `retriesLeft`/`spendRetry`/`hasRetryBudget`/ `retryOrEscalate`/`reenter`;
`export const events` + `EventFrom` unions; all five casts; the whole top-loop (`active[]`, `spawnChild`/`stopChild`,
`xstate.done.actor.*`, discover/saturated/ settling/idle, the spawnChild-placement footgun comment); `stalled`; the
two-step finals; the `WorkspaceHandles` alias apologia. The module contract shrinks to `export const machine`.

Every piece was validated: **feasible against current j2 internals** (most changes delete code; registration table, run
binding, HMAC tokens carry over unchanged), **typecheck-proven against installed xstate 5.32.2** (compiled experiments
in `xstate-lab/`), **consistent with flue's actual source**, and **closer to jr's real semantics than coding.ts was**.

---

## 1. The pieces

### 1.1 `j2Setup` — the authoring surface (grill decision 7)

```ts
j2Setup({ types, events: [defs], actors, actions, guards }).createMachine({...})
```

- Returns xstate's **public `SetupReturn`** type → `.createMachine()` yields a plain `StateMachine`:
  Stately-inspectable, `.provide()`-testable, no j2 runtime needed to construct. Proven by compiled experiment
  (`xstate-lab/exp1-j2setup.ts`): consumer surface has zero casts.
- Injects mechanism events (`agent.fault`, `workspace.lost`) into the union; derives workflow event types from the zod
  defs (kills hand-written `EventFrom` unions). Prior art: Stately's own `@statelyai/agent` derives unions from zod maps
  the same way.
- Pre-registers `agentRun`/`gate` with typed inputs.
- Because it takes defs **as values**, it validates at `createMachine` time that every event key in the machine maps to
  a def (closes xstate's nested-`on` typo hole — unknown keys in nested states typecheck silently upstream) and attaches
  the vocabulary to the machine for discovery (WeakMap `vocabularyOf(machine)`, machine object bit-identical).
  **`export const events` dies.**
- ADR-0011's anti-global-registry argument survives: attribution flows through the machine object, per-workflow by
  construction.

### 1.2 Tools and gate-accepts derive from transitions (decision 4)

A state that invokes `agentRun` gets, as the agent's tool menu, exactly the `audience: "agent"` events its transitions
(own + bubbled ancestors) handle. A state that invokes `gate` gets the `audience: "external"` events the same way. MCP
never appears in workflow code.

- Derivation happens **statically in `j2Setup.createMachine`** (config rewrite appending the derived names to the invoke
  input) — names still ride serializable input, so the ADR-0007 restore path and invoke-time `resolveAccepts` validation
  are byte-for-byte unchanged. The same static walk feeds `j2 visualize` ("this state's agent can call X, Y").
- Dotted names (`agent.*`, `workspace.lost`, `xstate.*`, `after`) are already mechanically excluded by `NAME_RE`.
- Verified against coding.ts's shape: agent states derive `{request_review, review_verdict, report_blocked}`, gate
  states derive `{approve, request_changes, work_ready}`, zero overlap.
- Escape hatch: explicit `tools:`/`accepts:` on the invoke input remains expressible.

**SETTLED (grill 2026-07-14): `audience` is optional — `"agent" | "external" | "any"`, default `"any"`.** The invoking
actor kind is the primary router (an `agentRun` menu draws audience ∈ {agent, any}; a `gate` draws {external, any} —
from the invoking state's transitions incl. bubbled ancestors), so simple workflows need zero tags: the rewrite's
coding/reviewing states derive their agent menus and humanReview derives its accepts with no `audience` anywhere. The
tag exists to _restrict_: cross-contamination is only possible when an event is handled at a shared ancestor while both
actor kinds are invoked beneath it — tag the security-sensitive events (`approve: "external"` guarantees no agent state
can ever offer it) and leave the rest untagged. `"any"` stays writable explicitly so restriction is
greppable/reversible. Why the def and not per-transition demarcation: xstate transitions have no typed metadata slot
suited to this without inventing j2-only config inside the transition table (no-DSL rule); audience is a property of the
event's contract (who may say this), matching the registration table's authorization dialects — and it keeps ADR-0011's
blessed handle-once-at-an-ancestor idiom, which pure structural (own-transitions-only) derivation would break.

### 1.3 `agentRun` input: `{ agent, prompt }` (decisions 2, 3, 5)

```ts
invoke: { src: "agentRun", input: ({ context }) => ({ agent: "coder", prompt: coderPrompt(context) }) }
```

- **Ambient resolution** (decision 3): endpoint + sandbox resolve from the nearest enclosing `workspace()` via the actor
  parent chain (`self._parent` is public API; the wrapper's `running` state co-invokes a registrar actor — invoked
  actors restart on restore, entry actions don't, so this is restore-safe by construction). Not found → loud failure
  unless input carries an explicit `endpoint` (the dev-stub / workspace-less path keeps working).
- **ADR-0013 security survives and strengthens**: `mayDeliverToAgent` compares the HMAC-verified token's pod name
  against the registration's sandbox — now written by j2 from the same deterministic `workspaceName()` the token was
  minted for. The parent chain resolves the _enclosing_ wrapper structurally, never a sibling's. The baba71f footgun
  (forgot `sandbox`, every tool call 403'd) becomes unrepresentable.
- **Offsets are 100% internal** (decision 2): `agentRun` reports `iid → offset` through the run binding into a host
  ledger persisted in the same `RunBlob` save. Iids are globally unique, so the recursive nested-context folding in
  `reattachAgentRuns` dies too. Implementation note: flue beta.8+ ships `agents.observe()/history()` — a
  reconnect-from-offset API purpose-built for this; prototype against it before hand-rolling more (see §4).
- **Session continuity — fresh by default, SETTLED (grill 2026-07-14)**: jr launches a _fresh session on every relaunch_
  by deliberate design (lossy handoff: revision coders read notes + code, never the prior conversation). Default: every
  `agentRun` invocation is a fresh conversation. `session: "continue"` + `scope` opts into flue same-instance-id
  continuation: iid derives from `(run, enclosing child id, agent, scope)`; the per-invocation prompt lands as the next
  user turn in the ongoing conversation; the tool menu still re-derives from the invoking state (one conversation can
  travel across states with changing menus); j2 fails loudly at invoke if a `continue` iid is already live (flue
  lease-fences per iid). Mid-turn restore re-attaches the in-flight turn in both modes — `session` only governs new
  invocations. coding.ts had the default exactly backwards.
- **Retries absorbed** (decision 5), two distinct fault classes, both invisible until terminal:
  - _Infra faults_ — delegate to flue's native `durability: { maxAttempts, timeoutMs }` (it already distinguishes
    completed/aborted/exhausted/timeout and never re-runs a completed tool); j2 re-attaches from the offset ledger.
  - _No-signal_ (agent ended its turn without calling a menu tool — jr's dominant failure mode) — flue considers that a
    normal completed turn, so this stays a j2-owned budgeted re-prompt ("you must call one of: …"). Flue's own `finish`
    nudge is confirmed unavailable on the durable agent path (disjoint-session wall, re-verified in flue source).
  - The workflow sees ONE terminal `agent.fault { reason }` and routes it — jr's investigator slots in later as a
    consumer-authored triage state on that route, receiving the reason.
  - Retry attempts surface on the run feed / visualize as telemetry projected to `{ child, attempt }` (ADR-0014: no iids
    on the open feed).

### 1.4 `workspace(body, spec)` — unchanged shape, smaller handles (decision 1 re-validated)

The wrapper-machine approach **survives re-validation**, for a reason stronger than ADR-0012 states: the persisted
`teardown` state is _durable intent_ — a crash mid-teardown restores into `teardown` and re-runs the idempotent destroy.
Host-side lifecycle loses that on `kill -9` and can't express parking-is-retention; invoke-stop cleanup is
synchronous-only (verified at source: `stop()` cannot await). `provide()` is independently dead — it can't reach child
machines and `instance.ts` already injects nothing. **Retire ADR-0003**; keep `.provide()` as the test seam.

Changes: body-facing handles shrink to `{ workdir, repos, branch }` (endpoint/sandbox become mechanism-internal); typing
uses the proven declared-signature pattern (`InputFrom<TBody>` minus `workspace`, `OutputFrom<TBody>` out —
consumer-side casts all gone). Complementary tool for lighter cases: xstate 5.32's `setup().createStateConfig` lets j2
ship typed state _fragments_ (e.g. a human-gate state) consumers splice in without any child machine — but it can't
carry teardown, so it complements rather than replaces the wrapper.

### 1.5 `pool(worker, spec)` — the top machine (decision 6)

```ts
pool(feature, { source: readyFeatures, itemId, cap, itemInput, onDrained: "final" });
```

- Generalized over a **source port** — `next(active) → item | null` + optional `wake` event + `pollEvery` — a queue,
  generator, or re-queried set. tk's claim actor becomes one adapter; CONTEXT.md's Work Source/Ready-set survive as that
  adapter's semantics, not the primitive.
- Absorbs: spawn-under-cap, stable child ids, `xstate.done.actor.*` collection (typed via
  `DoneActorEvent<Output, string>` — the wildcard narrows fully, zero casts, verified), `stopChild` bookkeeping, the
  wake gate, the re-query timer.
- **Dissolves the visualize footgun by construction**: the one top-level `spawnChild` lives in j2's pool code, once; the
  ecosystem has no competing primitive (verified vacuum — the canonical v5 pattern is exactly coding.ts's hand-rolled
  loop).
- **Run termination + deadlock** (jr correction): jr runs _end_ (exit 0/2/3) and detect deadlock (open tickets, none
  ready, none running). `onDrained: "final"` restores that; the pool distinguishes drained / deadlocked / healthy-parked
  and reports per-item outcomes as its output. coding.ts parked forever and couldn't tell deadlock from waiting.
- **SETTLED (grill 2026-07-14): the pool is the answer.** The typed idioms (`DoneActorEvent` union entry, `assertEvent`,
  outcome-in-context) ship as documented patterns anyway — anyone outgrowing `pool` hand-rolls without penalty (it
  returns a plain machine, also nestable as a child).
- **Terminal semantics are three-valued** (forced by the park-a-gate escalation decision): source drained + children
  settled → **final** (jr exit 0); open-but-never-ready items + nothing progressing → **deadlock**, surfaced distinctly
  (jr exit 2); children parked in gates → **waiting**, run stays open, the gates list is the "what needs me" surface (jr
  exit 3). The pool can triage these because it owns both source and children — the strongest single argument for it.
  Triage surfaces as run _status_ (feed / `j2 runs`), not machine events; a `pool.deadlock` event can be added when a
  real workflow needs to react to it.

### 1.6 Cast-free idioms j2 documents (or wraps)

- Machine output at root reading **outcome-from-context** (`output: ({context}) => ({ status: context.outcome!, ... })`)
  — kills the done-event cast; xstate types that event as `unknown` by design.
- `DoneActorEvent<T, string>` in the union for wildcard child completion (pool internalizes it).
- `assertEvent` where a narrowed event is needed in a shared action.

## 2. jr-semantics corrections adopted (from ground truth, not coding.ts)

1. **Fresh sessions by default** (§1.3) — coding.ts inverted jr's most deliberate design decision.
2. **Escalation must not destroy work — SETTLED (grill 2026-07-14): park-a-gate.** jr ground truth: most escalations
   were _environment_ issues the human resolved inside the environment, so the Sandbox must stay alive
   (parking-is-retention; the User Container is the human's seat). The rewrite's `escalated` state: record tk escalation
   → best-effort `pushBranch` (so an idle-GC-reaped park still leaves the branch recoverable) → park a gate accepting
   `resume` (blocker fixed → re-enter `working`; jr's coder re-entry protocol re-escalates if not) and `dismiss` (give
   up → settle as escalated). `workspace.lost` while parked settles directly. Publish-then-settle survives only as the
   `dismiss` exit. Accepted consequence: runs with live escalations stay open — "what needs me" is the gates list (jr's
   exit-2/3, done properly).
3. **Round accounting**: human `request_changes` starts a _fresh_ architect cycle (`archRounds: 0`), architect approval
   resets the counter; per-task coder reset kept (jr's per-run reset was an accident of note-counting).
4. **`stalled` state deleted**: jr has no analog (a chain blocked on a human-assigned task just never surfaces in the
   ready-set and the run ends). The rewrite escalates with reason instead — one path; with correction 2, escalation now
   IS a park, so `stalled`'s only purpose (keeping the Sandbox alive) is subsumed.
5. **Terminal `agent.fault` covers "turn ended without an event"** — jr's dominant failure mode; the consumer triage
   hook (investigator) is a future state on the fault route, not j2 policy.

## 3. ADR / CONTEXT.md impact

| Doc        | Change                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR-0003   | **Retire/supersede** (templates + provide). Keep the kernel "everything pluggable is an xstate actor". Code already complies.                                                                                                                                                  |
| ADR-0007   | Invariant survives verbatim; amend offset-location wording to the host ledger.                                                                                                                                                                                                 |
| ADR-0011   | Supersede: `export const events` manifest, explicit `tools: [names]`. Keep: closure delivery, registration table, gate-as-resource, per-workflow scoping, static imports, invoke-time failure.                                                                                 |
| ADR-0012   | Amend handles boundary (body-facing `{workdir, repos, branch}` vs mechanism-facing).                                                                                                                                                                                           |
| ADR-0013   | Decision untouched, strengthened; amend mechanism note (wrapper registers, agentRun resolves + records). Fix the `connectMcpServer` sample (missing `name` arg — real signature `connectMcpServer(name, options)`; the name is visible to the model as `mcp__<name>__<tool>`). |
| ADR-0014   | No change if retry telemetry is projected to `{child, attempt}` (no iids on the open feed).                                                                                                                                                                                    |
| ADR-0002   | Grow superseded section: offsets → ledger; **"flue exposes no cancel primitive" is now false** (beta.8 `agents.abort()`).                                                                                                                                                      |
| ADR-0006   | Forced-final-pick re-prompt moves into agentRun's absorbed nudge (one line).                                                                                                                                                                                                   |
| CONTEXT.md | Retire **Template**/**Provider**; reframe **Work Source** as a source-port adapter (Ready-set doctrine survives); **Gate** gains derived-accepts; add **Source** and **Pool** if the primitive lands.                                                                          |

## 4. Independent wins (do regardless of the redesign)

1. **Bump `@flue/sdk` beta.5 → beta.8+**: gains real `agents.abort()` (replaces abandon-and-reap cancel; ADR-0002
   assumption stale) and `agents.observe()/history()` (reconnect-from-offset — may replace the hand-rolled `tool_start`
   checkpointing in `flue-client.ts` wholesale).
2. **Fix `connectMcpServer` call shape** in ADR-0013's sample. (The other consumer, the dev Harness image's hand-rolled
   persona, was deleted with the image — ADR-0038.)
3. **Delete `packages/agent-protocol/src/addressing.ts`** (`mcpPath`) — dead post-ADR-0013.
4. Flue's `durability` config for infra retries (§1.3) is available today.

## 5. Confirmed walls (don't re-litigate)

- **MCP-adapter arrangement is settled physics**: flue's native finish-tool/forced-result exists only on the ephemeral
  workflow-session path; the durable agent path (`POST /agents/:name/:id`) strips extra tools — verified in flue source.
  ADR-0006/0013 stand.
- **xstate stop-is-synchronous** → teardown must be wrapper states (ADR-0012 stands).
- Inline (object-src) spawned children can't persist → everything durable is a registered string src — which `j2Setup`
  pre-registration makes automatic (decisions 2/6/7 reinforce each other).

## 6. Open questions (deliberately not settled here)

- tk consistency loop (orchestrator tk vs in-Sandbox architect edits) — unchanged from coding.ts's deferred note; the
  source-port abstraction doesn't move it.
- Stacked in-flight features (B branches off unmerged A) under the PR flow — jr had merge-all; no j2 story yet.
- Whether `workspace()` nesting renders collapsed in visualize (tag exists; cosmetic).
- Investigator/triage as a shipped example persona vs pure docs pattern.

## 7. Suggested build order

1. j2Setup + defineEvent `audience` + vocabulary-on-machine (deletes manifest; enables the rest).
2. Offsets → host ledger + SDK bump (prototype `observe()` first).
3. Ambient handles (registrar actor + parent-chain walk) + shrink `AgentRunInput`/handles.
4. Retry/nudge absorption into agentRun (flue durability + no-signal loop) + terminal fault.
5. Tools/accepts derivation in j2Setup.
6. pool + source port; rewrite coding.ts for real; retire ADR-0003 et al.; update CONTEXT.md.
