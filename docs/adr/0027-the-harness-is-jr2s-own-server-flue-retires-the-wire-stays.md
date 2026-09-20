# The Harness is jr2's own server: flue retires, the wire stays

jr2 has been programming around its Harness, not with it. The evidence is the ADR trail itself.
[ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)'s entire codegen-at-pod-start mechanism —
generated shims, a boot-time `flue build`, agent names frozen at that build — exists because flue offers no programmatic
server assembly; its own Considered options says so. [ADR-0026](0026-a-turn-that-is-over-has-an-empty-menu.md) was
forced by a foreign advisory session jr2 never asked for, and records a rejection ("there is nothing on the wire to
branch on") that is only true because someone else writes the wire.
[ADR-0023](0023-the-harness-prints-the-conversation.md)'s printer needed a loopback SSE client plus a 40-attempt
404-chase against flue's own parking behavior. The `flue-contract` tier ([ADR-0010](0010-bdd-acceptance-tests.md)) holds
a test asserting a defect we are waiting on someone else to fix: on pinned beta.9, an abort landing mid-stream erases
the assistant message from every later turn — fixed only on flue's unreleased line. And the Agent tool-restriction gap
has no seat in beta.9 at all: `SandboxFactory.tools` replaces the whole list, the default tools are private to a bundled
chunk, and ADR-0018's recorded escape hatch — "eject to a real flue project" — un-decides ADR-0018.

Waiting was the standing plan, and flue 2.0 ends it. The 2.0 nightlies do export tool constructors, but as part of a
rewrite: `defineAgent` is gone (an `AgentFunction` with hooks replaces it), `connectMcpServer` is renamed, the workflow
exports are absent from the runtime index, and the schema resets. `latest` has sat frozen at `1.0.0-beta.9` for a month
while all activity lands on an unannounced 2.0 line. That is a framework heading somewhere else, carrying our defect fix
with it.

Meanwhile the thing jr2 actually needs from flue is small, and jr2 already owns its specification. The Orchestrator
imports `@flue/sdk` in exactly one module (`flue-client.ts`), uses three verbs — send, wait, abort — behind
`AgentRunPort`, and persists a three-string admission handle. The stub Harness (`stub-harness.ts`) is a hand-written,
SDK-verified model of the five wire endpoints. And the base flue builds on is public: `@earendil-works/pi-agent-core`
(MIT, independent of flue's authors) — from which flue imports only the low-level `Agent` loop and reimplements the
rest. pi's `AgentHarness` is a **higher** starting point than flue's own: session tree, compaction, skills, an abort, an
in-process event stream, and `setTools(tools, activeToolNames)` — the tool-restriction gap does not exist for a caller
that owns tool assembly. As of 0.82.x it ships the read/write/edit/bash tools; grep and glob are ~40 lines each.

## Decision

- **jr2 owns its Harness: `@jr2/harness` at `packages/harness`**, built on `@earendil-works/pi-agent-core` +
  `@earendil-works/pi-ai` (pinned exact — 0.x minors break) and Hono, which the repo already uses. The stock image keeps
  its tag (`jr2-harness:<kitversion>`) and every operator contract: numeric uid, binding `:8080` is Ready, `git` in the
  image — plus `ripgrep` for the grep tool.
- **Assembly is runtime construction, not codegen.** `main.ts` constructs the server and listens; each admission carries
  its Agent's definition (ADR-0049), validated loudly and re-read per Submission. `boot.mjs`, the generated shims, the
  boot-time `flue build`, and the readiness lag it caused are deleted, and so — later — was the `JR2_AGENTS_JSON` roster
  this cut read at boot. The ADR-0018 contract — stock image, user-owned plain-data definitions — survives with its
  mechanism simplified.
- **The wire stays, and becomes normative.** The five endpoints the stub documents (`POST /agents/:name/:id`,
  updates/history views, long-poll, `POST .../abort → {aborted}`) and the three-string admission
  `{streamUrl, offset, submissionId}` (jr2 now mints its own opaque values) are jr2's protocol, not flue's. The stub
  Harness, the admission ledger ([ADR-0016](0016-agent-turn-mechanics-are-internal.md)), `AgentRunPort`, and every
  mechanics/`@kind` assertion survive byte-identical. Long-poll is the only wait transport; the SDK's `?wait=result` and
  SSE paths are not part of the contract. The admit body is `{message, model?, thinkingLevel?}` — the optional dials
  ([ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)) are this Submission's override layer
  over the Agent's definition, omitted when unset, and an unresolvable one is a 400 at admission rather than a
  Submission that settles `failed` — a one-line addition precisely because the protocol is jr2's own.

- **The re-owned semantics are stated, not inherited:**
  - **Per-instance queue: accept and queue.** A Submission is promoted when it is the first unsettled Submission of its
    conversation; admission order. [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s correction
    — flue queues, and the ordered abort depends on it — is now a design jr2 asserts rather than a behavior it
    discovered.
  - **Abort sweeps.** The active Submission and everything queued at the moment the abort is processed settle `aborted`,
    in admission order; the response answers `{aborted: boolean}` (`false` on an idle instance). Arrival order at the
    Harness is the order; the client-side pending-abort await (ADR-0024) stays as the cross-request guarantee.
  - **Settlement is `completed | failed | aborted`**, with `aborted` carrying `{type: "submission_aborted"}` —
    continuity with what ADR-0024/0025 recorded.
  - **An unknown conversation is 404**, on both views. `POST` creates (that is admission); abort answers
    `{aborted: false}`. This is a deliberate divergence from the stub, which answers every read with an empty stream:
    the stub is inert by design, but a real Harness that answered a lost conversation with silence would park a
    re-attached `wait` forever. Honesty about loss beats an endless poll.
  - **The durability contract is explicit: a conversation lives exactly as long as its Harness process.** Sessions are
    in-memory; flue's node-target store was in-memory SQLite as deployed, so nothing is lost that was ever had. What is
    durable is Orchestrator-side — the admission ledger and snapshot ([ADR-0007](0007-durable-machine-state.md)), and
    `wait`'s reconnect-from-offset. A Harness death under an admitted Submission surfaces as 404 → fault → workflow
    policy, the same family as `workspace.lost`. Provider-stream retry moves inside the turn (pi's `maxRetries`) — the
    seat ADR-0016 delegated to flue's `durability{}`.
  - **[ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)'s enabling fact is reproduced as explicit code.** Each
    Submission connects a fresh MCP client to `$JR2_ADAPTER_URL/mcp/<iid>` and lists tools, so the menu is per-turn and
    the Adapter still needs no push channel, no turn index, no second port. Menu tools keep the `mcp__jr2__<name>`
    naming — shipped instructions and the printer's prefix-stripping depend on it. The previous turn's connection is
    closed deterministically; the retire-the-previous idiom and ADR-0023's 404-chase existed to work around flue API
    gaps that are gone.
- **The Orchestrator side shrinks.** `harness-client.ts` replaces `flue-client.ts`: a fetch client for the three verbs,
  with `wait` as a long-poll loop from the admitted offset (capped backoff, indefinite reconnect — pod death is
  `workspace.lost`'s job) that raises a typed `SettlementFault` on `failed`/`aborted`/404. `actor.ts` does not change:
  the port, the admission shape, the nudge loop, and the abort ordering are untouched.

## Considered options

- **Wait for flue 2.0.** Rejected: unreleased, unscheduled, and a rewrite of the surfaces jr2 generates against
  (`defineAgent`, MCP wiring, routing). The structural problems — foreign advisory sessions, no programmatic assembly —
  are architecture, not backlog. Meanwhile the pinned defect erases assistant messages on real abort timings.
- **Fork flue at beta.9.** Rejected: ~17K lines of built output plus a CLI codegen owned to keep seven imported symbols,
  diverging from a codebase whose maintainers are mid-rewrite — the defect fix would have to be backported from a line
  that left. And its durability layer, the one genuinely load-bearing-looking piece, is in-memory as jr2 deploys it.
- **Fresh on pi, new wire.** Rejected: redesigning the protocol throws away the tested contract, the stub, the ledger
  shape, and the mechanics tier for no identified semantic gain. The wire was never the problem; the runtime behind it
  was.
- **Fresh on pi, wire kept** — chosen.

## Consequences

- **Deleted**: `packages/orchestrator/harness/` (boot.mjs, the flue project skeleton, the boot build and its readiness
  lag), the printer's loopback client and 404-chase, ADR-0026's foreign-advisory rationale (the decision stands on its
  other leg: the turn-start race), and the "eject to a real flue project" escape hatch — which means the tool contract
  must now be answered, not re-deferred
  ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)).
- **Kept verbatim**: the wire, the stub as the mechanics fixture, `AgentRunPort` and the admission ledger, ADR-0024's
  rule, receipt, and ordering, and the Adapter container split — restated in jr2 terms: the Adapter is a separate
  container _because working tools execute in the Harness container_, so the credential-isolation premise survives while
  `local()` leaves the vocabulary.
- **The `flue-contract` tier dissolves into the conformance suite.** Its rig — scripted OpenAI-compatible provider, real
  Adapter over a killable fake Orchestrator, real server — moves into `packages/harness/test/` and runs in the default
  `test` gate: the opt-in-ness existed only because the tier owned a foreign pin and build. Its claims become jr2
  requirements, with the pinned-defect assertion inverted: an abort mid-stream must **not** erase the assistant message.
  This suite is the only automated exercise of the real turn loop — the `@kind` tier keeps faking the LLM — and it is
  the canary for pi bumps.
- **The pinning risk moves; it does not vanish.** pi releases ~2.4×/week and breaks across 0.x minors. The pin is exact,
  a bump is a deliberate kit change gated by the conformance suite, and the breaking surface is now a class jr2
  constructs — not a code generator, a CLI build, and a process-global registry.
- **Migration is phased behind the wire.** Because both ends speak the same protocol, the image swap and the
  Orchestrator client swap are independent commits, each leaving every tier green; an old Orchestrator drives the new
  image and vice versa. `@flue/*` leaves the repo when the last pin (the retired contract tier) is deleted.
