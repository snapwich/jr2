// The CLI's kube transport (ADR-0019): run-verbs reach a deployed orchestrator by port-forwarding
// its Service via the kube API for the duration of the command, authenticating with the Instance
// token read from its in-cluster Secret — kube RBAC is the real gate. This module is the seam:
// `KubePort` is what target resolution consumes (tests inject a fake), `kubectlKube` is the real
// one, shelling out to the same `kubectl` a human debugging the cluster would use.

import { execFile, spawn } from "node:child_process";
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
export { INSTANCE_SECRET, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@jr2/orchestrator";

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
 * identity and the instance image's content hash; annotations carry the converged image map, which
 * is too long for a label value (ADR-0038). */
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
  /** `kubectl apply -f -` of a multi-doc YAML or JSON manifest string. */
  apply(opts: { manifest: string; context?: string }): Promise<void>;
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
  /** Run a one-shot node script IN the cluster (`kubectl run --rm`) and return its output — the
   * provider-preflight seam (ADR-0019: reachability must be probed from where pods live).
   * `caPem` makes the probe trust a private CA the same way the Harness does (ADR-0020):
   * `NODE_EXTRA_CA_CERTS`, which must be process env at node start — it cannot be set from
   * inside the script. */
  runOneShot(opts: {
    namespace: string;
    name: string;
    script: string;
    caPem?: string;
    context?: string;
  }): Promise<string>;
};

const nsArgs = (namespace?: string): string[] => (namespace ? ["--namespace", namespace] : []);

/** The two workload kinds `jr2 up` rolls out and waits on. */
export type RolloutKind = "deployment" | "daemonset";

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

  async apply({ manifest, context }) {
    await execStdin(["kubectl", ...ctxArgs(context), "apply", "-f", "-"], manifest);
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

  async runOneShot({ namespace, name, script, caPem, context }) {
    // With a CA bundle: write the PEM to a file BEFORE node starts, because NODE_EXTRA_CA_CERTS
    // is only honored as process-start env. The PEM rides an env var base64'd (multiline values
    // and `--env` don't mix); `"$1"` keeps the script out of shell parsing entirely (execFile
    // passes argv verbatim, no host shell either).
    const command = caPem
      ? ["sh", "-ec", 'echo "$JR2_CA_B64" | base64 -d > /tmp/jr2-ca.crt && exec node -e "$1"', "sh", script]
      : ["node", "-e", script];
    try {
      const { stdout } = await exec(
        "kubectl",
        [
          ...ctxArgs(context),
          ...nsArgs(namespace),
          "run",
          name,
          "--rm",
          "--attach",
          "--restart=Never",
          "--quiet",
          "--image=node:24-slim",
          ...(caPem
            ? [`--env=JR2_CA_B64=${Buffer.from(caPem).toString("base64")}`, "--env=NODE_EXTRA_CA_CERTS=/tmp/jr2-ca.crt"]
            : []),
          "--command",
          "--",
          ...command,
        ],
        { timeout: 180_000 },
      );
      return stdout;
    } catch (err) {
      throw oneShotFailure(err);
    }
  },
};

/**
 * A one-shot probe's failure, made readable. `kubectl run --attach` streams the POD's own output
 * on ITS stdout, and kubectl writes only its verdict ("pod … terminated (Error)") to stderr — so
 * the one line that says WHY (a stack, a DNS error, an HTTP status) is exactly what execFile's
 * error message drops, since that message carries stderr alone. The provider preflight (ADR-0019)
 * exists to be the cheapest diagnosis available; without the pod's own words it can only report
 * that something in the cluster exited non-zero, and the caller is back to reproducing the probe
 * by hand. So the attached output leads, and the kubectl verdict follows it.
 */
export function oneShotFailure(err: unknown): Error {
  const attached = typeof (err as { stdout?: unknown })?.stdout === "string" ? (err as { stdout: string }).stdout : "";
  const base = err instanceof Error ? err.message : String(err);
  const trimmed = attached.trim();
  return trimmed ? new Error(`${trimmed}\n${base}`) : err instanceof Error ? err : new Error(base);
}

/** What a rollout wait needs to know to go looking: the workload that did not come up (a Deployment
 * unless `kind` says otherwise), and the label selector its pods carry (each converge layer already
 * knows its own — it verifies the running image through the same selector). */
export type RolloutTarget = {
  kind?: RolloutKind;
  name: string;
  namespace: string;
  selector: string;
  context?: string;
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
 * pods, which the caller then goes and reads by hand. This is `oneShotFailure()` one layer up: the
 * evidence leads, kubectl's verdict follows, and `jr2 up`'s three rollout waits share the one pair
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
    const maker = target.kind === "daemonset" ? "the DaemonSet" : "the ReplicaSet";
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
