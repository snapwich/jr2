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
step spawns the real `j2` binary against a real `j2 dev`. `Rule` = acceptance criterion; `Scenario` = isolation unit
(own temp instance + `dev`, torn down in `After`), so `--parallel` is safe. Run with `pnpm --filter @j2/e2e test:e2e`;
it has no `test` script, so the unit gate stays fast. Zero-build: Node 24 strips `.ts` step defs (no ts-node). **`@kind`
(opt-in, needs docker + kind + go):** the data-plane tier — real Sandboxes for `workspace()` flows (ADR-0012). Excluded
from the default profile, so the everyday suite needs no infra. Run: `just e2e-kind-up`, `just operator-run` (another
shell), `just e2e-kind`. **Harness conformance (ADR-0027; in `@j2/harness`, no infra):** the claims the socket-free
tests cannot see, driven through the real turn loop — pi at the exact pin, the real `@j2/adapter` over a real socket, a
scripted provider that chooses each turn's shape. Not a separate tier: it runs in the default `test` gate as part of
`pnpm -r test`. `@j2/harness` owns the pi pin; the suite is the canary for pi bumps (0.x minors break) — **run it before
bumping pi**.
