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
//   <git.credentials[].token>
//                      each token env var the config names rides the instance Secret (ADR-0051):
//                      the Orchestrator materializes it into the Repo's credential Secret.
//
// The first stdout line is one JSON object `{ url, workflows }` — the discovery seam a fixture (or
// a human tailing pod logs) parses instead of racing the socket.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadWorkflows, startInstance, type RunningInstance } from "./instance.ts";
import {
  HARNESS_CONFIGMAP,
  HARNESS_CONFIG_KEY,
  HARNESS_ENV_SECRET,
  IMAGES_KEY,
  IMAGES_MOUNT,
  INSTANCE_HARNESS_PORT,
  INSTANCE_HARNESS_SERVICE,
  ORCHESTRATOR_SERVICE,
} from "./names.ts";
import { partsOf } from "./parts.ts";
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

  // The data-plane switch (ADR-0012/0031/0051): a registered Machine COMPOSES a Sandbox — read off
  // the same walk `j2 up` makes — and this process is deployed in a cluster → wire the kubectl
  // Sandbox backend. Otherwise an instance without a data plane (workspace() invocations fault
  // pointedly). The walk loads the same modules `startInstance` registers below; Node's module
  // cache makes them one import.
  const carried = partsOf((await loadWorkflows(opts.dir)).map((w) => w.machine));
  const dataPlane = carried.composesSandbox && namespace !== undefined;
  let sandbox: SandboxPort | undefined;
  if (dataPlane) {
    sandbox = kubectlSandbox({
      // The fence (ADR-0051): a per-run url must match one of these, or the provision refuses it.
      credentials: config?.git?.credentials ?? [],
      // Named here the same way HARNESS_CONFIGMAP is: a j2-owned mount path, deliberately NOT an
      // env knob — there is no image escape hatch left to configure (ADR-0038). Note what this
      // buys: the map is read per provision, so an instance whose `j2-images` ConfigMap is not yet
      // mounted still BOOTS and serves — only a provision fails, pointing at `j2 up`. That is the
      // correct blast pattern, and the stale-read window is one kubelet propagation.
      imagesPath: join(IMAGES_MOUNT, IMAGES_KEY),
      // The Harness containers' env (ADR-0018): what this instance can REACH (the custom provider
      // — no Agents, they ride each Turn since ADR-0049), then the instance's own valueFrom
      // entries (literal values already live in the j2-harness-env Secret below).
      env: [
        {
          name: "J2_HARNESS_JSON",
          valueFrom: { configMapKeyRef: { name: HARNESS_CONFIGMAP, key: HARNESS_CONFIG_KEY } },
        },
        // The echo gate (ADR-0023): the Harness verifies echo bearers against this sha-256. The
        // digest, never the token — the Agent executes code in the Harness container, and a
        // digest inverts to nothing (the Instance token itself never enters a Sandbox, ADR-0013).
        {
          name: "J2_ECHO_TOKEN_SHA256",
          value: createHash("sha256").update(instanceToken).digest("base64url"),
        },
        ...(config?.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
      ],
      envFrom: [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(config?.harness?.envFrom ?? [])],
      // Presence only — the PEM itself was materialized into the j2-ca ConfigMap by `j2 up`
      // (ADR-0020); the in-cluster config eval never reads the file.
      caBundle: config?.harness?.caBundle !== undefined,
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
    dataPlane,
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
