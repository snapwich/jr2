# BDD acceptance tests via Cucumber.js (black-box, scenario-isolated)

j2's per-package tests are `node --test` suites that run in-process and socket-free (e.g. the CLI's `cli.test.ts` calls
`main(argv, io)` with `fetch` bound to `app.request`). Those are fast and cover unit and integration behavior, but
nothing exercises the _system_ the way a user does — the real `j2` binary, a real HTTP socket, exit codes, signals. This
ADR adds a second, complementary tier: **black-box end-to-end acceptance tests, written in Gherkin and run by
Cucumber.js**, living in a top-level `./features/` workspace package (`@j2/e2e`).

## What we decided

- **Two tiers, not one.** In-process `node --test` stays the unit/integration tier (fast, no sockets, per package).
  Cucumber.js is the **e2e** tier: each step spawns the real `j2` binary as a child process against a real orchestrator
  server on an ephemeral port, and asserts only on what a shell sees — captured stdout (the one machine-readable
  result), stderr (human activity), and the exit code. The e2e tier does not re-test what the in-process tier already
  covers.
- **The per-scenario orchestrator is the image entrypoint, not a CLI verb.** There is no host dev mode (ADR-0019), but
  the instance image's server entrypoint is an ordinary Node process — the test fixture boots exactly that process on
  the host, with `--url`/token env pointing the spawned `j2` binary at it. Same real server the cluster runs, no
  cluster, no user-facing verb. The wire-compatible **stub Harness** (ADR-0011) is a fixture owned by this tier and
  served the same way.
- **`Feature` → `Rule` → `Scenario` maps to criteria.** A `Rule` is one acceptance criterion; a `Scenario` is an example
  of it. This is organizational only — `Rule`s carry no shared state.
- **`Scenario` is the isolation unit.** Each scenario gets its own scaffolded temp instance (via the real `j2 init`),
  its own server process + sqlite store, torn down in an `After` hook. Nothing is shared across scenarios, so the suite
  is safe under `cucumber-js --parallel`.
- **An opt-in `@kind` tier for the data plane** (added once the `workspace()` slice landed — ADR-0012). Workspaces are
  always real Sandboxes, so the only way to test them is against a real cluster: the `@kind` scenarios drive the
  operator's Sandbox CR, a pod, the read-only source volume, an in-pod git worktree, and the Harness endpoint — faking
  only the LLM (the Sandbox runs the **dev Harness image**: the same wire-compatible stub, in a container with `git`).
  They are tagged `@kind` and **excluded from the default profile**, so the everyday suite needs no docker. Bring-up is
  the product's own path (ADR-0019): one shared vanilla kind cluster, locally built kit images, then **`j2 up` per
  scenario into a fresh namespace** — namespace-as-identity makes the scenario the isolation unit here too, so nothing
  is instance-bound to the cluster and `--parallel` is bounded only by cluster capacity.
- **A workspace package, not a bare folder.** `./features/` is `@j2/e2e` so it owns its own `xstate` (+ cucumber)
  dependency: a scaffolded instance's `workflows/*.ts` `import "xstate"`, resolved by walking up from the temp dir, and
  the repo root has no `xstate`. The package's `node_modules` satisfies it. It is top-level (not under `packages/cli/`)
  because an e2e test exercises most packages at once — the CLI is the common entry point, not the only conceivable one.
- **Zero-build, like the rest of the repo.** Cucumber.js v13 runs `.ts` ESM step definitions directly under Node 24's
  native type-stripping — no `ts-node`, no transpile step. (Verified before adopting it.)

## Considered options

- **Express BDD as a convention in `node --test`** (a Given/When/Then helper, no `.feature` files): keeps zero deps, but
  loses the plain-English acceptance specs that are the point of writing them at the user boundary. Rejected — we want
  the `.feature` files as readable, reviewable criteria.
- **In-process e2e** (drive `main(argv, io)` instead of a subprocess): faster, but it is integration, not e2e — it can't
  catch bin/shebang, exit-code, signal, or attach bugs. That's already the job of the in-process tier; the e2e tier
  exists precisely to cover the subprocess boundary.
- **Requiring a cluster for all e2e** (every scenario through `j2 up`): honest but slow, and it gates the everyday suite
  on docker. Rejected — the control-plane surface is fully exercisable against the bare server process; only the data
  plane needs kind, and it has its own tier.

## Consequences

- `@cucumber/cucumber` is the **first test-framework dependency** in a repo that otherwise uses only `node --test` — a
  deliberate deviation, scoped to `@j2/e2e` (it does not leak into the kit packages).
- The suite is run with `pnpm --filter @j2/e2e test:e2e`; `@j2/e2e` exposes **no** `test` script, so `pnpm -r test`
  stays fast and unit-only.
- Human-in-the-loop delivery is covered at the gates API (`features/agent-and-gates.feature` — the agent played over
  `/agents/<iid>/*`, the human over `/runs/:id/gates/:gate/events`); the `j2 send --gate` CLI verb is covered at the
  in-process tier. A CLI-driven e2e gate scenario remains a candidate follow-up `Rule`.
