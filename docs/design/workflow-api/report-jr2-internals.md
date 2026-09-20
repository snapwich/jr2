# jr2 internals — feasibility of the API-redesign decisions

Repo: `/home/richs/repos/jr2/default` @ main (72b043d). Verdict up front: **every decision 2–7 is implementable without
touching the security model or the durability invariant; most of them delete code. The wrapper-machine answer to
decision 1 survives re-validation, with one refinement.**

## 1. Current implementation map

Four packages: `@jr2/orchestrator`, `@jr2/agent-protocol`, `@jr2/adapter`, `@jr2/cli`; plus `operator/` (Go, Sandbox
CR), `examples/coding/`, `features/`.

| Piece              | File                                        | Role                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agentRun actor     | `packages/orchestrator/src/actor.ts`        | `fromCallback`; registers event surface + admits run over `input.endpoint`; surfaces `agent.offset`/`agent.fault` via `sendBack`. Port-factory seam; real flue port in `flue-client.ts` (only module importing `@flue/sdk`). |
| Registration table | `packages/orchestrator/src/registration.ts` | One table `address → {defs, deliver closure, sandbox, meta}`; `RunBinding` in a `WeakMap<ActorSystem, RunBinding>` — ambient resolution already exists. `resolveAccepts` = per-workflow name→def check.                      |
| gate actor         | `packages/orchestrator/src/gate.ts`         | 40 lines; registers `{gate, accepts, meta}`.                                                                                                                                                                                 |
| workspace wrapper  | `packages/orchestrator/src/workspace.ts`    | provisioning → attaching → running (body + reconcile probe) → teardown → done. `SandboxPort` via run binding; all four ops idempotent. `WorkspaceHandles = {endpoint, sandbox, workdir, repos, branch}`.                     |
| RunHost            | `packages/orchestrator/src/run-host.ts`     | start/restore/persist; **persistence rides the inspection stream** (`@xstate.snapshot`, microtask-coalesced); `bindRun` before start; run feed (`status`+`emit`); `observe()` projection (ADR-0014).                         |
| Durability         | `packages/orchestrator/src/durability.ts`   | `reattachAgentRuns` walks the snapshot tree; each level's `context.offsets` scopes child-input rewrites (drop `prompt`, set `attachOffset`).                                                                                 |
| Tokens             | `packages/orchestrator/src/tokens.ts`       | Sandbox token = `<sandbox>.<hmac(key,name)>` (stateless, restart-stable); `mayDeliverToAgent(principal, reg.sandbox)`.                                                                                                       |
| Discovery          | `packages/orchestrator/src/instance.ts`     | filename discovery; contract `export const machine` + `export const events`; `provide: () => ({})` — **host already injects nothing**.                                                                                       |
| Stub Harness       | `packages/orchestrator/src/stub-harness.ts` | wire-compatible fake flue; endpoint-is-a-URL keeps agentRun one code path.                                                                                                                                                   |
| Machine doc / viz  | `packages/orchestrator/src/machine-doc.ts`  | walks live `machine.root` + `machine.implementations.actors`; children via invoke srcs + **top-level `spawnChild` only**; `enqueueActions` → `opaqueActions` warning.                                                        |
| Adapter            | `packages/adapter/src/adapter.ts`           | in-pod MCP dialect over `/agents/:iid/*` with the Sandbox token.                                                                                                                                                             |

Already-true facts the redesign builds on: ADR-0003 injection is dead in practice (`instance.ts:113` "Nothing to inject…
provide stays a test seam"); ambient run identity already works at any nesting depth; the host already sees the whole
tree via inspection.

## 2. Decisions 2–7

### Decision 2 — offsets fully host-side: feasible, simpler than today

Today: `flue-client.ts` checkpoints offsets (baseline at admission + each `tool_start`) → `agent.offset` via `sendBack`
→ consumer assigns `context.offsets` → `reattachAgentRuns` scopes rewrites per level. The consumer leg exists only
because context was the persistence vehicle.

Recommended mechanism: **report through the run binding, not xstate.** `agentRun` already holds `runBindingOf(system)`;
add `binding.recordOffset(iid, offset)` → host ledger persisted in the same `RunBlob` (`offsets: Record<iid,string>`
beside `snapshot`, same `store.save`, same atomicity, same microtask scheduler). Iids embed the run UUID (globally
unique) so a flat map replaces nested scoping; `reattachAgentRuns` keeps the tree walk for input rewriting, drops
`offsetsIn`/shadowing. Deletes: `agent.offset` event type, consumer root handler, `context.offsets`, attach-vs-prompt
branch in `turn()`. Alternative (watch `@xstate.event` inspection events) works but leaves a mechanism event traversing
consumer machines — binding ledger is cleaner.

ADR-0007 wording: the invariant (serializable-only context; restore rewrites the child's _persisted input_, not the
parent invoke; reconcile before re-attach) survives verbatim — it's about live handles generally. Dies: ADR-0002-refined
"host folds it into Machine context", ADR-0011's "offsets accumulate in nested contexts… fold recursively", GAP(5)
framing. The at-most-once sliver is unchanged; the baseline checkpoint keeps working, landing in the ledger.

### Decision 3 — ambient endpoint/sandbox/iid: feasible; ADR-0013 survives and strengthens

The system-keyed WeakMap **cannot** carry per-workspace handles as-is — many concurrent workspaces share one actor
system. Mechanism that works: **nearest-ancestor resolution via the actor parent chain**. xstate 5.32.2's public
`ActorRef` has `_parent?: AnyActorRef` (`types.d.ts:797`); callback actors receive `self`. So:

- `workspace()`'s `running` state co-invokes a registrar callback (beside the existing reconcile probe) that puts
  `WorkspaceHandles` in a `WeakMap<AnyActorRef, Handles>` keyed by the wrapper's actorRef, removed on stop.
- `agentRun` walks `self._parent` to the nearest registered ancestor; not found → fail loudly unless input carries an
  explicit `endpoint` (keeps the stub-Harness/mechanics-tier path).
- **Restore-safe by construction**: invoked actors restart on snapshot restore (exactly how the reconcile probe works);
  entry actions do NOT re-run on restore, so it must be an invoked actor. Handles are persisted in wrapper context, so
  re-registration is correct.

**ADR-0013 token scoping (the MUST) survives mechanically**: authorization never depended on the consumer.
`mayDeliverToAgent` compares the HMAC-verified token's pod name against `registration.sandbox`. Today the consumer
copies `c.workspace.sandbox` — and commit baba71f shows the failure mode: coding.ts omitted it and every tool call 403'd
(fail-closed footgun). Ambiently, agentRun records the resolved ancestor's sandbox — the same deterministic
`workspaceName(runId, wsId)` the token was minted against (workspace.ts: "Derived, not remembered"). The parent chain
resolves the _enclosing_ wrapper structurally, never a sibling's, so cross-feature injection stays impossible. Only
ADR-0013's mechanism note ("WorkspaceHandles gains sandbox and agentRun's input takes it") needs amending.

**Iid convention**: `<runId>/<actor-path>/<scope>/<role>` — actor path (spawn/invoke ids) is stable across restore;
consumer `scope` covers reviewer-fresh-per-task vs coder-resume (jr semantics). Compute at first invoke; it rides the
persisted input, so `reattachAgentRuns` keys unchanged. `turn()`/`iid()` die. Body-facing `WorkspaceHandles` shrinks to
`{workdir, repos, branch}` (prompts still interpolate `workdir` — workflow-legit).

### Decision 4 — tools from transitions: feasible; derive in jr2.setup, demarcate on defineEvent

Three candidate introspection sites:

1. **jr2.setup at machine build (recommended)** — receives full config; walks states statically (machine-doc.ts proves
   the info is statically recoverable via `node.transitions` incl. ancestors); wraps each agentRun-invoke's `input` fn
   to append `tools: [...]`. Names still ride serializable input → persisted-input restore and `resolveAccepts`
   invoke-time validation are completely unchanged. Same for `gate.accepts`.
2. Registration-time in RunHost — the actor doesn't know its invoking state; recovering it from live snapshots is
   ambiguous with parallel agentRuns. Rejected.
3. Lazy at surface read — validation drifts from delivery. Rejected.

Ambiguity: `NAME_RE` already excludes dots, so `xstate.*`/`agent.*`/`workspace.lost`/`after` are mechanically never
workflow events. Remaining ambiguity is _audience_ (bubbled human events leaking into agent menus; bubbled
`report_blocked` is desired). **Demarcation on defineEvent is cleaner**: (a) audience is a property of the event's
contract, matching the table's existing agent/gate authorization dialects; (b) xstate v5 transitions have no metadata
slot (only `description`) — transition-level demarcation means a jr2-only DSL inside the transition table, which
decision 7 forbids; (c) one `audience: "agent" | "external"` tag resolves coding.ts fully (verified: agent states derive
{request_review, review_verdict, report_blocked}; gate states derive {approve, request_changes, resume, work_ready};
zero overlap). Registration table needs no changes. Escape hatch: an explicit `tools:` in invoke input stays
expressible. `eventMap`'s loud failure on `deferred`/`poll` must be preserved.

### Decision 5 — retries absorbed: feasible; one feed design choice

Absorb into `agentRunActorWith`'s admit loop: catch faults, backoff-retry under a defaulted budget (a knob, not
context), re-attach from the **host offset ledger** (the actor asks its binding — decision-2 synergy). Registration
stays live across retries (same iid, no table churn). The no-signal nudge (jr handle_no_signal / ADR-0006's
forced-final-pick re-prompt) fits the same loop, jr2-owned. Only budget exhaustion emits the ONE terminal `agent.fault`.
Deletes `retriesLeft`/`spendRetry`/`hasRetryBudget`/`retryOrEscalate`/`reenter`.

Observability: add a telemetry channel via the binding → `run.listeners` (new `RunFeedEvent` kind). **ADR-0014 caveat**:
the open observation feed excludes `instanceId` and emit payloads; retry telemetry names iids. Project it to
`{kind:"retry", child:"F-1", attempt:2}` (state-key-class data) so `jr2 visualize` can show it without widening the
line.

### Decision 6 — pool primitive: feasible; dissolves the visualize footgun

jr2 can own coding.ts's whole top loop (~90 lines): discover→saturated→settling→idle, cap accounting, `spawnChild` with
stable ids, `xstate.done.actor.*` + `stopChild` bookkeeping, re-query timer, wake gate. `pool(source, worker, {cap})` —
a machine-returning factory like `workspace()`, generalized over a source port (`next(exclude) → item|null`, optional
wake-event). tk's `claimNextFeature` becomes one adapter; CONTEXT.md's Work Source/Ready-set survive as that adapter's
semantics.

Visualize: machine-doc sees only top-level `spawnChild` with string srcs resolved against the machine's own setup
registry; `enqueueActions` is opaque. If the pool factory emits the spawnChild itself (named worker actor in its
internal setup, top-level action), the static trace is **guaranteed by construction, once, in jr2 code** — the
comment-enforced placement footgun (coding.ts:519–523) deletes; no machine-doc changes. The pool also internalizes the
`xstate.done.actor.*` event-union casts (`claimedFeature`).

### Decision 7 — jr2.setup, manifest dies: feasible; pick an attribution mechanism

Vocabulary is NOT readable off xstate structure alone (transition descriptors give names, not zod defs). jr2.setup must
be told the defs (it needs them anyway for decision 4 and the events type union) and attach them for discovery:
**WeakMap export** (`vocabularyOf(machine)`) keeps the returned object a bit-identical plain StateMachine
(Stately-inspectable, `.provide()`-testable); caveat: `.provide()` returns a new machine object — discovery registers
the pre-provide machine so this is fine, else fall back to a non-enumerable property. ADR-0011's anti-global-registry
argument is satisfied: attribution flows through the machine object, per-workflow by construction; a shared defs module
can feed two machines. Per-workflow scoping (`resolveAccepts`, `workflowEvents`) untouched — only the source of the map
changes. Module contract shrinks to `export const machine`. Dev reload works naturally (fresh machine object per `?v=`
generation). Pre-registering jr2 actors and injecting mechanism event types (`agent.fault`, `workspace.lost` — dotted,
collision-free) is straightforward.

## 3. Child machines vs provide() vs alternatives

**The wrapper survives.** ADR-0012's stated argument (xstate v5 stop is synchronous → async multi-step teardown must be
states the machine transitions through → the provisioner must observe body completion → wrap) is correct and verified in
code. The deeper, understated argument: the persisted `teardown` state is **durable intent** — a crash mid-teardown
restores into `teardown` and re-runs the idempotent destroy. Alternatives:

- **Host-side lifecycle outside the tree**: only run-granular; per-feature Sandboxes need mid-tree completion
  observation (host has it via inspection) but teardown intent then lives in host memory — lost on `kill -9` unless the
  host builds a ledger, which is what the persisted state already is, free. Also can't express parking-is-retention
  without reading machine state. Rejected.
- **Invoke-with-lifecycle actor** (destroy in stop cleanup): fire-and-forget, unretried, unpersisted, races process
  exit. The line: synchronous in-process cleanup belongs in actor stop (that's what agentRun/gate disposers do);
  anything async/remote needs a state. Rejected.
- **Author-assembled lifecycle states / parallel region**: guarantee in consumer hands on every error path; violates the
  teardown-by-wrapper non-negotiable. Rejected.
- **provide() proper**: independently dead — fills only the machine it's called on, can't reach child machines (top →
  workspace → body → agentRun is three levels), and `instance.ts` injects nothing already. Retire ADR-0003; keep
  `.provide()` as the testing affordance decision 7 mandates.

Refinement: under decisions 3+6 the wrapper's consumer residue approaches zero (no endpoint/sandbox in body input;
`workspace()` composable behind the pool). Its extra nesting in visualize is arguably a feature (provisioning/teardown
are real states); it could render collapsed via a tag (`MachineStateDoc.tags` exists). Reconcile probe +
`workspace.lost` policy channel are wrapper-shaped and stay.

## 4. ADR changes

- **ADR-0003 + CONTEXT.md Template/Provider entries**: retire/supersede (code already complies with the successor); keep
  "everything pluggable is an xstate actor" as the kernel.
- **ADR-0007**: invariant survives verbatim; amend only the offset-location wording (0002-refined, 0011 consequence) to
  the host ledger.
- **ADR-0011**: supersede the `export const events` manifest and explicit `tools: [names]` clauses; keep closure
  delivery, registration table, gate-as-resource, per-workflow scoping, static-import doctrine, invoke-time failure.
- **ADR-0012**: amend the handles boundary only (body-facing vs mechanism-facing split).
- **ADR-0013**: decision untouched, strengthened; amend the mechanism note (wrapper registers, agentRun resolves +
  records).
- **ADR-0014**: no change if retry telemetry is projected to child-id + attempt; don't put iids on the open feed.
- **ADR-0002/0006**: grow 0002's superseded section (offset leg → ledger); 0006's forced-final-pick re-prompt moves into
  agentRun's absorbed nudge (one-line refinement).

## 5. Loose ends

- `packages/agent-protocol/src/addressing.ts` (`mcpPath`) is dead code post-ADR-0013 — delete with the redesign.
- Keep an explicit-`endpoint` escape on the test/dev surface: mechanics-tier e2e runs workspace-less agentRuns against
  the stub Harness (no sandbox; "no Sandbox token can claim it").
- RunBlob shape change (offsets ledger): one-time fold of `context.offsets` on `restore()`, or accept restart-loss
  (brief: durability secondary).
- Reviewer-per-task fresh-conversation semantics hinge on consumer `scope` in the iid convention — the one place
  conversation identity legitimately needs a consumer word; don't convention it away.
