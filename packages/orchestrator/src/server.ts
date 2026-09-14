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
// a human tailing pod logs) parses instead of racing the socket. Deployed with a data plane, the
// boot then creates one `Repo` resource per identity its Machines bind (ADR-0051) and announces
// each as `{ repo, url, bound: true }` — or `{ repo, error }` — one line apiece, after serving:
// a Repo the cluster refuses is a degraded Repo (ADR-0048), never a boot that did not happen.
// Deployed WITHOUT one, the same pass still runs and binds nothing, which unlabels every Repo a
// previous deploy bound — an Instance that drops its last `workspace()` leaves `j2 gc` able to
// collect what it stopped using.

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
import { partsOf, type CarriedRepo } from "./parts.ts";
import { kubectlRepoFetches, type RepoFetches } from "./repo-fetch.ts";
import { kubectlRepos, type RepoResources } from "./repos.ts";
import { kubectlSandbox, type KubectlExec } from "./sandbox-kubectl.ts";
import { loadSigningKey, mintInstanceToken } from "./tokens.ts";
import type { SandboxPort } from "./workspace.ts";

export type ServerMainOptions = {
  /** The instance folder (deployed: the image's WORKDIR; fixtures: a temp instance). */
  dir: string;
  /** The environment to read the contract above from (deployed: `process.env`). */
  env: Record<string, string | undefined>;
  /** Where the one-line JSON announcement goes (deployed: stdout). */
  announce: (line: string) => void;
  /** The kubectl process seam behind the data plane's two ports, injectable for tests.
   * Deployed: the `kubectl` on PATH. */
  exec?: KubectlExec;
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
  let repos: RepoResources | undefined;
  let fetches: RepoFetches | undefined;
  // The Repo port hangs off DEPLOYED, not off the data plane: this boot's reconcile is the only
  // writer that ever REMOVES `j2.dev/bound` (repos.ts), and an Instance that drops its last
  // `workspace()` still owns the Repos its earlier deploys bound. So the port is built whenever
  // there is a cluster to drive, and the walk — now naming nothing — unlabels every one of them,
  // which is what puts them on `j2 gc`'s clock. Gate it on the data plane instead and they stay
  // bound forever: uncollectable resources, with their node caches behind them.
  if (namespace !== undefined) {
    const credentials = config?.git?.credentials ?? [];
    // The Repo resources (ADR-0051): created by this process, cloned by the operator's cache agent
    // on every node that needs them. The port resolves `git.credentials` into each resource's
    // `secretRef`, reading a token entry's env var off this process — the Instance Secret is
    // `envFrom` on the Deployment, so `j2 up` is what put it there.
    repos = kubectlRepos({ namespace, credentials, env, ...(opts.exec ? { exec: opts.exec } : {}) });
    if (dataPlane) {
      // The ask a pod makes when something inside it fetches (ADR-0053): it marks the Sandbox CR
      // and waits on the same status the provision waits on. Gated on the DATA PLANE, unlike the
      // Repo port above — there is nothing to ask for where no Sandbox is ever composed, and the
      // only caller is a pod that would have to exist to call it.
      fetches = kubectlRepoFetches({ namespace, ...(opts.exec ? { exec: opts.exec } : {}) });
      sandbox = kubectlSandbox({
        // The fence (ADR-0051): a per-run url must match one of these, or the provision refuses it.
        credentials,
        // Where a provision records the Repos it names, before the CR names them.
        repos,
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
        // Which nodes are Sandbox nodes (ADR-0052) — the CR carries it, the operator reads no config.
        ...(config?.sandbox ? { placement: config.sandbox } : {}),
        orchestratorUrl: `http://${ORCHESTRATOR_SERVICE}.${namespace}.svc:${port}`,
        signingKey,
        namespace,
        ...(opts.exec ? { exec: opts.exec } : {}),
      });
    }
  }

  const inst = await startInstance({
    dir: opts.dir,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    instanceToken,
    signingKey,
    sandbox,
    dataPlane,
    // Read per request, never snapshotted: the Repos as the cluster reports them right now. An
    // instance without a data plane reports none — `GET /repos` answers `{ dataPlane: false,
    // repos: [] }` (http.ts), and what its dropped Machines left behind is `j2 gc`'s to name.
    ...(dataPlane && repos ? { repos: () => repos.list() } : {}),
    // The pod's route out (ADR-0053), same shape: read per request, off the port.
    ...(fetches ? { fetchRepo: (name: string, identity: string) => fetches.fetch(name, identity) } : {}),
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
  // After serving, never awaited: the bound Repos' resources (ADR-0051). Serving does not wait on
  // the cluster — a run whose Repo the boot could not record still finds its provision ensuring
  // it again — and a refusal is one announced line per Repo, in ADR-0048's shape. A deployed
  // instance that binds nothing still runs this: the walk names no Repo, so the reconcile is the
  // whole of it, and every resource an earlier deploy bound becomes evictable.
  if (repos) void ensureBound(repos, carried.repos, opts.announce);
  return inst;
}

/**
 * The boot's half of ADR-0051's "the Orchestrator creates Repo resources": one per identity the
 * registered Machines bind, so statically known repositories are KNOWN before a run asks (the
 * cache agent probes each; a node clones on first demand) — then
 * the bound label reconciled, so a slot unbound since the last deploy is a Repo `j2 gc` may
 * evict. The boot is the ONE writer of a bound resource's spec: a redeploy that moved a url or a
 * credential restates it here, and no provision does. Sequential, and each failure its own
 * line: a wrong url on one Machine must not hide the others.
 */
async function ensureBound(
  repos: RepoResources,
  bound: CarriedRepo[],
  announce: (line: string) => void,
): Promise<void> {
  for (const repo of bound) {
    try {
      await repos.bind({ url: repo.url, identity: repo.identity, key: repo.key });
      announce(JSON.stringify({ repo: repo.key, url: repo.url, bound: true }));
    } catch (err) {
      announce(JSON.stringify({ repo: repo.key, url: repo.url, error: (err as Error).message }));
    }
  }
  try {
    await repos.reconcileBound(bound.map((r) => r.key));
  } catch (err) {
    announce(JSON.stringify({ repos: bound.map((r) => r.key), error: (err as Error).message }));
  }
}
