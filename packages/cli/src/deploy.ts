// What `jr2 up` deploys (ADR-0019): pure manifest builders + the small decision helpers, kept free
// of subprocesses so the converge logic is unit-testable. Object names inside the instance's
// namespace are constants (namespace is the identity); every object carries the instance label so
// ownership is derivable from the cluster — there is no local target state.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CA_CONFIGMAP,
  custodianComposition,
  CUSTODIAN_BOOTSTRAP_KEY,
  CUSTODIAN_SCRIPT_KEY,
  GIT_SSH_SECRET,
  HELD_CA_SECRET,
  HELD_CONFIGMAP,
  HELD_KEY,
  HELD_MOUNT,
  HELD_SECRETS_SECRET,
  HELD_TLS_SECRET,
  HARNESS_ENV_SECRET,
  IMAGES_CONFIGMAP,
  IMAGES_KEY,
  IMAGES_MOUNT,
  HARNESS_CONFIGMAP,
  HARNESS_CONFIG_KEY,
  INSTANCE_HARNESS_PORT,
  INSTANCE_HARNESS_SERVICE,
  INSTANCE_SECRET,
  KIT_VERSION,
  NO_DISRUPT_ANNOTATIONS,
  ORCHESTRATOR_PORT,
  ORCHESTRATOR_SERVICE,
  REPO_CACHE,
  PRIORITY_CLASS_CONTROL,
  PRIORITY_CLASS_SANDBOX,
  REPO_CACHE_HOSTPATH,
  SERVICE_ACCOUNT_CA,
  STATE_PVC,
  type HarnessConfig,
  type HeldManifest,
  type PriorityClasses,
  type SandboxPlacement,
} from "@jr2/orchestrator";
import type { Pem } from "./held-pki.ts";

export {
  GIT_SSH_SECRET,
  HARNESS_CONFIGMAP,
  HARNESS_ENV_SECRET,
  INSTANCE_HARNESS_SERVICE,
  KIT_VERSION,
  REPO_CACHE,
  STATE_PVC,
};

export const LABEL_INSTANCE = "jr2.dev/instance";
export const LABEL_VERSION = "jr2.dev/version";
export const LABEL_HASH = "jr2.dev/content-hash";

/** The converged name→ref image map, stamped on the Orchestrator Deployment's OWN metadata so the
 * next `jr2 up` can diff it and spend no docker on what has not moved (ADR-0038). An ANNOTATION, not
 * a label: a serialized map blows past the 63-character label-value limit immediately. */
export const ANNOTATION_IMAGES = "jr2.dev/images";

export const ORCHESTRATOR_SA = "jr2-orchestrator";

/** The HMAC over the held-secret inputs, on the Instance Harness's pod template (ADR-0059). */
export const ANNOTATION_HELD_DIGEST = "jr2.dev/held-digest";

/** The Instance Harness pod's `fsGroup` — a Sandbox pod's default work group (ADR-0005), for the
 * same reason: a group every container is granted, which the Custodian's values are readable by. */
const INSTANCE_HARNESS_FS_GROUP = 2000;

/** The two ingress NetworkPolicies (ADR-0058) — see `harnessIngressPolicies`. */
export const SANDBOX_INGRESS_POLICY = "jr2-sandbox-ingress";
export const INSTANCE_HARNESS_INGRESS_POLICY = "jr2-instance-harness-ingress";

/** The operator's install location — per-cluster, shared by every instance (ADR-0019). */
export const OPERATOR_NAMESPACE = "jr2-system";
export const OPERATOR_DEPLOYMENT = "jr2-controller-manager";
/** The operator Deployment's pod selector, as rendered into `manifests/operator.yaml`. */
export const OPERATOR_SELECTOR = "control-plane=controller-manager";

/** The rendered operator install manifest shipped inside this package (`just operator-manifest`
 * regenerates it from operator/config). The manager image ref is substituted at apply time, and so
 * is its PriorityClass (ADR-0060): the manifest names `jr2-control`, and an Instance that names its
 * own control class gets no pod that names one `jr2 up` did not create. */
export async function operatorManifest(image: string, controlClass = PRIORITY_CLASS_CONTROL): Promise<string> {
  const raw = await readFile(fileURLToPath(new URL("../manifests/operator.yaml", import.meta.url)), "utf8");
  if (!raw.includes("image: controller:latest")) {
    throw new Error("packaged operator.yaml has no `image: controller:latest` placeholder — regenerate it");
  }
  const classLine = `priorityClassName: ${PRIORITY_CLASS_CONTROL}`;
  if (!raw.includes(classLine)) {
    throw new Error(`packaged operator.yaml has no \`${classLine}\` — regenerate it`);
  }
  return raw
    .replace("image: controller:latest", `image: ${image}`)
    .replace(classLine, `priorityClassName: ${controlClass}`);
}

/** Compare dotted versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => Number(s) || 0);
  const pb = b.split(/[.-]/).map((s) => Number(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type KubeManifest = Record<string, unknown>;

/**
 * jr2's own pods are kit-sized, with no config key (ADR-0060): memory request = limit, a CPU request
 * and NO CPU limit — a provisioning burst needs CPU, and no Agent Substrate move applies to them.
 * The Repo cache agent is the one exception to request = limit: `git index-pack` spikes, and its OOM
 * costs only a refetch. The operator's own size rides its manifest (operator/config).
 */
export const KIT_POD_SIZES = {
  orchestrator: { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "1Gi" } },
  /** Its conversations are never freed yet. */
  instanceHarness: { requests: { cpu: "250m", memory: "1Gi" }, limits: { memory: "1Gi" } },
  /** The Instance Harness pod's Custodian: the same 64Mi/50m slice a Sandbox's takes, kit-sized. */
  instanceCustodian: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "64Mi" } },
  repoCache: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "1Gi" } },
} as const;

/** A fresh copy, so no manifest shares an object with another (or with the constant). */
const sized = (r: { requests: Record<string, string>; limits: Record<string, string> }) => ({
  requests: { ...r.requests },
  limits: { ...r.limits },
});

/** The PriorityClass each of jr2's two tiers runs under (ADR-0060): the Instance's own when
 * `priorityClasses` names one, else the one `jr2 up` creates. */
export function priorityClassNames(classes: PriorityClasses | undefined): { control: string; sandbox: string } {
  return {
    control: classes?.control ?? PRIORITY_CLASS_CONTROL,
    sandbox: classes?.sandbox ?? PRIORITY_CLASS_SANDBOX,
  };
}

/**
 * The PriorityClasses `jr2 up` creates, cluster-scoped, beside the CRDs (ADR-0060) — one manifest
 * each, and none for a key `priorityClasses` names, since the cluster then has its own scheme.
 * `jr2-control` preempts lower priorities: the Orchestrator, the operator and the Repo cache agent
 * are small, fixed, and needed by every Sandbox. `jr2-sandbox` never preempts: a waiting Sandbox
 * evicts nobody, and an ordinary pod (priority 0) cannot preempt a live one. Both stay far below the
 * system classes (2000000000+). Shared by every Instance on the cluster, like the operator, so they
 * carry no instance label; a class's value and policy are immutable, and these never change.
 */
export function priorityClassObjects(classes: PriorityClasses | undefined): string[] {
  const managed = { "app.kubernetes.io/managed-by": "jr2" };
  const pc = (name: string, value: number, preemptionPolicy: string, description: string): string =>
    JSON.stringify({
      apiVersion: "scheduling.k8s.io/v1",
      kind: "PriorityClass",
      metadata: { name, labels: managed },
      value,
      preemptionPolicy,
      globalDefault: false,
      description,
    });
  return [
    ...(classes?.control === undefined
      ? [
          pc(
            PRIORITY_CLASS_CONTROL,
            100000,
            "PreemptLowerPriority",
            "jr2 control: the Orchestrator, the operator and the Repo cache agent (ADR-0060)",
          ),
        ]
      : []),
    ...(classes?.sandbox === undefined
      ? [
          pc(
            PRIORITY_CLASS_SANDBOX,
            1000,
            "Never",
            "jr2 Sandboxes and the Instance Harness: never preempted by ordinary pods, never preempting (ADR-0060)",
          ),
        ]
      : []),
  ];
}

/**
 * What `jr2 up` resolved about held secrets (ADR-0059), ready to become objects. Values appear in
 * two places only: `values` (the literals, for the `jr2-held-secrets` Secret) and the CA's and the
 * leaves' keys — each lands in a Secret no Harness container mounts.
 */
export type HeldObjects = {
  manifest: HeldManifest;
  /** The literal values, by name — never in the manifest, never in a ConfigMap. */
  values: Record<string, string>;
  /** The per-Instance CA — kept across converges; present whenever a secret is held. */
  ca?: Pem;
  /** One leaf per bound target, by file stem (`leafStem`). */
  leaves: Record<string, Pem>;
  /** The Custodian's rendered bootstrap (JSON) and script. */
  bootstrap: string;
  script: string;
};

/** Everything `jr2 up` converges inside the instance's namespace, as one apply-able List. */
export function instanceObjects(opts: {
  name: string;
  namespace: string;
  image: string;
  hash: string;
  /** Secret data (token, signing key, harness env literals) — written stringData, kube encodes. */
  secretData: Record<string, string>;
  /** The HARNESS containers' literal `harness.env` values — a SEPARATE Secret from `secretData` by
   * doctrine (ADR-0013): Agent code executes where this lands, so the Instance token and signing
   * key must never share a Secret with it, and no model key rides it either (ADR-0059). */
  harnessEnvData: Record<string, string>;
  harness?: HarnessConfig;
  /** Held secrets (ADR-0059): the Custodian's objects. The `jr2-held` ConfigMap is applied always —
   * every Harness pod runs a Custodian — and the rest only while a secret is held. */
  held: HeldObjects;
  /** Every image ref THIS converge resolved (ADR-0037/0038/0049): `{ harness, custodian, operator?,
   * sandbox: { <key>: ref }, sandboxUser: { <key>: user } }`, where a key is a build context's
   * content digest or the reserved `default`. It lands twice, deliberately as one JSON so the
   * record `up` diffs and the map pods read can never disagree: as the `jr2-images` ConfigMap the
   * Orchestrator reads per provision, and as an annotation on the Deployment's own metadata.
   * `sandboxUser` rides along because a provision cannot inspect an image and the pod's uid-1000
   * fallback turns on whether the image declares a `USER` (up.ts, ADR-0037). */
  imageRefs: Record<string, unknown>;
  /** The data plane (ADR-0051): present iff a registered Machine composes a Sandbox, carrying the
   * resolved operator ref — the same binary is the cache agent (`/manager repo-cache`). Absent, no
   * DaemonSet and none of its RBAC is applied; `up` deletes a stale one. */
  repoCache?: { image: string; placement?: SandboxPlacement };
  /** `priorityClasses` from jr2.config.ts (ADR-0060): the classes to name instead of jr2's own. */
  priorityClasses?: PriorityClasses;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
  const priority = priorityClassNames(opts.priorityClasses);
  const meta = (name: string, extra: Record<string, string> = {}): KubeManifest => ({
    name,
    namespace: opts.namespace,
    labels: { ...labels, ...extra },
  });
  const imagesJson = JSON.stringify(opts.imageRefs, null, 2);

  const items: KubeManifest[] = [
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(STATE_PVC),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
      },
    },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(ORCHESTRATOR_SA) },
    {
      // The orchestrator drives Sandbox CRs (+ their token Secrets) in its own namespace
      // (ADR-0012/0013), watches them (ADR-0063), and creates the Repo CRs the cache agent
      // reconciles (ADR-0051). Nothing on Pods: it never reads one — the operator publishes the pod
      // facts on the Sandbox's status — and the attach is the Harness's own `POST /attach`, so no
      // `pods/exec` stream crosses the API server (ADR-0063).
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(ORCHESTRATOR_SA),
      rules: [
        { apiGroups: ["core.jr2.dev"], resources: ["sandboxes", "repos"], verbs: ["*"] },
        // patch: the token Secret is server-side applied idempotently and later ownerRef-patched.
        {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "list", "create", "delete", "patch", "update"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: meta(ORCHESTRATOR_SA),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ORCHESTRATOR_SA },
      subjects: [{ kind: "ServiceAccount", name: ORCHESTRATOR_SA, namespace: opts.namespace }],
    },
    {
      // What this instance can REACH (ADR-0018), consumed by every Harness container at pod boot.
      // Deployment fact, so it is config (ADR-0050) — and it carries NO Agents: a Machine carries
      // its own and the definition rides each admission (ADR-0049), so a provider edit is the only
      // thing this ConfigMap + a pod restart still delivers.
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(HARNESS_CONFIGMAP),
      data: {
        [HARNESS_CONFIG_KEY]: JSON.stringify(
          {
            // apiKey is deliberately dropped: it is a held secret (ADR-0059) — the Custodian holds
            // it, the Harness's env holds its Stand-in, and a ConfigMap is no place for either.
            provider: opts.harness?.provider
              ? {
                  id: opts.harness.provider.id,
                  api: opts.harness.provider.api,
                  baseUrl: opts.harness.provider.baseUrl,
                  // Token limits are model properties, not credentials — they ride the ConfigMap
                  // so the Harness can register the provider with them.
                  contextWindow: opts.harness.provider.contextWindow,
                  maxTokens: opts.harness.provider.maxTokens,
                  models: opts.harness.provider.models,
                }
              : undefined,
            // Where pi's catalog providers send their calls (ADR-0059): endpoints, not keys.
            catalog: opts.harness?.catalog,
          },
          null,
          2,
        ),
      },
    },
    {
      // The resolved image map (ADR-0037/0038): what a Sandbox is made of, read PER PROVISION
      // from the mount below. A ConfigMap and not Deployment env, because env is a pod-template
      // change: adding a CLI to a Sandbox Dockerfile would roll the Orchestrator and put every
      // live run through snapshot restore (ADR-0007) for a change affecting only FUTURE Sandboxes.
      // Mounted by name, so a content update propagates in place and nothing rolls.
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(IMAGES_CONFIGMAP),
      data: { [IMAGES_KEY]: imagesJson },
    },
    // Held secrets (ADR-0059). `held.json` is what every composition reads — the Orchestrator per
    // provision from the mount below, `jr2 up` for the Instance Harness — beside the Custodian's
    // bootstrap and script, which Envoy reads at start. Names, hosts, headers: never a value.
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(HELD_CONFIGMAP),
      data: {
        [HELD_KEY]: JSON.stringify(opts.held.manifest, null, 2),
        [CUSTODIAN_BOOTSTRAP_KEY]: opts.held.bootstrap,
        [CUSTODIAN_SCRIPT_KEY]: opts.held.script,
      },
    },
    ...heldSecretObjects(opts.held, meta),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(INSTANCE_SECRET),
      type: "Opaque",
      stringData: opts.secretData,
    },
    {
      // What the HARNESS containers envFrom (see `harnessEnvData` above): Agent creds, never the
      // Instance token. Always applied (possibly empty) so the Sandbox spec can reference it
      // unconditionally.
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(HARNESS_ENV_SECRET),
      type: "Opaque",
      stringData: opts.harnessEnvData,
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        ...meta(ORCHESTRATOR_SERVICE, { [LABEL_HASH]: opts.hash, [LABEL_VERSION]: KIT_VERSION }),
        // The converged image map, on the DEPLOYMENT'S OWN metadata and never on
        // `spec.template.metadata` (ADR-0038). On the pod template it would be part of the pod
        // spec, so every re-resolved ref would roll the Orchestrator — the exact cost the
        // ConfigMap exists to avoid. Here it is a record `jr2 up` reads back and diffs, which is
        // what makes a steady-state converge spend a directory walk and no docker at all.
        annotations: { [ANNOTATION_IMAGES]: imagesJson },
      },
      spec: {
        replicas: 1, // single WRITER (CONTEXT.md): the snapshot store brooks no split-brain
        strategy: { type: "Recreate" }, // two writers may never overlap on the PVC
        selector: { matchLabels: { app: ORCHESTRATOR_SERVICE } },
        template: {
          metadata: { labels: { ...labels, app: ORCHESTRATOR_SERVICE } },
          spec: {
            serviceAccountName: ORCHESTRATOR_SA,
            // Control tier (ADR-0060): small, fixed, needed by every Sandbox. No disruption opt-out:
            // a restarted Orchestrator re-attaches (ADR-0007).
            priorityClassName: priority.control,
            containers: [
              {
                name: "orchestrator",
                image: opts.image,
                imagePullPolicy: "IfNotPresent",
                ports: [{ containerPort: ORCHESTRATOR_PORT }],
                envFrom: [{ secretRef: { name: INSTANCE_SECRET } }],
                env: [
                  // The entrypoint derives its own Service DNS + Sandbox namespace from these.
                  { name: "JR2_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                  // What `/healthz` reports as this instance's identity. The same content address
                  // the image tag carries (ADR-0019), in-process so a CLI can ask over HTTP
                  // instead of needing kube access to read the Deployment's labels.
                  { name: "JR2_CONTENT_HASH", value: opts.hash },
                  // The API server's trust (ADR-0063): the Orchestrator's own Kubernetes client is
                  // built-in `fetch`, which trusts the ServiceAccount's CA through this and nothing
                  // else — no TLS code, no dependency.
                  { name: "NODE_EXTRA_CA_CERTS", value: SERVICE_ACCOUNT_CA },
                ],
                // The Orchestrator creates Repo resources and never clones (ADR-0051) — the cache
                // agent on each node does, reading the credential Secret a Repo's `secretRef`
                // names — so nothing of git's is mounted here: state and the image map only.
                volumeMounts: [
                  { name: "state", mountPath: "/instance/.jr2" },
                  // The image map, read per provision (ADR-0038). A mount, so `jr2 up` rewriting
                  // it costs one kubelet propagation window instead of a rollout.
                  { name: "images", mountPath: IMAGES_MOUNT, readOnly: true },
                  // What the Custodian holds, read per provision the same way (ADR-0059): names
                  // and hosts, which this process could not derive — its `.env` values are absent.
                  { name: "held", mountPath: HELD_MOUNT, readOnly: true },
                ],
                resources: sized(KIT_POD_SIZES.orchestrator),
                // The period, not the boot, is what `up`'s rollout wait measures. Measured: the
                // container answers `/healthz` 1.1s after it starts, and the default 10s period
                // billed that as 11.0s — one probe fired before the server was up, then a whole
                // missed period. 2s quantizes a ~1s boot at ~1s.
                //
                // `failureThreshold` is then raised to hold the tolerance the default period gave,
                // because ONE knob sets two unrelated things: how fast a boot is noticed, and how
                // long a running pod may stall before the kubelet takes it out of service. The
                // Orchestrator is `replicas: 1` (CONTEXT.md: single writer), so its Service has
                // exactly one endpoint and losing it is an outage, not a failover — and its store
                // writes are synchronous, so a GC pause or a node busy with a docker build can
                // silence `/healthz` for seconds. 15 × 2s keeps the 30s the default 3 × 10s gave.
                readinessProbe: {
                  httpGet: { path: "/healthz", port: ORCHESTRATOR_PORT },
                  initialDelaySeconds: 1,
                  periodSeconds: 2,
                  failureThreshold: 15,
                },
                // Liveness restarts, which readiness never does (ADR-0008). A restart of this
                // `replicas: 1` writer is an outage plus a restore, so it fires only on a process
                // that has answered nothing for five minutes (30 × 10s): silent that long is dead,
                // not stalled, and without it the pod sits NotReady until a human deletes it. A
                // process that EXITS needs no probe — the restart policy already has it. The same
                // five minutes cover a boot's restore, so there is no initial delay.
                livenessProbe: {
                  httpGet: { path: "/healthz", port: ORCHESTRATOR_PORT },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
              },
            ],
            volumes: [
              { name: "state", persistentVolumeClaim: { claimName: STATE_PVC } },
              { name: "images", configMap: { name: IMAGES_CONFIGMAP } },
              { name: "held", configMap: { name: HELD_CONFIGMAP, items: [{ key: HELD_KEY, path: HELD_KEY }] } },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(ORCHESTRATOR_SERVICE),
      spec: {
        selector: { app: ORCHESTRATOR_SERVICE },
        ports: [{ port: ORCHESTRATOR_PORT, targetPort: ORCHESTRATOR_PORT }],
      },
    },
    ...harnessIngressPolicies(opts.name, meta),
    ...(opts.repoCache
      ? repoCacheObjects({
          ...opts.repoCache,
          namespace: opts.namespace,
          labels,
          meta,
          priorityClassName: priority.control,
        })
      : []),
  ];

  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** The operator's label on every Sandbox pod (operator/internal/controller/helpers.go) — and on no
 * other pod, which is what lets one selector mean "every Sandbox, now and later". */
const SANDBOX_POD_LABEL = "sandbox.jr2.dev/name";

/**
 * Ingress to every Harness pod is the Orchestrator's alone (ADR-0058) — the NetworkPolicy half of
 * the wire's defense; the bearer is the other, and the control (ADR-0013: policy bounds where a pod
 * may talk, only a token bounds what it may do). One policy per placement: every Sandbox pod, by
 * the label the operator stamps on each, and the Instance Harness.
 *
 * Converged UNCONDITIONALLY, not only when a Machine composes a Sandbox or declares a `"none"`
 * Agent: a policy that selects nothing costs nothing, and a pod born before its policy would be a
 * window. The peer is this instance's Orchestrator and no other — a `podSelector` never crosses the
 * namespace, and the instance label pins it within one. What is NOT here, on purpose:
 *
 * - The Orchestrator is not selected. Every route there is token-gated, and a Custodian in any
 *   Harness pod must reach it; a policy could not tell the Custodian's packets from the Agent's.
 * - No egress. What a Sandbox may reach is its own decision (ADR-0058 records it open).
 * - No port. The Orchestrator speaks only the Harness wire to these pods, and a port here would
 *   have to track the CR's `port`; `kubectl port-forward` (the CLI, a human's shell into the User
 *   Container — ADR-0005) and kubelet probes never cross a policy at all.
 */
function harnessIngressPolicies(instance: string, meta: (name: string) => KubeManifest): KubeManifest[] {
  const fromOrchestrator = [
    { from: [{ podSelector: { matchLabels: { app: ORCHESTRATOR_SERVICE, [LABEL_INSTANCE]: instance } } }] },
  ];
  const policy = (name: string, podSelector: Record<string, unknown>): KubeManifest => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(name),
    spec: { podSelector, policyTypes: ["Ingress"], ingress: fromOrchestrator },
  });
  return [
    policy(SANDBOX_INGRESS_POLICY, { matchExpressions: [{ key: SANDBOX_POD_LABEL, operator: "Exists" }] }),
    policy(INSTANCE_HARNESS_INGRESS_POLICY, { matchLabels: { app: INSTANCE_HARNESS_SERVICE } }),
  ];
}

/** Where the cache agent's pod sees the node's directory: `--cache-dir`'s default. */
const REPO_CACHE_MOUNT = "/cache";
/** The agent's `$HOME` — an emptyDir, where it writes a deploy key for the life of the pod. */
const REPO_CACHE_HOME = "/home/jr2";

/**
 * The data plane's node half (ADR-0051, ADR-0004): the cache agent as a DaemonSet, one pod per Sandbox node,
 * each the one writer of `/var/lib/jr2/<namespace>/repos` on its node — the hostPath the operator
 * mounts one leaf of, read-only, into every Sandbox there that names the key. It runs the operator
 * image (`/manager repo-cache`), so the kit's operator ref is resolved even when the operator layer
 * itself is unmanaged.
 *
 * The seat is ROOT, and deliberately so: the kubelet creates a `DirectoryOrCreate` hostPath owned by
 * root, and a Sandbox's mount of the leaf may exist before the agent has written anything there.
 * Everything else is hardened as the operator's baseline is — no capabilities, no escalation, a
 * read-only root filesystem (the two writable places are the emptyDirs below), the default seccomp
 * profile. It carries the Sandbox pod's own `nodeSelector` and `tolerations` and nothing wider
 * (ADR-0052), so an agent lands on exactly the nodes a Sandbox can be placed on. The ServiceAccount token IS mounted: the agent is a client of the Repo resources and
 * of the pods on its node (never of Sandboxes — demand is a pod's mount), unlike a Sandbox, whose
 * north star is never reaching the API.
 */
function repoCacheObjects(opts: {
  image: string;
  /** The Instance's Sandbox node predicate (ADR-0052): the same `nodeSelector` and `tolerations`
   * every Sandbox pod carries, so the agent runs on exactly the Sandbox nodes. */
  placement?: SandboxPlacement;
  namespace: string;
  labels: Record<string, string>;
  meta: (name: string, extra?: Record<string, string>) => KubeManifest;
  /** The control tier's class (ADR-0060): every Sandbox on the node needs this agent. */
  priorityClassName: string;
}): KubeManifest[] {
  const { image, namespace, labels, meta, placement, priorityClassName } = opts;
  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(REPO_CACHE) },
    {
      // What one agent writes on the API is its own node's entry in each Repo's status; it reads
      // the Repos, the pods on its node that mount their caches (demand and eviction are a pod's
      // mount, not a Sandbox resource — ADR-0051), and the credential Secret a Repo's `secretRef`
      // names — nothing it could create or delete.
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(REPO_CACHE),
      rules: [
        { apiGroups: ["core.jr2.dev"], resources: ["repos"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["core.jr2.dev"], resources: ["repos/status"], verbs: ["get", "patch", "update"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: meta(REPO_CACHE),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: REPO_CACHE },
      subjects: [{ kind: "ServiceAccount", name: REPO_CACHE, namespace }],
    },
    {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: meta(REPO_CACHE, { [LABEL_VERSION]: KIT_VERSION }),
      spec: {
        selector: { matchLabels: { app: REPO_CACHE } },
        updateStrategy: { type: "RollingUpdate" },
        template: {
          metadata: { labels: { ...labels, app: REPO_CACHE } },
          spec: {
            serviceAccountName: REPO_CACHE,
            automountServiceAccountToken: true,
            priorityClassName,
            // One agent per Sandbox node (ADR-0052): the pod's own placement, verbatim. A node no
            // Sandbox can reach gets no agent — a cache there is a clone nobody reads, and an
            // affinity term the scheduler cannot honor. (The DaemonSet controller still adds its
            // own toleration for `unschedulable`, so a cordoned Sandbox node keeps its agent.)
            ...(placement?.nodeSelector ? { nodeSelector: placement.nodeSelector } : {}),
            ...(placement?.tolerations?.length ? { tolerations: placement.tolerations } : {}),
            containers: [
              {
                name: "agent",
                image,
                imagePullPolicy: "IfNotPresent",
                command: ["/manager", "repo-cache"],
                env: [
                  // The downward API names the node this pod is the writer for, and the namespace
                  // whose Repos and pods it watches (the agent's `--node` / `--namespace`).
                  { name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
                  { name: "JR2_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                  { name: "HOME", value: REPO_CACHE_HOME },
                ],
                volumeMounts: [
                  { name: "cache", mountPath: REPO_CACHE_MOUNT },
                  { name: "home", mountPath: REPO_CACHE_HOME },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                // Kit-sized (ADR-0060): the one request below its limit — `git index-pack` spikes.
                resources: sized(KIT_POD_SIZES.repoCache),
                securityContext: {
                  runAsUser: 0,
                  runAsGroup: 0,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  seccompProfile: { type: "RuntimeDefault" },
                },
              },
            ],
            volumes: [
              {
                name: "cache",
                hostPath: { path: `${REPO_CACHE_HOSTPATH}/${namespace}/repos`, type: "DirectoryOrCreate" },
              },
              { name: "home", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
  ];
}

/**
 * The held-secret Secrets (ADR-0059), present only while a secret is held: the CA (which NO pod
 * mounts — `jr2 up` alone reads it back), the literal values and the leaves (the Custodian's alone).
 * `stringData` as written: no trailing newline is added to a value.
 */
function heldSecretObjects(held: HeldObjects, meta: (name: string) => KubeManifest): KubeManifest[] {
  if (held.manifest.secrets.length === 0 || !held.ca) return [];
  const secret = (name: string, stringData: Record<string, string>): KubeManifest => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta(name),
    type: "Opaque",
    stringData,
  });
  const leaves: Record<string, string> = {};
  for (const [stem, pem] of Object.entries(held.leaves)) {
    leaves[`${stem}.crt`] = pem.cert;
    leaves[`${stem}.key`] = pem.key;
  }
  return [
    secret(HELD_CA_SECRET, { "ca.crt": held.ca.cert, "ca.key": held.ca.key }),
    ...(Object.keys(held.values).length ? [secret(HELD_SECRETS_SECRET, held.values)] : []),
    secret(HELD_TLS_SECRET, leaves),
  ];
}

/**
 * The trust ConfigMap (ADR-0020, ADR-0059): the user's `caBundle` as `ca.crt`, and while a secret
 * is held, the three bundles its path needs. Its own manifest, apart from the List, because the
 * bundles carry every root certificate — past what client-side apply's annotation can hold — so
 * `jr2 up` applies it server-side. Undefined when there is nothing to trust.
 */
export function trustObject(opts: {
  name: string;
  namespace: string;
  caBundle?: string;
  bundles?: { extra: string; bundle: string; upstream: string };
}): string | undefined {
  if (opts.caBundle === undefined && opts.bundles === undefined) return undefined;
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CA_CONFIGMAP,
      namespace: opts.namespace,
      labels: { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" },
    },
    data: {
      ...(opts.caBundle !== undefined ? { "ca.crt": opts.caBundle } : {}),
      ...(opts.bundles
        ? { "extra.crt": opts.bundles.extra, "bundle.crt": opts.bundles.bundle, "upstream.crt": opts.bundles.upstream }
        : {}),
    },
  });
}

/**
 * The Instance Harness (ADR-0031): the per-instance Harness Deployment + Service `jr2 up`
 * converges whenever an Agent a registered Machine CARRIES declares `workspace: "none"`
 * (ADR-0049's walk) — the placement for every Menu-only Agent's Turn, regardless of any enclosing
 * Workspace. The one Harness shape, minus the Workspace: the stock Harness image plus the Custodian,
 * composed by the same function a Sandbox's is (custodian.ts, ADR-0059), the same harness-config
 * ConfigMap and env/envFrom/trust wiring a Sandbox's Harness container gets — and NO `/work`
 * volume, no attach step. It runs the STOCK image permanently: `workspace: "none"` withholds the
 * whole Working toolset (ADR-0028), so there are no tools to carry and no Sandbox Image to resolve
 * (ADR-0037). No config key names, sizes, addresses, or enables it: the Machine walk is the entire
 * surface.
 */
export function instanceHarnessObjects(opts: {
  name: string;
  namespace: string;
  /** The RESOLVED stock Harness ref (ADR-0018/0031/0038) — a content-addressed tag in a kit
   * checkout, the published `<kitversion>` tag installed. Not an override seat: `images.harness`
   * is gone, and the only Harness this instance can run is the one `jr2 up` resolved.
   *
   * The accepted asymmetry: the Instance Harness names its images HERE, in the pod template, while
   * a Sandbox's refs travel through the `jr2-images` ConfigMap. Both are right for what they are —
   * this Deployment is supposed to roll when its image moves; the Orchestrator is not. */
  harnessImage: string;
  /** The resolved Custodian ref: the Harness's one route to its Menu, kept even though a `"none"`
   * Agent cannot execute code — forking the path for one pod buys a divergence ADR-0031 declines. */
  custodianImage: string;
  /** What this converge resolved about held secrets (ADR-0059) — the same manifest the
   * Orchestrator composes every Sandbox's Custodian from. */
  held: HeldManifest;
  /** An HMAC over every held-secret input (`held.json`, the leaves, the literal values, the
   * Custodian's config), keyed with the signing key so it reveals nothing — on the pod template, so
   * a change to any of them rolls this pod (ADR-0059). */
  heldDigest: string;
  harness?: HarnessConfig;
  /** The instance ships a private-CA bundle (ADR-0020). */
  caBundle?: boolean;
  /** The digest of this placement's Harness bearer (ADR-0058; `harnessTokenDigest(key,
   * "jr2-instance-harness")`) — the wire's gate. The digest, never the bearer: the same shape
   * every Sandbox Harness container gets, so this pod can verify the Orchestrator and mint
   * nothing. */
  bearerSha256: string;
  /** `priorityClasses` from jr2.config.ts (ADR-0060): the classes to name instead of jr2's own. */
  priorityClasses?: PriorityClasses;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
  const meta = (): KubeManifest => ({
    name: INSTANCE_HARNESS_SERVICE,
    namespace: opts.namespace,
    labels,
  });

  // The per-container half of the operator's baseline (hardenedContainerSecurityContext there):
  // drop every capability, forbid escalation, non-root under the default seccomp profile.
  const hardenedContainerSecurityContext = () => ({
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  });

  // The Custodian (ADR-0013, ADR-0059): the placement's Sandbox token — signed for this
  // placement's name (`up.ts` mints it into the instance Secret), so it speaks only for the Turns
  // hosted HERE (tokens.ts) — plus every held secret. Mounted into the Custodian alone; the Instance
  // token itself never enters this pod.
  const custodian = custodianComposition(opts.held, {
    image: opts.custodianImage,
    token: { secret: INSTANCE_SECRET, key: "JR2_INSTANCE_HARNESS_TOKEN" },
    caBundle: opts.caBundle === true,
    resources: sized(KIT_POD_SIZES.instanceCustodian),
  });

  const harnessContainer = {
    name: "harness",
    image: opts.harnessImage,
    imagePullPolicy: "IfNotPresent",
    ports: [{ containerPort: INSTANCE_HARNESS_PORT }],
    // The same asymmetry the Sandbox pod builds (ADR-0013/0020/0059): the mounted harness config
    // and the instance's valueFrom entries ride `env` (literal values live in the jr2-harness-env
    // Secret), then the Custodian's address and every Stand-in, and no credential ever does.
    env: [
      {
        name: "JR2_HARNESS_JSON",
        valueFrom: { configMapKeyRef: { name: HARNESS_CONFIGMAP, key: HARNESS_CONFIG_KEY } },
      },
      // The placement gate (ADR-0031): every admission carries its own definition (ADR-0049), so
      // the Harness itself refuses any admission whose definition declares Workspace access —
      // Menu-only Agents alone run here, which is what makes "no code execution in this pod" true
      // rather than asserted. The bearer (below) narrows who may try; this decides what.
      { name: "JR2_MENU_ONLY", value: "1" },
      ...(opts.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
      ...custodian.harnessEnv,
      // The wire's gate (ADR-0058), last — as on a Sandbox — so no `harness.env` entry chooses it.
      { name: "JR2_HARNESS_TOKEN_SHA256", value: opts.bearerSha256 },
    ],
    envFrom: [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(opts.harness?.envFrom ?? [])],
    ...(custodian.harnessMounts.length ? { volumeMounts: custodian.harnessMounts } : {}),
    // The operator probes a Sandbox's Harness the same way: serving = the socket accepts.
    // Period and threshold as reasoned on the Orchestrator above: the default 10s period is the
    // rollout wait rather than the boot, and the threshold then has to carry the stall tolerance
    // the period used to supply. This pod is single-replica too.
    readinessProbe: {
      tcpSocket: { port: INSTANCE_HARNESS_PORT },
      initialDelaySeconds: 1,
      periodSeconds: 2,
      failureThreshold: 15,
    },
    resources: sized(KIT_POD_SIZES.instanceHarness),
    securityContext: hardenedContainerSecurityContext(),
  };

  const items: KubeManifest[] = [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { ...meta(), labels: { ...labels, [LABEL_VERSION]: KIT_VERSION } },
      spec: {
        // ONE replica, Recreate: a conversation is an Instance ID on one Harness PROCESS
        // (ADR-0031) — two pods behind this Service would route one conversation to two servers,
        // the exact amnesia definition-wins placement exists to prevent. A restart loses the
        // conversations (live-only, ADR-0023); the Deployment restores the endpoint, not the
        // history.
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: INSTANCE_HARNESS_SERVICE } },
        template: {
          metadata: {
            labels: { ...labels, app: INSTANCE_HARNESS_SERVICE },
            // A held-secret edit rolls this pod; a live Sandbox keeps what its Custodian read at
            // start (ADR-0059, the ADR-0037 stance). Moving it loses its live conversations, so no
            // autoscaler may choose to (ADR-0060) — a drain still can.
            annotations: { [ANNOTATION_HELD_DIGEST]: opts.heldDigest, ...NO_DISRUPT_ANNOTATIONS },
          },
          spec: {
            // The Sandbox tier's class (ADR-0060): it holds live conversations, as a Sandbox holds
            // `/work`, and it may wait rather than preempt.
            priorityClassName: priorityClassNames(opts.priorityClasses).sandbox,
            containers: [harnessContainer, custodian.custodianContainer],
            // The operator's isolation baseline (sandbox_controller.go), mirrored: same Harness
            // image, same "never reach the Kubernetes API" north star — JR2_MENU_ONLY makes code
            // execution here unlikely, not unimaginable. No `shareProcessNamespace`: the Harness
            // container must not read the Custodian's `/proc`. `fsGroup` makes the Custodian's
            // group-readable values readable by Envoy's own uid, as a Sandbox pod's does.
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
              fsGroup: INSTANCE_HARNESS_FS_GROUP,
            },
            volumes: custodian.volumes,
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(),
      spec: {
        selector: { app: INSTANCE_HARNESS_SERVICE },
        ports: [{ port: INSTANCE_HARNESS_PORT, targetPort: INSTANCE_HARNESS_PORT }],
      },
    },
  ];

  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}
