# jr2

Greenfield kit for agentic workflows as xstate machines. **Read [CONTEXT.md](./CONTEXT.md) (glossary) and the relevant
[docs/adr/](./docs/adr/) before designing or naming anything** — terms in CONTEXT.md are deliberate and carry `Avoid:`
lists; match them in code, comments, and commits.

## Judging a change

jr2 is greenfield. Nothing currently runs in production. Therefore:

- Do not argue from impact, adoption, or "blast radius". These are zero for every change, so they separate nothing.
- Judge a change by the design: does it agree with [CONTEXT.md](./CONTEXT.md) and the [ADRs](./docs/adr/)? Does it make
  the next decision easier or harder? Is the name correct?
- A wrong design costs more here than in a mature codebase, because everything written later builds on it.

## Testing strategy (ADR-0010, ADR-0027)

Three tiers plus one in-package suite. **Unit/integration:** `node --test` per package, in-process + socket-free
(`pnpm -r test`). **E2e:** Gherkin `.feature` specs in `./features/` (`@jr2/e2e`), run by Cucumber.js — black-box, each
step spawns the real `jr2` binary against a real orchestrator process served per scenario. `Rule` = acceptance
criterion; `Scenario` = isolation unit (own temp instance + orchestrator, torn down in `After`), so `--parallel` is
safe. Run with `pnpm --filter @jr2/e2e test:e2e`; it has no `test` script, so the unit gate stays fast. Zero-build: Node
24 strips `.ts` step defs (no ts-node). **`@kind` (opt-in, needs docker + kind + go):** the data-plane tier — real
Sandboxes for `workspace()` flows (ADR-0012), running the **stock** Harness against a host-side scripted model provider,
so only the LLM is faked (ADR-0038). Excluded from the default profile, so the everyday suite needs no infra. Bring-up
builds nothing: `jr2 up` from this checkout builds and loads every image it deploys, and converges the operator
in-cluster (the tier's config never sets `operator.manage: false`), so it is exactly two commands — `just e2e-kind-up`,
then `just e2e-kind`. **`@dist` (opt-in, needs docker + kind + network):** the distribution tier — the kit as a USER
installs it (ADR-0043). Only the REGISTRY is faked: a suite fixture publishes `@jr2/{cli,orchestrator,agent-protocol}`
into an ephemeral verdaccio, builds the Kit images at their published tags, and `npm i -g @jr2/cli` into a throwaway
prefix; each scenario then drives that INSTALLED binary — `jr2 init` a temp dir outside any checkout or git repo,
install with npm (one scenario) or pnpm (the other), `jr2 up`, `jr2 run ping`, and (npm) `jr2 down`. So `npm pack`, the
`files:` lists, the exact-version pin the scaffold writes, the lockfile-dispatched bundle install, and installed mode
itself execute here and in no other tier. Publish is once per suite run, so the profile is deliberately serial;
scenarios isolate by namespace like `@kind`. Two commands: `just e2e-dist-up`, then `just e2e-dist` — and `just dist-up`
is the same loop with a human at the wheel. **`@console` (opt-in, needs a Playwright chromium):** browser scenarios for
the Console's UX — a Playwright page held inside Cucumber steps against the same per-scenario orchestrator; no docker
(ADR-0010 as amended, ADR-0032). Excluded from the default e2e profile; store logic stays unit-tested in
`console-store.test.ts`. **Harness conformance (ADR-0027; in `@jr2/harness`, no infra):** the claims the socket-free
tests cannot see, driven through the real turn loop — pi at the exact pin, the Menu over a real socket to the
Custodian's address, a scripted provider that chooses each turn's shape. Not a separate tier: it runs in the default
`test` gate as part of `pnpm -r test`. `@jr2/harness` owns the pi pin; conformance is the canary for pi bumps (0.x
minors break), and since ADR-0038 `@kind` is a **second** canary — it drives the same turn loop in a real pod — so **run
both before bumping pi** — and the `@model` tier below, the third canary. **`@model` (ADR-0066; opt-in):** a REAL model
behind each scenario's Custodian — see [Model-tier testing](#model-tier-testing-adr-0066) below. **Custodian suite
(ADR-0059; opt-in, needs docker):** the Custodian's claims against the pinned Envoy image itself — the swap, the strip,
the refusals, the dial guard, SSE, abort, and the Anthropic SDK through `HTTPS_PROXY` — `just custodian-test`; not in
`pnpm -r test`. Run it before moving the Envoy pin.

## Model-tier testing (ADR-0066)

The `@model` tier is the `@kind` tier with the last fake removed: a real model endpoint behind each scenario's
Custodian. It is the only suite that can see a change in what a model DOES with what jr2 shows it, and ADR-0029/0062
measured that such changes are large (the same Allowed picks: 0/10 obeyed ahead of the prompt, 10/10 after). It never
runs in CI. **You run it.**

**When.** After any change to what the model reads or is offered, before calling the change done: the Briefing
(`packages/harness/src/briefing.ts`), the Menu's rendering or its refusal text, the nudge, the Working tools and their
descriptions, Compaction's summary, the admit body's notices, the pi pin, a provider adapter, or an authoring surface
that changes a Frame. Also before bumping pi: it is the third canary beside conformance and `@kind`. If you are
reviewing a feature or refactor that touched one of these and did not run it, say so.

**How.**

```
just e2e-kind-up                              # once; the same vanilla kind cluster @kind uses
just e2e-model                                # JR2_MODEL_ENDPOINT=homelab by default
JR2_MODEL_ENDPOINT=<name> just e2e-model      # another profile in features/model-endpoints/
```

The recipe probes the endpoint from the host first. With nothing answering it prints `skipped: no model endpoint at …`
and exits 0 — report that skip in your handoff exactly as you would a result; it is never silent and never a pass. A
key, if the endpoint wants one, rides `JR2_MODEL_API_KEY` alone and never a file. Reachability from the PODS is
`jr2 up`'s own provider preflight, per scenario.

**What it runs.** Six scenarios in `features/model.feature`, serial (the endpoint is one shared capacity). Five are
CLAIMS — an ADR's measured claim as N trials with a floor: `obedience` (Allowed picks obeyed, thinking off and on),
`advised` (a Menu-only Agent's first call is its pick), `workdir` (a relative write lands in the Worktree), `noticed` (a
memory-kill notice is acted on). One is THE RUN — `ticket`: planner, coder, reviewer, and a commit verified in the pod
(branch ahead of `main`, HEAD is the named commit, tree clean, `node --test` passes). The whole tier is about 20 minutes
on the home lab; the two Menu-only claims are a few minutes each.

**Reading the result.** Every cell is written to `features/.tmp/model-scorecard.json`, keyed by model id, and printed as
`scorecard: <model> <cell>: k/N`. Two thresholds, two meanings:

- **A floor** is in the scenario (`at least 9 trials`). Below it the scenario FAILS: a defect in what jr2 shows the
  model, or in the step. Read the failure list — each trial prints its run id and what it observed — and the pod log
  (`kubectl -n <ns> logs statefulset/jr2-instance-harness -c harness`) before touching a prompt or a floor. Do not raise
  a floor to pass; do not re-run until it passes.
- **A baseline** is committed in `features/model-baselines/<id>--<model>.json`. Below it while above the floor, the cell
  is REPORTED (`BELOW baseline`), not failed: drift, a signal to read. A 9/10 that was 10/10 is one trial; a pattern
  across cells is a regression.

Update a baseline by copying the cells from a run you have read, in the same change that explains them. The instrument
is the weakest model the kit claims to support (today the home-lab vLLM, Qwen3.6-35B-A3B); a stronger model gets its own
baseline file and must clear the same floors. It cannot lower them.

**Adding a claim.** It qualifies when an ADR states what a correct Agent does differently for it AND a step can observe
the difference from outside the pod. A workflow in `features/model-instance/workflows/`, a driver in
`features/steps/model.steps.ts`, a scenario with a floor, and the ADR's measurement as the floor's origin. The Menu-only
claims read the model's first call off the Instance Harness's printed conversation (ADR-0023) — the only place a refused
pick is visible — so they run one trial at a time; Sandbox claims read their pods and run `parallel` at once. A trial
whose SETUP never happened (the claim measures a later Turn) is `void` and replaced, a bounded number of times; it is
not a failure of the claim.

**What it is not.** Not a benchmark of the model, and not a gate in CI. A prompt in a claim workflow is fixed data:
tuning it to pass would measure the prompt. The `ticket` run never asserts the diff, the commit message or the Turn
count — those are the model's.
