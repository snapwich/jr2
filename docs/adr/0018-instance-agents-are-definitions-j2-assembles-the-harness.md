# The instance authors Agent definitions; j2 assembles the Harness

Building the first real Harness (the jr-parity exercise, 2026-07-18) landed a **full harness-framework project** in the
instance — package.json, runtime config, Dockerfile, per-agent source (under flue, the embedded framework since retired
— [ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)). That put j2 mechanism in the user's
hands: the [ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md) Adapter leash (connect the MCP surface per Submission
— forget it and the Agent is silently mute, the same footgun class ADR-0016 removed from workflows), the ADR-0004/0012
sandbox geography (working tools execute in the Harness container against `/work`), the dependency pin that must match
the Orchestrator's wire, and the image contracts the operator imposes (numeric uid, `:8080` = Ready, git present). The
only content a user genuinely owns is the persona: model + instructions (+ someday tools/skills). CONTEXT.md already
promised the split — an Agent is a definition j2 maps into the Harness, and the Instance folder holds only what a
Machine cannot carry (ADR-0049/0050: the definition is one of the things it can).

## Decision

- **An Agent is a plain-data definition carried by a Machine as an actor slot** —
  `actors: { <name>: agent({ model, instructions, … }) }`, slot key = Agent name, invoked as `src: "<name>"` (ADR-0049).
  The definition may be written inline or imported from any module. Serializable persona data only; **the instance never
  imports the Harness runtime**. `model` is **required**: every Agent is independently valid, and definitions are the
  only models `j2 up` can preflight — it collects them by walking the registered Machines. (The first cut
  filename-discovered `agents/<name>.ts`, mirroring `workflows/`, and a second put them in `j2.config.ts`; both were
  Instance rosters, and a roster cannot hold two Machines' `coder`s.)
- **The Harness image is stock and published** — `j2-harness:<kitversion>`, one release train with the kit (like the
  operator and Adapter images, ADR-0019). An instance builds **no** Harness image. The image is `@j2/harness`, j2's own
  server (ADR-0027), honoring the operator's image contracts.
- **The definition rides the Turn, never the image.** The admission body carries the slot's definition (ADR-0049); the
  server validates it loudly and re-reads model/instructions/cwd per Submission. No image is built anywhere for a
  definition edit. (A ConfigMap roster read at boot — `J2_AGENTS_JSON` — was the mechanism between the codegen-at-boot
  cut and this one; it retired because a Machine edit already rebakes the Orchestrator, so the roster bought nothing a
  Machine-carried definition loses.)
- **The kit's server assembly carries the mechanism**: the Adapter leash, the workspace cwd, tool assembly — existing
  only in kit code, unforgettable by construction (symmetric with ADR-0016 making endpoint/sandbox threading
  unrepresentable in workflows).
- **`harness` is the agent-runtime section of `j2.config.ts`** — it declares what the instance can **reach**, never
  which model to use: a custom provider (`{ api, baseUrl }` plus token limits — `contextWindow`/`maxTokens`,
  provider-level and per-model, since a custom id has no catalog entry and unset limits resolve to 0, starving
  auto-compaction — e.g. an OpenAI-compatible vLLM endpoint), and the env/creds Agents need. It moved out of `sandbox`
  deliberately: `sandbox` is pod-transport (it still _carries_ this env to the Harness container), but model concerns
  are Harness semantics and users configure them here. `j2 up` preflights a configured provider from inside the cluster,
  per distinct model the definitions name (ADR-0019). An instance-wide default model was tried and removed: it was
  reached through `.env` (`J2_MODEL`), which put a design decision in the file reserved for deployment-varying values
  (ADR-0019) — and split one fact in two, since the endpoint's per-model token limits were already committed in
  `j2.config.ts` keyed by the very model id `.env` was choosing. The honest split: **`harness` declares reach; the
  definition makes the choice.**

## Dials: a workflow may set two of a definition's fields for one Turn

One definition value may be carried by several Machines, so one persona legitimately runs at different settings in
different workflows — a reviewer on a one-line diff and the same reviewer on an architecture change want identical
instructions and different effort. Spread-composition (below) answers this with persona×tier files where "heavy" is a
knob wearing a persona's filename, so `agentRun` takes two optional **dials**, `model` and `thinkingLevel`, layered over
the definition per Submission.

The line that keeps this from becoming "re-specify the definition at the call site": **identity vs. dial.** Identity —
`instructions`, `access`, `cwd` — is definition-only: a call site that rewrote it would make the Agent's name a lie, and
`access` carries [ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)'s containment claim
that a read-only reviewer _cannot_ write, which per-invocation escalation would void. **ADR-0028 is therefore untouched
by the dials.** Dials say only how hard to run: it is still the coder, it is the coder running hot.

Where a model is checked: two seats, each where the knowledge is. At **converge**, `j2 up` walks the registered Machines
for the definitions they carry (ADR-0049) and probes a configured provider once per distinct model they name. At
**admission**, the Harness resolves the definition it was handed against its registry and 400s the invoke as its state
is entered, rather than settling the Submission `failed` mid-run. The pod-boot seat retired with the roster it read: the
Harness no longer knows an Agent before a Turn brings it one. A dial has only ever had the admission seat — a call-site
model cannot be checked earlier, because an invoke's `input` is a function and is not statically recoverable.
Definitions keep converge-time safety; overrides pay the later check for the flexibility.

## Considered options

- **Thin wrapper** (a j2 identity imported inside a user-owned harness project). Rejected: shrinks the per-agent file
  but leaves the dependency pin, the runtime config, and the Dockerfile contracts in user space — the parts that break
  silently when they drift from the Orchestrator's wire and the operator's pod.
- **Instance owns the harness project** (the first cut). Rejected: violates the documented Instance/Agent split, and
  every new agent re-copies the leash.
- **Per-instance Harness image built by a `j2 harness build`** (the second cut: j2 generates the project under
  `.j2/harness/`, the user docker-builds it). Rejected once definitions were plain data: the image content was 100%
  kit-owned mechanism plus a JSON's worth of persona — so the persona moves at runtime and the image joins the published
  release train. This also deleted a build + `kind load` step from every agent edit.

## Consequences

- The definition contract is data-only: what an Agent may do to the Workspace is part of it (`access`, ADR-0028); custom
  tools/skills/subagents have no seat yet. When someone needs them, the contract grows deliberately — there is no eject
  hatch to a foreign harness project (ADR-0027 deleted it).
- Because definitions are plain data, stock ones compose with no API: a Machine carries `agent(coder)`, and a consumer
  retunes it with `customize(machine, { agents: { coder: { model: "…" } } })` (ADR-0049, ADR-0009).
- An invalid definition fails at admission, loudly, naming the slot: a model no registry resolves, a malformed field. A
  Machine with no Agent slots is valid — a `workspace()` body parking a Sandbox (ADR-0012) invokes none. Readiness is
  binding `:8080`, with no boot build ahead of it (ADR-0027).
- The kit owns version compatibility: the Harness runtime and its exact pins are kit concerns (ADR-0027) — bumping them
  is a kit change, never an instance chore.
