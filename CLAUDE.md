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

## Testing strategy (ADR-0010)

Four tiers. **Unit/integration:** `node --test` per package, in-process + socket-free (`pnpm -r test`). **E2e:** Gherkin
`.feature` specs in `./features/` (`@j2/e2e`), run by Cucumber.js — black-box, each step spawns the real `j2` binary
against a real `j2 dev`. `Rule` = acceptance criterion; `Scenario` = isolation unit (own temp instance + `dev`, torn
down in `After`), so `--parallel` is safe. Run with `pnpm --filter @j2/e2e test:e2e`; it has no `test` script, so the
unit gate stays fast. Zero-build: Node 24 strips `.ts` step defs (no ts-node). **`@kind` (opt-in, needs docker + kind +
go):** the data-plane tier — real Sandboxes for `workspace()` flows (ADR-0012). Excluded from the default profile, so
the everyday suite needs no infra. Run: `just e2e-kind-up`, `just operator-run` (another shell), `just e2e-kind`.
**`flue-contract` (opt-in, no infra):** the real flue runtime at the pinned version vs. a scripted fake provider — the
three tiers above all go through the stub Harness, which models flue's wire and holds no conversation, so it cannot see
what the runtime keeps or drops. Owns the `@flue` pin; **run `just flue-contract` before bumping it** (one test asserts
a defect on purpose and fails when flue fixes it).
