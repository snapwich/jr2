// j2 Orchestrator entrypoint — runs in its own pod, interprets a Machine, and
// drives Agents on remote Harnesses via a flue client.
//
// This is deliberately THIN: it wires durable infrastructure (the MCP control
// plane, the Postgres snapshot store, the reconcile ports) and hands off to
// `runOrchestrator` (durability.ts), which owns crash/restore/re-attach. The seam
// is shared with #8, so the meat stays out of here.
//
// A restart is just re-running this process with the SAME RUN_ID against the SAME
// Postgres: it loads the persisted snapshot, reconciles, and re-attaches to the
// in-flight Agent run by `(name, instanceId) + offset` — it does not restart the
// run. The control plane binds a FIXED port so the Harness reaches the same ingress
// address across restarts. (PoC #7.)

import { ControlPlane } from "./control-plane.ts";
import { PgSnapshotStore } from "./snapshot-store.ts";
import { runOrchestrator } from "./durability.ts";
import { flueRunLiveness, kubectlSandboxChecker, noopSandboxChecker, noopWorkSourceLease } from "./reconcile.ts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const runId = env("RUN_ID");
  const agentName = env("AGENT", "worker");
  const instanceId = env("INSTANCE_ID");
  const harnessBase = env("HARNESS_BASE", "http://localhost:8092");
  const prompt = process.env.PROMPT; // only used on a FRESH start
  const cpHost = env("CP_HOST", "127.0.0.1");
  const cpPort = Number(env("CP_PORT", "8391"));
  const sandboxName = process.env.SANDBOX_NAME; // omit → skip the Sandbox reconcile axis
  const kubeContext = env("KUBE_CONTEXT", "kind-j2"); // pinned; never the home cluster
  const approveDelayMs = process.env.APPROVE_DELAY_MS ? Number(process.env.APPROVE_DELAY_MS) : undefined;

  const controlPlane = new ControlPlane({ host: cpHost, port: cpPort });
  await controlPlane.start();
  console.log(
    `[orchestrator] control plane (Sandbox→Orchestrator ingress) on ${controlPlane.mcpUrlFor("<instanceId>")}`,
  );

  const store = new PgSnapshotStore({
    host: env("PGHOST", "127.0.0.1"),
    port: Number(env("PGPORT", "5433")),
    user: env("PGUSER", "postgres"),
    password: env("PGPASSWORD", "postgres"),
    database: env("PGDATABASE", "postgres"),
    // Fail a stuck connect fast so init()'s retry loop can re-attempt, rather than
    // hanging the whole restart on one socket.
    connectionTimeoutMillis: 3000,
  });
  await store.init();

  const result = await runOrchestrator({
    store,
    controlPlane,
    runId,
    input: { controlPlane, harnessBase, agentName, instanceId, prompt },
    sandboxName,
    reconcileDeps: {
      sandbox: sandboxName ? kubectlSandboxChecker({ context: kubeContext }) : noopSandboxChecker,
      lease: noopWorkSourceLease,
      liveness: flueRunLiveness(harnessBase),
    },
    decision: approveDelayMs !== undefined ? { autoApproveAfterMs: approveDelayMs } : undefined,
  });

  if (result.outcome === "lost") {
    console.log(`[orchestrator] run '${runId}' stood down: ${result.reason}`);
    await controlPlane.stop();
    await store.close();
    process.exit(3);
  }

  const outcome = await result.done;
  console.log(`[orchestrator] run '${runId}' finished: ${outcome}`);
  await controlPlane.stop();
  await store.close();
  process.exit(outcome === "done" ? 0 : 1);
}

main().catch((e) => {
  console.error("[orchestrator] crashed:", e);
  process.exit(2);
});
