// The provider preflight's check (ADR-0019, ADR-0059): `jr2 up` runs this file in the stock
// Harness image, in the check pod beside a Custodian, with the Harness container's env — the
// harness config, `harness.env` and `harness.envFrom`, a Stand-in for each held model key, the
// proxy and the trust. So each model resolves and is called as a Turn calls it: pi's catalog and
// its api, the `harness.catalog` gateway, and the Custodian that swaps the key in toward the bound
// host. The key itself never reaches this process.
//
// The argv is the model specifiers to check, each one in turn. Two lines per model on stdout
// (`preflight-line.ts`): a start, then a verdict, which `jr2 up` reads as they come. The exit is 1
// when any model's verdict is `fault`.

import {
  PREFLIGHT_MODEL_BUDGET_SECONDS,
  preflightLine,
  preflightStart,
  type PreflightVerdict,
} from "./preflight-line.ts";
import { modelsFor, checkModel } from "./provider.ts";
import { loadHarnessSpec } from "./spec.ts";

/** Each model's whole budget (`PREFLIGHT_MODEL_BUDGET_SECONDS`): past it the model is a fault, and
 * the next model has its own budget, so one slow model never uses the time of the others. */
const MODEL_BUDGET_MS = PREFLIGHT_MODEL_BUDGET_SECONDS * 1000;

const specifiers = process.argv.slice(2);
const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The registry is built from the harness config before any check: a config this Harness cannot
// run (an api it does not speak, a catalog id pi does not have) is each model's fault, in words,
// not a stack trace that the reader cannot tell from a crash.
let models: ReturnType<typeof modelsFor> | undefined;
let refused: string | undefined;
try {
  models = modelsFor(loadHarnessSpec(process.env), process.env);
} catch (err) {
  refused = `the Harness cannot run this config: ${said(err)}`;
}
let failed = false;
for (const specifier of specifiers) {
  console.log(preflightStart(specifier));
  let verdict: PreflightVerdict;
  if (!models) {
    verdict = { kind: "fault", reason: refused! };
  } else {
    const budget = AbortSignal.timeout(MODEL_BUDGET_MS);
    verdict = await checkModel(models, specifier, { signal: budget }).catch(
      (err: unknown): PreflightVerdict => ({ kind: "fault", reason: said(err) }),
    );
    if (budget.aborted && verdict.kind === "fault") {
      verdict = { kind: "fault", reason: `no verdict in ${MODEL_BUDGET_MS / 1000} s, the model's whole time` };
    }
  }
  console.log(preflightLine(specifier, verdict));
  if (verdict.kind === "fault") failed = true;
}
process.exitCode = failed ? 1 : 0;
