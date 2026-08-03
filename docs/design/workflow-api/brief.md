# j2 workflow-API redesign — grill outcomes (2026-07-13)

Goal: simplify the consumer-facing workflow API so `examples/coding/workflows/coding.ts` reads as pure workflow (states,
transitions, prompts, policy) with zero j2-mechanism residue. Consumer implements their workflow; j2 owns how it runs.
Convention over configuration.

## Decisions (user-confirmed)

1. **Direction: mechanisms absorb plumbing, not templates.** ADR-0003's template/`provide()` model likely retires;
   consumers author machines. BUT: re-validate the child-machine-vs-`provide()` tradeoff — child machines were
   introduced to hide j2-internal complexity (e.g. workspace provisioning states) while a consumer machine runs
   "inside". Maybe another way accomplishes that. Multiple proposals / sub-proposals welcome.
2. **Offsets/durability plumbing → 100% j2-internal.** Host persists iid→offset off the inspection stream (already
   does); rewrites agentRun inputs on restore. Consumer never writes `offsets`, never handles `agent.offset`, never
   branches attach-vs-prompt. No consumer-visible escape hatch needed (same-iid = same conversation is the convention).
3. **Ambient infra coordinates.** `agentRun` input drops `endpoint`/`sandbox`/`instanceId` plumbing: resolved from the
   enclosing `workspace()` scope via the actor system. No case exists where a body talks to a different
   sandbox/endpoint. Conversation identity derived by convention (run + child id + consumer-supplied `scope` + agent
   role). `turn()`/`iid()` helpers die. `WorkspaceHandles` shrinks to workflow-legit fields (workdir, repos, branch).
4. **Agent tools by convention.** Consumer specifies only prompt + genuinely custom tools. Workflow-driving tools
   (events) are inserted by j2 — ideally DERIVED from the invoking state's event transitions (or demarcated as agent
   transitions). MCP is an implementation detail the consumer never sees. Open sub-problem: derivation ambiguity
   (bubbled ancestor handlers; events that must NOT reach agents e.g. human-gate `approve`); demarcation is the
   fallback. Likely the same convention applies to `gate.accepts`.
5. **Retries absorbed.** j2 internally retries infra faults and auto-nudges no-signal agents within a defaulted budget
   (knob, not context). Workflow sees ONE terminal `agent.fault` and routes it (policy).
   `retriesLeft`/`spendRetry`/`hasRetryBudget`/`retryOrEscalate`/`reenter` all delete. Retry attempts should be
   observable via j2 visualize / run feed (j2 telemetry, not machine events).
6. **Top-machine primitive: open, generalized.** A `pool`-like primitive for spawn-under-cap + completion collection is
   welcome IF generalized over a source (queue/generator/re-queried set), NOT a jr-coupled "claim work" verb. Work
   Source becomes one adapter over it. User open to j2 owning the whole work loop if the API makes sense.
7. **Authoring surface: `j2.setup` analog OK.** Statically imported, xstate-shaped, derives event unions from defs,
   pre-registers j2 actors, injects mechanism event types. MUST return a plain xstate machine (Stately-inspectable,
   `.provide()`-testable). No j2-only DSL. **The `export const events` manifest dies** — vocabulary derivable from the
   machine object.

## Non-negotiables

- **jr semantic parity — but verified against the actual jr repo** (/home/richs/.local/share/jr), not coding.ts (which
  may have diverged inventing the API). jr itself fluctuated; simplifying jr's workflow is OK if the goal is preserved.
  "Mostly semantic parity."
- **ADR-0013 security**: ambient sandbox resolution must preserve per-Sandbox token scoping; cross-feature event
  injection stays impossible.
- **Durability is secondary**: some loss acceptable if it greatly simplifies (e.g. restart a feature after a crashed
  agent). Ideal = durable AND clean; clean wins ties.
- **xstate v5 fixed.** TypeScript fixed.
- **Teardown-by-wrapper guarantee** (ADR-0012) stays out of consumer hands.

## Success bar

Judge proposals by rewriting coding.ts against each: the rewrite reads as pure workflow — no offsets, no
endpoint/sandbox threading, no retry accounting, no casts, no manifest, no comment-enforced footguns (e.g. spawnChild
placement for visualize). If a line doesn't correspond to a sentence in jr's behavior description, it shouldn't exist.

## Assumptions to re-evaluate

- child machines vs provide() vs other encapsulation mechanisms (per decision 1)
- flue usage: study https://flueframework.com/ — is j2 using flue (iids, endpoints, offsets, Harness) the way that makes
  most sense?
- Work Source / Ready-set model in CONTEXT.md vs generalized source primitive
- ADR-0003 + CONTEXT.md Template/Provider entries: retire or redefine (pending research)
