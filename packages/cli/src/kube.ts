// The CLI's kube transport (ADR-0019): run-verbs reach a deployed orchestrator by port-forwarding
// its Service via the kube API for the duration of the command, authenticating with the Instance
// token read from its in-cluster Secret — kube RBAC is the real gate. This module is the seam:
// `KubePort` is what target resolution consumes (tests inject a fake), `kubectlKube` is the real
// one, shelling out to the same `kubectl` a human debugging the cluster would use.

import { execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** How long a RUN-VERB waits to find out whether the cluster is there (ADR-0019). Matches the
 * Harness client's connect bound (`harness-client.ts`), so the two seats that dial across a
 * network agree on what "too long" means. It bounds resolution only: `jr2 up` waits on rollouts
 * for minutes, and says so with its own `--timeout`.
 *
 * Spent TWICE, because `--request-timeout` bounds one server request and kubectl retries API
 * discovery behind it — a 5s flag was measured buying a 25s command. The flag makes each attempt
 * give up promptly; `timeout` (execFile kills the child) is what bounds the command. */
export const REACH_BUDGET_MS = 10_000;

const reachArgs = [`--request-timeout=${REACH_BUDGET_MS}ms`];

/** Why a bounded kubectl did not answer, in a phrase a verb can put after a dash. */
function unreachable(e: unknown): string {
  const err = e as { killed?: boolean; stderr?: string; message?: string };
  if (err.killed) return `no answer after ${REACH_BUDGET_MS / 1000}s`;
  const said = (err.stderr ?? "").trim().split("\n").filter(Boolean).pop();
  return said ?? err.message ?? "kubectl failed";
}

// The fixed in-namespace object names live with the orchestrator (its entrypoint consumes them
// too); re-exported here for the CLI's own modules.
export { INSTANCE_SECRET, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@jr2/orchestrator/internal";

export type KubePort = {
  /** The current kubectl context, or undefined when there is none configured. */
  currentContext(): Promise<string | undefined>;
  /** One decoded key of a Secret; undefined when the Secret (or key) is ABSENT. Rejects when the
   * cluster could not answer at all — the two are different faults (ADR-0019), and a caller that
   * merged them would send a user with a dead VPN off to check a context that is correct. */
  readSecret(opts: { namespace: string; name: string; key: string; context?: string }): Promise<string | undefined>;
  /** Forward a Service port to an ephemeral local port for the life of the command. */
  portForward(opts: {
    namespace: string;
    service: string;
    port: number;
    context?: string;
  }): Promise<{ url: string; close: () => void }>;
};

const ctxArgs = (context?: string): string[] => (context ? ["--context", context] : []);

/** The loosely-typed kube object shape the converge logic inspects: labels carry the instance's
 * identity; annotations carry the converged image map, which is too long for a label value
 * (ADR-0038). */
export type KubeObject = {
  metadata: {
    name: string;
    /** Only ever populated by a cluster-wide read. It is how the sweep's roots (ADR-0039) narrow a
     * `--all-namespaces` listing back to the namespaces that belong to a jr2 instance — the objects
     * are found cluster-wide precisely because no instance's images are only its own business. */
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
} & Record<string, unknown>;

/** What `jr2 up`/`jr2 down` converge through — admin-shaped, next to the transport-shaped KubePort.
 * Injected via `io.kubeAdmin` in tests; `kubectlAdmin` is the real one. */
export type KubeAdmin = {
  /** The current kubectl context, or undefined when there is none configured. */
  context(): Promise<string | undefined>;
  /** One object as JSON; undefined when absent. Cluster-scoped kinds pass no namespace. */
  getJson<T = KubeObject>(opts: {
    kind: string;
    name: string;
    namespace?: string;
    context?: string;
  }): Promise<T | undefined>;
  /** Objects matching a label selector. Unlike `getJson`, a failed query THROWS rather than
   * reading as "absent" — this is what converge claims are checked against, and a check that
   * silently passes when it could not look is the defect it exists to catch. */
  listJson<T = KubeObject>(opts: {
    kind: string;
    /** `-l`. A bare key (no `=`) is an EXISTENCE selector, which is how the sweep asks for "every
     * namespace some instance owns" without knowing any of their names. */
    selector?: string;
    /** `--field-selector`. The one root addressed by NAME rather than by label — the `jr2-images`
     * ConfigMap (ADR-0039) — is read this way instead of with `getJson`, because `getJson` reads
     * every failure as "absent", and a root that reads as absent when the API could not be reached
     * is a keep set that deletes another instance's images. */
    fieldSelector?: string;
    namespace?: string;
    /** `--all-namespaces`. The sweep's roots are CLUSTER-WIDE (ADR-0039): a ref that any instance's
     * image map, Sandbox, or pod names is not garbage, so "my namespace" is the wrong scope for a
     * keep set. Ignored when `namespace` is set. */
    allNamespaces?: boolean;
    context?: string;
  }): Promise<T[]>;
  /** `kubectl apply -f -` of a multi-doc YAML or JSON manifest string. `serverSide` is for an
   * object too large for client-side apply's `last-applied-configuration` annotation (256 KiB) —
   * the trust bundles, which carry every root certificate (ADR-0059); jr2 is its only writer, so it
   * takes the fields it owns (`--force-conflicts`). */
  apply(opts: { manifest: string; context?: string; serverSide?: boolean }): Promise<void>;
  /** `kubectl label --overwrite`. */
  label(opts: {
    kind: string;
    name: string;
    namespace?: string;
    labels: Record<string, string>;
    context?: string;
  }): Promise<void>;
  /** `kubectl delete --ignore-not-found` of one object. */
  deleteObject(opts: {
    kind: string;
    name: string;
    namespace?: string;
    context?: string;
    wait?: boolean;
  }): Promise<void>;
  /** `kubectl delete --ignore-not-found -f -` of a manifest string (the operator uninstall). */
  deleteManifest(opts: { manifest: string; context?: string }): Promise<void>;
  /** `kubectl rollout status <kind>/<name>` — converge isn't done until the pods are. A Deployment
   * by default; the cache agent's DaemonSet (ADR-0051) is the one other rollout `jr2 up` waits on. */
  waitRollout(opts: RolloutRequest): Promise<void>;
  /** The tail of one container's output (`kubectl logs --tail`) — evidence, not a claim: a read
   * that fails (no such pod, a container that never started, no RBAC) answers `""`, because this
   * is only ever called to explain a failure that already happened (ADR-0046) and a diagnosis
   * that can itself fail is a second failure on top of the first. `previous` asks for the
   * container instance BEFORE the current one, which is the only place a CrashLoopBackOff pod's
   * crash is still written down. */
  logs(opts: {
    namespace: string;
    pod: string;
    container?: string;
    tailLines?: number;
    previous?: boolean;
    context?: string;
  }): Promise<string>;
  /** The API server's `gitVersion` (`kubectl get --raw /version`), e.g. `v1.35.0-gke.1200` — what
   * ADR-0037's Kubernetes floor is judged against. THROWS when the server does not answer, like
   * `listJson`: a floor check that passed because it could not look is no check at all. */
  serverVersion(opts: { context?: string }): Promise<string>;
  /** `kubectl create --dry-run=server -o json -f -`: the object as admission would store it,
   * stored nowhere. THROWS on a refusal, with kubectl's reason. */
  dryRunCreate(opts: { manifest: string; context?: string }): Promise<{ spec?: { resources?: unknown } }>;
  /** Wait until one pod has run to its end, and read its logs — the provider preflight's seam
   * (ADR-0019, ADR-0059). Its pod has a Custodian beside the probe, which `kubectl run` cannot
   * make, so `jr2 up` applies it and waits here. Two bounds: `startSeconds` until the probe
   * container runs (the image pulls and the Custodian's start), then `runSeconds` for the probe. It
   * stops early on a pod that cannot start (`podProgress`). Never throws. */
  awaitPodEnd(opts: {
    namespace: string;
    name: string;
    container: string;
    startSeconds: number;
    runSeconds: number;
    context?: string;
    /** Called with each new reason the pod gives for not running yet (`Unschedulable: …`). */
    onPending?: (line: string) => void;
    /** Called with the check container's log on each poll while it runs. */
    onLog?: (log: string) => void;
  }): Promise<PodEnd>;
};

/** How one pod ended (`awaitPodEnd`). `phase` is the pod's own, or `stuck` (it cannot start:
 * `stuck` says why) or `timeout` (`started` says whether the probe ran). `output` is the probe
 * container's whole log; `custodian` the Custodian's, its previous run's first when it restarted.
 * `reasons` is each container's waiting or ended reason as the kubelet says it. */
export type PodEnd = {
  phase: "Succeeded" | "Failed" | "stuck" | "timeout";
  started: boolean;
  stuck?: string;
  output: string;
  custodian: string;
  reasons: string[];
};

/** A container's status as the kubelet reports it: the part `podProgress` reads. */
type ProbeContainerStatus = {
  name?: string;
  restartCount?: number;
  state?: Record<string, { reason?: string; message?: string }>;
  /** Why the run before the current one ended: where an OOMKilled sidecar says so. */
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
};

/** The pod as `podProgress` reads it. */
export type ProbePodObject = {
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    initContainerStatuses?: ProbeContainerStatus[];
    containerStatuses?: ProbeContainerStatus[];
  };
};

/** Why a pod that has not ended is not running yet, for a person who waits on it: the scheduler's
 * reason, else the first container's waiting reason, else its phase. Undefined when it gives none,
 * and for a pod that runs with no container waiting. */
export function podPending(pod: ProbePodObject | undefined): string | undefined {
  const unscheduled = pod?.status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
  if (unscheduled)
    return `${unscheduled.reason ?? "not scheduled"}${unscheduled.message ? `: ${unscheduled.message}` : ""}`;
  const statuses = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])];
  for (const c of statuses) {
    const waiting = c.state?.waiting;
    if (waiting?.reason) return `${c.name ?? "?"}: ${waiting.reason}`;
  }
  // A pod that runs, with no container waiting, is not waiting to start: its check is on its way.
  return pod?.status?.phase === "Running" ? undefined : pod?.status?.phase;
}

/** A volume a pod cannot mount because a Secret, a ConfigMap or a key it names is missing: the
 * kubelet keeps the pod in ContainerCreating and says so in a FailedMount event alone — `secret "x"
 * not found`, `references non-existent secret key: y`, `configmap references non-existent config
 * key`. The first such event can be a race with the objects that the same apply wrote, so it counts
 * only when the kubelet says it again: its `count` or `lastTimestamp` went up since an earlier
 * poll. `seen` keeps each message's last value from poll to poll. */
export function failedMount(
  events: ReadonlyArray<{ reason?: string; message?: string; count?: number; lastTimestamp?: string }>,
  seen: Map<string, string>,
): string | undefined {
  let found: string | undefined;
  for (const e of events) {
    if (e.reason !== "FailedMount" || !/not found|non-existent|couldn't find key|does not exist/i.test(e.message ?? ""))
      continue;
    const message = e.message ?? "";
    const mark = `${e.count ?? 1}|${e.lastTimestamp ?? ""}`;
    const before = seen.get(message);
    if (before !== undefined && before !== mark) found ??= `FailedMount: ${message}`;
    seen.set(message, mark);
  }
  return found;
}

/** The waiting reasons from which a pod does not come back by itself (ADR-0019): an image no node
 * can pull, a Secret or ConfigMap key it names that is missing, a container that crashes at start. */
export const TERMINAL_WAITING = new Set(["InvalidImageName", "CreateContainerConfigError", "CrashLoopBackOff"]);

/** A pull that ends with one of these comes back by itself (a slow registry, a timeout, a rate
 * limit); a pull whose message says that the image or the right to it is not there does not. */
const PULL_WAITING = new Set(["ErrImagePull", "ImagePullBackOff"]);
const PULL_FINAL = /not found|manifest unknown|unauthorized|denied/i;

/**
 * Where a probe pod is (`awaitPodEnd`): ended (`phase`), unable to start (`stuck`, the reason), or
 * still on its way, with whether `container` runs yet. A restart of `sidecar` is `stuck`: the
 * Custodian restarts only when it refused to start, and the next start refuses alike. Pure, for its
 * test.
 */
export function podProgress(
  pod: ProbePodObject | undefined,
  container: string,
  sidecar: string,
): { phase?: "Succeeded" | "Failed"; stuck?: string; running: boolean; reasons: string[] } {
  const statuses = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])];
  const reasons = statuses.flatMap((c) => [
    ...Object.entries(c.state ?? {}).flatMap(([state, s]) =>
      s.reason || s.message ? [`${c.name ?? "?"}: ${state} ${s.reason ?? ""} ${s.message ?? ""}`.trim()] : [],
    ),
    ...(c.lastState?.terminated?.reason ? [`${c.name ?? "?"}: last ended ${c.lastState.terminated.reason}`] : []),
  ]);
  const running = statuses.some((c) => c.name === container && c.state?.running !== undefined);
  const phase = pod?.status?.phase;
  if (phase === "Succeeded" || phase === "Failed") return { phase, running, reasons };
  for (const c of statuses) {
    const waiting = c.state?.waiting?.reason;
    const pullFinal =
      waiting !== undefined && PULL_WAITING.has(waiting) && PULL_FINAL.test(c.state?.waiting?.message ?? "");
    if (waiting && (TERMINAL_WAITING.has(waiting) || pullFinal)) {
      const last = c.lastState?.terminated?.reason;
      return { stuck: `${c.name ?? "?"}: ${waiting}${last ? ` (last ended ${last})` : ""}`, running, reasons };
    }
    if (c.name === sidecar && (c.restartCount ?? 0) > 0) {
      const last = c.lastState?.terminated?.reason;
      return { stuck: `${sidecar}: restarted${last ? ` (last ended ${last})` : ""}`, running, reasons };
    }
  }
  return { running, reasons };
}

/** What `waitPodEnd` reads the pod and the clock through: kubectl and the wall clock in
 * `kubectlAdmin`, a script and a fake clock in its test. */
export type PodEndPorts = {
  pod(): Promise<ProbePodObject | undefined>;
  /** The pod's events: where a FailedMount is told. */
  events(): Promise<Array<{ reason?: string; message?: string; count?: number; lastTimestamp?: string }>>;
  /** Each new reason the pod gives for not running yet. */
  pending?(line: string): void;
  /** The container's log so far, on each poll while it runs: its results as they come. */
  log?(output: string): void;
  logs(container: string, opts: { tailLines: number; previous?: boolean }): Promise<string>;
  sleep(ms: number): Promise<unknown>;
  now(): number;
};

/**
 * The wait of `awaitPodEnd`: poll the pod every 2 s until it ends (`podProgress`), cannot start
 * (a terminal waiting reason, a Custodian restart, a `FailedMount` event), or runs out of time —
 * `startSeconds` until `container` runs, then `runSeconds` from then on. While it waits to start,
 * each new reason it gives goes to `pending`. Then it reads the logs: the probe's whole log, for
 * every model's line, read again when a pod that ended answers nothing; and the Custodian's last
 * 50 lines, its run before first when it restarted.
 */
export async function waitPodEnd(
  ports: PodEndPorts,
  opts: { container: string; startSeconds: number; runSeconds: number },
): Promise<PodEnd> {
  const startBy = ports.now() + opts.startSeconds * 1000;
  let runBy: number | undefined;
  let seen: ReturnType<typeof podProgress>;
  let end: PodEnd["phase"];
  let restarted = false;
  let said: string | undefined;
  const mounts = new Map<string, string>();
  for (;;) {
    const pod = await ports.pod();
    seen = podProgress(pod, opts.container, "custodian");
    restarted ||= seen.stuck?.startsWith("custodian: restarted") === true;
    if (seen.running && runBy === undefined) runBy = ports.now() + opts.runSeconds * 1000;
    if (seen.phase) {
      end = seen.phase;
      break;
    }
    if (!seen.stuck && !seen.running) {
      const mount = failedMount(await ports.events(), mounts);
      if (mount) seen = { ...seen, stuck: mount };
    }
    if (seen.stuck) {
      end = "stuck";
      break;
    }
    if (ports.now() >= (runBy ?? startBy)) {
      end = "timeout";
      break;
    }
    if (seen.running && ports.log) ports.log(await ports.logs(opts.container, { tailLines: -1 }));
    const pending = seen.running ? undefined : podPending(pod);
    if (pending && pending !== said) ports.pending?.(pending);
    said = pending;
    await ports.sleep(2000);
  }
  // The whole log: one line per model. A probe that ended always wrote one, so an empty read is a
  // read that failed (kubectl answers nothing then): read again before calling it empty.
  let output = await ports.logs(opts.container, { tailLines: -1 });
  for (let n = 0; n < 3 && !output.trim() && (end === "Succeeded" || end === "Failed"); n++) {
    await ports.sleep(1000);
    output = await ports.logs(opts.container, { tailLines: -1 });
  }
  const custodian = [
    ...(restarted ? [await ports.logs("custodian", { tailLines: 50, previous: true })] : []),
    await ports.logs("custodian", { tailLines: 50 }),
  ].join("\n");
  return {
    phase: end,
    started: runBy !== undefined,
    ...(seen.stuck ? { stuck: seen.stuck } : {}),
    output,
    custodian,
    reasons: seen.reasons,
  };
}

const nsArgs = (namespace?: string): string[] => (namespace ? ["--namespace", namespace] : []);

/** The workload kinds `jr2 up` rolls out and waits on. */
export type RolloutKind = "deployment" | "daemonset" | "statefulset";

/** One rollout to wait for: the object, by kind and name, in its namespace. */
export type RolloutRequest = {
  /** Default `deployment`. */
  kind?: RolloutKind;
  name: string;
  namespace: string;
  context?: string;
  timeoutSeconds?: number;
};

/** The argv of one rollout wait — pure, so the kind → `kubectl rollout status <kind>/<name>` mapping
 * is checkable without a cluster. */
export function rolloutStatusArgs({
  kind = "deployment",
  name,
  namespace,
  context,
  timeoutSeconds = 180,
}: RolloutRequest): string[] {
  return [
    ...ctxArgs(context),
    ...nsArgs(namespace),
    "rollout",
    "status",
    `${kind}/${name}`,
    `--timeout=${timeoutSeconds}s`,
  ];
}

/** ADR-0037's Kubernetes floor: every Sandbox's `/opt/jr2` is an `image` volume of the harness
 * image, and image volumes are on by default from 1.35 (GA in 1.36). There is no fallback below it
 * — a second pod shape kept alive for clusters no Instance runs on — so `jr2 up` refuses there. */
export const KUBE_FLOOR = { major: 1, minor: 35 } as const;

/**
 * Why this server version cannot host an Instance, or undefined when it can. Pure, so the floor is
 * checkable without a cluster. Judged on the leading `v<major>.<minor>` alone: distributions append
 * their own suffixes (`-gke.1200`, `+k3s1`, `-eks-…`), and none of them moves the feature gate. A
 * version with no such prefix is refused BY NAME rather than passed — a floor that waves through
 * what it cannot read is the timeout ADR-0046 exists to replace.
 */
export function kubeFloorRefusal(gitVersion: string): string | undefined {
  const floor = `${KUBE_FLOOR.major}.${KUBE_FLOOR.minor}`;
  const why = `jr2 needs Kubernetes ${floor} or newer (every Sandbox mounts jr2's runtime as an image volume, ADR-0037)`;
  const m = /^v?(\d+)\.(\d+)/.exec(gitVersion);
  if (!m) return `reports version "${gitVersion}", which names no major.minor; ${why}`;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > KUBE_FLOOR.major || (major === KUBE_FLOOR.major && minor >= KUBE_FLOOR.minor)) return undefined;
  return `runs Kubernetes ${gitVersion}; ${why}`;
}

/**
 * Did this read fail because the cluster has no such RESOURCE TYPE (`kubectl get sandboxes… ` on a
 * cluster with no jr2 CRD)? kubectl exits 1 with `the server doesn't have a resource type "…"`, and
 * that single failure means something no other one does: the kind cannot exist, so neither can any
 * object of it. Narrow on purpose — Forbidden and "connection refused" DID hide objects, and a
 * caller that degraded on those would build a keep set that deletes another instance's images.
 */
export function isMissingResourceType(err: unknown): boolean {
  return /doesn't have a resource type/i.test(err instanceof Error ? err.message : String(err));
}

/** The real admin port, over `kubectl` subprocesses. */
export const kubectlAdmin: KubeAdmin = {
  context: () => kubectlKube.currentContext(),

  async getJson({ kind, name, namespace, context }) {
    try {
      const { stdout } = await exec("kubectl", [
        ...ctxArgs(context),
        ...nsArgs(namespace),
        "get",
        kind,
        name,
        "-o",
        "json",
      ]);
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  },

  async listJson({ kind, selector, fieldSelector, namespace, allNamespaces, context }) {
    const { stdout } = await exec(
      "kubectl",
      [
        ...ctxArgs(context),
        ...nsArgs(namespace),
        "get",
        kind,
        // AFTER the kind, unlike `--namespace`: kubectl reads a `--all-namespaces` that precedes
        // `get` as a plugin invocation and fails with "flags cannot be placed before plugin name".
        ...(!namespace && allNamespaces ? ["--all-namespaces"] : []),
        ...(selector ? ["-l", selector] : []),
        ...(fieldSelector ? ["--field-selector", fieldSelector] : []),
        "-o",
        "json",
      ],
      // A cluster-wide pod list (the sweep's third root, ADR-0039) blows past execFile's 1 MB
      // default on any cluster with real workloads, and a truncated read is a SMALLER keep set.
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return (JSON.parse(stdout) as { items?: never[] }).items ?? [];
  },

  async apply({ manifest, context, serverSide }) {
    const mode = serverSide ? ["--server-side", "--force-conflicts", "--field-manager=jr2"] : [];
    await execStdin(["kubectl", ...ctxArgs(context), "apply", ...mode, "-f", "-"], manifest);
  },

  async label({ kind, name, namespace, labels, context }) {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
    await exec("kubectl", [...ctxArgs(context), ...nsArgs(namespace), "label", "--overwrite", kind, name, ...pairs]);
  },

  async deleteObject({ kind, name, namespace, context, wait }) {
    await exec("kubectl", [
      ...ctxArgs(context),
      ...nsArgs(namespace),
      "delete",
      kind,
      name,
      "--ignore-not-found",
      `--wait=${wait !== false}`,
    ]);
  },

  async deleteManifest({ manifest, context }) {
    await execStdin(["kubectl", ...ctxArgs(context), "delete", "--ignore-not-found", "-f", "-"], manifest);
  },

  async waitRollout(req) {
    await exec("kubectl", rolloutStatusArgs(req));
  },

  async logs({ namespace, pod, container, tailLines = 20, previous, context }) {
    try {
      const { stdout } = await exec("kubectl", [
        ...ctxArgs(context),
        ...nsArgs(namespace),
        "logs",
        pod,
        ...(container ? ["-c", container] : []),
        `--tail=${tailLines}`,
        ...(previous ? ["--previous"] : []),
      ]);
      return stdout;
    } catch {
      return ""; // "the container wrote nothing readable" IS the answer here — see the port's doc
    }
  },

  async serverVersion({ context }) {
    // `get --raw /version`, not `kubectl version`: that one reports the CLIENT too; this asks the
    // server alone, and answers in the server's own JSON. Bounded like every first contact: it is
    // the first thing `jr2 up` asks, so a dead context fails here, fast, with kubectl's own reason.
    try {
      const { stdout } = await exec("kubectl", [...ctxArgs(context), "get", "--raw", "/version", ...reachArgs], {
        timeout: REACH_BUDGET_MS,
      });
      return (JSON.parse(stdout) as { gitVersion?: string }).gitVersion ?? "";
    } catch (e) {
      throw new Error(unreachable(e));
    }
  },

  async dryRunCreate({ manifest, context }) {
    const out = await execStdinOut(
      ["kubectl", ...ctxArgs(context), "create", "--dry-run=server", "-o", "json", "-f", "-"],
      manifest,
    );
    return JSON.parse(out) as { spec?: { resources?: unknown } };
  },

  async awaitPodEnd({ namespace, name, container, startSeconds, runSeconds, context, onPending, onLog }) {
    const ctx = context ? { context } : {};
    return waitPodEnd(
      {
        pod: () => kubectlAdmin.getJson<ProbePodObject>({ kind: "pod", name, namespace, ...ctx }),
        // A read that fails is no event: the wait goes on, and its bounds still hold.
        events: () =>
          kubectlAdmin
            .listJson<{ reason?: string; message?: string; count?: number; lastTimestamp?: string }>({
              kind: "event",
              fieldSelector: `involvedObject.name=${name}`,
              namespace,
              ...ctx,
            })
            .catch(() => []),
        ...(onPending ? { pending: onPending } : {}),
        ...(onLog ? { log: onLog } : {}),
        logs: (c, opts) => kubectlAdmin.logs({ namespace, pod: name, container: c, ...opts, ...ctx }),
        sleep,
        now: Date.now,
      },
      { container, startSeconds, runSeconds },
    );
  },
};

/** What a rollout wait needs to know to go looking: the workload that did not come up (a Deployment
 * unless `kind` says otherwise), and the label selector its pods carry (each converge layer already
 * knows its own — it verifies the running image through the same selector). */
export type RolloutTarget = {
  kind?: RolloutKind;
  name: string;
  namespace: string;
  selector: string;
  context?: string;
  /** Default 180s (see `rolloutStatusArgs`). */
  timeoutSeconds?: number;
};

/** One container's state, as the kubelet tells it. `reason`/`message` are its words verbatim — the
 * diagnosis table below may annotate them, never restate them (ADR-0046).
 *
 * `lastExit` is carried BESIDE them and never instead: a container in CrashLoopBackOff is WAITING,
 * and its waiting message is the uninformative "back-off 40s restarting failed container" while the
 * sentence that says why ("exec format error") sits in the exit it is backing off from. Keeping
 * only the current state is exactly how the ADR-0045 failure stayed invisible. */
type ContainerEvidence = {
  name: string;
  image?: string;
  ready?: boolean;
  restarts?: number;
  reason?: string;
  message?: string;
  lastExit?: string;
};

/** One pod's whole story: what it is, where it landed, what its containers say, what the cluster
 * said about it, and the tail of the container that is not running. */
type PodEvidence = {
  name: string;
  phase?: string;
  node?: string;
  nodeArch?: string;
  containers: ContainerEvidence[];
  events: string[];
  logs?: { container: string; text: string };
};

/** Everything the failed rollout could be seen to say. `notes` carries the reads that could NOT be
 * made, said out loud: a silent gap here reads as "the cluster had nothing to say", which is the
 * exact lie this diagnosis exists to stop telling. */
type RolloutEvidence = { pods: PodEvidence[]; notes: string[] };

/** How many pods are worth printing. A failed rollout is usually one pod saying one thing; past a
 * handful the message stops being read at all. */
const EVIDENCE_PODS = 3;

type PodStatusObject = {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { nodeName?: string; containers?: Array<{ name?: string; image?: string }> };
  status?: {
    phase?: string;
    containerStatuses?: ContainerStatusObject[];
    initContainerStatuses?: ContainerStatusObject[];
  };
};

type TerminatedState = { reason?: string; exitCode?: number; message?: string };

type ContainerStatusObject = {
  name?: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: TerminatedState };
  lastState?: { terminated?: TerminatedState };
};

type EventObject = {
  metadata: { name: string; creationTimestamp?: string };
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind?: string; name?: string };
};

/**
 * A rollout's failure, made readable (ADR-0046). `kubectl rollout status` reports its verdict and
 * nothing else — `error: timed out waiting for the condition` — so the fact that says WHY (an
 * `exec format error`, a pull the kubelet gave up on, a Secret that is not there) lives in the
 * pods, which the caller then goes and reads by hand. So the evidence leads, kubectl's verdict follows, and `jr2 up`'s three rollout waits share the one pair
 * of eyes.
 *
 * Every read here is best-effort by construction. It runs only after a failure has already
 * happened, so a diagnosis that can itself throw would replace a bad error with a worse one.
 */
export async function rolloutFailure(kube: KubeAdmin, err: unknown, target: RolloutTarget): Promise<Error> {
  const verdict = (err instanceof Error ? err.message : String(err)).trim();
  let evidence: RolloutEvidence;
  try {
    evidence = await gatherRolloutEvidence(kube, target);
  } catch (gatherErr) {
    evidence = { pods: [], notes: [`the pods could not be read (${errText(gatherErr)})`] };
  }
  const lines = [
    `${target.name}: rollout did not complete in namespace ${target.namespace} — the pods say:`,
    "",
    ...renderEvidence(evidence, target),
  ];
  // The named diagnoses sit BETWEEN the evidence and the verdict, and only ever point at what is
  // printed above them: a table that swallowed the evidence would turn a wrong match into a lie,
  // while one that annotates it costs nothing when wrong (ADR-0046).
  const diagnosis = diagnoseRollout(evidence, target);
  if (diagnosis.length > 0) lines.push("", ...diagnosis);
  if (verdict) lines.push("", verdict);
  return new Error(lines.join("\n"));
}

/** One error's words, whatever was thrown — every gathering read reports its own failure this way. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Read once, degrade per read: a listing that fails becomes a note, never an exception. */
async function gatherRolloutEvidence(kube: KubeAdmin, target: RolloutTarget): Promise<RolloutEvidence> {
  const { namespace, selector } = target;
  const ctx = target.context ? { context: target.context } : {};
  const notes: string[] = [];

  let pods: PodStatusObject[] = [];
  try {
    pods = await kube.listJson<PodStatusObject>({ kind: "pod", selector, namespace, ...ctx });
  } catch (err) {
    notes.push(`pods matching ${selector} could not be listed (${errText(err)})`);
  }
  // Pods on the way out belong to the OUTGOING ReplicaSet: they are what the cluster is done
  // running, not what refused to come up.
  const live = pods.filter((p) => !p.metadata.deletionTimestamp);
  if (pods.length > 0 && live.length === 0) notes.push(`every pod matching ${selector} is terminating`);
  if (pods.length === 0 && notes.length === 0) {
    const maker =
      target.kind === "daemonset"
        ? "the DaemonSet"
        : target.kind === "statefulset"
          ? "the StatefulSet"
          : "the ReplicaSet";
    notes.push(`no pod matches ${selector} — ${maker} made none (check quota, node taints, and the selector)`);
  }

  let events: EventObject[] = [];
  try {
    events = await kube.listJson<EventObject>({ kind: "event", namespace, ...ctx });
  } catch (err) {
    notes.push(`events could not be listed (${errText(err)})`);
  }

  const chosen = [...live].sort(byTrouble).slice(0, EVIDENCE_PODS);
  const out: PodEvidence[] = [];
  for (const pod of chosen) {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    // A pod that never got as far as a container status (unschedulable, still Pending) still has a
    // spec, and the refs it names are evidence — the empty case must not print an empty pod.
    const containers: ContainerEvidence[] =
      statuses.length > 0
        ? statuses.map((s) => containerEvidence(s, pod))
        : (pod.spec?.containers ?? []).map((c) => ({
            name: c.name ?? "(unnamed)",
            ...(c.image ? { image: c.image } : {}),
          }));
    // The container to quote is the one that is NOT running: an init container that failed blocks
    // everything behind it, so it is read first.
    const troubled = statuses.find((s) => s.ready !== true) ?? statuses[0];
    const evidence: PodEvidence = {
      name: pod.metadata.name,
      phase: pod.status?.phase,
      node: pod.spec?.nodeName,
      containers,
      events: podEvents(events, pod.metadata.name),
    };
    // The node's architecture is what an `exec format error` is measured against (ADR-0045), and
    // it is one cheap read of an object the pod already names.
    if (pod.spec?.nodeName) {
      const node = await kube.getJson<{ status?: { nodeInfo?: { architecture?: string } } }>({
        kind: "node",
        name: pod.spec.nodeName,
        ...ctx,
      });
      const arch = node?.status?.nodeInfo?.architecture;
      if (arch) evidence.nodeArch = arch;
    }
    if (troubled?.name) {
      // The current instance first, then the one before it: a container in CrashLoopBackOff has
      // already been torn down, so its own words survive only under `--previous`.
      const text =
        (await kube.logs({ namespace, pod: pod.metadata.name, container: troubled.name, tailLines: 20, ...ctx })) ||
        (await kube.logs({
          namespace,
          pod: pod.metadata.name,
          container: troubled.name,
          tailLines: 20,
          previous: true,
          ...ctx,
        }));
      if (text.trim()) evidence.logs = { container: troubled.name, text: text.trim() };
    }
    out.push(evidence);
  }
  if (live.length > out.length) notes.push(`${live.length - out.length} further pod(s) not shown`);
  return { pods: out, notes };
}

/** Not-ready pods first — the ones that failed are the ones worth the space. A pod with NO container
 * statuses at all is trouble too, not the absence of it: that is a pod the kubelet never got as far
 * as starting (unschedulable, still Pending), which is exactly the one a failed rollout is about —
 * and `every` on an empty list would otherwise sort it last, behind the pods that came up. */
function byTrouble(a: PodStatusObject, b: PodStatusObject): number {
  const ready = (p: PodStatusObject): number => {
    const statuses = p.status?.containerStatuses ?? [];
    return statuses.length > 0 && statuses.every((c) => c.ready === true) ? 1 : 0;
  };
  return ready(a) - ready(b);
}

function containerEvidence(status: ContainerStatusObject, pod: PodStatusObject): ContainerEvidence {
  const waiting = status.state?.waiting;
  const ended = status.state?.terminated;
  const before = status.lastState?.terminated;
  const out: ContainerEvidence = { name: status.name ?? "(unnamed)" };
  // The SPEC's ref, not the status's: the spec carries the ref this converge asked for, while the
  // status may carry whatever the kubelet resolved it to (or nothing, on a pull that never landed).
  const image = pod.spec?.containers?.find((c) => c.name === status.name)?.image ?? status.image;
  if (image) out.image = image;
  if (status.ready !== undefined) out.ready = status.ready;
  if (status.restartCount) out.restarts = status.restartCount;
  if (waiting?.reason) out.reason = waiting.reason;
  else if (ended) out.reason = `${ended.reason ?? "Terminated"} (exit ${ended.exitCode ?? "?"})`;
  const msg = waiting?.message ?? ended?.message;
  if (msg) out.message = msg.trim();
  // A WAITING container is backing off from an exit that already happened, and that exit is where
  // the cause is written (see {@link ContainerEvidence}) — so it is carried beside the waiting
  // words, never in place of them.
  if (waiting && before) {
    out.lastExit = [
      `last exit ${before.exitCode ?? "?"}`,
      ...(before.reason ? [`(${before.reason})`] : []),
      ...(before.message ? [`— ${before.message.trim()}`] : []),
    ].join(" ");
  }
  return out;
}

/** The events about one pod, oldest first, last few only — the kubelet's own narration. */
function podEvents(events: EventObject[], pod: string): string[] {
  const when = (e: EventObject): string => e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? "";
  return events
    .filter((e) => e.involvedObject?.name === pod)
    .sort((a, b) => when(a).localeCompare(when(b)))
    .slice(-4)
    .map((e) => `${e.type ?? "Normal"} ${e.reason ?? "?"}: ${(e.message ?? "").trim()}`);
}

/** The evidence, printed raw — the thing every named diagnosis is only allowed to annotate. */
function renderEvidence(evidence: RolloutEvidence, target: RolloutTarget): string[] {
  const lines: string[] = [];
  for (const pod of evidence.pods) {
    const where = pod.node ? ` on node ${pod.node}${pod.nodeArch ? ` (${pod.nodeArch})` : ""}` : "";
    lines.push(`  pod ${pod.name} (${pod.phase ?? "phase unknown"})${where}`);
    for (const c of pod.containers) {
      const restarts = c.restarts ? `, ${c.restarts} restart(s)` : "";
      lines.push(`    container ${c.name}: ${c.reason ?? (c.ready ? "ready" : "not ready")}${restarts}`);
      if (c.image) lines.push(`      image ${c.image}`);
      if (c.message) for (const l of c.message.split("\n")) lines.push(`      ${l}`);
      if (c.lastExit) for (const l of c.lastExit.split("\n")) lines.push(`      ${l}`);
    }
    for (const e of pod.events) lines.push(`    event ${e}`);
    if (pod.logs) {
      lines.push(`    logs (${pod.logs.container}, last lines):`);
      for (const l of pod.logs.text.split("\n")) lines.push(`      | ${l}`);
    }
  }
  for (const note of evidence.notes) lines.push(`  ${note}`);
  if (lines.length === 0) lines.push(`  (nothing readable matched ${target.selector})`);
  return lines;
}

/**
 * The named diagnoses (ADR-0046): four causes someone actually hit, each naming the way back. They
 * ANNOTATE the evidence above them and never replace it — every claim here is about text the
 * message already printed raw, so a wrong match costs a wrong sentence and no facts.
 */
function diagnoseRollout(evidence: RolloutEvidence, target: RolloutTarget): string[] {
  const lines: string[] = [];
  for (const pod of evidence.pods) {
    const said = [
      ...pod.containers.map((c) => `${c.reason ?? ""} ${c.message ?? ""} ${c.lastExit ?? ""}`),
      ...pod.events,
      pod.logs?.text ?? "",
    ].join("\n");
    const ref = pod.containers.find((c) => c.ready !== true)?.image ?? pod.containers[0]?.image;

    // 1. The failure that produced ADR-0045, still named here: belt-and-braces, and the only trace
    // left for a pre-0045 image or a registry-ref Sandbox Image jr2 never built.
    const wrongPlatform = /exec format error/i.test(said);
    if (wrongPlatform) {
      const built = taggedPlatforms(ref);
      lines.push(
        `diagnosis: ${pod.name} carries an image built for another platform — the node cannot run its binaries.`,
        `  image ${ref ?? "(unknown)"}${built ? ` — its tag names ${built}` : " — its tag names no platform"}`,
        `  node  ${pod.node ?? "(unknown)"}${pod.nodeArch ? ` runs ${pod.nodeArch}` : ""}`,
        `  \`jr2 up\` builds for the platforms the cluster's nodes report (ADR-0045); re-run it with --force to` +
          ` rebuild this image, or name the set with \`platforms\` in jr2.config.ts.`,
      );
    }

    // 2. A ref the kubelet could not fetch. The trap is the bare ref: no registry host means Docker
    // Hub, which is never where a jr2-built image is.
    if (/ImagePullBackOff|ErrImagePull/i.test(said)) {
      lines.push(
        `diagnosis: the kubelet could not pull ${ref ?? "the image"}.`,
        `  it resolves to ${resolveRef(ref)}`,
        ...(isBareRef(ref)
          ? [
              `  a ref with no registry host resolves to Docker Hub, so an image jr2 built locally must have been` +
                ` delivered to this cluster (kind load, or a push to the configured \`registry\`) — \`jr2 up --force\`` +
                ` rebuilds and re-delivers it.`,
            ]
          : [`  check the push landed there and that this cluster may pull from it (credentials, network, mirror).`]),
      );
    }

    // 3. The container ran, so its own last words are the diagnosis; this entry exists to say
    // "read the tail above", not to interpret it. Yielded to the entry above when the crash it
    // backs off from is a platform mismatch: that is the same crash with a cause attached, and two
    // names for one failure is how a table starts lying.
    if (!wrongPlatform && /CrashLoopBackOff/i.test(said)) {
      lines.push(
        pod.logs
          ? `diagnosis: ${pod.name} starts and exits — the log tail above is what it said on its way out.`
          : `diagnosis: ${pod.name} starts and exits, and wrote nothing readable — ` +
              `\`kubectl -n ${target.namespace} logs ${pod.name} --previous\` once it restarts again.`,
      );
    }

    // 4. What slipped past the converge's own `envFrom` preflight (ADR-0019): the kubelet names the
    // object it could not find, so the diagnosis is to repeat that name where it can be seen.
    if (/CreateContainerConfigError/i.test(said)) {
      const missing = /(secret|configmap)\s+"([^"]+)"\s+not found/i.exec(said);
      lines.push(
        missing
          ? `diagnosis: the pod's env references ${missing[1]!.toLowerCase()} "${missing[2]}", which this namespace` +
              ` does not hold — create it, then re-run \`jr2 up\`.`
          : `diagnosis: the container's configuration cannot be built from what the namespace holds — the object it` +
              ` names is in the message above.`,
      );
    }
  }
  return lines;
}

/** The platforms a content-addressed tag names (ADR-0045: `<hash>-<arch>[-<arch>]`), or undefined
 * for a tag that names none — a pre-0045 image, or a ref jr2 never built. */
function taggedPlatforms(ref?: string): string | undefined {
  if (!ref) return undefined;
  const tag = ref.slice(ref.lastIndexOf(":") + 1);
  const suffix = /(?:-(?:amd64|arm64|arm|386|s390x|ppc64le|riscv64))+$/.exec(tag);
  return suffix ? suffix[0].slice(1).split("-").join(" + ") : undefined;
}

/** Does this ref name a registry at all? Docker's own rule: only a FIRST PATH SEGMENT — there must
 * be a `/` — that carries a dot, a port, or is `localhost` is a registry host. Everything else is a
 * Docker Hub path, and `jr2-instance-demo:4a77b1-amd64` is the trap this exists to name: the colon
 * belongs to the tag, so the ref has no host and the kubelet asks Docker Hub for it. */
function isBareRef(ref?: string): boolean {
  if (!ref) return false;
  const slash = ref.indexOf("/");
  if (slash === -1) return true;
  const first = ref.slice(0, slash);
  return !(first.includes(".") || first.includes(":") || first === "localhost");
}

/** What the kubelet will actually ask for — the same normalization docker applies, spelled out. */
function resolveRef(ref?: string): string {
  if (!ref) return "(unknown)";
  if (!isBareRef(ref)) return ref;
  return `docker.io/${ref.includes("/") ? ref : `library/${ref}`}`;
}

/** Run a command feeding `stdin`, surfacing stderr in the thrown error (kubectl's messages are the
 * useful part of an apply failure). */
function execStdin(cmd: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd.join(" ")} exited (${code}): ${err.trim()}`)),
    );
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** `execStdin`, keeping stdout. */
function execStdinOut(cmd: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1));
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd.join(" ")} exited (${code}): ${err.trim()}`)),
    );
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * The pod ADR-0060's check dry-runs: one that states pod-level resources (KEP-2837). A server
 * whose PodLevelResources gate is off drops `spec.resources` at admission without a word, and
 * every Sandbox then runs Burstable — a User Container with no split unbounded, against "jr2
 * reserves the whole Size". On by default from 1.34, below KUBE_FLOOR, so only an owner who turned
 * it off trips this. Shaped for the `restricted` Pod Security level, so a namespace that enforces
 * it does not refuse the probe for another reason. Never scheduled, never pulled.
 */
export function podResourcesProbe(namespace: string): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "jr2-pod-resources-probe", namespace },
    spec: {
      resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "10m", memory: "16Mi" } },
      securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "probe",
          image: "registry.k8s.io/pause:3.10",
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        },
      ],
    },
  };
}

/** The real kube port, over `kubectl` subprocesses. */
export const kubectlKube: KubePort = {
  async currentContext() {
    try {
      const { stdout } = await exec("kubectl", ["config", "current-context"]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },

  // `--ignore-not-found` is what separates the two faults BY EXIT CODE rather than by matching on
  // kubectl's English: an absent Secret exits 0 with empty stdout, and everything else — no route,
  // no credentials, RBAC refusing the read — exits non-zero and is reported rather than swallowed.
  async readSecret({ namespace, name, key, context }) {
    try {
      const { stdout } = await exec(
        "kubectl",
        [
          ...ctxArgs(context),
          "--namespace",
          namespace,
          "get",
          "secret",
          name,
          "--ignore-not-found",
          "-o",
          `jsonpath={.data.${key}}`,
          ...reachArgs,
        ],
        { timeout: REACH_BUDGET_MS },
      );
      return stdout ? Buffer.from(stdout, "base64").toString("utf8") : undefined;
    } catch (e) {
      throw new Error(unreachable(e));
    }
  },

  // `:port` asks kubectl for an ephemeral local port, announced on its stdout as
  // "Forwarding from 127.0.0.1:<local> -> <remote>" — parsed rather than raced.
  portForward({ namespace, service, port, context }) {
    return new Promise((resolve, reject) => {
      const child = spawn("kubectl", [
        ...ctxArgs(context),
        "--namespace",
        namespace,
        "port-forward",
        `service/${service}`,
        `:${port}`,
      ]);
      let out = "";
      let err = "";
      // The forward is long-lived by design, so the bound is on its FIRST BYTE, not on the child:
      // silence here is the same unreachable cluster the Secret read just survived, and a verb that
      // waits forever for the announcement has only moved the hang one line down.
      const gaveUp = setTimeout(() => {
        child.kill();
        reject(new Error(`kubectl port-forward: no answer after ${REACH_BUDGET_MS / 1000}s`));
      }, REACH_BUDGET_MS);
      gaveUp.unref?.();
      const settle =
        <T>(f: (v: T) => void) =>
        (v: T) => {
          clearTimeout(gaveUp);
          f(v);
        };
      const done = settle(resolve);
      const failed = settle(reject);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) done({ url: `http://127.0.0.1:${m[1]}`, close: () => child.kill() });
      });
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => failed(new Error(`kubectl port-forward failed: ${e.message}`)));
      child.on("close", (code) => failed(new Error(`kubectl port-forward exited (${code}): ${err.trim()}`)));
    });
  },
};
