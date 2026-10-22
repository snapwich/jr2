# The Harness is jr2's own server: flue retires, the wire stays

jr2 has been programming around its Harness, not with it. The evidence is the ADR trail itself.
[ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)'s entire codegen-at-pod-start mechanism —
generated shims, a boot-time `flue build`, agent names frozen at that build — exists because flue offers no programmatic
server assembly; its own Considered options says so. [ADR-0026](0026-a-turn-that-is-over-is-never-prompted.md) was
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
rest. jr2 takes the same slim core: pi-agent-core gives the `Agent` loop, its tool hooks (`beforeToolCall`,
`finishTurn`, `prepareRequest`), the abort, the steering queue and an in-process event stream. The tool-restriction gap
does not exist for a caller that owns tool assembly. jr2 owns the rest: the engine part on disk, Compaction
([ADR-0036](0036-a-turn-compacts-its-own-context-mid-flight.md)) and the six Working tools, whose text the model reads.

## Decision

- **jr2 owns its Harness: `@jr2/harness` at `packages/harness`**, built on `@earendil-works/pi-agent-core` +
  `@earendil-works/pi-ai` (pinned exact; a minor can break, and pi 1.0 removed the session, Compaction and the coding
  tools from pi-agent-core) and Hono, which the repo already uses. The stock image keeps its tag
  (`jr2-harness:<kitversion>`) and every operator contract: numeric uid, binding `:8080` is Ready, `git` in the image —
  plus `ripgrep` for the grep tool.
- **pi is the engine, not the contract.** The Harness keeps its contract in jr2's own shapes. One seam (`Engine`,
  `engine.ts`) is the interface between the Turn and the engine. The Turn gives the engine one Submission's run: the
  model, the thinking level, the system prompt, the tools, the context and the prompt. It hears the run as events
  (`message_end`, `step_boundary`, `tool_start`, `tool_end`), and it can `steer` and `abort` the run. Inside the run,
  the Turn decides through four hooks:
  - `convertToLlm`: the messages that the provider gets.
  - `beforeRequest`: Compaction (ADR-0036).
  - `beforeToolCall`: the runaway watch (ADR-0035). A block can also abort the run.
  - `endsRun`: the end of the run at the step boundary.

  The seam's tools, events and hooks are jr2's types. The seam's messages are pi-ai's provider messages, plus jr2's
  Compaction summary. pi-ai is the provider library, not the engine (see below), so these shapes are not the engine's.
  An adapter (`EngineAdapter`) opens the conversation's engine part and makes its engine. `pi-engine.ts` is the one
  adapter, and the one module that imports pi-agent-core. It holds pi's `Agent` loop, its hooks and events, and the
  leading system message that carries the system prompt and the tool declarations (pi 1.x's way).

  The engine part (ADR-0031) is engine-named: the adapter chooses its directory (`engine/pi`). Its format is jr2's
  transcript (`transcript.ts`), not pi's, because pi 1.x keeps no conversation. The Turn and Compaction (ADR-0036) read
  and write it. So the adapter does not own the format. It owns the name. The name is the guard: only the engine that
  wrote a part is known to read it correctly, because that engine's loop decides what goes into it. So a Harness on
  another engine opens another directory, does not read pi's part, and continues from the record's history.

  pi-ai is the provider library that every engine sends its requests through, so the Harness uses it directly:
  - the model catalog and the custom provider (`provider.ts`);
  - the message and tool-declaration types;
  - TypeBox `Type` for the Working tools' schemas (pi-ai coerces the arguments of a TypeBox schema differently from
    those of a plain JSON Schema);
  - `uuidv7`, for two ids that go to a provider as a prompt-cache key (pi-ai's `sessionId`): the engine part's id, and
    the id of each Compaction summary request;
  - `contentText`: the summary request joins a message's text by pi-ai's rule, as pi 0.82.1 did;
  - `retryAssistantCall`: the summary call retries by the same rule as each provider request.

  A second engine is a second adapter. One module chooses the Harness's adapter (`engine-choice.ts`), and the Turn names
  no adapter: a test rig can pass another (`TurnDeps.engineAdapter`). So a second engine changes `engine-choice.ts`, not
  the Turn. The Working tools, the printer, the transcript and Compaction do not change.

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
  - **The durability contract is explicit: a conversation lives as long as its Sandbox, and on the Instance Harness as
    long as its run** (ADR-0031). The Harness persists each conversation to a directory as it goes and rebuilds it on
    boot, so a Harness restart inside a living pod keeps it; a Submission in flight at the restart settles `failed`.
    What is durable across a lost pod is Orchestrator-side — the admission ledger and snapshot
    ([ADR-0007](0007-durable-machine-state.md)), and `wait`'s reconnect-from-offset. A conversation that is gone
    surfaces as 404 → fault → workflow policy, the same family as `workspace.lost`. Provider-stream retry moves inside
    the turn: the Harness states 2 retries, and pi-ai runs them (`maxRetries`) — the seat ADR-0016 delegated to flue's
    `durability{}`.
  - **[ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)'s enabling fact is reproduced
    as explicit code.** Each Submission reads `$JR2_CUSTODIAN_URL/agents/<iid>/surface` afresh and presents it to pi as
    the Menu, so the menu is per-turn with no push channel, no turn index, no second port. Menu tools keep the
    `mcp__jr2__<name>` naming — shipped instructions and the printer's prefix-stripping depend on it — though no MCP
    carries them ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). The
    retire-the-previous idiom and ADR-0023's 404-chase existed to work around flue API gaps that are gone.
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
  rule, receipt, and ordering, and the container split — restated in jr2 terms: the pod's credentials live in a separate
  container (the Custodian, ADR-0059) _because working tools execute in the Harness container_, so the
  credential-isolation premise survives while `local()` leaves the vocabulary.
- **The `flue-contract` tier dissolves into the conformance suite.** Its rig — scripted OpenAI-compatible provider, the
  Menu over a real socket to a killable fake Orchestrator, real server — moves into `packages/harness/test/` and runs in
  the default `test` gate: the opt-in-ness existed only because the tier owned a foreign pin and build. Its claims
  become jr2 requirements, with the pinned-defect assertion inverted: an abort mid-stream must **not** erase the
  assistant message. This suite is the first canary for pi bumps; `@kind` (ADR-0038) drives the same turn loop in a real
  pod against a scripted model, and `@model`
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)) against a real one —
  run all three before bumping the pin.
- **The pinning risk moves; it does not vanish.** pi releases often and a minor can break. The pin is exact, a bump is a
  deliberate kit change gated by the conformance suite, and the breaking surface is now the `Agent` loop's hooks and
  pi-ai's provider adapters — not a code generator, a CLI build, and a process-global registry. What pi removed jr2 now
  owns, so a bump cannot move it: the Working tools keep their text, and Compaction its algorithm.
- **Migration is phased behind the wire.** Because both ends speak the same protocol, the image swap and the
  Orchestrator client swap are independent commits, each leaving every tier green; an old Orchestrator drives the new
  image and vice versa. `@flue/*` leaves the repo when the last pin (the retired contract tier) is deleted.
