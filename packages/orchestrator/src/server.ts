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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { startInstance, type RunningInstance } from "./instance.ts";
import {
  AGENTS_CONFIGMAP,
  GIT_SSH_MOUNT,
  HARNESS_ENV_SECRET,
  IMAGES_KEY,
  IMAGES_MOUNT,
  INSTANCE_HARNESS_PORT,
  INSTANCE_HARNESS_SERVICE,
  ORCHESTRATOR_SERVICE,
} from "./names.ts";
import { startRepoReconcile, type RepoReconcile } from "./repos.ts";
import { kubectlSandbox } from "./sandbox-kubectl.ts";
import { loadSigningKey, mintInstanceToken } from "./tokens.ts";
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

  // Deployed (J2_NAMESPACE set): Adapters dial the orchestrator at its own Service DNS — stable
  // by nature, which is what lets live Sandboxes outlive orchestrator restarts (ADR-0013).
  const namespace = env.J2_NAMESPACE;

  // Resolved HERE, not left for startInstance to mint: every Sandbox Harness gets the token's
  // sha-256 as its echo gate (ADR-0023, below), so the token must exist before the first
  // provision. From the instance Secret when deployed; per-boot for a host-booted fixture,
  // exactly as before.
  const instanceToken = env.J2_INSTANCE_TOKEN ?? mintInstanceToken();

  // The data-plane switch (ADR-0012/0031): `config.repos` non-empty → reconcile the source
  // volume, then wire the kubectl Sandbox backend — a Workspace needs repos. Empty/absent → a
  // workspace-less instance (workspace() invocations fault pointedly).
  let sandbox: SandboxPort | undefined;
  let repos: RepoReconcile | undefined;
  if (config?.repos?.length) {
    const reposDir = env.J2_REPOS_DIR ?? join(opts.dir, "repos");
    const sshKeyPath = join(GIT_SSH_MOUNT, "key");
    // Started, NOT awaited (ADR-0048). A repo that cannot clone — an unregistered deploy key
    // (ADR-0047), a wrong url, a git host outage — used to throw here, exit the container, and
    // crash-loop the daemon that hosts every Workflow, including the ones that never touch a repo.
    // The same blast pattern as the images ConfigMap below: degrade the capability, not the
    // daemon. Each pass announces per repo (git's own error on a failure) and the loop keeps
    // retrying the failed ones, so the window a converge opened closes on its own.
    repos = startRepoReconcile({
      config,
      reposDir,
      creds: {
        tokenEnv: env.J2_GIT_TOKEN !== undefined ? "J2_GIT_TOKEN" : undefined,
        sshKeyPath: existsSync(sshKeyPath) ? sshKeyPath : undefined,
      },
      onSync: (sync) =>
        opts.announce(
          JSON.stringify(
            sync.error === undefined
              ? { repo: sync.name, action: sync.action }
              : { repo: sync.name, error: sync.error },
          ),
        ),
    });

    sandbox = kubectlSandbox({
      // What a repo's sync last did (ADR-0048): the attach reads `<reposDir>/<name>/default` off
      // the source volume, so a repo that never synced is the moment the degradation bites — and
      // the run that owns the consequence is the one that hears about it, by name and with git's
      // own error. The wait for the first pass moved HERE from the boot: an attach that arrives
      // while the clone is still running waits for it, instead of racing it into an empty volume.
      repoError: async (name) => {
        await repos!.first;
        return repos!.errorFor(name);
      },
      // Named here the same way AGENTS_CONFIGMAP is: a j2-owned mount path, deliberately NOT an
      // env knob — there is no image escape hatch left to configure (ADR-0038). Note what this
      // buys: the map is read per provision, so an instance whose `j2-images` ConfigMap is not yet
      // mounted still BOOTS and serves — only a provision fails, pointing at `j2 up`. That is the
      // correct blast pattern, and the stale-read window is one kubelet propagation.
      imagesPath: join(IMAGES_MOUNT, IMAGES_KEY),
      // The Harness containers' env (ADR-0018): the mounted agents spec, then the instance's own
      // valueFrom entries (literal values already live in the j2-harness-env Secret below).
      env: [
        {
          name: "J2_AGENTS_JSON",
          valueFrom: { configMapKeyRef: { name: AGENTS_CONFIGMAP, key: "agents.json" } },
        },
        // The echo gate (ADR-0023): the Harness verifies echo bearers against this sha-256. The
        // digest, never the token — the Agent executes code in the Harness container, and a
        // digest inverts to nothing (the Instance token itself never enters a Sandbox, ADR-0013).
        {
          name: "J2_ECHO_TOKEN_SHA256",
          value: createHash("sha256").update(instanceToken).digest("base64url"),
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
    });
  }

  const inst = await startInstance({
    dir: opts.dir,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    instanceToken,
    signingKey,
    sandbox,
    // The supervised reconcile (ADR-0048): its per-repo state rides the status surface, and the
    // instance's `close()` stops its retry loop.
    repos,
    // Where a Menu-only Turn runs (ADR-0031): the Instance Harness's deterministic Service DNS.
    // `j2 up` converges the Deployment behind it whenever any definition declares
    // `workspace: "none"`, so deployed, the address exists exactly when it is needed.
    instanceHarness: namespace
      ? `http://${INSTANCE_HARNESS_SERVICE}.${namespace}.svc:${INSTANCE_HARNESS_PORT}`
      : undefined,
  });
  // Resumed runs are routine and stay quiet; runs this boot did NOT resume are not, so they ride
  // the announce line (ADR-0030) — the one thing every boot prints, whatever is reading it. Without
  // this, `drifted` is only reachable by asking after a run id nobody knows to ask about.
  const { lost, drifted, failed } = inst.restored;
  opts.announce(
    JSON.stringify({
      url: inst.url,
      workflows: inst.workflows,
      ...(lost.length ? { lost } : {}),
      ...(drifted.length ? { drifted } : {}),
      ...(failed.length ? { failed } : {}),
    }),
  );
  return inst;
}
