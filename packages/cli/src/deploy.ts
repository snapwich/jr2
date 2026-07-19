// What `j2 up` deploys (ADR-0019): pure manifest builders + the small decision helpers, kept free
// of subprocesses so the converge logic is unit-testable. Object names inside the instance's
// namespace are constants (namespace is the identity); every object carries the instance label so
// ownership is derivable from the cluster — there is no local target state.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AGENTS_CONFIGMAP,
  CA_CONFIGMAP,
  GIT_SSH_MOUNT,
  GIT_SSH_SECRET,
  HARNESS_ENV_SECRET,
  INSTANCE_SECRET,
  KIT_VERSION,
  ORCHESTRATOR_PORT,
  ORCHESTRATOR_SERVICE,
  REPOS_PVC,
  STATE_PVC,
  type DiscoveredAgent,
  type HarnessConfig,
} from "@j2/orchestrator";

export { AGENTS_CONFIGMAP, GIT_SSH_SECRET, HARNESS_ENV_SECRET, KIT_VERSION, REPOS_PVC, STATE_PVC };

export const LABEL_INSTANCE = "j2.dev/instance";
export const LABEL_VERSION = "j2.dev/version";
export const LABEL_HASH = "j2.dev/content-hash";

export const ORCHESTRATOR_SA = "j2-orchestrator";

/** The operator's install location — per-cluster, shared by every instance (ADR-0019). */
export const OPERATOR_NAMESPACE = "j2-system";
export const OPERATOR_DEPLOYMENT = "j2-controller-manager";

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
  agents: DiscoveredAgent[];
  harness?: HarnessConfig;
  /** The private-CA PEM bundle (`harness.caBundle` file contents, read by `up` — ADR-0020). */
  caBundle?: string;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "j2" };
  const meta = (name: string, extra: Record<string, string> = {}): KubeManifest => ({
    name,
    namespace: opts.namespace,
    labels: { ...labels, ...extra },
  });

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
      // The Agent definitions + harness config, consumed by the stock Harness image at pod boot
      // (ADR-0018). Definition edits reach pods as a ConfigMap update + pod restart — no image.
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(AGENTS_CONFIGMAP),
      data: {
        "agents.json": JSON.stringify(
          {
            agents: opts.agents,
            harness: {
              model: opts.harness?.model,
              // apiKey is deliberately dropped: it materializes into the Secret as
              // J2_PROVIDER_API_KEY (`up`), and the generated app.ts reads it from env — a
              // ConfigMap is not a place for a credential.
              provider: opts.harness?.provider
                ? {
                    id: opts.harness.provider.id,
                    api: opts.harness.provider.api,
                    baseUrl: opts.harness.provider.baseUrl,
                    // Token limits are model properties, not credentials — they ride the
                    // ConfigMap so the generated app.ts can hand them to registerProvider.
                    contextWindow: opts.harness.provider.contextWindow,
                    maxTokens: opts.harness.provider.maxTokens,
                    models: opts.harness.provider.models,
                  }
                : undefined,
            },
          },
          null,
          2,
        ),
      },
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
      metadata: meta(ORCHESTRATOR_SERVICE, { [LABEL_HASH]: opts.hash, [LABEL_VERSION]: KIT_VERSION }),
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
                ],
                volumeMounts: [
                  { name: "state", mountPath: "/instance/.j2" },
                  // Writable HERE (the boot reconcile is the volume's one writer, ADR-0004);
                  // Sandboxes mount the same claim read-only.
                  { name: "repos", mountPath: "/repos" },
                  // The optional deploy key (`j2 up`'s ssh offer) — the reconcile's identity.
                  { name: "git-ssh", mountPath: GIT_SSH_MOUNT, readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: ORCHESTRATOR_PORT },
                  initialDelaySeconds: 1,
                },
              },
            ],
            volumes: [
              { name: "state", persistentVolumeClaim: { claimName: STATE_PVC } },
              { name: "repos", persistentVolumeClaim: { claimName: REPOS_PVC } },
              { name: "git-ssh", secret: { secretName: GIT_SSH_SECRET, optional: true, defaultMode: 0o400 } },
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
