// The provider preflight's check (ADR-0019, ADR-0059): `jr2 up` runs this file in the stock
// Harness image, in the check pod beside a Custodian, with the Harness container's env — the
// harness config, `harness.env` and `harness.envFrom`, a Stand-in for each held model key, the
// proxy and the trust. So each model resolves and is called as a Turn calls it: pi's catalog and
// its api, the `harness.catalog` gateway, and the Custodian that swaps the key in toward the bound
// host. The key itself never reaches this process.
//
// The argv is the model specifiers to check, each one in turn, then `--mcp` and the remote MCP
// servers to list (ADR-0079), each one in turn. Two lines per model and per server on stdout
// (`preflight-line.ts`): a start, then a verdict, which `jr2 up` reads as they come. A server's
// verdict is its tool list: `jr2 up` holds the allowlists, and compares. The server's url and the
// name of its secret come from the harness config's `mcp`, as a Turn's do; the bearer is the
// Stand-in of that secret, in env, which the Custodian swaps for the value. The exit is 1 when any
// model's or server's verdict is `fault`.

import { listMcpTools } from "./mcp-list.ts";
import {
  mcpPreflightLine,
  mcpPreflightStart,
  PREFLIGHT_MCP_ARG,
  PREFLIGHT_MCP_BUDGET_SECONDS,
  PREFLIGHT_MODEL_BUDGET_SECONDS,
  preflightLine,
  preflightStart,
  type McpPreflightVerdict,
  type PreflightVerdict,
} from "./preflight-line.ts";
import { modelsFor, checkModel } from "./provider.ts";
import { loadHarnessSpec, type HarnessSpec } from "./spec.ts";

/** Each model's whole budget (`PREFLIGHT_MODEL_BUDGET_SECONDS`): past it the model is a fault, and
 * the next model has its own budget, so one slow model never uses the time of the others. */
const MODEL_BUDGET_MS = PREFLIGHT_MODEL_BUDGET_SECONDS * 1000;

const argv = process.argv.slice(2);
const cut = argv.indexOf(PREFLIGHT_MCP_ARG);
const specifiers = cut < 0 ? argv : argv.slice(0, cut);
const servers = cut < 0 ? [] : argv.slice(cut + 1);
const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The registry is built from the harness config before any check: a config this Harness cannot
// run (an api it does not speak, a catalog id pi does not have) is each model's fault, in words,
// not a stack trace that the reader cannot tell from a crash.
let spec: HarnessSpec | undefined;
let models: ReturnType<typeof modelsFor> | undefined;
let refused: string | undefined;
try {
  spec = loadHarnessSpec(process.env);
  models = modelsFor(spec, process.env);
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
for (const name of servers) {
  console.log(mcpPreflightStart(name));
  const verdict = await checkMcpServer(name);
  console.log(mcpPreflightLine(name, verdict));
  if (verdict.kind === "fault") failed = true;
}
process.exitCode = failed ? 1 : 0;

/** One server's listing, through this pod's proxy, with the Stand-in of its secret. */
async function checkMcpServer(name: string): Promise<McpPreflightVerdict> {
  if (!spec) return { kind: "fault", reason: refused! };
  const server = Object.hasOwn(spec.mcp ?? {}, name) ? spec.mcp![name]! : undefined;
  if (server === undefined || !("url" in server)) {
    return { kind: "fault", reason: `the harness config has no remote MCP server "${name}" — a jr2 defect` };
  }
  const standIn = server.secret === undefined ? undefined : process.env[server.secret];
  if (server.secret !== undefined && !standIn) {
    return { kind: "fault", reason: `the check pod holds no Stand-in of ${server.secret} — a jr2 defect` };
  }
  const budget = AbortSignal.timeout(PREFLIGHT_MCP_BUDGET_SECONDS * 1000);
  const listing = await listMcpTools(server.url, standIn, { signal: budget });
  if (listing.kind === "listed") return listing;
  if (listing.kind === "refused") return { kind: "refused", reason: String(listing.status) };
  const why = budget.aborted ? `no answer in ${PREFLIGHT_MCP_BUDGET_SECONDS} s, the server's whole time` : listing.why;
  return { kind: "warn", reason: why };
}
