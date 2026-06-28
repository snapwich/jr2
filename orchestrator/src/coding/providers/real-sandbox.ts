// REAL create-Sandbox / cleanup-Sandbox providers — fill the Sandbox-lifecycle
// slots by reconciling a `Sandbox` custom resource (core.j2.dev/v1alpha1, PoC #1
// operator) on a real cluster, then waiting for `status.endpoint`. Requires the
// operator installed + running (`just operator-install` + `just operator-run`).
//
// This is the create-Sandbox tier of the mock↔real swap: same template, the
// `createSandbox`/`cleanupSandbox` slots point at the cluster instead of the
// instant mocks.

import { fromPromise } from "xstate";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SandboxHandle, CreateSandboxInput, CleanupSandboxInput } from "../slots.ts";

const exec = promisify(execFile);

export interface RealSandboxConfig {
  namespace?: string;
  /** Primary (Harness) container image. Default: a reachable http-echo. */
  image?: string;
  /** Container port the Service targets. */
  port?: number;
  /** Max time to wait for `status.endpoint`. */
  readyTimeoutMs?: number;
}

function sandboxName(featureId: string): string {
  return `sbx-${featureId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function manifest(name: string, cfg: Required<Pick<RealSandboxConfig, "image" | "port" | "namespace">>) {
  return {
    apiVersion: "core.j2.dev/v1alpha1",
    kind: "Sandbox",
    metadata: { name, namespace: cfg.namespace },
    spec: {
      image: cfg.image,
      args: ["-listen=:" + cfg.port, "-text=hello-from-" + name],
      port: cfg.port,
      resources: { requests: { cpu: "10m", memory: "16Mi" } },
    },
  };
}

async function kubectlApply(json: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("kubectl", ["apply", "-f", "-"], { stdio: ["pipe", "ignore", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`kubectl apply exited ${code}`))));
    p.stdin.end(json);
  });
}

export function makeRealSandbox(cfg: RealSandboxConfig = {}) {
  const resolved = {
    namespace: cfg.namespace ?? "default",
    image: cfg.image ?? "hashicorp/http-echo:1.0.0",
    port: cfg.port ?? 8080,
  };
  const readyTimeoutMs = cfg.readyTimeoutMs ?? 60_000;

  return fromPromise<SandboxHandle, CreateSandboxInput>(async ({ input }) => {
    const name = sandboxName(input.featureId);
    await kubectlApply(JSON.stringify(manifest(name, resolved)));

    // Poll status.endpoint until the operator reports the Service is up.
    const deadline = Date.now() + readyTimeoutMs;
    let endpoint = "";
    while (Date.now() < deadline) {
      const { stdout } = await exec("kubectl", [
        "get",
        "sandbox",
        name,
        "-n",
        resolved.namespace,
        "-o",
        "jsonpath={.status.endpoint}",
      ]).catch(() => ({ stdout: "" }));
      if (stdout.trim()) {
        endpoint = stdout.trim();
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!endpoint) throw new Error(`Sandbox ${name} did not report status.endpoint in time`);
    console.log(`[real-sandbox] created ${name} → status.endpoint=${endpoint}`);
    return { id: name, endpoint };
  });
}

export function makeRealSandboxCleanup(cfg: RealSandboxConfig = {}) {
  const namespace = cfg.namespace ?? "default";
  return fromPromise<void, CleanupSandboxInput>(async ({ input }) => {
    await exec("kubectl", ["delete", "sandbox", input.sandbox.id, "-n", namespace, "--ignore-not-found"]).catch(
      () => {},
    );
    console.log(`[real-sandbox] deleted ${input.sandbox.id}`);
  });
}
