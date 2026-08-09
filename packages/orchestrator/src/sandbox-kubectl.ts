// The canonical SandboxPort (ADR-0012 / GAP(3)): drives the operator's Sandbox CRD through
// `kubectl`, honoring the current kube context (ADR-0009: the kube target IS the kubectl
// context; `--context` overrides). Shelling to kubectl instead of a client library keeps the
// dependency surface at zero and the behavior identical to what a human debugging the cluster
// would type; the `exec` process seam is injectable so the mapping logic is unit-testable
// without a cluster. The kind e2e tier exercises the real thing.
//
// Reachability: the orchestrator always runs in-cluster (ADR-0019), so it dials
// `status.endpoint` (`http://<name>.<ns>.svc:…`) directly — stable across orchestrator
// restarts by nature, which is what ADR-0012's "same endpoint" re-attach promise rides on.
//
// All four operations are idempotent (SandboxPort contract): apply is create-or-update, attach
// guards every clone/worktree, delete ignores absent.
//
// WHICH IMAGE a Sandbox runs is not an option here (ADR-0037/0038). The spec carries a NAME; the
// resolved name→ref map arrives as a mounted ConfigMap and is read on EVERY provision, so a
// `j2 up` that rebuilds an image reaches future Sandboxes without rolling this process. The pod's
// primary container is the wrapped Sandbox Image — the user's tools with j2's runtime injected
// at `/opt/j2` — which is why there is no longer a User Container beside it.
//
// This is also where the ADAPTER is injected (ADR-0013). The operator needs no change to carry it:
// ADR-0001 made `Sidecars` generic container fragments it schedules WITHOUT understanding, so the
// Adapter is exactly that — a container with an image, an env, and a Secret. What this module
// builds is the pod's asymmetry:
//
//   harness container   J2_ADAPTER_URL=http://127.0.0.1:8081     (an address, no credential)
//   adapter container   J2_ORCHESTRATOR_URL + J2_SANDBOX_TOKEN   (the credential, via envFrom)
//
// The Agent has code execution in the first and none in the second. The token is minted here — a
// signed Sandbox name (see tokens.ts), so re-provisioning after a restart yields the SAME token and
// the Secret re-applies as a no-op.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { readImageRefs, resolveSandboxImage, type ImageRefs } from "./images.ts";
import { CA_CONFIGMAP, IMAGES_KEY, IMAGES_MOUNT, REPOS_PVC } from "./names.ts";
import { sandboxToken } from "./tokens.ts";
import type { HarnessEnvFromSource, HarnessEnvVar } from "./config.ts";
import type { WorkspaceSpec, SandboxPort } from "./workspace.ts";

/** Run one kubectl invocation to completion. `input` is piped to stdin (`apply -f -`). */
export type KubectlExec = (args: string[], opts?: { input?: string }) => Promise<{ stdout: string; stderr: string }>;

/** Where the Harness container sees the instance's CA bundle (ADR-0020). */
const CA_MOUNT = "/etc/j2/ca";

export type KubectlSandboxOptions = {
  /** The mounted image map (ADR-0037/0038) — every ref this port can name, written by `j2 up`.
   * Default: the `j2-images` ConfigMap's mount. No image option here any more: which image a
   * Sandbox runs is a NAME on the spec, resolved against this map at provision. */
  imagesPath?: string;
  /** Extra env for the HARNESS container (`harness.env`) — merged ahead of the
   * mechanism-owned vars, which win on collision. */
  env?: HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container (`harness.envFrom`) — how a real
   * Harness gets its model API key without the value ever touching j2 config. */
  envFrom?: HarnessEnvFromSource[];
  /** The instance ships a private-CA bundle (ADR-0020): mount the `j2-ca` ConfigMap into the
   * HARNESS container and point NODE_EXTRA_CA_CERTS at it — never the Adapter, which speaks plain
   * HTTP to the Orchestrator's Service (the same asymmetry as env/envFrom above). */
  caBundle?: boolean;
  /**
   * Where the Adapter reaches the Orchestrator FROM INSIDE THE CLUSTER — the orchestrator's own
   * Service DNS (derived from J2_NAMESPACE by the entrypoint). The Agent is never told it.
   * A thunk is still accepted for callers that resolve their address late.
   */
  orchestratorUrl?: string | (() => string | undefined);
  /** The key Sandbox tokens are signed with — from the instance Secret (ADR-0013/0019). */
  signingKey?: Buffer;
  /** The Adapter's port on the pod's loopback. Default 8081. */
  adapterPort?: number;
  /** Kube namespace for Sandbox CRs. Default `default`. */
  namespace?: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** In-pod root for the pod-local clones + worktrees (ADR-0004 layout). Default `/work`. */
  workRoot?: string;
  /** CR `spec.idleTimeout` — the operator's abandoned-Sandbox GC backstop (ADR-0001). Default `30m`. */
  idleTimeout?: string;
  /** How often a workspace's lease actor renews (ADR-0001/0021): the cadence at which
   * `j2.dev/keepalive` is re-stamped AND continuity is read back. Must be ≪ idleTimeout, since
   * a lapsed lease is what lets the operator reap. Default 5m. */
  leaseIntervalMs?: number;
  /** Await-Ready budget. Default 120s, polled every second. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Process seam, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
};

export function kubectlSandbox(opts: KubectlSandboxOptions = {}): SandboxPort {
  const ns = opts.namespace ?? "default";
  const imagesPath = opts.imagesPath ?? join(IMAGES_MOUNT, IMAGES_KEY);
  const workRoot = opts.workRoot ?? "/work";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const exec = opts.exec ?? defaultExec;

  const adapterPort = opts.adapterPort ?? 8081;
  const leaseIntervalMs = opts.leaseIntervalMs ?? 5 * 60_000;
  const base = ["--namespace", ns, ...(opts.context ? ["--context", opts.context] : [])];

  /** The Sandbox's token Secret — read by the Adapter container, and by nothing else in the pod. */
  const secretName = (name: string) => `${name}-token`;

  /** Resolved at provision time (see the option's doc): the Orchestrator's in-cluster address. */
  const orchestratorUrl = (): string | undefined =>
    typeof opts.orchestratorUrl === "function" ? opts.orchestratorUrl() : opts.orchestratorUrl;

  /** The Adapter, as the operator sees it: an opaque container fragment (ADR-0001). */
  const adapterSidecar = (name: string, refs: ImageRefs) => ({
    name: "adapter",
    image: refs.adapter,
    env: [
      { name: "J2_ORCHESTRATOR_URL", value: orchestratorUrl() },
      { name: "J2_SANDBOX", value: name },
      { name: "J2_ADAPTER_PORT", value: String(adapterPort) },
    ],
    // The credential, and the reason this is a separate container: `local()` tools give the Agent
    // code execution in the HARNESS container, so anything mounted there is the Agent's. Here, it
    // is out of reach — different container, no shared process namespace.
    envFrom: [{ secretRef: { name: secretName(name) } }],
  });

  /** The pod's sidecar list (ADR-0001: opaque fragments the operator schedules verbatim). The
   * Adapter is ALWAYS here now: with its ref in the image map there is no "no adapter configured"
   * state left to branch on, and a Sandbox without one is a pod that comes up Ready and then parks
   * its Machine forever on a tool call it cannot make (ADR-0013). A map with no `adapter` fails the
   * read instead (images.ts). The User Container is gone entirely (ADR-0037): the wrap already ate
   * it — a Sandbox Image is the user's tools PLUS the Harness, so `kubectl exec -c harness` is the
   * human's shell on the agent's own filesystem. */
  const sidecarsFor = (name: string, refs: ImageRefs) => [adapterSidecar(name, refs)];

  // The Harness container's env: the instance's passthrough (`harness.env` — e.g. model
  // config) first, then the mechanism-owned vars (the Adapter address, the CA trust path), which
  // win on collision. Note the asymmetry stands (ADR-0013): user env/envFrom land on the HARNESS
  // container only — never on the Adapter, whose env is minted here and carries the pod's only
  // credential.
  const harnessEnv = (): HarnessEnvVar[] => [
    ...(opts.env ?? []),
    { name: "J2_ADAPTER_URL", value: `http://127.0.0.1:${adapterPort}` },
    ...(opts.caBundle ? [{ name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/ca.crt` }] : []),
  ];

  const crFor = (req: { name: string; runId: string; workflow: string; image?: string }, refs: ImageRefs) => {
    const sidecars = sidecarsFor(req.name, refs);
    return {
      apiVersion: "core.j2.dev/v1alpha1",
      kind: "Sandbox",
      metadata: {
        name: req.name,
        namespace: ns,
        // The run↔workspace link `j2 ls` groups by (ADR-0009/0012) — readable without the host.
        labels: { "j2.dev/run": req.runId, "j2.dev/workflow": req.workflow },
      },
      spec: {
        // The wrapped Sandbox Image (ADR-0037) — the user's tools with j2's runtime injected at
        // `/opt/j2`, so this container IS both the Harness and the human's `exec` shell.
        image: resolveSandboxImage(refs, req.image),
        idleTimeout: opts.idleTimeout ?? "30m",
        // Never empty any more: J2_ADAPTER_URL is unconditional, so the "omit an empty env" branch
        // this used to carry was unreachable.
        env: harnessEnv(),
        ...(opts.envFrom?.length ? { envFrom: opts.envFrom } : {}),
        // What the AGENT gets: an address on its own loopback, and no credential anywhere. This is
        // the only thing in the pod that tells it how to reach its Machine (ADR-0013).
        sidecars,
        volumes: [
          // The in-cluster source volume (ADR-0004/0019): the same PVC the orchestrator's boot
          // reconcile writes, mounted read-only here. No hostPath, nothing kind-special.
          { name: "repos", persistentVolumeClaim: { claimName: REPOS_PVC, readOnly: true } },
          // The worktree root is a POD volume, not a directory baked into the image. Two reasons,
          // both load-bearing: the operator runs every Sandbox container as an unprivileged uid
          // (ADR-0001), which cannot mkdir under `/` — so an image-owned `/work` would make every
          // attach fail — and `/work` is the wrap's `WORKDIR` (ADR-0037), the spot a human's
          // `kubectl exec` lands on, which must hold the same worktrees the Agent writes. An
          // emptyDir lands 0777, so it is writable whatever uid the Sandbox Image runs as: no
          // image contract beyond `git`.
          { name: "work", emptyDir: {} },
          ...(opts.caBundle ? [{ name: "ca", configMap: { name: CA_CONFIGMAP } }] : []),
        ],
        // Read-only is load-bearing twice (ADR-0004): no write contention, and nothing in a
        // Sandbox can `gc` the object store its `--shared` clones borrow from.
        // CR-level volumeMounts land on the HARNESS container only (the operator's contract) —
        // exactly the CA-trust asymmetry ADR-0020 wants: the Adapter never inherits it.
        volumeMounts: [
          { name: "repos", mountPath: "/repos", readOnly: true },
          { name: "work", mountPath: workRoot },
          ...(opts.caBundle ? [{ name: "ca", mountPath: CA_MOUNT, readOnly: true }] : []),
        ],
      },
    };
  };

  type SandboxStatus = { phase?: string; endpoint?: string; podUID?: string; uid?: string };

  /** Parse a Sandbox CR off any kubectl call that printed one (`get -o json`, and the lease's
   * `annotate -o json` — which returns the object AFTER the patch, status included). */
  const readSandbox = (stdout: string): SandboxStatus => {
    const parsed = JSON.parse(stdout) as {
      metadata?: { uid?: string };
      status?: { phase?: string; endpoint?: string; podUID?: string };
    };
    return { ...(parsed.status ?? {}), uid: parsed.metadata?.uid };
  };

  const getSandbox = async (name: string): Promise<SandboxStatus | undefined> => {
    try {
      const { stdout } = await exec(["get", "sandbox", name, ...base, "-o", "json"]);
      return readSandbox(stdout);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  };

  /**
   * Mint this Sandbox's token into a Secret, BEFORE the CR exists — the operator creates the pod
   * the moment it sees the CR, and a pod whose `envFrom` names an absent Secret sits in
   * CreateContainerConfigError. Idempotent by construction: the token is the Sandbox's name, signed
   * (tokens.ts), so a re-provision after an orchestrator restart re-applies the SAME value, and the
   * Adapter that has been holding it all along stays valid.
   */
  const applyTokenSecret = async (name: string): Promise<void> => {
    if (!opts.signingKey) throw new Error("kubectlSandbox: an Adapter needs a signingKey to mint its Sandbox token");
    // Fail the provision rather than ship an Adapter that cannot reach the Orchestrator. A mute
    // Adapter is the worst possible outcome: the pod comes up Ready, the Agent is admitted, its
    // tool call dies on `localhost`, and the Machine simply parks forever — a hang with no error.
    if (!orchestratorUrl()) {
      throw new Error(
        "kubectlSandbox: the Adapter has no route to the Orchestrator (no orchestratorUrl — deployed " +
          "instances derive Service DNS from J2_NAMESPACE). An Agent with no Adapter cannot drive its " +
          "Machine at all (ADR-0013).",
      );
    }
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName(name), namespace: ns, labels: { "j2.dev/sandbox": name } },
      type: "Opaque",
      stringData: { J2_SANDBOX_TOKEN: sandboxToken(opts.signingKey, name) },
    };
    await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(secret) });
  };

  /**
   * Make the Secret a child of the Sandbox CR, so Kubernetes reaps it whenever the CR goes — including
   * the paths no j2 code observes (the operator's idle-timeout GC, a `kubectl delete sandbox` by hand).
   * Needs the CR's uid, so it can only happen after the apply; a failure here leaks a Secret, never a
   * pod, so it is not worth failing the provision over.
   */
  const ownSecret = async (name: string, uid: string | undefined): Promise<void> => {
    if (!uid) return;
    const ownerRef = [
      { apiVersion: "core.j2.dev/v1alpha1", kind: "Sandbox", name, uid, controller: true, blockOwnerDeletion: false },
    ];
    await exec([
      "patch",
      "secret",
      secretName(name),
      ...base,
      "--type",
      "merge",
      "-p",
      JSON.stringify({ metadata: { ownerReferences: ownerRef } }),
    ]).catch(() => {});
  };

  return {
    async provision(req) {
      // Read PER PROVISION, and first (ADR-0038). Not hoisted into `kubectlSandbox()`: a boot-time
      // read would freeze the map for the process lifetime, which is precisely the Deployment-env
      // behavior the ConfigMap mount was chosen over — the point of the mount is that a `j2 up`
      // reaches future Sandboxes without rolling the Orchestrator. Reading before the Secret apply
      // also means an unknown image name costs nothing: no Secret, no CR, nothing to clean up.
      const refs = await readImageRefs(imagesPath);
      const cr = crFor(req, refs);

      await applyTokenSecret(req.name); // before the CR: the pod's Adapter mounts it at start
      await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(cr) });

      const deadline = Date.now() + readyTimeoutMs;
      let owned = false;
      for (;;) {
        const status = await getSandbox(req.name);
        if (!owned && status?.uid) ((owned = true), await ownSecret(req.name, status.uid));
        if (status?.phase === "Ready") {
          // Only `phase: Ready` means serving — status.endpoint appears earlier (ADR-0001).
          if (!status.endpoint) throw new Error(`Sandbox "${req.name}" is Ready but reports no endpoint`);
          // The identity the lease will hold this workspace to (ADR-0021). Ready means the pod
          // is up, so the operator has published it; an operator too old to do so leaves it
          // undefined and the lease falls back to presence.
          return { endpoint: status.endpoint, identity: status.podUID };
        }
        if (Date.now() >= deadline) {
          throw new Error(`Sandbox "${req.name}" never reached Ready (last phase: ${status?.phase ?? "absent"})`);
        }
        await sleep(pollMs);
      }
    },

    async attach(req) {
      const { script, workdir, repos, review } = attachScript(req.spec, { reposMount: "/repos", workRoot });
      // `-c harness` is unchanged and still correct after ADR-0037: the wrapped Sandbox Image IS
      // the harness container — the user's tools with j2's runtime injected at `/opt/j2`.
      await exec(["exec", `pod/${req.name}`, ...base, "-c", "harness", "--", "sh", "-ec", script]);
      return { workdir, repos, ...(review ? { review } : {}) };
    },

    leaseIntervalMs,

    async renew(name) {
      // ONE call, both directions: `annotate --overwrite -o json` writes the stamp and prints the
      // object as it stands afterwards, status included. So asserting liveness and learning
      // whether the workspace survived cost exactly one API round trip (ADR-0021).
      try {
        const { stdout } = await exec([
          "annotate",
          "sandbox",
          name,
          ...base,
          `j2.dev/keepalive=${new Date().toISOString()}`,
          "--overwrite",
          "-o",
          "json",
        ]);
        return { present: true, identity: readSandbox(stdout).podUID };
      } catch (err) {
        if (isNotFound(err)) return { present: false };
        throw err; // anything else is UNKNOWN — the caller must not read it as loss
      }
    },

    async destroy(name) {
      // The Secret is an owned child of the CR, so deleting the CR reaps it — this is belt and
      // braces for the case where the ownerRef patch didn't land.
      await exec(["delete", "sandbox", name, ...base, "--ignore-not-found"]);
      await exec(["delete", "secret", secretName(name), ...base, "--ignore-not-found"]).catch(() => {});
    },
  };
}

/**
 * The post-Ready attach step as one idempotent in-pod script (ADR-0004): per repo, a pod-local
 * `git clone --shared --no-checkout` borrowing objects from the RO `default/` volume, then the
 * branch worktree as a sibling (gwtmux layout: `<repo>/default/` + `<repo>/<branch>/`).
 * With a `reviewSha`, also the detached review worktree (ADR-0028) — another sibling.
 * Exported for the port's tests; the workflow never sees it.
 */
export function attachScript(
  spec: WorkspaceSpec,
  paths: { reposMount: string; workRoot: string },
): { script: string; workdir: string; repos: Record<string, string>; review?: Record<string, string> } {
  const repos: Record<string, string> = {};
  const review: Record<string, string> = {};
  // The RO repos volume is written by the ORCHESTRATOR's uid and read here as the Harness's
  // unprivileged uid (ADR-0001/0004), so git's dubious-ownership guard would refuse the clone
  // source. safe.directory is only honored from global/system config (never `-c`), and inside
  // the pod every path is j2-owned — trusting them all is the honest scope.
  const lines: string[] = [`git config --global safe.directory '*'`];
  const branchDir = spec.branch.replace(/\//g, "-");
  for (const repo of spec.repos) {
    const dflt = `${paths.workRoot}/${repo.name}/default`;
    const worktree = `${paths.workRoot}/${repo.name}/${branchDir}`;
    repos[repo.name] = worktree;
    lines.push(
      `mkdir -p ${sq(`${paths.workRoot}/${repo.name}`)}`,
      `[ -d ${sq(`${dflt}/.git`)} ] || git clone --shared --no-checkout ${sq(`${paths.reposMount}/${repo.name}/default`)} ${sq(dflt)}`,
      `[ -d ${sq(worktree)} ] || git -C ${sq(dflt)} worktree add ${sq(worktree)} -b ${sq(spec.branch)} ${sq(repo.baseRef)}`,
    );
    if (spec.reviewSha) {
      // The reviewer's seat (ADR-0028): a DETACHED HEAD at the sha under review, so a rogue write
      // cannot move the branch and a rogue commit evaporates with the checkout. Forced checkout
      // AND clean on every attach: a previous round's rogue edits (tracked) and leftovers
      // (untracked) must not survive into this round — the review worktree's contents are the
      // sha under review, period.
      const reviewDir = `${worktree}-review`;
      review[repo.name] = reviewDir;
      lines.push(
        `[ -d ${sq(reviewDir)} ] || git -C ${sq(dflt)} worktree add --detach ${sq(reviewDir)} ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} checkout --detach -f ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} clean -fd`,
      );
    }
  }
  const first = spec.repos[0];
  if (!first) throw new Error("workspace spec has no repos — nothing to attach");
  return {
    script: lines.join("\n"),
    workdir: repos[first.name]!,
    repos,
    ...(spec.reviewSha ? { review } : {}),
  };
}

/** POSIX single-quote an argument for the in-pod `sh -ec` script. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /NotFound|not found/i.test(err.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const defaultExec: KubectlExec = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile("kubectl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`kubectl ${args[0]} failed: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
  });
