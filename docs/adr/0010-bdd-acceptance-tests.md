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
  only the LLM. (Originally the Sandbox ran a **dev Harness image**, a wire-compatible stub in a container with `git`;
  [ADR-0038](0038-j2-up-builds-every-image-it-deploys.md) retired it. The pod runs the STOCK Harness now — real pi, the
  real Menu over MCP, real Working tools — and the substitution moved to the provider: a scripted OpenAI-compatible
  endpoint the World serves from the host. Which is what makes this tier a second pi canary.) They are tagged `@kind`
  and **excluded from the default profile**, so the everyday suite needs no docker. Bring-up is the product's own path
  (ADR-0019): one shared VANILLA kind cluster and nothing else, then **`j2 up` per scenario into a fresh namespace** —
  which since ADR-0038 builds and loads every image it deploys, so no image is pre-loaded by hand. Namespace-as-identity
  makes the scenario the isolation unit here too, so nothing is instance-bound to the cluster. **The tier defaulted to
  serial for a long time, and the serial bound moved twice.** `--parallel` was expected to be bounded only by cluster
  capacity, and was instead bound by one shared name — the Sandbox Image wrap's intermediate `-base` tag (ADR-0037), a
  content address, so concurrent converges of one checkout built and untagged the _same_ image. Measured then (11
  scenarios, sealed tree): 4 workers → 7/11, 3 → 9/11, 2 → 9/11, serial → 11/11 in ~5m — degree 2 produced ZERO capacity
  timeouts and still lost two scenarios, which is what proved the name, not capacity, was the bound.
  [ADR-0040](0040-the-wraps-intermediate-is-scratch-a-converge-names-its-own.md) deleted that bound (the intermediate is
  per-converge scratch) and [ADR-0041](0041-a-build-the-host-already-holds-is-not-spent-again.md) made a warm scenario's
  converge build nothing (~13s fresh-namespace converge, every build disk-skipped). Measured on that tree: serial →
  11/11 in 5m01s; **degree 4 → 11/11 in ~1m30–1m45s in 8 of 10 runs**, and sixteen parallel runs across degrees 2–4
  produced ZERO converge or image failures — the shared-name class is verifiably gone, and the scenario isolation this
  ADR designed was intact throughout (own namespace, own scripted model port). What parallelism surfaced instead was a
  second bound, and it turned out not to be a test-tier problem at all: roughly one run in three lost a scenario whose
  first turn never reached the scripted model, which was misread as first-turn LATENCY because the run simply sat there.
  It was a lost turn. [ADR-0042](0042-ready-is-not-routable-an-admission-retries-its-connection.md) has the diagnosis —
  a Sandbox CR at `phase: Ready` is not yet ROUTABLE, and the run's single unretried admission POST was the first thing
  ever to dial that Service — and the fix; the Adapter's Menu read turned out to be a second instance of the same
  defect, found only because fixing the first let the tier run far enough to expose it. Parallelism only samples those
  windows more often, which is exactly why the flake was degree-independent and serial runs never hit it. Measured after
  both: **degree 4 → 8 consecutive runs, 88/88 scenarios, 1m30–1m43s each** on a sealed tree, against a ~1-in-3 loss
  rate before. **The wired default is now `--parallel 4`** (in the `kind` profile, so a direct
  `npx cucumber-js --profile kind` gets it too); pass `--parallel 1` to bisect a suspected isolation bug. Three tier
  changes came out of the hunt and stay. A FAILED `@kind` scenario dumps its evidence (the provider's request count,
  `j2 status`, the Harness's `?view=history`, every pod log with timestamps, events, EndpointSlices) to
  `features/.tmp/kind-failures/` before its namespace is deleted. The tier's own workflow ROUTES `agent.fault` instead
  of ignoring it — an ignored terminal fault is an invisible one, and a tier that hangs where it could name the reason
  is a tier that costs a session per defect. And **every** scenario, passing or not, is now scraped for what ADR-0042's
  retries COST (`j2.routability seat=… attempts=… ms=… last=…`), against a budget of 30s or 8 attempts judged per worker
  in `AfterAll` — two meters because a REJECT spends attempts and a dropped SYN spends time, and the tier measured one
  of each in its first two runs (2 attempts / 10667ms, then 3 attempts / 502ms / `ECONNREFUSED`). That last one is the
  tier watching the fix rather than merely enjoying it: the retry is absorbed by design, so without it a cluster
  drifting toward the 90s window would keep passing — slightly slower, silently — until the day it did not.
- **An opt-in `@console` tier for the Console's UX** (added with
  [ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)). The Console's risky behavior is interaction —
  token-mode switching, the frame-triggered gate inbox, selection vs. folding — which no reducer test sees and no CLI
  step drives. These scenarios hold a **Playwright page inside ordinary Cucumber steps** (Playwright the _library_, not
  the `@playwright/test` runner): the browser is a second driver of the same black box, reusing the per-scenario
  orchestrator fixture unchanged, and a scenario may drive both (the CLI starts a run; the browser sees it park). Tagged
  `@console` and **excluded from the default profile** exactly as `@kind` is — the everyday suite must not require a
  Chromium install — but they need no docker: a host-booted orchestrator serves the Console fine. Scope discipline: they
  assert what a user does and sees, never pixels or layout; what the page _believes_ stays in `console-store.test.ts`.
- **Harness conformance, in `@j2/harness`, in the default gate**
  ([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)). The three tiers above all reach the
  Harness through the **stub Harness**, which is a hand-written model of the _wire_ — it holds no conversation, so it
  can report a turn settled `aborted` without ever having had a turn to settle. That is the right fixture for testing
  j2, and it is blind by construction to what the real runtime keeps, drops, or sends onward. Those claims are covered
  by the conformance suite in `packages/harness/test/`, driven through the real turn loop — pi at the exact pin, the
  real `@j2/adapter` over a real socket, a **scripted provider** — so a turn's shape (where it stalls, what it
  half-emits) is chosen by the test rather than by a model. The witness is the message array the provider receives on
  the _next_ turn, which is the only place these claims are visible. Not a separate tier: it runs as part of
  `pnpm -r test` (no docker, no cluster), and it is the canary for pi bumps — **run it before bumping the pin**. (A
  predecessor tier that ran the retired foreign harness runtime at its pin dissolved into this suite — ADR-0027.)
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
  deliberate deviation, scoped to `@j2/e2e` (it does not leak into the kit packages). `playwright` joins it there, same
  scoping, browser binaries installed only where `@console` runs (CI, or `npx playwright install chromium` locally).
- The suite is run with `pnpm --filter @j2/e2e test:e2e`; `@j2/e2e` exposes **no** `test` script, so `pnpm -r test`
  stays fast and unit-only.
- Human-in-the-loop delivery is covered at the gates API (`features/agent-and-gates.feature` — the agent played over
  `/agents/<iid>/*`, the human over `/runs/:id/gates/:gate/events`); the `j2 send --gate` CLI verb is covered at the
  in-process tier. A CLI-driven e2e gate scenario remains a candidate follow-up `Rule`.
