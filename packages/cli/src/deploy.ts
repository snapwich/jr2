// What `jr2 up` deploys (ADR-0019): pure manifest builders + the small decision helpers, kept free
// of subprocesses so the converge logic is unit-testable. Object names inside the instance's
// namespace are constants (namespace is the identity); every object carries the instance label so
// ownership is derivable from the cluster — there is no local target state.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CA_CONFIGMAP,
  GIT_SSH_SECRET,
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
  ORCHESTRATOR_PORT,
  ORCHESTRATOR_SERVICE,
  REPO_CACHE,
  REPO_CACHE_HOSTPATH,
  STATE_PVC,
  type HarnessConfig,
  type SandboxPlacement,
} from "@jr2/orchestrator";

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

/** The two ingress NetworkPolicies (ADR-0058) — see `harnessIngressPolicies`. */
export const SANDBOX_INGRESS_POLICY = "jr2-sandbox-ingress";
export const INSTANCE_HARNESS_INGRESS_POLICY = "jr2-instance-harness-ingress";

/** The operator's install location — per-cluster, shared by every instance (ADR-0019). */
export const OPERATOR_NAMESPACE = "jr2-system";
export const OPERATOR_DEPLOYMENT = "jr2-controller-manager";
/** The operator Deployment's pod selector, as rendered into `manifests/operator.yaml`. */
export const OPERATOR_SELECTOR = "control-plane=controller-manager";

/** The rendered operator install manifest shipped inside this package (`just operator-manifest`
 * regenerates it from operator/config). The manager image ref is substituted at apply time. */
export async function operatorManifest(image: string): Promise<string> {
  const raw = await readFile(fileURLToPath(new URL("../manifests/operator.yaml", import.meta.url)), "utf8");
  if (!raw.includes("image: controller:latest")) {
    throw new Error("packaged operator.yaml has no `image: controller:latest` placeholder — regenerate it");
  }
  return raw.replace("image: controller:latest", `image: ${image}`);
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

/** Everything `jr2 up` converges inside the instance's namespace, as one apply-able List. */
export function instanceObjects(opts: {
  name: string;
  namespace: string;
  image: string;
  hash: string;
  /** Secret data (token, signing key, harness env literals) — written stringData, kube encodes. */
  secretData: Record<string, string>;
  /** The HARNESS containers' env values (creds, provider key) — a SEPARATE Secret from
   * `secretData` by doctrine (ADR-0013): Agent code executes where this lands, so the Instance
   * token and signing key must never share a Secret with it. */
  harnessEnvData: Record<string, string>;
  harness?: HarnessConfig;
  /** The private-CA PEM bundle (`harness.caBundle` file contents, read by `up` — ADR-0020). */
  caBundle?: string;
  /** Every image ref THIS converge resolved (ADR-0037/0038/0049): `{ harness, adapter, operator?,
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
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
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
      // (ADR-0012/0013) and creates the Repo CRs the cache agent reconciles (ADR-0051); pod
      // exec/port-forward are the attach path (ADR-0004).
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(ORCHESTRATOR_SA),
      rules: [
        { apiGroups: ["core.jr2.dev"], resources: ["sandboxes", "repos"], verbs: ["*"] },
        // patch/update: the token Secret is `kubectl apply`d idempotently and later ownerRef-patched.
        {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "list", "create", "delete", "patch", "update"],
        },
        { apiGroups: [""], resources: ["pods", "pods/log"], verbs: ["get", "list", "watch"] },
        { apiGroups: [""], resources: ["pods/exec", "pods/portforward"], verbs: ["create"] },
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
            // apiKey is deliberately dropped: it materializes into the Secret as
            // JR2_PROVIDER_API_KEY (`up`), and the Harness reads it from env — a ConfigMap is not
            // a place for a credential.
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
    // The private-CA bundle (ADR-0020) — a ConfigMap, not a Secret: CA certs are public data.
    // kubectlSandbox mounts it into the Harness container and points NODE_EXTRA_CA_CERTS at it.
    ...(opts.caBundle
      ? [
          {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: meta(CA_CONFIGMAP),
            data: { "ca.crt": opts.caBundle },
          },
        ]
      : []),
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
                ],
                // The Orchestrator creates Repo resources and never clones (ADR-0051) — the cache
                // agent on each node does, reading the credential Secret a Repo's `secretRef`
                // names — so nothing of git's is mounted here: state and the image map only.
                volumeMounts: [
                  { name: "state", mountPath: "/instance/.jr2" },
                  // The image map, read per provision (ADR-0038). A mount, so `jr2 up` rewriting
                  // it costs one kubelet propagation window instead of a rollout.
                  { name: "images", mountPath: IMAGES_MOUNT, readOnly: true },
                ],
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
              },
            ],
            volumes: [
              { name: "state", persistentVolumeClaim: { claimName: STATE_PVC } },
              { name: "images", configMap: { name: IMAGES_CONFIGMAP } },
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
    ...(opts.repoCache ? repoCacheObjects({ ...opts.repoCache, namespace: opts.namespace, labels, meta }) : []),
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
 * - The Orchestrator is not selected. Every route there is token-gated, and an Adapter in any
 *   Harness pod must reach it; a policy could not tell the Adapter's packets from the Agent's.
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
}): KubeManifest[] {
  const { image, namespace, labels, meta, placement } = opts;
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
                resources: { requests: { cpu: "20m", memory: "64Mi" } },
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

/** Where the Instance Harness's Harness container sees the CA bundle — the same path
 * `kubectlSandbox` mounts it at in a Sandbox pod (ADR-0020). */
const CA_MOUNT = "/etc/jr2/ca";

/** The Adapter's port on the pod's loopback — the same default the Sandbox pod uses. */
const ADAPTER_PORT = 8081;

/**
 * The Instance Harness (ADR-0031): the per-instance Harness Deployment + Service `jr2 up`
 * converges whenever an Agent a registered Machine CARRIES declares `workspace: "none"`
 * (ADR-0049's walk) — the placement for every Menu-only Agent's Turn, regardless of any enclosing
 * Workspace. The one Harness shape, minus the Workspace: the stock Harness image plus the Adapter
 * sidecar, the same harness-config ConfigMap and env/envFrom/CA wiring a Sandbox's Harness
 * container gets — and NO `/work` volume, no attach step. It runs the STOCK image permanently: `workspace: "none"` withholds the whole
 * Working toolset (ADR-0028), so there are no tools to carry and no Sandbox Image to resolve
 * (ADR-0037). No config key names, sizes, addresses, or enables it: the Machine walk is the
 * entire surface.
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
  /** The resolved Adapter ref: the Harness's one menu-delivery path, kept even though a `"none"`
   * Agent cannot execute code — forking the path for one pod buys a divergence ADR-0031 declines. */
  adapterImage: string;
  harness?: HarnessConfig;
  /** The instance ships a private-CA bundle (ADR-0020): mount `jr2-ca` into the Harness container. */
  caBundle?: boolean;
  /** The digest of this placement's Harness bearer (ADR-0058; `harnessTokenDigest(key,
   * "jr2-instance-harness")`) — the wire's gate. The digest, never the bearer: the same shape
   * every Sandbox Harness container gets, so this pod can verify the Orchestrator and mint
   * nothing. */
  bearerSha256: string;
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

  const harnessContainer = {
    name: "harness",
    image: opts.harnessImage,
    imagePullPolicy: "IfNotPresent",
    ports: [{ containerPort: INSTANCE_HARNESS_PORT }],
    // The same asymmetry the Sandbox pod builds (ADR-0013/0020): the mounted harness config and
    // the instance's valueFrom entries ride `env` (literal values live in the jr2-harness-env
    // Secret), the CA trust lands here and nowhere else, and no credential ever does.
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
      { name: "JR2_ADAPTER_URL", value: `http://127.0.0.1:${ADAPTER_PORT}` },
      ...(opts.caBundle ? [{ name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/ca.crt` }] : []),
      // The wire's gate (ADR-0058), last — as on a Sandbox — so no `harness.env` entry chooses it.
      { name: "JR2_HARNESS_TOKEN_SHA256", value: opts.bearerSha256 },
    ],
    envFrom: [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(opts.harness?.envFrom ?? [])],
    ...(opts.caBundle ? { volumeMounts: [{ name: "ca", mountPath: CA_MOUNT, readOnly: true }] } : {}),
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
    securityContext: hardenedContainerSecurityContext(),
  };

  const adapterContainer = {
    name: "adapter",
    image: opts.adapterImage,
    imagePullPolicy: "IfNotPresent",
    securityContext: hardenedContainerSecurityContext(),
    env: [
      {
        name: "JR2_ORCHESTRATOR_URL",
        value: `http://${ORCHESTRATOR_SERVICE}.${opts.namespace}.svc:${ORCHESTRATOR_PORT}`,
      },
      { name: "JR2_ADAPTER_PORT", value: String(ADAPTER_PORT) },
      // The Adapter's bearer env, carrying a sandbox-style token SIGNED FOR THIS PLACEMENT's
      // name (`up.ts` mints it into the instance Secret): ADR-0013's delivery doctrine, extended
      // to the second placement — the token speaks only for registrations that record the
      // Instance Harness as the pod hosting their Turn (tokens.ts), never a Workspace's, and the
      // Instance token itself never enters this pod. The credential lives in this container,
      // where no Agent can read it — and `JR2_MENU_ONLY` above is what keeps that true: only
      // Menu-only Agents run here, so nothing in this pod executes code (ADR-0031's
      // defense-in-depth bonus).
      {
        name: "JR2_SANDBOX_TOKEN",
        valueFrom: { secretKeyRef: { name: INSTANCE_SECRET, key: "JR2_INSTANCE_HARNESS_TOKEN" } },
      },
    ],
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
          metadata: { labels: { ...labels, app: INSTANCE_HARNESS_SERVICE } },
          spec: {
            containers: [harnessContainer, adapterContainer],
            // The operator's isolation baseline (sandbox_controller.go), mirrored: same Harness
            // image, same "never reach the Kubernetes API" north star — JR2_MENU_ONLY makes code
            // execution here unlikely, not unimaginable.
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            ...(opts.caBundle ? { volumes: [{ name: "ca", configMap: { name: CA_CONFIGMAP } }] } : {}),
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
