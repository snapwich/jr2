# A global `jr2` hands off to the Instance's own, and an Instance has one Kit version

[ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md) made `jr2 init` pin `@jr2/cli` as
an exact devDependency beside `@jr2/orchestrator`, and said instances upgrade "by editing two dep lines". That pin only
means something if the Instance's copy of the CLI is the one that runs — and nothing made it so. `bin/jr2.js` ran
itself, whatever cwd it was run from, and `KIT_VERSION` was read from the `@jr2/orchestrator` the **running CLI**
resolved, never the one the Instance resolved. The first bump after 0.1.0 (2026-09-20) showed the hole: a global
`jr2@0.1.1` in an Instance pinning `@jr2/orchestrator@0.1.2` and `@jr2/cli@0.1.0` converged 0.1.1 Kit images around a
0.1.2 bundle, and nothing said a word. Published `@jr2/cli@X` depends on `@jr2/orchestrator@X` exact, so a mismatched
pin quietly nests a **second** orchestrator under the CLI — the class-identity failure commit 2685d9b had already
patched one symptom of. This ADR settles which binary runs, and what "the Instance's version" is.

## Decision

- **A global `jr2` hands off (the gulp/grunt model).** Before any verb, the binary walks up from cwd to `jr2.config.ts`
  (ADR-0009's root marker). If that folder resolves `@jr2/cli` to a real path other than its own, it runs that package's
  `bin.jr2` with the same arguments and stdio, and exits with its code. Nothing else — no flag parsing, no verb
  exceptions (`--url` inside an Instance still hands off; the rule stays one sentence). _Amended 2026-09-20:_ plus one
  env var, `JR2_HANDOFF_FROM=<version> <realpath>`, naming the copy that handed off. `jr2 version` prints it as the
  `global` line, so "is my global out of date" is answered without leaving the Instance; nothing else reads it. It is
  the only fact the local copy cannot learn on its own (`npm ls -g` is slow and per-manager). A global that predates the
  variable hands off without it, and the report then shows no `global` line at all — indistinguishable from `npx jr2`,
  and there is no third source to ask.
- **Spawn, not import.** gulp loads the local gulp in-process because local gulp is a _library_ its CLI drives; here the
  local is a _binary_. Spawning couples the global to one contract — the local package's `bin` field, npm's own, stable
  across versions — and the local's preamble runs: its pinned `ts-blank-space`, its hooks, whatever a future bin adds.
  Importing `src/cli.ts` would make the local's internal layout and `main` signature a cross-version API the global must
  honor forever, and the global is the copy that cannot be updated once it ships. One extra Node start per invocation is
  the price. Ctrl-C is unchanged: both share the process group.
- **An Instance has one Kit version: the `@jr2/orchestrator` it resolves**, because that is what its image bakes.
  Wherever the CLI loads an Instance (the root walk every Instance verb goes through; `--url` verbs skip the walk per
  ADR-0009, `jr2 init` has no Instance yet), it resolves `@jr2/orchestrator/package.json` from the Instance root and
  from itself and requires the two **real paths** to be equal. Not equal — or absent — is a refusal that names both
  versions and the two lines to edit, then says reinstall. Real-path identity rather than a version compare: same file
  means same version by construction under npm hoisting, pnpm dedup, and checkout symlinks alike, and it is exactly the
  property the class-identity bug needs.
- **`@jr2/orchestrator` is a peer of `@jr2/cli`, not a dependency.** `peerDependencies: workspace:*` (pnpm rewrites it
  exact at publish) plus the same under `devDependencies` for the checkout's own tests. npm then fails a mismatched pin
  at install (`ERESOLVE`), before anything runs; pnpm and bun warn and the check above refuses. The CLI stops carrying
  an orchestrator of its own, so a second copy can only come from the Instance's resolution — the copy we want. The CLI
  stays a **devDependency** of every Instance: the bundle installs `--omit=dev`/`--prod`, and the image has no use for a
  CLI or its erasure hook; peers of a devDependency still auto-install and still `ERESOLVE`.
- **`jr2 init` reads the CLI's own version.** A global with no Instance around it must not need its peer resolved, so
  the scaffold's exact pin comes from `@jr2/cli`'s `package.json`. The numbers are equal by construction: one release
  train, lockstep ([ADR-0055](0055-a-release-is-a-pushed-tag-and-the-publish-guard-is-the-credential.md)).

## Consequences

- ADR-0043's "edit two dep lines" is amended: an Instance is upgraded by editing two lines **to the same number**, and
  editing one is now a refusal (or an install error), never a silent skew.
- A global installed before this ADR does not hand off; the user updates it once. After that the global's version stops
  mattering inside an Instance, which is the point.
- The `@dist` tier exercises the handoff for free: its installed global drives an Instance whose own `@jr2/cli` came
  from the same verdaccio at a different real path. The mode-line assertion it already makes now asserts the local
  copy's line.
- `docs/intro` bumps `@jr2/cli` to the number its orchestrator already carries.
