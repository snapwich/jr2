// The stock Harness image's PID 1 (ADR-0018/0027): env → spec → serve. Runtime construction,
// not codegen — the retired boot assembly and its readiness lag are gone; binding :8080 is the
// pod's Ready signal. Everything here is wiring: validation lives in `spec.ts`, the wire in
// `app.ts`, the turn in `turn.ts`. Fatal errors land in the pod log by throwing.

import { serve } from "@hono/node-server";
import { harnessApp } from "./app.ts";
import { dialFault, modelsFor, validateSpecModels } from "./provider.ts";
import { loadSpec } from "./spec.ts";
import { runSubmissionFor } from "./turn.ts";

function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`no ${name} in the environment — ${why}`);
  return value;
}

const spec = loadSpec(process.env);
const adapterUrl = required(
  "J2_ADAPTER_URL",
  "the Agent has no Adapter to reach, so it cannot drive its Machine (ADR-0013)",
);
const models = modelsFor(spec.harness, process.env);
// Boot-time, not first-Submission: a definition naming a model nothing serves is a fact about the
// mounted spec, and the pod log is where it belongs (ADR-0018 as amended).
validateSpecModels(spec, models);

const app = harnessApp({
  spec,
  runSubmissionFor: (seat) => runSubmissionFor({ spec, models, adapterUrl, ...seat }),
  checkDials: (dials) => dialFault(models, dials),
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080), hostname: "0.0.0.0" }, (info) => {
  console.log(`j2 harness serving ${spec.agents.length} agent(s) on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Parked long-polls hold sockets open; without severing them a graceful close outlives the
    // pod's termination grace period.
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}
