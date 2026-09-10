// What `j2 up` deploys (ADR-0019): pure manifest builders + the small decision helpers, kept free
// of subprocesses so the converge logic is unit-testable. Object names inside the instance's
// namespace are constants (namespace is the identity); every object carries the instance label so
// ownership is derivable from the cluster — there is no local target state.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CA_CONFIGMAP,
  GIT_SSH_MOUNT,
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
  REPOS_PVC,
  STATE_PVC,
  type HarnessConfig,
} from "@j2/orchestrator";

export {
  GIT_SSH_SECRET,
  HARNESS_CONFIGMAP,
  HARNESS_ENV_SECRET,
  INSTANCE_HARNESS_SERVICE,
  KIT_VERSION,
  REPOS_PVC,
  STATE_PVC,
};

export const LABEL_INSTANCE = "j2.dev/instance";
export const LABEL_VERSION = "j2.dev/version";
export const LABEL_HASH = "j2.dev/content-hash";

/** The converged name→ref image map, stamped on the Orchestrator Deployment's OWN metadata so the
 * next `j2 up` can diff it and spend no docker on what has not moved (ADR-0038). An ANNOTATION, not
 * a label: a serialized map blows past the 63-character label-value limit immediately. */
export const ANNOTATION_IMAGES = "j2.dev/images";

export const ORCHESTRATOR_SA = "j2-orchestrator";

/** The operator's install location — per-cluster, shared by every instance (ADR-0019). */
export const OPERATOR_NAMESPACE = "j2-system";
export const OPERATOR_DEPLOYMENT = "j2-controller-manager";
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

/** Everything `j2 up` converges inside the instance's namespace, as one apply-able List. */
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
   * record `up` diffs and the map pods read can never disagree: as the `j2-images` ConfigMap the
   * Orchestrator reads per provision, and as an annotation on the Deployment's own metadata.
   * `sandboxUser` rides along because a provision cannot inspect an image and the pod's uid-1000
   * fallback turns on whether the image declares a `USER` (up.ts, ADR-0037). */
  imageRefs: Record<string, unknown>;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "j2" };
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
    {
      // The in-cluster source volume (ADR-0004/0019): the boot reconcile clones `repos[]` here;
      // Sandboxes mount it read-only and `--shared`-borrow its objects. RWO suits a single node
      // (kind); multi-node clusters want an RWX storage class (ADR-0004 storage shape).
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(REPOS_PVC),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "5Gi" } },
      },
    },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(ORCHESTRATOR_SA) },
    {
      // The orchestrator drives Sandbox CRs (+ their token Secrets) in its own namespace
      // (ADR-0012/0013); pod exec/port-forward are the attach path (ADR-0004).
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(ORCHESTRATOR_SA),
      rules: [
        { apiGroups: ["core.j2.dev"], resources: ["sandboxes"], verbs: ["*"] },
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
            // J2_PROVIDER_API_KEY (`up`), and the Harness reads it from env — a ConfigMap is not
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
        // ConfigMap exists to avoid. Here it is a record `j2 up` reads back and diffs, which is
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
                  { name: "J2_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                  { name: "J2_REPOS_DIR", value: "/repos" },
                  // What `/healthz` reports as this instance's identity. The same content address
                  // the image tag carries (ADR-0019), in-process so a CLI can ask over HTTP
                  // instead of needing kube access to read the Deployment's labels.
                  { name: "J2_CONTENT_HASH", value: opts.hash },
                ],
                volumeMounts: [
                  { name: "state", mountPath: "/instance/.j2" },
                  // Writable HERE (the boot reconcile is the volume's one writer, ADR-0004);
                  // Sandboxes mount the same claim read-only.
                  { name: "repos", mountPath: "/repos" },
                  // The optional deploy key (`j2 up`'s ssh offer) — the reconcile's identity.
                  { name: "git-ssh", mountPath: GIT_SSH_MOUNT, readOnly: true },
                  // The image map, read per provision (ADR-0038). A mount, so `j2 up` rewriting
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
              { name: "repos", persistentVolumeClaim: { claimName: REPOS_PVC } },
              { name: "git-ssh", secret: { secretName: GIT_SSH_SECRET, optional: true, defaultMode: 0o400 } },
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
  ];

  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** Where the Instance Harness's Harness container sees the CA bundle — the same path
 * `kubectlSandbox` mounts it at in a Sandbox pod (ADR-0020). */
const CA_MOUNT = "/etc/j2/ca";

/** The Adapter's port on the pod's loopback — the same default the Sandbox pod uses. */
const ADAPTER_PORT = 8081;

/**
 * The Instance Harness (ADR-0031): the per-instance Harness Deployment + Service `j2 up`
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
   * is gone, and the only Harness this instance can run is the one `j2 up` resolved.
   *
   * The accepted asymmetry: the Instance Harness names its images HERE, in the pod template, while
   * a Sandbox's refs travel through the `j2-images` ConfigMap. Both are right for what they are —
   * this Deployment is supposed to roll when its image moves; the Orchestrator is not. */
  harnessImage: string;
  /** The resolved Adapter ref: the Harness's one menu-delivery path, kept even though a `"none"`
   * Agent cannot execute code — forking the path for one pod buys a divergence ADR-0031 declines. */
  adapterImage: string;
  harness?: HarnessConfig;
  /** The instance ships a private-CA bundle (ADR-0020): mount `j2-ca` into the Harness container. */
  caBundle?: boolean;
  /** The Instance token's sha-256 — the Harness's echo gate (ADR-0023). The digest, never the
   * token: the same env every Sandbox Harness container gets, kept here so the one-Harness-shape
   * claim stays whole even though nothing narrates to the Instance Harness today. */
  echoTokenSha256?: string;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "j2" };
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
    // the instance's valueFrom entries ride `env` (literal values live in the j2-harness-env
    // Secret), the CA trust lands here and nowhere else, and no credential ever does.
    env: [
      {
        name: "J2_HARNESS_JSON",
        valueFrom: { configMapKeyRef: { name: HARNESS_CONFIGMAP, key: HARNESS_CONFIG_KEY } },
      },
      // The placement gate (ADR-0031): every admission carries its own definition (ADR-0049) and
      // the wire is unauthenticated in-cluster, so the Harness itself refuses any admission whose
      // definition declares Workspace access — Menu-only Agents alone run here, which is what
      // makes "no code execution in this pod" true rather than asserted.
      { name: "J2_MENU_ONLY", value: "1" },
      ...(opts.echoTokenSha256 ? [{ name: "J2_ECHO_TOKEN_SHA256", value: opts.echoTokenSha256 }] : []),
      ...(opts.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
      { name: "J2_ADAPTER_URL", value: `http://127.0.0.1:${ADAPTER_PORT}` },
      ...(opts.caBundle ? [{ name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/ca.crt` }] : []),
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
        name: "J2_ORCHESTRATOR_URL",
        value: `http://${ORCHESTRATOR_SERVICE}.${opts.namespace}.svc:${ORCHESTRATOR_PORT}`,
      },
      { name: "J2_ADAPTER_PORT", value: String(ADAPTER_PORT) },
      // The Adapter's bearer env, carrying a sandbox-style token SIGNED FOR THIS PLACEMENT's
      // name (`up.ts` mints it into the instance Secret): ADR-0013's delivery doctrine, extended
      // to the second placement — the token speaks only for registrations that record the
      // Instance Harness as the pod hosting their Turn (tokens.ts), never a Workspace's, and the
      // Instance token itself never enters this pod. The credential lives in this container,
      // where no Agent can read it — and `J2_MENU_ONLY` above is what keeps that true: only
      // Menu-only Agents run here, so nothing in this pod executes code (ADR-0031's
      // defense-in-depth bonus).
      {
        name: "J2_SANDBOX_TOKEN",
        valueFrom: { secretKeyRef: { name: INSTANCE_SECRET, key: "J2_INSTANCE_HARNESS_TOKEN" } },
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
            // image, same "never reach the Kubernetes API" north star — J2_MENU_ONLY makes code
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
