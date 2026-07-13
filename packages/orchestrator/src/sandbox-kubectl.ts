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

import { execFile, spawn as nodeSpawn } from "node:child_process";
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

  const base = ["--namespace", ns, ...(opts.context ? ["--context", opts.context] : [])];
  /** name → its live port-forward child, so destroy/re-ensure manage exactly one per Sandbox. */
  const forwards = new Map<string, { proc: KubectlProc; ready: Promise<void> }>();

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
      volumes: [{ name: "repos", hostPath: { path: reposMount, type: "Directory" } }],
      // Read-only is load-bearing twice (ADR-0004): no write contention, and nothing in a
      // Sandbox can `gc` the object store its `--shared` clones borrow from.
      volumeMounts: [{ name: "repos", mountPath: "/repos", readOnly: true }],
    },
  });

  const getSandbox = async (name: string): Promise<{ phase?: string; endpoint?: string } | undefined> => {
    try {
      const { stdout } = await exec(["get", "sandbox", name, ...base, "-o", "json"]);
      const parsed = JSON.parse(stdout) as { status?: { phase?: string; endpoint?: string } };
      return parsed.status ?? {};
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
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
      await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(crFor(req)) });

      const deadline = Date.now() + readyTimeoutMs;
      for (;;) {
        const status = await getSandbox(req.name);
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
      await exec(["delete", "sandbox", name, ...base, "--ignore-not-found"]);
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
