// The Adapter container's entrypoint (ADR-0013). Everything it needs arrives as env, and the two
// halves of that env are the security boundary:
//
//   J2_ORCHESTRATOR_URL   where the control plane is, from inside the pod
//   J2_SANDBOX_TOKEN      the credential — from a Secret the CR mounts into THIS container ALONE
//
// The Harness container next door gets neither. It gets `J2_ADAPTER_URL`, which points at this
// process on `localhost`. That asymmetry is the entire enforcement: the Agent has code execution
// where the credential is not.

import { startAdapter } from "./serve.ts";
import { OrchestratorClient } from "./adapter.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`the Adapter needs ${name} (set by the Sandbox CR — ADR-0013)`);
  return value;
}

const orchestrator = new OrchestratorClient({
  url: required("J2_ORCHESTRATOR_URL"),
  token: required("J2_SANDBOX_TOKEN"),
});

const adapter = await startAdapter({
  orchestrator,
  port: Number(process.env.J2_ADAPTER_PORT ?? 8081),
  // The Agent is in this pod (shared network namespace), so loopback is all that is ever needed —
  // and all that should ever be reachable.
  hostname: "127.0.0.1",
});

console.log(`j2 adapter serving ${adapter.url}/mcp/<instanceId> for sandbox ${process.env.J2_SANDBOX ?? "?"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void adapter.close().then(() => process.exit(0));
  });
}
