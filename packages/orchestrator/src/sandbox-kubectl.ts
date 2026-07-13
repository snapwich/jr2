// The canonical SandboxPort (ADR-0012 / GAP(3)): drives the operator's Sandbox CRD through
// `kubectl`, honoring the current kube context (ADR-0009: the kube target IS the kubectl
// context; `--context` overrides). Shelling to kubectl instead of a client library keeps the
// dependency surface at zero and the behavior identical to what a human debugging the cluster
// would type; both process seams (`exec`, `spawn`) are injectable so the mapping logic is
// unit-testable without a cluster. The kind e2e tier exercises the real thing.
//
// Reachability: a DEPLOYED orchestrator dials `status.endpoint` (`http://<name>.<ns>.svc:…`)
// directly (`reach: "endpoint"`). A host-side `j2 dev` cannot resolve svc DNS, so the default
// is `reach: "port-forward"`: a `kubectl port-forward` per Sandbox on a local port derived
// DETERMINISTICALLY from the Sandbox name — the endpoint persisted into run snapshots must
// survive an orchestrator restart (ADR-0012 re-attach: same endpoint), so the port cannot be
// ephemeral. `exists()` re-ensures the forward, which is what heals endpoints after a restart:
// the workspace wrapper's reconcile probe calls it on every restore, mechanically.
//
// All four operations are idempotent (SandboxPort contract): apply is create-or-update, attach
// guards every clone/worktree, delete ignores absent.
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

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { sandboxToken } from "./tokens.ts";
import type { WorkspaceSpec, SandboxPort } from "./workspace.ts";

/** Run one kubectl invocation to completion. `input` is piped to stdin (`apply -f -`). */
export type KubectlExec = (args: string[], opts?: { input?: string }) => Promise<{ stdout: string; stderr: string }>;

/** A long-lived kubectl child (port-forward): line-observed stdout, exit signal, kill. */
export type KubectlProc = {
  onLine: (cb: (line: string) => void) => void;
  onExit: (cb: () => void) => void;
  kill: () => void;
};
export type KubectlSpawn = (args: string[]) => KubectlProc;

export type KubectlSandboxOptions = {
  /** The Harness image every Sandbox runs (one image, many personas — ADR-0001). */
  image: string;
  /** The Adapter image (ADR-0013) — the Agent's MCP surface, and the pod's only credential holder.
   * Absent = no Adapter is injected, so the Agent has no route to its Machine. */
  adapterImage?: string;
  /**
   * Where the Adapter reaches the Orchestrator FROM INSIDE THE CLUSTER: the pod→host address
   * `j2 cluster up` recorded (kind), or Service DNS (deployed). The Agent is never told it.
   *
   * A thunk, because `j2 dev` builds this port BEFORE it knows its own address (`--port 0` resolves
   * only once the socket is listening) and every use of it is at provision time, long after.
   */
  orchestratorUrl?: string | (() => string | undefined);
  /** The key Sandbox tokens are signed with — the instance's `.j2/secret` (ADR-0013). */
  signingKey?: Buffer;
  /** The Adapter's port on the pod's loopback. Default 8081. */
  adapterPort?: number;
  /** Kube namespace for Sandbox CRs. Default `default`. */
  namespace?: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** NODE path of the read-only repos volume (kind: baked by `extraMounts`). Default `/repos`. */
  reposMountPath?: string;
  /** In-pod root for the pod-local clones + worktrees (ADR-0004 layout). Default `/work`. */
  workRoot?: string;
  /** CR `spec.idleTimeout` — the operator's orphan GC backstop. Default `30m`. */
  idleTimeout?: string;
  /** How the orchestrator reaches the Harness. Default `port-forward` (host-side dev). */
  reach?: "port-forward" | "endpoint";
  /** Await-Ready budget. Default 120s, polled every second. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Process seams, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
  spawn?: KubectlSpawn;
};

/** The local port a Sandbox's port-forward binds — deterministic so persisted endpoints
 * survive orchestrator restarts (re-ensured, same address). Collisions across names are made
 * unlikely by the range; a foreign process squatting the port surfaces as a loud forward error. */
export function forwardPort(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 13000 + ((h >>> 0) % 20000);
}

export function kubectlSandbox(opts: KubectlSandboxOptions): SandboxPort {
  const ns = opts.namespace ?? "default";
  const reposMount = opts.reposMountPath ?? "/repos";
  const workRoot = opts.workRoot ?? "/work";
  const reach = opts.reach ?? "port-forward";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const exec = opts.exec ?? defaultExec;
  const spawn = opts.spawn ?? defaultSpawn;

  const adapterPort = opts.adapterPort ?? 8081;
  const base = ["--namespace", ns, ...(opts.context ? ["--context", opts.context] : [])];
  /** name → its live port-forward child, so destroy/re-ensure manage exactly one per Sandbox. */
  const forwards = new Map<string, { proc: KubectlProc; ready: Promise<void> }>();

  /** The Sandbox's token Secret — read by the Adapter container, and by nothing else in the pod. */
  const secretName = (name: string) => `${name}-token`;

  /** Resolved at provision time (see the option's doc): the Orchestrator's in-cluster address. */
  const orchestratorUrl = (): string | undefined =>
    typeof opts.orchestratorUrl === "function" ? opts.orchestratorUrl() : opts.orchestratorUrl;

  /** The Adapter, as the operator sees it: an opaque container fragment (ADR-0001). */
  const adapterSidecar = (name: string) => ({
    name: "adapter",
    image: opts.adapterImage,
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

  const crFor = (req: { name: string; runId: string; workflow: string }) => ({
    apiVersion: "core.j2.dev/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: req.name,
      namespace: ns,
      // The run↔workspace link `j2 ls` groups by (ADR-0009/0012) — readable without the host.
      labels: { "j2.dev/run": req.runId, "j2.dev/workflow": req.workflow },
    },
    spec: {
      image: opts.image,
      idleTimeout: opts.idleTimeout ?? "30m",
      // What the AGENT gets: an address on its own loopback, and no credential anywhere. This is
      // the only thing in the pod that tells it how to reach its Machine (ADR-0013).
      ...(opts.adapterImage
        ? {
            env: [{ name: "J2_ADAPTER_URL", value: `http://127.0.0.1:${adapterPort}` }],
            sidecars: [adapterSidecar(req.name)],
          }
        : {}),
      volumes: [
        { name: "repos", hostPath: { path: reposMount, type: "Directory" } },
        // The worktree root is a POD volume, not a directory baked into the image. Two reasons,
        // both load-bearing: the operator runs every Sandbox container as an unprivileged uid
        // (ADR-0001), which cannot mkdir under `/` — so an image-owned `/work` would make every
        // attach fail — and ADR-0005 has the User Container sharing the worktrees with the
        // Harness, which only a pod volume can do. An emptyDir lands 0777, so it is writable
        // whatever uid the Harness image happens to run as: no image contract beyond `git`.
        { name: "work", emptyDir: {} },
      ],
      // Read-only is load-bearing twice (ADR-0004): no write contention, and nothing in a
      // Sandbox can `gc` the object store its `--shared` clones borrow from.
      volumeMounts: [
        { name: "repos", mountPath: "/repos", readOnly: true },
        { name: "work", mountPath: workRoot },
      ],
    },
  });

  const getSandbox = async (name: string): Promise<{ phase?: string; endpoint?: string; uid?: string } | undefined> => {
    try {
      const { stdout } = await exec(["get", "sandbox", name, ...base, "-o", "json"]);
      const parsed = JSON.parse(stdout) as {
        metadata?: { uid?: string };
        status?: { phase?: string; endpoint?: string };
      };
      return { ...(parsed.status ?? {}), uid: parsed.metadata?.uid };
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
    if (!opts.adapterImage) return;
    if (!opts.signingKey) throw new Error("kubectlSandbox: an Adapter needs a signingKey to mint its Sandbox token");
    // Fail the provision rather than ship an Adapter that cannot reach the Orchestrator. A mute
    // Adapter is the worst possible outcome: the pod comes up Ready, the Agent is admitted, its
    // tool call dies on `localhost`, and the Machine simply parks forever — a hang with no error.
    if (!orchestratorUrl()) {
      throw new Error(
        "kubectlSandbox: the Adapter has no route to the Orchestrator (no `podToHost` in .j2/cluster.json — " +
          "run `j2 cluster up`). An Agent with no Adapter cannot drive its Machine at all (ADR-0013).",
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
    if (!opts.adapterImage || !uid) return;
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

  /** Ensure the deterministic port-forward for `name` is up; resolve once it is listening. */
  const ensureForward = (name: string): Promise<void> => {
    const existing = forwards.get(name);
    if (existing) return existing.ready;
    const local = forwardPort(name);
    const proc = spawn(["port-forward", `pod/${name}`, ...base, `${local}:8080`]);
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      proc.onLine((line) => {
        if (!settled && /Forwarding from/.test(line)) ((settled = true), resolve());
      });
      proc.onExit(() => {
        forwards.delete(name);
        if (!settled) ((settled = true), reject(new Error(`kubectl port-forward for "${name}" exited before serving`)));
      });
    });
    forwards.set(name, { proc, ready });
    return ready;
  };

  const dropForward = (name: string): void => {
    const fwd = forwards.get(name);
    forwards.delete(name);
    fwd?.proc.kill();
  };

  return {
    async provision(req) {
      await applyTokenSecret(req.name); // before the CR: the pod's Adapter mounts it at start
      await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(crFor(req)) });

      const deadline = Date.now() + readyTimeoutMs;
      let owned = false;
      for (;;) {
        const status = await getSandbox(req.name);
        if (!owned && status?.uid) ((owned = true), await ownSecret(req.name, status.uid));
        if (status?.phase === "Ready") {
          // Only `phase: Ready` means serving — status.endpoint appears earlier (ADR-0001).
          if (reach === "endpoint") {
            if (!status.endpoint) throw new Error(`Sandbox "${req.name}" is Ready but reports no endpoint`);
            return { endpoint: status.endpoint };
          }
          await ensureForward(req.name);
          return { endpoint: `http://127.0.0.1:${forwardPort(req.name)}` };
        }
        if (Date.now() >= deadline) {
          throw new Error(`Sandbox "${req.name}" never reached Ready (last phase: ${status?.phase ?? "absent"})`);
        }
        await sleep(pollMs);
      }
    },

    async attach(req) {
      const { script, workdir, repos } = attachScript(req.spec, { reposMount: "/repos", workRoot });
      await exec(["exec", `pod/${req.name}`, ...base, "-c", "harness", "--", "sh", "-ec", script]);
      return { workdir, repos };
    },

    async exists(name) {
      const status = await getSandbox(name);
      if (status === undefined) return false;
      // Present: heal the reach path too (a restart dropped this process's forwards; the
      // workspace reconcile probe lands here on every restore — ADR-0012 "same endpoint").
      if (reach === "port-forward") await ensureForward(name).catch(() => {});
      return true;
    },

    async destroy(name) {
      dropForward(name);
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
 * Exported for the port's tests; the workflow never sees it.
 */
export function attachScript(
  spec: WorkspaceSpec,
  paths: { reposMount: string; workRoot: string },
): { script: string; workdir: string; repos: Record<string, string> } {
  const repos: Record<string, string> = {};
  const lines: string[] = [];
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
  }
  const first = spec.repos[0];
  if (!first) throw new Error("workspace spec has no repos — nothing to attach");
  return { script: lines.join("\n"), workdir: repos[first.name]!, repos };
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

const defaultSpawn: KubectlSpawn = (args) => {
  const child = nodeSpawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
  return {
    onLine: (cb) => {
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          cb(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
    },
    onExit: (cb) => child.on("close", cb),
    kill: () => child.kill("SIGTERM"),
  };
};
