# The instance authors Agent definitions; j2 assembles the Harness

Building the first real Harness (examples/coding, 2026-07-18) landed a **full flue project** in the instance —
`agents/{package.json, flue.config.ts, Dockerfile, src/agents/*.ts}` — because flue has no programmatic server-assembly
API: agents exist only as files a `flue build` discovers, so a flue project must exist _somewhere_, and the expedient
somewhere was user space. That put j2 mechanism in the user's hands: the ADR-0013 Adapter leash
(`connectMcpServer("j2", …/mcp/<id>)` per submission — forget it and the Agent is silently mute, the same footgun class
ADR-0016 removed from workflows), the ADR-0004/0012 sandbox geography (`local()`, `cwd: "/work"`), the `route` exposure,
the flue dependency pin that must match the orchestrator's `@flue/sdk` wire, and the image contracts the operator
imposes (numeric uid, `:8080` = Ready, git present). The only content a user genuinely owns is the persona: model +
instructions (+ someday tools/skills). CONTEXT.md already promised the split — an Agent "maps to a flue `createAgent`
definition" (j2 does the mapping), and an Instance mirrors "flue's `flue.config.ts` + `agents/`".

## Decision

- **The instance's `agents/<name>.ts` is a plain-data Agent definition** — filename = Agent name, mirroring
  `workflows/`. The contract is `export default defineAgent({ model, instructions, … })`, a typed identity from
  `@j2/orchestrator` (like `defineConfig`). Serializable persona data only; **the instance never imports flue**.
- **The Harness image is stock and published** — `j2-harness:<kitversion>`, one release train with the kit (like the
  operator and Adapter images, ADR-0019). An instance builds **no** Harness image. The stock image bakes the complete
  flue project skeleton (pinned `@flue/runtime`/`@flue/cli` matching the orchestrator's `@flue/sdk`, `flue.config.ts`,
  full `node_modules`, the operator's image contracts) plus a j2 entrypoint.
- **Definitions are injected at pod start, not baked.** `j2 up` publishes the instance's definitions as a ConfigMap; the
  entrypoint writes one generated shim per definition, runs `flue build --target node` (~0.5 s, fully offline — flue has
  no boot-time discovery; the build codegens static imports and bundles `dist/server.mjs`, verified against the
  published 1.0.0-beta.9 dist), then execs the server. Only agent **names** are frozen at that build: the shims read
  model/instructions/cwd from the mounted data at runtime (flue initializers run per submission), so definition edits
  reach pods as a ConfigMap update + pod restart — no image build anywhere.
- **The shim carries the mechanism**: the Adapter leash, `sandbox: local()` + `cwd`, the `route` export — existing only
  in generated code, unforgettable by construction (symmetric with ADR-0016 making endpoint/sandbox threading
  unrepresentable in workflows).
- **`harness` is the agent-runtime section of `j2.config.ts`** — the config the stock image consumes alongside the
  definitions: default model, custom provider (`{ api, baseUrl }` plus token limits — `contextWindow`/`maxTokens`,
  provider-level and per-model, since a custom id has no flue catalog entry and unset limits resolve to 0, starving
  auto-compaction — e.g. an OpenAI-compatible vLLM endpoint, which the generated project registers via
  `registerProvider`), and the env/creds Agents need. It moved out of `sandbox` deliberately: `sandbox` is pod-transport
  (it still _carries_ this env to the Harness container), but model concerns are Harness semantics and users configure
  them here. `j2 up` preflights a configured provider from inside the cluster (ADR-0019).

**Amended 2026-08-02.** Two clauses above no longer hold. The `harness` section's **default model is removed**, and
`model` is **required** on every definition. And a workflow may set two of a definition's fields for one Turn.

_Why the default went._ It was reached through `.env` (`J2_MODEL` → `harness.model`), which put a design decision in the
file reserved for deployment-varying values (ADR-0019) — and split one fact in two, since this endpoint's per-model
token limits were already committed in `j2.config.ts` keyed by the very model id `.env` was choosing. Removing it leaves
the honest split: **`harness` declares what the instance can REACH** (endpoints, credentials, trust, limits), **the
definition makes the choice.** A required `model` also keeps every Agent independently valid, and keeps definitions the
only models `j2 up` can preflight — so the preflight now probes each distinct model the definitions name for the
configured provider, instead of one default that any definition could shadow.

_Why an invocation may override it._ Agents are instance-scoped and every workflow may name any of them, so one persona
legitimately runs at different settings in different workflows — a reviewer on a one-line diff and the same reviewer on
an architecture change want identical instructions and different effort. Spread-composition (below) answers this with
persona×tier files where "heavy" is a knob wearing a persona's filename, so `agentRun` takes two optional **dials**,
`model` and `thinkingLevel`, layered over the definition per Submission.

_The line that keeps this from becoming "re-specify the definition at the call site."_ **Identity vs. dial.** Identity —
`instructions`, `access`, `cwd` — is definition-only: a call site that rewrote it would make the Agent's name a lie, and
`access` carries [ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)'s containment claim
that a read-only reviewer _cannot_ write, which per-invocation escalation would void. **ADR-0028 is therefore unaffected
by this amendment.** Dials say only how hard to run: it is still the coder, it is the coder running hot.

_Where a model is checked._ Three seats, each where the knowledge is. A definition's model resolves against the registry
at **pod boot** (loudly, in the pod log — a typo is a static fact about the mounted spec). A configured provider is
probed per named model at **converge**. A dial is checked at **admission**, 400-ing the invoke as its state is entered
rather than settling the Submission `failed` mid-run — a call-site model cannot be checked earlier, because an invoke's
`input` is a function and is not statically recoverable. Definitions keep converge-time safety; overrides pay a later
check for the flexibility.

## Considered options

- **Thin wrapper** (`j2Agent({…})` imported inside a user-owned flue project). Rejected: shrinks the per-agent file but
  leaves the dependency pin, `flue.config.ts`, and the Dockerfile contracts in user space — the parts that break
  silently when they drift from the orchestrator's wire and the operator's pod.
- **Instance owns the flue project** (the first cut). Rejected: violates the documented Instance/Agent split, and every
  new agent re-copies the leash.
- **Per-instance Harness image built by a `j2 harness build`** (the second cut: j2 generates the project under
  `.j2/harness/`, the user docker-builds it). Rejected once definitions were plain data: the image content was 100%
  kit-owned mechanism plus a JSON's worth of persona — so the persona moves at runtime and the image joins the published
  release train. This also deleted a build+`kind load` step from every agent edit.
- **Programmatic flue server assembly** (no generated files, no boot build). Not available: the published flue has no
  serve command — `flue build` is the only way to produce a server, and it bakes agents via static-import codegen
  (verified against `@flue/cli` 1.0.0-beta.9; the `@flue/runtime/internal` entry points exist but are an unsupported
  fork-risk).

## Consequences

- The definition contract is data-only for now: custom flue tools/skills/subagents have no seat in it. The escape
  hatches when someone needs them: eject to a real flue project with their own image (per-instance baking returns for
  exactly those users), or grow the contract then, deliberately.
- Because definitions are plain data, stock ones compose with no API: `@j2/agents` definitions are used by re-export
  (`export { coder as default } from "@j2/agents"` — filename-discovery stays the one registration mechanism) and
  extended by spread (ADR-0009).
- Stock-image mechanics the entrypoint owns: the app dir is chown'd for the non-root uid (the boot build writes
  `dist/`), build stderr surfaces in pod logs (duplicate/zero agent names fail the flue build), and readiness lags a few
  seconds behind container start (the `:8080` probe passes only after the boot build).
- The stock image carries the flue build toolchain as baked devDeps — a bigger image, paid once per kit release, in
  exchange for no per-instance builds and no network at boot.
- The generator owns version compatibility: bumping the flue wire is a j2 kit change, never an instance chore.
