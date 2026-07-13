// Entrypoint for the dev Harness image (see Dockerfile). Serves the wire-compatible stub Harness
// on 0.0.0.0:8080 — the port the operator TCP-probes for readiness and fronts with the Sandbox's
// Service, so "listening" is precisely "phase: Ready".

import { startStubHarness } from "./stub-harness.ts";

const harness = await startStubHarness({ port: 8080, hostname: "0.0.0.0" });
console.log(`j2 dev harness listening on ${harness.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void harness.close().then(() => process.exit(0));
  });
}
