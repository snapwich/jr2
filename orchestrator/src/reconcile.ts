// Restore-time reconciliation (PoC #7).
//
// A restored snapshot is a claim about a world that kept moving while the
// Orchestrator was dead. Before trusting it and re-attaching, reconcile against
// the live world along three axes:
//
//   1. Sandbox CR     — does the Sandbox the run expected still exist / is it Ready?
//                       (kubectl against the operator's `core.j2.dev/Sandbox`.)
//   2. Work Source     — re-assert any claimed lease. Thin here (driveMachine has no
//                       Work Source) — the hook is designed and stubbed for #6/#8.
//   3. In-flight run   — is the Agent run still live on its Harness (so re-attach by
//                       `(name, instanceId) + offset` is meaningful, not a corpse)?
//
// Each axis is a small PORT so #8 can supply real implementations without this
// module assuming driveMachine's shape. `reconcile()` composes them into a single
// proceed | lost decision; `durability.ts` acts on it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFlueClient } from "@flue/sdk";

const execFileP = promisify(execFile);

// --- Sandbox CR -------------------------------------------------------------

export interface SandboxStatus {
  exists: boolean;
  /** True when the operator has populated status (status.endpoint set). */
  ready: boolean;
}

export interface SandboxChecker {
  check(name: string): Promise<SandboxStatus>;
}

/**
 * Real checker: `kubectl get sandbox <name>` against a PINNED context. We pin the
 * context (default `kind-j2`) so reconcile can never reach a production/home
 * cluster — a durability probe must not touch anything but its own kind cluster.
 */
export function kubectlSandboxChecker(opts: { context: string; namespace?: string }): SandboxChecker {
  const ns = opts.namespace ?? "default";
  return {
    async check(name: string): Promise<SandboxStatus> {
      try {
        const { stdout } = await execFileP("kubectl", [
          "--context",
          opts.context,
          "-n",
          ns,
          "get",
          "sandbox",
          name,
          "-o",
          "json",
        ]);
        const cr = JSON.parse(stdout) as { status?: { endpoint?: string } };
        return { exists: true, ready: cr.status?.endpoint != null };
      } catch {
        // NotFound (or any kubectl failure) → treat as absent. The defined failure
        // path keys off `exists`, so a flaky kubectl degrades to "can't confirm" →
        // lost, which is the safe direction (we do not blindly re-attach).
        return { exists: false, ready: false };
      }
    },
  };
}

/** Always-present checker — used where a run has no Sandbox dependency (e.g. tests). */
export const noopSandboxChecker: SandboxChecker = {
  check: async () => ({ exists: true, ready: true }),
};

// --- Work Source lease ------------------------------------------------------

export interface WorkSourceLease {
  /** Re-assert the lease the dead Orchestrator held. False ⇒ lease lost ⇒ stand down. */
  reassert(): Promise<boolean>;
}

/** driveMachine claims no work, so the lease always re-asserts. #6 supplies the real port. */
export const noopWorkSourceLease: WorkSourceLease = { reassert: async () => true };

// --- In-flight run liveness -------------------------------------------------

export interface RunLiveness {
  /** Best-effort: is `(agentName, instanceId)` a real, readable run on the Harness? */
  isLive(agentName: string, instanceId: string, offset?: string): Promise<boolean>;
}

/**
 * Probe the Harness by doing a bounded catch-up read of the Agent's Durable Stream.
 * Any event ⇒ the run exists (history is replayable from its offset). An unknown
 * instance yields no events / errors ⇒ not live. This is also the lever for the
 * crash-between-admit-and-persist edge: if we have a prompt but no persisted offset,
 * a live probe means the prior submission DID land, so we re-attach instead of
 * re-POSTing (which flue would treat as a duplicate next turn).
 */
export function flueRunLiveness(harnessBase: string, timeoutMs = 4000): RunLiveness {
  return {
    async isLive(agentName: string, instanceId: string, offset = "-1"): Promise<boolean> {
      const client = createFlueClient({ baseUrl: harnessBase });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort("liveness probe timeout"), timeoutMs);
      try {
        const stream = client.agents.stream(agentName, instanceId, {
          offset,
          live: false, // catch-up read only — do not tail
          signal: abort.signal,
        });
        for await (const _e of stream) {
          return true; // first event proves the run exists
        }
        return false; // empty stream → no such run
      } catch {
        return false; // unknown instance / transport error → treat as not live
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// --- Composition ------------------------------------------------------------

export interface ReconcileContext {
  agentName: string;
  instanceId: string;
  offset?: string;
  /** Name of the Sandbox CR this run expects. Omit to skip the Sandbox axis. */
  sandboxName?: string;
}

export interface ReconcileDeps {
  sandbox: SandboxChecker;
  lease: WorkSourceLease;
  liveness: RunLiveness;
  /** When true, require status Ready (not just existence). Default false. */
  requireSandboxReady?: boolean;
}

export type ReconcileResult = { outcome: "proceed" } | { outcome: "lost"; reason: string };

export async function reconcile(ctx: ReconcileContext, deps: ReconcileDeps): Promise<ReconcileResult> {
  // 1. Sandbox CR — if the run named one and it is gone, the run cannot be re-attached.
  if (ctx.sandboxName) {
    const sb = await deps.sandbox.check(ctx.sandboxName);
    if (!sb.exists) return { outcome: "lost", reason: `Sandbox CR '${ctx.sandboxName}' absent` };
    if (deps.requireSandboxReady && !sb.ready)
      return { outcome: "lost", reason: `Sandbox CR '${ctx.sandboxName}' not Ready` };
  }

  // 2. Work Source lease — stand down if another Orchestrator grabbed it while we were dead.
  if (!(await deps.lease.reassert())) return { outcome: "lost", reason: "work-source lease lost" };

  // 3. In-flight run — only re-attach to a run that is actually still live.
  if (ctx.offset) {
    const live = await deps.liveness.isLive(ctx.agentName, ctx.instanceId, ctx.offset);
    if (!live) return { outcome: "lost", reason: "in-flight run no longer live on Harness" };
  }

  return { outcome: "proceed" };
}
