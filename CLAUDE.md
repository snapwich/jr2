# j2

Greenfield kit for agentic workflows as xstate machines. **Read [CONTEXT.md](./CONTEXT.md) (glossary) and the relevant
[docs/adr/](./docs/adr/) before designing or naming anything** — terms in CONTEXT.md are deliberate and carry `Avoid:`
lists; match them in code, comments, and commits.

## Testing strategy (ADR-0010)

Two tiers. **Unit/integration:** `node --test` per package, in-process + socket-free (`pnpm -r test`). **E2e:** Gherkin
`.feature` specs in `./features/` (`@j2/e2e`), run by Cucumber.js — black-box, each step spawns the real `j2` binary
against a real `j2 dev`. `Rule` = acceptance criterion; `Scenario` = isolation unit (own temp instance + `dev`, torn
down in `After`), so `--parallel` is safe. Run with `pnpm --filter @j2/e2e test:e2e`; it has no `test` script, so the
unit gate stays fast. Zero-build: Node 24 strips `.ts` step defs (no ts-node).
