# A Machine carries its parts and composes by invoke

A workflow could not use another workflow's Machine as a child without re-declaring the child's events at its own root
(the `triaged-task` example documented the workaround), and a Machine had no way to travel: its Agents lived in the
Instance's roster by name and its Sandbox Image in the Instance's `images/`, so a packaged Machine depended on someone
else's config holding the right strings. The grill of 2026-09-06/09 settled composition and packaging as one decision,
because they are one problem: **what a Machine depends on that is not inside it.**

## Decision

- **Composition is Machine composition.** A workflow module imports another module's exported Machine and invokes it as
  an xstate child (`actors: { deep, quick }`, `invoke: { src: "deep" }`). One run, one snapshot, one run id; the child's
  Gates list under the parent's run and its emits ride the same feed. There is no sub-run and no
  invoke-by-registered-name: a nested Machine is reached by `import`, never by the name `j2 run` uses. Rejected:
  Temporal-style child workflows with their own run ids — a new actor kind, cross-run correlation, and cancel
  propagation, for no requirement that needs a second run id.
- **Everything a Machine depends on rides the Machine, scoped to it.** Vocabulary already did (ADR-0011, per-Machine
  since this decision). The two remaining dependencies join it:
  - **An Agent is an actor slot.** `j2Setup({ actors: { researcher: agent({ model, instructions, … }) } })`, invoked as
    `src: "researcher"` with `{ prompt, …dials }` as input. `agent(definition)` is `agentRun` closed over one definition
    and branded with it; `agentRun` and `agent: "name"` leave the authoring surface. The typo check is xstate's own
    `src` typing — a slot the Machine does not declare is a compile error with nothing added — and Stately shows
    `researching → invoke researcher` instead of a uniform `agentRun`. Two Machines in one run may both carry a
    `researcher`; each resolves against its own implementations, and the Instance ID's actor path keeps their
    conversations apart.
  - **The Sandbox Image is a `workspace()` option**, static: `workspace(body, { input, image, spec })`. `image` is a
    string in one of two shapes — a `file:` URL (`import.meta.resolve("./image")`, a docker context the module ships) or
    a registry ref — or absent, which keeps ADR-0037's fallback. It moved out of the per-run spec because `j2 up` must
    find it statically. It is never persisted: the provisioning state re-reads it off the Machine on restore.
- **The definition rides the Turn.** The admission body carries the slot's definition; the Harness runs what it was
  handed and re-reads it per Submission as before. The Instance roster (`agents/`, then `config.agents`), its ConfigMap,
  and `J2_AGENTS_JSON` retire — a flat roster cannot hold two `researcher`s, and a Machine edit already needs `j2 up` to
  rebake the Orchestrator, so the ConfigMap bought nothing a Machine-carried definition loses. Placement (ADR-0031)
  reads `workspace: "none"` off the slot's definition.
- **Parts resolve at invoke time through the live actor's logic, never a build-time closure.** `agentRun` finds its
  definition in the logic it was invoked as; `provision` reads the image off the wrapper's parts map keyed on
  `machine.config`. This is the one rule that lets xstate's `provide()` and customization coexist, and the same rule
  ADR-0011 adopted for Vocabulary.
- **Customization is `customize(machine, parts)`**, a plain function in the family of `workspace()` and `pool()`,
  returning a plain `StateMachine`. `parts` has the declaration's own shape, recursively partial:
  `{ agents?: { <slot>?: Partial<AgentDefinition> }, image?, actors?: { <child>?: parts } }`. Internally an Agent
  override is xstate's `machine.provide({ actors: { researcher: agent(merged) } })`; a child override is the same call
  one level down, recursing — each level is exactly the one-level reach ADR-0015 found `provide` has, held by the
  composer who owns the child object, never host-side injection. j2's wrappers are transparent:
  `customize(research, { agents })` reaches the body through the `body` slot, so a consumer never writes `body`. The
  image is the one part `provide` cannot carry (xstate copies only implementations), so that field clones the wrapper's
  config and rebuilds. Rejected: a `.with()` method on the machine — it needs a j2-owned machine type over xstate's,
  which ADR-0015 avoided, and it vanishes after any `.provide()`; a callable-machine hybrid — verified to work, reads as
  a trick.
- **A package exports a Machine, nothing beside it.** The door (ADR-0033), the vocabulary, the Agents, and the image all
  ride the exported object. The three uses:

  ```ts
  export const machine = research;                                                            // as-is
  export const machine = customize(research, { agents: { researcher: { model } }, image });   // retuned
  const deep = customize(research, { agents: { researcher: { model: opus } } });              // nested twice,
  const quick = customize(research, { agents: { researcher: { model: haiku } } });            // differently
  export const machine = j2Setup({ events: [route], actors: { triager: agent(triager), deep, quick } }).createMachine(…);
  ```

  A local `workflows/*.ts` is written exactly the same way; there is no package-side API.

- **The wrapper's body is a named slot** (`invoke: { id: "body", src: "body" }` over `setup({ actors: { body } })`), and
  `pool()`'s worker likewise. That is what lets `provide`, `customize`, Stately, and the `j2 up` walk reach it
  uniformly.
- **`j2 up` walks the registered Machines** — `implementations.actors`, descending into child Machines — to collect
  models to preflight and `file:` image contexts to build. A context is keyed by its content digest (the same digest
  ADR-0038 tags by), so the host at `j2 up` and the baked Orchestrator, whose `node_modules` holds the same folder,
  agree without a path table. Repos stay Instance config (deployment facts) and arrive through the door or a parent's
  mapper.

## Consequences

- **Agent identity moves from the Instance to the Machine.** CONTEXT.md's Agent entry restates: an Agent is a part of a
  Machine, not an Instance-scoped roster entry; `customize` is a definition-level act by the composer, so ADR-0018's
  identity-vs-Dial line is untouched — a Turn still sets `model`/`thinkingLevel` and nothing else.
- **A Workflow is a Machine registered under a name.** The "wired to its Agents and config" clause retires: the wiring
  is inside the Machine.
- `defineAgent` retires in favor of `agent()`; `AgentTurnInput.agent` goes; `deriveMenus` keys on agent-slot logic
  instead of `src === "agentRun"`; the unit-test seam becomes `provide({ actors: { researcher: fake } })`.
- Only declared parts can be customized; none can be added. A consumer who needs a third Agent composes a new Machine.
- **`import.meta.resolve` stays** in any Machine that ships a context; there is no other way for an ES module to name a
  folder it owns.
- The ledger records which slot a Turn ran as, not the definition's text. If per-Turn auditability of instructions is
  ever needed, the admission marker can carry a definition digest.
- `j2 dev`'s reload cache-busts the workflow module only; an edit to an imported Machine module is not picked up until
  the next full reload. Known, unaddressed here.
- A `workflows/` file that is both discovered and imported by another registers as its own Workflow too; a Machine meant
  only for composition lives in a `_`-prefixed file or outside `workflows/`.
- Same-name slots across Machines plus a `conversation:` pin continue one conversation under two personas, and nothing
  refuses it. The obvious guard — a definition digest on the ledger record (ADR-0016), compared before a continuation is
  admitted — is NOT taken here, because it cannot tell the two cases apart: it would equally refuse a run whose only
  change is an edited `instructions` after a redeploy, which ADR-0030 deliberately lets continue (shape decides
  restorability, not behavior). A refusal needs a persona identity that survives a retune but not a swap, and this
  decision does not settle what that is. Known, unaddressed here.
