# j2

Greenfield kit for agentic workflows as xstate machines. **Read [CONTEXT.md](./CONTEXT.md) (glossary) and the relevant
[docs/adr/](./docs/adr/) before designing or naming anything** — terms in CONTEXT.md are deliberate and carry `Avoid:`
lists; match them in code, comments, and commits.

## Judging a change

j2 is greenfield. Nothing currently runs in production. Therefore:

- Do not argue from impact, adoption, or "blast radius". These are zero for every change, so they separate nothing.
- Judge a change by the design: does it agree with [CONTEXT.md](./CONTEXT.md) and the [ADRs](./docs/adr/)? Does it make
  the next decision easier or harder? Is the name correct?
- A wrong design costs more here than in a mature codebase, because everything written later builds on it.

## Testing strategy (ADR-0010, ADR-0027)

Three tiers plus one in-package suite. **Unit/integration:** `node --test` per package, in-process + socket-free
(`pnpm -r test`). **E2e:** Gherkin `.feature` specs in `./features/` (`@j2/e2e`), run by Cucumber.js — black-box, each
step spawns the real `j2` binary against a real orchestrator process served per scenario. `Rule` = acceptance criterion;
`Scenario` = isolation unit (own temp instance + orchestrator, torn down in `After`), so `--parallel` is safe. Run with
`pnpm --filter @j2/e2e test:e2e`; it has no `test` script, so the unit gate stays fast. Zero-build: Node 24 strips `.ts`
step defs (no ts-node). **`@kind` (opt-in, needs docker + kind + go):** the data-plane tier — real Sandboxes for
`workspace()` flows (ADR-0012), running the **stock** Harness against a host-side scripted model provider, so only the
LLM is faked (ADR-0038). Excluded from the default profile, so the everyday suite needs no infra. Bring-up builds
nothing: `j2 up` from this checkout builds and loads every image it deploys. Run: `just e2e-kind-up`,
`just operator-run` (another shell), `just e2e-kind`. **`@console` (opt-in, needs a Playwright chromium):** browser
scenarios for the Console's UX — a Playwright page held inside Cucumber steps against the same per-scenario
orchestrator; no docker (ADR-0010 as amended, ADR-0032). Excluded from the default e2e profile; store logic stays
unit-tested in `console-store.test.ts`. **Harness conformance (ADR-0027; in `@j2/harness`, no infra):** the claims the
socket-free tests cannot see, driven through the real turn loop — pi at the exact pin, the real `@j2/adapter` over a
real socket, a scripted provider that chooses each turn's shape. Not a separate tier: it runs in the default `test` gate
as part of `pnpm -r test`. `@j2/harness` owns the pi pin; conformance is the canary for pi bumps (0.x minors break), and
since ADR-0038 `@kind` is a **second** canary — it drives the same turn loop in a real pod — so **run both before
bumping pi**.
