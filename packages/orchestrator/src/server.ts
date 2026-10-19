// The deployed orchestrator's entrypoint (ADR-0019): the process the Orchestrator Kit image runs
// — and, by the same token, the e2e tier's per-scenario fixture (ADR-0010 boots exactly this
// process on the host). Configuration is env, kube-style; the instance folder is the process cwd.
// The Kit image holds the engine there and nothing of any Instance (ADR-0069): the Workflows and
// `jr2.config.ts` are the CURRENT ASSEMBLY's, which `jr2 up` publishes onto the state volume
// (assembly.ts). The folder the process starts in is never loaded: a host-booted fixture publishes
// through the same door. No dev.json, no stub Harness: those were host-dev affordances, and there
// is no host dev mode.
//
//   PORT               listen port (default 4000 — what the Service targets)
//   HOST               listen hostname (default 0.0.0.0: pods must be reachable off-loopback)
//   JR2_INSTANCE_TOKEN  the Instance credential (ADR-0013), from the instance's Secret; minted
//                      per boot when absent (then only the announce line knows it — fixtures set it)
//   JR2_PUBLISH_TOKEN   the publish credential (ADR-0069): `PUT /assembly` alone accepts it. From
//                      the same Secret; minted per boot when absent, so no host-booted process has
//                      a publish door anyone outside it can open.
//   JR2_SIGNING_KEY     base64 key Sandbox tokens are signed with; from the Secret so live Sandboxes
//                      survive a pod restart. Absent → minted into `<dir>/.jr2/secret` (dev-grade).
//   JR2_NAMESPACE       the pod's own namespace (Deployment fieldRef) — presence = "deployed":
//                      Sandboxes are driven in it, and the Custodians' route home is Service DNS.
//
// No git token reaches this process (ADR-0068): `jr2 up` writes each entry's clone Secret, and
// the Repo port names it from `git-clone.json` in the `jr2-held` mount.
//
// The first stdout line is one JSON object `{ url, workflows, assembly, kitVersion }` — the
// discovery seam a fixture (or a human tailing pod logs) parses instead of racing the socket.
// `assembly` is the current Assembly's hash, or `null` with `assemblyError` saying why when the
// volume named one this process cannot load. A boot with no current Assembly also names the live
// runs it left `waiting` for the first publish, which restores them and announces what it did as
// one more line, `{ assembly, lost?, drifted?, failed? }`, when any run was not resumed.
// Deployed, the boot then creates one `Repo` resource per identity its Machines bind (ADR-0051)
// and announces each as `{ repo, url, bound: true }` — or `{ repo, error }` — one line apiece,
// after serving: a Repo the cluster refuses is a degraded Repo (ADR-0048), never a boot that did
// not happen. An Assembly that binds none still runs the same pass and binds nothing, which
// unlabels every Repo a previous deploy bound — an Instance that drops its last `workspace()`
// leaves `jr2 gc` able to collect what it stopped using. Each publish runs the pass again. With no
// current Assembly there is no pass: nothing says what is bound, and the next publish decides.

import { join } from "node:path";
import { resolveAssembly, type ResolvedAssembly } from "./assembly.ts";
import { KIT_VERSION, loadConfig, type JR2Config } from "./config.ts";
import { readImageRefs } from "./images.ts";
import { readMountDigests } from "./mount-digest.ts";
import { GIT_CLONE_MANIFEST_KEY, readGitCloneManifest } from "./git-clone.ts";
import { loadWorkflows, startInstance, type RunningInstance } from "./instance.ts";
import {
  HARNESS_CONFIGMAP,
  HARNESS_CONFIG_KEY,
  HARNESS_ENV_SECRET,
  HELD_MOUNT,
  IMAGES_KEY,
  IMAGES_MOUNT,
  INSTANCE_HARNESS_PORT,
  INSTANCE_HARNESS_SERVICE,
  INSTANCE_EFFECTOR,
  EFFECTOR_PORT,
} from "./names.ts";
import { partsOf, type CarriedRepo } from "./parts.ts";
import { kubeClient, type KubeClient } from "./kube-client.ts";
import { kubeRepoFetches, type RepoFetches } from "./repo-fetch.ts";
import { kubeRepos, type RepoResources } from "./repos.ts";
import { SANDBOX_EFFECTOR_PORT, kubeSandbox } from "./sandbox-kube.ts";
import { sandboxEffectorService } from "./sandbox-effector.ts";
import { watchSandboxes, type SandboxWatch } from "./sandbox-watch.ts";
import { loadSigningKey, mintInstanceToken } from "./tokens.ts";
import type { SandboxPort } from "./workspace.ts";

export type ServerMainOptions = {
  /** The instance folder (deployed: the image's WORKDIR, with the state volume at `.jr2`;
   * fixtures: a temp instance, whose `.jr2` receives what the fixture publishes). */
  dir: string;
  /** The environment to read the contract above from (deployed: `process.env`). */
  env: Record<string, string | undefined>;
  /** Where the one-line JSON announcement goes (deployed: stdout). */
  announce: (line: string) => void;
  /** The Kubernetes client behind the data plane's ports (ADR-0063), injectable for tests.
   * Deployed: the in-cluster client over the Pod's ServiceAccount. */
  kube?: KubeClient;
};

/** Boot the instance the env describes; resolves once serving (the caller owns signals/exit). */
export async function serverMain(opts: ServerMainOptions): Promise<RunningInstance> {
  const { env } = opts;
  const port = env.PORT !== undefined ? Number(env.PORT) : 4000;
  const signingKey =
    env.JR2_SIGNING_KEY !== undefined ? Buffer.from(env.JR2_SIGNING_KEY, "base64") : await loadSigningKey(opts.dir);

  // Deployed (JR2_NAMESPACE set): Custodians dial the orchestrator at its own Service DNS — stable
  // by nature, which is what lets live Sandboxes outlive orchestrator restarts (ADR-0013). `jr2 up`
  // writes that address into the Custodian's bootstrap; nothing here passes it on.
  const namespace = env.JR2_NAMESPACE;

  // From the instance Secret when deployed; per-boot for a host-booted fixture.
  const instanceToken = env.JR2_INSTANCE_TOKEN ?? mintInstanceToken();
  const publishToken = env.JR2_PUBLISH_TOKEN ?? mintInstanceToken();

  // The current Assembly (ADR-0069), and its config and Workflows read from its ROOT, never from
  // the folder directly. A published Assembly that does not load (a Kit bump that broke an import,
  // say) is no current Assembly: the process serves and says why (ADR-0048).
  let resolved: ResolvedAssembly = await resolveAssembly(opts.dir);
  // The config that applies is ALWAYS the current Assembly's (ADR-0069): the ports read it through
  // this binding, and a publish replaces it.
  let config: JR2Config | undefined;
  let carried = partsOf([]);
  if (resolved.current) {
    const current = resolved.current;
    try {
      config = await loadConfig(current.root);
      carried = partsOf((await loadWorkflows(current.root)).map((w) => w.machine));
    } catch (err) {
      config = undefined;
      resolved = {
        current: null,
        error: `the current Assembly ${current.hash} does not load: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  // The data plane is ALWAYS wired when deployed (ADR-0069): a publish can bring the first
  // `workspace()`, and wiring a client is free. `jr2 up` still decides from its host-side walk
  // whether to DEPLOY the operator; a provision on a cluster with none fails naming `jr2 up`
  // (sandbox-kube.ts). A host-booted process has no cluster: its `workspace()` runs fault pointedly.
  const dataPlane = namespace !== undefined;
  let sandbox: SandboxPort | undefined;
  let repos: RepoResources | undefined;
  let fetches: RepoFetches | undefined;
  let watch: LazyWatch | undefined;
  if (namespace !== undefined) {
    const credentials = () => config?.git?.credentials ?? [];
    // ONE client for the process (ADR-0063): one write cap over every port that writes, and the
    // token read fresh on every request. Nothing is dialed until a port first asks.
    const client = opts.kube ?? kubeClient({ env });
    // The Repo resources (ADR-0051): created by this process, cloned by the operator's cache agent
    // on every node that needs them. The port resolves `git.credentials` into each resource's
    // `secretRef` and only names the Secret: `jr2 up` wrote each token's clone Secret and listed
    // them in `git-clone.json`, read here per call so a converge reaches the next attach (ADR-0068).
    // This port is also what unlabels the Repos an earlier deploy bound, so it hangs off DEPLOYED.
    repos = kubeRepos({
      namespace,
      credentials,
      cloneSecrets: async () => new Set((await readGitCloneManifest(join(HELD_MOUNT, GIT_CLONE_MANIFEST_KEY))).secrets),
      client,
    });
    // The one watch (ADR-0063): every Sandbox of this Instance, shared by the provision, the lease
    // and the fetch ask. Lazy, because a cluster where `jr2 up` deployed no operator serves no
    // Sandbox kind, and a watch on it would only log. It starts at boot when the current Assembly
    // composes a Sandbox: its first list IS the restore reconcile (ADR-0012).
    watch = lazyWatch(() => watchSandboxes(client, { namespace }));
    if (carried.composesSandbox) watch.start();
    // The ask a pod makes when something inside it fetches (ADR-0053): it marks the Sandbox CR and
    // waits on the same watch the provision waits on.
    fetches = kubeRepoFetches({ namespace, client, watch });
    sandbox = kubeSandbox({
      // Named here the same way HARNESS_CONFIGMAP is: a jr2-owned mount path, deliberately NOT an
      // env knob — there is no image escape hatch left to configure (ADR-0038). Note what this
      // buys: the map is read per provision, so an instance whose `jr2-images` ConfigMap is not yet
      // mounted still BOOTS and serves — only a provision fails, pointing at `jr2 up`. That is the
      // correct blast pattern, and the stale-read window is one kubelet propagation.
      imagesPath: join(IMAGES_MOUNT, IMAGES_KEY),
      // What comes from the config, read per provision off the current Assembly's (ADR-0069).
      settings: () => ({
        // The fence (ADR-0051): a per-run url must match one of these, or the provision refuses it.
        credentials: credentials(),
        // The Harness containers' env (ADR-0018): what this instance can REACH (the custom provider
        // — no Agents, they ride each Turn since ADR-0049), then the instance's own valueFrom
        // entries (literal values already live in the jr2-harness-env Secret below).
        env: [
          {
            name: "JR2_HARNESS_JSON",
            valueFrom: { configMapKeyRef: { name: HARNESS_CONFIGMAP, key: HARNESS_CONFIG_KEY } },
          },
          ...(config?.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
        ],
        envFrom: [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(config?.harness?.envFrom ?? [])],
        // Presence only — the PEM itself was materialized into the jr2-ca ConfigMap by `jr2 up`
        // (ADR-0020); the in-cluster config eval never reads the file.
        caBundle: config?.harness?.caBundle !== undefined,
        // Which nodes are Sandbox nodes (ADR-0052) — the CR carries it, the operator reads no config.
        ...(config?.sandbox ? { placement: config.sandbox } : {}),
        // The Size of a Workspace that states none (ADR-0060), and the class its pod runs under.
        ...(config?.sandbox?.resources ? { defaultSize: config.sandbox.resources } : {}),
        ...(config?.priorityClasses?.sandbox ? { priorityClassName: config.priorityClasses.sandbox } : {}),
      }),
      // Where a provision records the Repos it names, before the CR names them.
      repos,
      signingKey,
      namespace,
      client,
      watch,
    });
  }

  // The Repo passes run one after another on one chain, so the newest pass always finishes last:
  // a slow boot pass can never reconcile after a publish has bound other Repos.
  let passes: Promise<void> = Promise.resolve();
  const repoPass = (port: RepoResources, bound: CarriedRepo[]): void => {
    passes = passes.then(() => ensureBound(port, bound, opts.announce));
  };

  const inst = await startInstance({
    dir: opts.dir,
    assembly: resolved,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    instanceToken,
    publishToken,
    signingKey,
    sandbox,
    dataPlane,
    // The door reads the same image map a provision reads (ADR-0069): a `file:` context whose
    // digest it lacks is refused at the publish rather than at the first provision.
    ...(dataPlane
      ? { imageMap: () => readImageRefs(join(IMAGES_MOUNT, IMAGES_KEY)), mounts: () => readMountDigests() }
      : {}),
    // A publish landed (ADR-0069): its config is the one that applies from now on, and its
    // Machines may bind other Repos, so the Repo pass runs again. Synchronous: the walk is over
    // the Machines the door already imported.
    onPublish: ({ config: next, workflows }) => {
      config = next;
      carried = partsOf(workflows.map((w) => w.machine));
      if (carried.composesSandbox) watch?.start();
      if (repos) repoPass(repos, carried.repos);
    },
    // The runs a boot with no current Assembly left waiting, restored at the first publish. Only
    // what was not resumed is a line, as on the boot's own announce line (ADR-0030).
    onRestore: ({ assembly, lost, drifted, failed }) => {
      if (lost.length || drifted.length || failed.length) {
        opts.announce(
          JSON.stringify({
            assembly,
            ...(lost.length ? { lost } : {}),
            ...(drifted.length ? { drifted } : {}),
            ...(failed.length ? { failed } : {}),
          }),
        );
      }
    },
    // Read per request, never snapshotted: the Repos as the cluster reports them right now. An
    // instance without a data plane reports none — `GET /repos` answers `{ dataPlane: false,
    // repos: [] }` (http.ts), and what its dropped Machines left behind is `jr2 gc`'s to name.
    ...(dataPlane && repos ? { repos: () => repos.list() } : {}),
    // The pod's route out (ADR-0053), same shape: read per request, off the port.
    ...(fetches ? { fetchRepo: (name: string, identity: string) => fetches.fetch(name, identity) } : {}),
    // Where a Menu-only Turn runs (ADR-0031): the Instance Harness's deterministic Service DNS.
    // `jr2 up` converges the StatefulSet behind it whenever any definition declares
    // `workspace: "none"`, so deployed, the address exists exactly when it is needed.
    instanceHarness: namespace
      ? `http://${INSTANCE_HARNESS_SERVICE}.${namespace}.svc:${INSTANCE_HARNESS_PORT}`
      : undefined,
    // Where an http Effect runs (ADR-0068): the Instance Effector's headless Service. `jr2 up`
    // converges it whenever a registered Machine carries an http Effect.
    ...(namespace ? { instanceEffector: `${INSTANCE_EFFECTOR}.${namespace}.svc:${EFFECTOR_PORT}` } : {}),
    // Where a push, a file-body http or a credentialed command runs (ADR-0068): a Sandbox's Effector, by
    // the headless Service the provision writes beside it when `jr2 up` placed an Effect there.
    ...(namespace
      ? {
          sandboxEffector: (sandbox: string) =>
            `${sandboxEffectorService(sandbox)}.${namespace}.svc:${SANDBOX_EFFECTOR_PORT}`,
        }
      : {}),
  });
  // The watch ends with the instance: its stream is the one thing here that never settles alone.
  if (watch) {
    const close = inst.close;
    inst.close = async () => {
      watch!.stop();
      await close();
    };
  }
  // Resumed runs are routine and stay quiet; runs this boot did NOT resume are not, so they ride
  // the announce line (ADR-0030) — the one thing every boot prints, whatever is reading it. Without
  // this, `drifted` is only reachable by asking after a run id nobody knows to ask about.
  const { lost, drifted, failed } = inst.restored;
  opts.announce(
    JSON.stringify({
      url: inst.url,
      workflows: inst.workflows,
      // Which Assembly this process serves (ADR-0069), and the Kit version it accepts at the door.
      assembly: inst.assembly?.hash ?? null,
      kitVersion: KIT_VERSION,
      ...(inst.assemblyError !== undefined ? { assemblyError: inst.assemblyError } : {}),
      ...(inst.waiting.length ? { waiting: inst.waiting } : {}),
      ...(lost.length ? { lost } : {}),
      ...(drifted.length ? { drifted } : {}),
      ...(failed.length ? { failed } : {}),
    }),
  );
  // After serving, never awaited: the bound Repos' resources (ADR-0051). Serving does not wait on
  // the cluster — a run whose Repo the boot could not record still finds its provision ensuring
  // it again — and a refusal is one announced line per Repo, in ADR-0048's shape. A deployed
  // instance that binds nothing still runs this: the walk names no Repo, so the reconcile is the
  // whole of it, and every resource an earlier deploy bound becomes evictable. A boot with no
  // current Assembly does not: an empty walk there means "unknown", not "binds nothing", and
  // unlabeling every Repo would let `jr2 gc` evict them until the publish.
  if (repos && inst.assembly) repoPass(repos, carried.repos);
  return inst;
}

/** The one Sandbox watch, started on first use or by {@link LazyWatch.start}. */
type LazyWatch = SandboxWatch & { start(): void };

/**
 * A watch that starts on its first use (ADR-0063, ADR-0069). The data plane is wired on every
 * deployed boot, but a cluster with no operator serves no Sandbox kind: a watch started there
 * would only log its retries. Every method but `stop` starts it.
 */
function lazyWatch(begin: () => SandboxWatch): LazyWatch {
  let inner: SandboxWatch | undefined;
  const live = () => (inner ??= begin());
  return {
    start: () => void live(),
    synced: () => live().synced(),
    get: (name) => live().get(name),
    subscribe: (name, listener) => live().subscribe(name, listener),
    stop: () => inner?.stop(),
  };
}

/**
 * The boot's half of ADR-0051's "the Orchestrator creates Repo resources": one per identity the
 * registered Machines bind, so statically known repositories are KNOWN before a run asks (the
 * cache agent probes each; a node clones on first demand) — then
 * the bound label reconciled, so a slot unbound since the last deploy is a Repo `jr2 gc` may
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
