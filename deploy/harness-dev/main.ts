// Entrypoint for the dev Harness image (see Dockerfile). Serves the wire-compatible stub Harness
// on 0.0.0.0:8080 — the port the operator TCP-probes for readiness and fronts with the Sandbox's
// Service, so "listening" is precisely "phase: Ready".
//
// Unlike the in-process stub `j2 dev` hosts, this one HAS an Agent: `playAgent` (ADR-0013). That
// is the whole difference between the two tiers — the mechanics tier plays the agent from outside,
// the kind tier makes the pod do it, through the Adapter on localhost.

import { startStubHarness } from "./stub-harness.ts";
import { playAgent } from "./agent.ts";

const harness = await startStubHarness({ port: 8080, hostname: "0.0.0.0", onAdmit: playAgent });
console.log(`j2 dev harness listening on ${harness.url} (adapter: ${process.env.J2_ADAPTER_URL ?? "unset"})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void harness.close().then(() => process.exit(0));
  });
}
