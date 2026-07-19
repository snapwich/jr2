// The deployed orchestrator's entrypoint (ADR-0019): the process the instance image runs — and, by
// the same token, the e2e tier's per-scenario fixture (ADR-0010 boots exactly this process on the
// host). Configuration is env, kube-style; the instance folder is the process cwd (the image bakes
// engine + `workflows/` there, ADR-0008). No dev.json, no hot-reload, no stub Harness: those were
// host-dev affordances, and there is no host dev mode.
//
//   PORT               listen port (default 4000 — what the Service targets)
//   HOST               listen hostname (default 0.0.0.0: pods must be reachable off-loopback)
//   J2_INSTANCE_TOKEN  the Instance credential (ADR-0013), from the instance's Secret; minted
//                      per boot when absent (then only the announce line knows it — fixtures set it)
//   J2_SIGNING_KEY     base64 key Sandbox tokens are signed with; from the Secret so live Sandboxes
//                      survive a pod restart. Absent → minted into `<dir>/.j2/secret` (dev-grade).
//   J2_NAMESPACE       the pod's own namespace (Deployment fieldRef) — presence = "deployed":
//                      Sandboxes are driven in it, and the Adapters' route home is Service DNS.
//   J2_REPOS_DIR       the source volume the boot reconcile populates (default `<dir>/repos`).
//   J2_GIT_TOKEN       HTTPS token for private repo fetches (from the instance Secret, ADR-0019).
//
// The first stdout line is one JSON object `{ url, workflows }` — the discovery seam a fixture (or
// a human tailing pod logs) parses instead of racing the socket.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { DEFAULT_ADAPTER_IMAGE, DEFAULT_HARNESS_IMAGE } from "./config.ts";
import { startInstance, type RunningInstance } from "./instance.ts";
import { AGENTS_CONFIGMAP, GIT_SSH_MOUNT, HARNESS_ENV_SECRET, ORCHESTRATOR_SERVICE } from "./names.ts";
import { ensureRepos } from "./repos.ts";
import { kubectlSandbox } from "./sandbox-kubectl.ts";
import { loadSigningKey } from "./tokens.ts";
import type { SandboxPort } from "./workspace.ts";

export type ServerMainOptions = {
  /** The instance folder (deployed: the image's WORKDIR; fixtures: a temp instance). */
  dir: string;
  /** The environment to read the contract above from (deployed: `process.env`). */
  env: Record<string, string | undefined>;
  /** Where the one-line JSON announcement goes (deployed: stdout). */
  announce: (line: string) => void;
};

/** Boot the instance the env describes; resolves once serving (the caller owns signals/exit). */
export async function serverMain(opts: ServerMainOptions): Promise<RunningInstance> {
  const { env } = opts;
  const config = await loadConfig(opts.dir);
  const port = env.PORT !== undefined ? Number(env.PORT) : 4000;
  const signingKey =
    env.J2_SIGNING_KEY !== undefined ? Buffer.from(env.J2_SIGNING_KEY, "base64") : await loadSigningKey(opts.dir);

  // The data-plane switch (ADR-0012): `config.sandbox` present → reconcile the source volume,
  // then wire the kubectl Sandbox backend. Absent → a workspace-less instance (workspace()
  // invocations fault pointedly).
  let sandbox: SandboxPort | undefined;
  if (config?.sandbox) {
    const reposDir = env.J2_REPOS_DIR ?? join(opts.dir, "repos");
    const sshKeyPath = join(GIT_SSH_MOUNT, "key");
    const synced = await ensureRepos(config, reposDir, undefined, {
      tokenEnv: env.J2_GIT_TOKEN !== undefined ? "J2_GIT_TOKEN" : undefined,
      sshKeyPath: existsSync(sshKeyPath) ? sshKeyPath : undefined,
    });
    for (const repo of synced) opts.announce(JSON.stringify({ repo: repo.name, action: repo.action }));

    // Deployed (J2_NAMESPACE set): Adapters dial the orchestrator at its own Service DNS — stable
    // by nature, which is what lets live Sandboxes outlive orchestrator restarts (ADR-0013).
    const namespace = env.J2_NAMESPACE;
    sandbox = kubectlSandbox({
      image: config.sandbox.image ?? DEFAULT_HARNESS_IMAGE,
      adapterImage: config.sandbox.adapterImage ?? DEFAULT_ADAPTER_IMAGE,
      userImage: config.sandbox.userImage,
      // The Harness containers' env (ADR-0018): the mounted agents spec, then the instance's own
      // valueFrom entries (literal values already live in the j2-harness-env Secret below).
      env: [
        {
          name: "J2_AGENTS_JSON",
          valueFrom: { configMapKeyRef: { name: AGENTS_CONFIGMAP, key: "agents.json" } },
        },
        ...(config.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
      ],
      envFrom: [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(config.harness?.envFrom ?? [])],
      // Presence only — the PEM itself was materialized into the j2-ca ConfigMap by `j2 up`
      // (ADR-0020); the in-cluster config eval never reads the file.
      caBundle: config.harness?.caBundle !== undefined,
      orchestratorUrl: namespace ? `http://${ORCHESTRATOR_SERVICE}.${namespace}.svc:${port}` : undefined,
      signingKey,
      namespace,
      idleTimeout: config.sandbox.idleTimeout,
    });
  }

  const inst = await startInstance({
    dir: opts.dir,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    instanceToken: env.J2_INSTANCE_TOKEN,
    signingKey,
    sandbox,
  });
  opts.announce(JSON.stringify({ url: inst.url, workflows: inst.workflows }));
  return inst;
}
