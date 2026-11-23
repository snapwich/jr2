// What `jr2 up` deploys (ADR-0019): pure manifest builders + the small decision helpers, kept free
// of subprocesses so the converge logic is unit-testable. Object names inside the instance's
// namespace are constants (namespace is the identity); every object carries the instance label so
// ownership is derivable from the cluster — there is no local target state.

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALLER_DIGESTS_KEY,
  CALLER_DIGESTS_MOUNT,
  CALLER_DIGESTS_SECRET,
  callerTokenDigest,
  callerTokenSecret,
  CA_CONFIGMAP,
  FENCE_CONFIGMAP,
  FENCE_MOUNT,
  CA_MOUNT,
  EFFECTOR_PORT,
  INSTANCE_EFFECTOR,
  CONVERSATIONS_DIR,
  CONVERSATIONS_DIR_ENV,
  CONVERSATIONS_VOLUME,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_PROGRAM_KEY,
  heldStandInKey,
  HOOK_DIGESTS_KEY,
  HOOK_DIGESTS_MOUNT,
  HOOK_DIGESTS_SECRET,
  GIT_SSH_SECRET,
  HELD_CA_SECRET,
  HELD_CONFIGMAP,
  HELD_MOUNT,
  HELD_TLS_SECRET,
  heldManifestKey,
  heldSecretsSecret,
  INSTANCE_HARNESS_HELD_POD,
  HARNESS_ENV_SECRET,
  IMAGES_CONFIGMAP,
  IMAGES_KEY,
  IMAGES_MOUNT,
  HARNESS_CONFIGMAP,
  HARNESS_CONFIG_KEY,
  INSTANCE_HARNESS_PODS_SERVICE,
  INSTANCE_HARNESS_PORT,
  INSTANCE_HARNESS_SERVICE,
  INSTANCE_HARNESS_SLOT,
  CHECK_POD_SLOT,
  fenceComposition,
  fencePodNetwork,
  harnessHealthcheck,
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
  STATE_VOLUME_DEFAULT,
  memoryBytes,
  type EffectorPlan,
  type SandboxEffectorPlan,
  effectorManifestKey,
  LABEL_EFFECTOR_POD,
  sandboxEffectorObjectsOf,
  GIT_PUSH_MANIFEST_KEY,
  LABEL_GIT_PUSH,
  GIT_CLONE_MANIFEST_KEY,
  LABEL_GIT_CLONE,
  type GitCloneSecret,
  type GitPushManifest,
  type HarnessConfig,
  type JR2Config,
  isStdioServer,
  mcpTimeoutMs,
  type HeldManifest,
  markHarnessEnv,
  type PriorityClasses,
  type SandboxPlacement,
  CUSTODIAN_CONTROL_PORT,
  CUSTODIAN_DIAL_KEY,
  CUSTODIAN_DIAL_SECRET,
  CUSTODIAN_HEALTH_PORT,
  CUSTODIAN_INBOUND_PORT,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_CONFIG,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_SERVICE,
  CUSTODIAN_STATE,
  custodianPodBootstrap,
  custodianSlotSecret,
  FENCE_PLACEHOLDERS,
  FENCE_SEGMENT,
  FENCE_SLOTS,
  FENCE_TRUNK_ATTACHMENT,
  type FenceRanges,
} from "@jr2/orchestrator/internal";
import { fenceAttachments, FENCE_TRUNK_INTERFACE, UPLINK_SCRIPT, uplinkArgs } from "./fence.ts";
import type { Pem } from "@jr2/orchestrator/internal";

export {
  INSTANCE_EFFECTOR,
  INSTANCE_HARNESS_PODS_SERVICE,
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

/** The converged name→ref image map, stamped on the Orchestrator Deployment's OWN metadata so the
 * next `jr2 up` can diff it and spend no docker on what has not moved (ADR-0038). An ANNOTATION, not
 * a label: a serialized map blows past the 63-character label-value limit immediately. */
export const ANNOTATION_IMAGES = "jr2.dev/images";

export const ORCHESTRATOR_SA = "jr2-orchestrator";

/** The label on each named Caller token's Secret (ADR-0078), with the token's name as its value.
 * `jr2 up` finds the Secrets of the names that the config no longer declares by it, and
 * `jr2 caller rotate` finds every value whose digest the Orchestrator reads. */
export const LABEL_CALLER_TOKEN = "jr2.dev/caller-token";

/** The key of a named Caller token's value in its Secret (`callerTokenSecret`). */
export const CALLER_TOKEN_KEY = "token";

/**
 * The `jr2-caller-digests` file (ADR-0078): one JSON object from each named Caller token's name to
 * the sha-256 of its value, in hex, names in order. The Orchestrator reads it through a mount, and
 * never a value.
 */
export function callerDigestsJson(values: Readonly<Record<string, string>>): string {
  const names = Object.keys(values).sort();
  return JSON.stringify(Object.fromEntries(names.map((n) => [n, callerTokenDigest(values[n]!)])));
}

/**
 * The Secrets of the named Caller tokens (ADR-0078): one per name, which holds its value and which
 * no pod mounts (`jr2 caller token` reads it over the kube API), and `jr2-caller-digests`, which
 * the Orchestrator mounts. The digests Secret is applied always, empty with no token, so the
 * mount always has its Secret.
 */
export function callerTokenObjects(
  values: Readonly<Record<string, string>>,
  meta: (name: string, extra?: Record<string, string>) => KubeManifest,
): KubeManifest[] {
  return [
    ...Object.keys(values)
      .sort()
      .map(
        (name): KubeManifest => ({
          apiVersion: "v1",
          kind: "Secret",
          metadata: meta(callerTokenSecret(name), { [LABEL_CALLER_TOKEN]: name }),
          type: "Opaque",
          stringData: { [CALLER_TOKEN_KEY]: values[name]! },
        }),
      ),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(CALLER_DIGESTS_SECRET),
      type: "Opaque",
      stringData: { [CALLER_DIGESTS_KEY]: callerDigestsJson(values) },
    },
  ];
}

/**
 * `jr2-hook-digests` (ADR-0078): one JSON object from the secret name of each Hook whose verifier is
 * `token` to the sha-256 of its value, in hex, names in order. The Orchestrator mounts it, reads it
 * again when it changes, and never holds a value. Applied always, empty with no `token` Hook, so the
 * mount always has its Secret.
 */
export function hookDigestsObject(
  digests: Readonly<Record<string, string>>,
  meta: (name: string) => KubeManifest,
): KubeManifest {
  const names = Object.keys(digests).sort();
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta(HOOK_DIGESTS_SECRET),
    type: "Opaque",
    stringData: { [HOOK_DIGESTS_KEY]: JSON.stringify(Object.fromEntries(names.map((n) => [n, digests[n]!]))) },
  };
}

/** The digest of the Instance Harness's trust files, on its pod template (ADR-0020, ADR-0084). */
export const ANNOTATION_HELD_DIGEST = "jr2.dev/held-digest";

/** The digest of the `jr2-harness` ConfigMap's text (`harnessConfigJson`), on the Instance
 * Harness's pod template: the Harness reads the text once, at start, so an edit to the custom
 * provider, a gateway or an MCP server (ADR-0079) rolls the pod. The text holds no value, so the
 * digest is not keyed. */
export const ANNOTATION_HARNESS_CONFIG_DIGEST = "jr2.dev/harness-config-digest";

/** The Instance Harness pod's `fsGroup` — a Sandbox pod's default work group (ADR-0005), for the
 * same reason: a group every container is granted, which the Stand-in files are readable by. */
const INSTANCE_HARNESS_FS_GROUP = 2000;

/** How long the Instance Harness pod is given to stop (ADR-0031's drain): on SIGTERM it stops
 * admitting and finishes the Turns it holds, so the grace is a Turn's worst case. `jr2 up` waits
 * out a rollout that long, and no longer. */
export const INSTANCE_HARNESS_DRAIN_SECONDS = 600;

/** The Instance Harness's conversations volume (ADR-0031): the StatefulSet's one claim, and the
 * PVC ordinal 0 gets from it — `<claim>-<statefulset>-<ordinal>`. */
export const INSTANCE_HARNESS_PVC = `${CONVERSATIONS_VOLUME}-${INSTANCE_HARNESS_SERVICE}-0`;

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
  /** It holds the conversations its live runs hold, and frees the rest on the live set (ADR-0031). */
  instanceHarness: { requests: { cpu: "250m", memory: "1Gi" }, limits: { memory: "1Gi" } },
  repoCache: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "1Gi" } },
  /** The Instance Effector (ADR-0068): one http call at a time per Effect, its text body bounded. */
  instanceEffector: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "128Mi" } },
  /** The provider preflight's check container (ADR-0019): one Node.js process, pi-ai, one call at a time. */
  checkContainer: { requests: { cpu: "100m", memory: "512Mi" }, limits: { memory: "512Mi" } },
  /** The Custodian pod of a Sandbox node (ADR-0084): its Envoy holds the rules of each slot of the
   * Instance, and its control process holds each slot's Secrets, its files in the pod's memory and
   * the resolver. Sized for a full range, because each pod holds each slot of the Instance. Measured
   * on kind as each container's cgroup `memory.peak`, at 128 slots of 30 entries each (5 of them
   * Intercepted, with a secret and a leaf): Envoy 652 MiB and the control process 260 MiB when a pod
   * starts with every slot or takes them live; when each slot's rules change at once, the old
   * listeners drain for 60 s beside the new ones, and Envoy reached 1,222 MiB and the control
   * process 293 MiB. Idle: the pod 98 MiB and 6 millicores with no live slot, 144 MiB and 7
   * millicores with 20. An OOM of either container cuts each connection of that node's Harness
   * pods. The `uplink` init container runs `ip` and `nft` once. */
  custodianEnvoy: { requests: { cpu: "50m", memory: "1536Mi" }, limits: { memory: "1536Mi" } },
  custodianControl: { requests: { cpu: "50m", memory: "384Mi" }, limits: { memory: "384Mi" } },
  custodianUplink: { requests: { cpu: "50m", memory: "32Mi" }, limits: { memory: "32Mi" } },
  /** Each of the two one-shot pods that probe the Fence on a Sandbox node (`fence-probe.ts`): one
   * Node.js process, a few sockets, for a few seconds. */
  fenceProbe: { requests: { cpu: "50m", memory: "96Mi" }, limits: { memory: "96Mi" } },
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
 * `jr2-control` preempts lower priorities: the Orchestrator, the operator, the Repo cache agent and the
 * Instance Effector are small and fixed, and the first three are needed by every Sandbox.
 * `jr2-sandbox` never preempts: a waiting Sandbox evicts nobody, and an ordinary pod (priority 0)
 * cannot preempt a live one. Both stay far below the
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
 * One Harness pod's held objects (ADR-0059): what `jr2 up` placed in it, ready to become objects.
 * A Workspace's, or the Instance Harness's.
 */
export type HeldPodObjects = {
  /** The pod key (`INSTANCE_HARNESS_HELD_POD`, `workspaceHeldPod`). */
  pod: string;
  manifest: HeldManifest;
  /** Its literal values, by name — for its `jr2-held-secrets-<pod>` Secret; never in the manifest,
   * never in a ConfigMap. */
  values: Record<string, string>;
};

/**
 * What `jr2 up` resolved about held secrets (ADR-0059), ready to become objects. Values appear in
 * two places only: each pod's `values` (the literals, for its own `jr2-held-secrets-<pod>` Secret)
 * and the CA's and the leaves' keys — each lands in a Secret no Harness container mounts.
 */
export type HeldObjects = {
  /** Every Harness pod the walk found, each with what its Custodian holds. */
  pods: HeldPodObjects[];
  /** The per-Instance CA — kept across converges; present whenever a secret is held or the Instance
   * is on the Fence (ADR-0084). */
  ca?: Pem;
  /** One leaf per bound target of any pod, by file stem (`leafStem`). */
  leaves: Record<string, Pem>;
};

/** Does any pod hold a secret? */
export const holdsAny = (held: HeldObjects): boolean => held.pods.some((p) => p.manifest.secrets.length > 0);

/** What `jr2 up` does with the state volume claim (ADR-0065): the size to apply and the one line
 * that says what changed, or the refusal's text. */
export type StateVolumePlan = { size: string; line?: string } | { refused: string };

/**
 * The size of the Orchestrator's state volume claim (ADR-0065). `configured` is `runs.volume`;
 * `claim` the claim that exists, with its StorageClass and whether the class allows expansion
 * (`undefined` when `jr2 up` did not read it). A new claim takes `runs.volume` or the default. A
 * claim that exists keeps its size when the config sets none, grows when the config sets a larger
 * size on a class that expands, and refuses a smaller size, or a larger one on a class that does
 * not expand: Kubernetes never makes a claim smaller, and grows it only where the class allows.
 */
export function stateVolumePlan(
  configured: string | undefined,
  claim?: { size: string; storageClass?: string; expandable?: boolean },
): StateVolumePlan {
  if (!claim) return { size: configured ?? STATE_VOLUME_DEFAULT };
  if (configured === undefined) {
    if (memoryBytes(claim.size) === memoryBytes(STATE_VOLUME_DEFAULT)) return { size: claim.size };
    return {
      size: claim.size,
      line: `state volume: keeping the claim ${STATE_PVC} at ${claim.size} — runs.volume is not set, and the default ${STATE_VOLUME_DEFAULT} is for a new claim`,
    };
  }
  const want = memoryBytes(configured);
  const have = memoryBytes(claim.size);
  if (want === have) return { size: claim.size };
  if (want < have) {
    return {
      refused:
        `runs.volume is ${configured}, smaller than the state volume claim ${STATE_PVC} (${claim.size}) — Kubernetes never ` +
        `makes a claim smaller. Set runs.volume to ${claim.size} or more (ADR-0065)`,
    };
  }
  const named = claim.storageClass ? `StorageClass "${claim.storageClass}"` : "claim's StorageClass";
  if (claim.expandable !== true) {
    return {
      refused:
        `runs.volume is ${configured}, larger than the state volume claim ${STATE_PVC} (${claim.size}), and its ${named} ` +
        `does not allow expansion (allowVolumeExpansion is not true). Keep runs.volume at ${claim.size}, or use a ` +
        `StorageClass that allows expansion (ADR-0065)`,
    };
  }
  return { size: configured, line: `state volume: growing the claim ${STATE_PVC} from ${claim.size} to ${configured}` };
}

/** Everything `jr2 up` converges inside the instance's namespace, as one apply-able List. */
export function instanceObjects(opts: {
  name: string;
  namespace: string;
  /** The size of the state volume claim (`stateVolumePlan`, ADR-0065). Default: `5Gi`. */
  stateVolume?: string;
  /** The Orchestrator Kit image's ref (ADR-0069). The Deployment carries no content hash: the
   * Assembly's hash is an Orchestrator fact, read from `GET /assembly`. */
  image: string;
  /** Secret data (the Instance token, the publish token, the signing key) — written stringData,
   * kube encodes. The Orchestrator reads it through `envFrom`. */
  secretData: Record<string, string>;
  /** The values of the named Caller tokens, by name (ADR-0078): each goes into a Secret of its own,
   * and the Orchestrator mounts only their digests (`callerTokenObjects`). Absent: none. */
  callerTokens?: Readonly<Record<string, string>>;
  /** The sha-256 digests of the `token` Hooks' secrets, by secret name (ADR-0078): the Orchestrator
   * mounts them in `jr2-hook-digests` (`hookDigestsObject`). Absent: none. */
  hookDigests?: Readonly<Record<string, string>>;
  /** The HARNESS containers' literal `harness.env` values — a SEPARATE Secret from `secretData` by
   * doctrine (ADR-0013): Agent code executes where this lands, so the Instance token and signing
   * key must never share a Secret with it, and no model key rides it either (ADR-0059). */
  harnessEnvData: Record<string, string>;
  harness?: HarnessConfig;
  /** The config's `mcp` block (ADR-0079), for the `jr2-harness` ConfigMap. */
  mcp?: JR2Config["mcp"];
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
  /** Each Workspace's Sandbox Effector (ADR-0068): its manifest rides `jr2-held`, its
   * `jr2-effector-<pod>` Secret holds its literals and `effector.json`. */
  sandboxEffectors?: readonly SandboxEffectorPlan[];
  /** Each `git.credentials` entry's push Secret and the manifest the provision reads (ADR-0051). */
  gitPush?: { secrets: ReadonlyArray<{ name: string; data: Record<string, string> }>; manifest: GitPushManifest };
  /** Each `git.credentials` entry's clone Secret (ADR-0068): the token the cache agent spends. The
   * Orchestrator names it from `git-clone.json` and never holds it. */
  gitClone?: readonly GitCloneSecret[];
  /** The Instance's Custodian (ADR-0084), when it has one: the Orchestrator provisions each Sandbox
   * on the Fence and dials it through the Custodian. Its env changes with it, so the pod rolls. */
  fence?: { range: number; ranges: FenceRanges };
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
  const priority = priorityClassNames(opts.priorityClasses);
  const effectors = (opts.sandboxEffectors ?? []).map((plan) => ({ plan, ...sandboxEffectorObjectsOf(plan) }));
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
        resources: { requests: { storage: opts.stateVolume ?? STATE_VOLUME_DEFAULT } },
      },
    },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(ORCHESTRATOR_SA) },
    {
      // The orchestrator drives Sandbox CRs in its own namespace
      // (ADR-0012/0013), watches them (ADR-0063), and creates the Repo CRs the cache agent
      // reconciles (ADR-0051). Nothing on Pods: it never reads one — the operator publishes the pod
      // facts on the Sandbox's status — and the attach is the Harness's own `POST /attach`, so no
      // `pods/exec` stream crosses the API server (ADR-0063).
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(ORCHESTRATOR_SA),
      rules: [
        { apiGroups: ["core.jr2.dev"], resources: ["sandboxes", "repos"], verbs: ["*"] },
        // Secrets: create and patch, nothing else (ADR-0068). The Orchestrator server-side
        // applies its own per-Sandbox `<sandbox>-effector`, slot Secret and `<sandbox>-standins`
        // (ADR-0084), each owned by the CR,
        // and holds no git credential and no Effect secret (ADR-0068): no get, no list, so it cannot read or enumerate the Effect
        // secrets, the clone and push Secrets, or a user's Secret through the API. RBAC cannot
        // pin `create` to a name, and `resourceNames` has no prefix form.
        { apiGroups: [""], resources: ["secrets"], verbs: ["create", "patch"] },
        // A Sandbox's trust ConfigMap `<sandbox>-trust` (ADR-0084), server-side applied at
        // provision and owned by the CR, so the garbage collector deletes it with the pod. No
        // Service: a pod on the Fence has none (ADR-0068, ADR-0084).
        { apiGroups: [""], resources: ["configmaps"], verbs: ["create", "patch"] },
        // The Custodian's pods and their nodes (ADR-0084): the EndpointSlices of its headless
        // Service, so that the Orchestrator dials a Harness pod through the Custodian pod on that
        // pod's node. Still no read of a Pod.
        { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list", "watch"] },
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
        [HARNESS_CONFIG_KEY]: harnessConfigJson(opts.harness, opts.mcp),
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
    // Held secrets (ADR-0059): what `jr2 up` DECLARES. A pod's `held-<pod>.json` is what its
    // composition reads — the Orchestrator per provision from the mount below, `jr2 up` for the
    // Instance Harness — and the Custodian's program is here once. Envoy's per-pod files are
    // rendered by whoever makes the pod, never collected here: a shared object stops at 1 MiB.
    // Names, hosts, headers: never a value.
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(HELD_CONFIGMAP),
      data: {
        ...Object.fromEntries(opts.held.pods.map((p) => [heldManifestKey(p.pod), JSON.stringify(p.manifest, null, 2)])),
        // Each Sandbox Effector's manifest (ADR-0068): the sources of its secrets mount, by name.
        // The provision adds the container only for a pod whose manifest is here.
        ...Object.fromEntries(
          effectors.map((e) => [effectorManifestKey(e.plan.pod), JSON.stringify(e.manifest, null, 2)]),
        ),
        // The push manifest (ADR-0051): which entries have a push Secret, and what each can spend.
        // Names only; the provision names the matched entry's Secret on the Sandbox CR.
        ...(opts.gitPush?.manifest.entries.length
          ? { [GIT_PUSH_MANIFEST_KEY]: JSON.stringify(opts.gitPush.manifest, null, 2) }
          : {}),
        // The clone manifest (ADR-0068): which entries' clone Secrets exist, by name. The Orchestrator
        // names one as a Repo's `secretRef` only when it is listed here.
        ...(opts.gitClone?.length
          ? {
              [GIT_CLONE_MANIFEST_KEY]: JSON.stringify(
                { version: 1, secrets: opts.gitClone.map((s) => s.name) },
                null,
                2,
              ),
            }
          : {}),
      },
    },
    // Each entry's clone Secret (ADR-0068), in Flux's key names: the operator's cache agent reads the
    // one a Repo's `secretRef` names. The Orchestrator neither writes nor reads it.
    ...(opts.gitClone ?? []).map(
      (s): KubeManifest => ({
        apiVersion: "v1",
        kind: "Secret",
        metadata: meta(s.name, { [LABEL_GIT_CLONE]: "true" }),
        type: "Opaque",
        stringData: s.data,
      }),
    ),
    // Each entry's push Secret (ADR-0051): what it pushes and signs with, in Flux's key names where
    // Flux has them. The operator projects one into the Sandbox Effector of a Sandbox whose push
    // the entry's match covers; nothing else mounts it. And each entry's token Secret, which holds
    // the push token alone: only the Custodian reads it (ADR-0068).
    ...(opts.gitPush?.secrets ?? []).map(
      (s): KubeManifest => ({
        apiVersion: "v1",
        kind: "Secret",
        metadata: meta(s.name, { [LABEL_GIT_PUSH]: "true" }),
        type: "Opaque",
        data: s.data,
      }),
    ),
    ...heldSecretObjects(opts.held, meta),
    // Each Sandbox Effector's own Secret (ADR-0068): the literals its Effects name and
    // `effector.json`. A `valueFrom` stays in the user's Secret, projected by reference at
    // provision.
    ...effectors.map(
      (e): KubeManifest => ({
        apiVersion: "v1",
        kind: "Secret",
        metadata: meta(e.secret.name, { [LABEL_EFFECTOR_POD]: e.plan.pod }),
        type: "Opaque",
        stringData: e.secret.stringData,
      }),
    ),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(INSTANCE_SECRET),
      type: "Opaque",
      stringData: opts.secretData,
    },
    // The named Caller tokens (ADR-0078): a value in a Secret of its own, and the digests in the
    // one Secret the Orchestrator mounts below. Not in `jr2-instance`: that one is `envFrom`, which
    // a running pod reads once, and a new token or a rotation must roll no pod.
    ...callerTokenObjects(opts.callerTokens ?? {}, meta),
    // The `token` Hooks' digests (ADR-0078): a Secret of their own, as the door reads them, and
    // never `jr2-caller-digests`, which `jr2 caller rotate` writes whole. Never a value.
    hookDigestsObject(opts.hookDigests ?? {}, meta),
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
        ...meta(ORCHESTRATOR_SERVICE, { [LABEL_VERSION]: KIT_VERSION }),
        // The converged image map, on the DEPLOYMENT'S OWN metadata and never on
        // `spec.template.metadata` (ADR-0038). On the pod template it would be part of the pod
        // spec, so every re-resolved ref would roll the Orchestrator — the exact cost the
        // ConfigMap exists to avoid. Here it is a record `jr2 up` reads back and diffs, which is
        // what makes a steady-state converge spend a directory walk and no docker at all.
        annotations: { [ANNOTATION_IMAGES]: imagesJson },
      },
      spec: {
        replicas: 1, // single WRITER (GLOSSARY.md): the snapshot store brooks no split-brain
        strategy: { type: "Recreate" }, // two writers may never overlap on the PVC
        selector: { matchLabels: { app: ORCHESTRATOR_SERVICE } },
        template: {
          metadata: {
            labels: { ...labels, app: ORCHESTRATOR_SERVICE },
            // The Instance Secret reaches the process through `envFrom`, which a running pod reads
            // once. A minted replacement for a lost Secret (a new publish token above all,
            // ADR-0069) must roll the pod, or every publish after it is refused with 401.
            annotations: { [ANNOTATION_SECRET_DIGEST]: instanceSecretDigest(opts.secretData) },
          },
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
                  // The API server's trust (ADR-0063): the Orchestrator's own Kubernetes client is
                  // built-in `fetch`, which trusts the ServiceAccount's CA through this and nothing
                  // else — no TLS code, no dependency.
                  { name: "NODE_EXTRA_CA_CERTS", value: SERVICE_ACCOUNT_CA },
                  // The claim's size as this converge applied it (ADR-0065): the space guard
                  // measures against it, because a hostPath class's `statfs` gives the node's disk.
                  { name: "JR2_STATE_VOLUME", value: opts.stateVolume ?? STATE_VOLUME_DEFAULT },
                  // The Fence (ADR-0084): the VLAN range this Instance claimed, and its two ranges
                  // when `fence` moves them. With them, each Sandbox is on the Fence.
                  ...(opts.fence
                    ? [
                        { name: "JR2_FENCE_RANGE", value: String(opts.fence.range) },
                        ...(opts.fence.ranges.segment !== FENCE_SEGMENT
                          ? [{ name: "JR2_FENCE_SEGMENT", value: opts.fence.ranges.segment }]
                          : []),
                        ...(opts.fence.ranges.placeholders !== FENCE_PLACEHOLDERS
                          ? [{ name: "JR2_FENCE_PLACEHOLDERS", value: opts.fence.ranges.placeholders }]
                          : []),
                      ]
                    : []),
                ],
                // The Orchestrator creates Repo resources and never clones (ADR-0051) — the cache
                // agent on each node does, reading the credential Secret a Repo's `secretRef`
                // names, which `jr2 up` wrote (ADR-0068) — so nothing of git's is mounted here and no
                // git token is in this container's env: state, the image map and the manifests.
                volumeMounts: [
                  { name: "state", mountPath: "/instance/.jr2" },
                  // The image map, read per provision (ADR-0038). A mount, so `jr2 up` rewriting
                  // it costs one kubelet propagation window instead of a rollout.
                  { name: "images", mountPath: IMAGES_MOUNT, readOnly: true },
                  // What each Workspace's Custodian holds, read per provision the same way
                  // (ADR-0059): names and hosts, which this process could not derive — its `.env`
                  // values are absent.
                  { name: "held", mountPath: HELD_MOUNT, readOnly: true },
                  // The digests of the named Caller tokens (ADR-0078), read again when they
                  // change: a new token or a rotation costs one kubelet propagation window, about
                  // a minute, and no rollout. Never a value.
                  { name: "callers", mountPath: CALLER_DIGESTS_MOUNT, readOnly: true },
                  // The digests of the `token` Hooks' secrets (ADR-0078), read again in the same
                  // way: a new or changed secret costs one kubelet propagation window. Never a value.
                  { name: "hooks", mountPath: HOOK_DIGESTS_MOUNT, readOnly: true },
                  // The trust texts of each Sandbox on the Fence (`jr2-fence`, ADR-0020), read per
                  // provision. Certificates only.
                  ...(opts.fence ? [{ name: "fence", mountPath: FENCE_MOUNT, readOnly: true }] : []),
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
                // Orchestrator is `replicas: 1` (GLOSSARY.md: single writer), so its Service has
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
              { name: "held", configMap: { name: HELD_CONFIGMAP } },
              { name: "callers", secret: { secretName: CALLER_DIGESTS_SECRET } },
              { name: "hooks", secret: { secretName: HOOK_DIGESTS_SECRET } },
              ...(opts.fence ? [{ name: "fence", configMap: { name: FENCE_CONFIGMAP } }] : []),
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
 *
 * Because it lands on exactly the Sandbox nodes, it is also the Landlock detector (ADR-0077): it
 * probes at start and, on a node without Landlock, exits with the reason, and `jr2 up` refuses to
 * converge (`landlock.ts`).
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
                // On a node without Landlock the agent exits at start with a message that names
                // Landlock, the node and the reason (ADR-0077). The kubelet keeps it in the
                // container's status, where `jr2 up` reads it; the log line serves if the file
                // write fails.
                terminationMessagePolicy: "FallbackToLogsOnError",
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

/** The uid and the group of the Custodian pod's `envoy` and `control` containers. The group owns the
 * pod's state folder, so that `control` writes each file there and `envoy` reads it. */
export const CUSTODIAN_POD_USER = 65532;

/** The annotation on the Custodian pod template: the digest of its ConfigMap. Envoy reads its
 * bootstrap once, at start, so a changed bootstrap, program or trust must replace the pods. */
export const ANNOTATION_CUSTODIAN_CONFIG_DIGEST = "jr2.dev/custodian-config-digest";

/**
 * Each Secret that the Custodian's control process may read, other than the slot Secrets and the
 * dial token (ADR-0084): each pod's `jr2-held-secrets-<pod>` that holds a literal, each Secret of
 * the user's that a held secret's `secretKeyRef` names, and each token Secret in `pushes`, whose
 * `token` the Custodian swaps into a push (ADR-0068). Sorted, once each. Its Role names these and
 * no other Secret, so it cannot read `jr2-instance`, the signing key, or an entry's push Secret,
 * which holds the ssh push key and the commit-signing key.
 */
export function custodianValueSecrets(held: HeldObjects, pushes: readonly string[] = []): string[] {
  const names = new Set<string>(pushes);
  for (const pod of held.pods) {
    if (Object.keys(pod.values).length > 0) names.add(heldSecretsSecret(pod.pod));
    for (const binding of pod.manifest.secrets) {
      if (binding.source.kind === "secret") names.add(binding.source.secret);
    }
  }
  return [...names].sort();
}

/**
 * The Custodian of an Instance (ADR-0084), as one List: one pod on each Sandbox node, outside every
 * Harness pod. An Instance with a Harness pod (a Sandbox or the Instance Harness) has it.
 *
 * - The attachments: one for each slot of the Instance's VLAN range, and the trunk.
 * - The DaemonSet `jr2-custodian`, with the Sandbox placement, so that a Custodian pod is on each
 *   node where a Harness pod can be. Its pod has three containers:
 *   - `uplink` (init; the Orchestrator image, root with `NET_ADMIN` alone, in the pod's own network
 *     namespace): the VLAN interfaces of the range and the static rule set (`UPLINK_SCRIPT`);
 *   - `envoy` (the pinned image, no capability): a listener for each slot with rules, the inbound
 *     listener of the Orchestrator's dial, and the health listener;
 *   - `control` (the Orchestrator image, no capability): reads the slot Secrets, makes each slot's
 *     rules live in Envoy, and serves the resolver of each slot and its own API. It is the one
 *     container with a ServiceAccount token.
 * - The headless Service `jr2-custodian`: no address routes to it; its EndpointSlices name each
 *   ready Custodian pod and its node, which is how the Orchestrator finds the pod on a Harness pod's
 *   node.
 * - The Role: `get` on a fixed list of Secret names (each slot Secret, the dial token, and
 *   `valueSecrets`), and nothing else.
 * - The NetworkPolicy: the inbound and control ports admit this Instance's Orchestrator only. The
 *   dial token is the control that holds on a CNI that enforces no policy, and the Harness's bearer
 *   is the second one (ADR-0058).
 * - The dial token's Secret and the ConfigMap of Envoy's bootstrap, the Custodian's program and its
 *   upstream trust (the roots and the user's `caBundle`, never a jr2 CA).
 *
 * The pod template changes only with the images, the range, the ranges, the placement and the
 * ConfigMap's digest: a Harness pod's rules change through `control`, never through the template,
 * because each roll cuts every connection of that node's Harness pods.
 */
export function custodianObjects(opts: {
  name: string;
  namespace: string;
  /** The Instance's VLAN range (`claimRange`). */
  range: number;
  /** The Instance's two Fence ranges (`fenceRangesOf(config.fence)`). */
  ranges: FenceRanges;
  /** The Orchestrator Kit image: the `uplink` and `control` containers. */
  orchestratorImage: string;
  /** The pinned Envoy (`custodianRef`). */
  envoyImage: string;
  /** The Instance's dial token (`custodianDialToken`). */
  dialToken: string;
  /** The Secrets of held values that the control process may read (`custodianValueSecrets`). */
  valueSecrets: readonly string[];
  /** The user's `caBundle` (ADR-0020), trusted upstream beside the roots. */
  upstreamTrust: string;
  placement?: SandboxPlacement;
  priorityClasses?: PriorityClasses;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
  const meta = (name: string): KubeManifest => ({ name, namespace: opts.namespace, labels: { ...labels } });
  const app = { app: CUSTODIAN_SERVICE };
  const config = {
    "envoy.json": JSON.stringify(
      custodianPodBootstrap({
        orchestrator: { host: `${ORCHESTRATOR_SERVICE}.${opts.namespace}.svc`, port: ORCHESTRATOR_PORT },
        range: opts.range,
        ranges: opts.ranges,
      }),
    ),
    [CUSTODIAN_PROGRAM_KEY]: CUSTODIAN_PROGRAM,
    "upstream.crt": opts.upstreamTrust,
  };
  const digest = createHash("sha256");
  for (const [k, v] of Object.entries(config)) digest.update(k).update("\0").update(v).update("\0");
  const secretNames = [
    ...Array.from({ length: FENCE_SLOTS }, (_, i) => custodianSlotSecret(i)),
    CUSTODIAN_DIAL_SECRET,
    ...opts.valueSecrets,
  ];
  const security = {
    runAsUser: CUSTODIAN_POD_USER,
    runAsGroup: CUSTODIAN_POD_USER,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
  const serviceAccountDir = posix.dirname(SERVICE_ACCOUNT_CA);
  const moved = [
    ...(opts.ranges.segment !== FENCE_SEGMENT ? [{ name: "JR2_FENCE_SEGMENT", value: opts.ranges.segment }] : []),
    ...(opts.ranges.placeholders !== FENCE_PLACEHOLDERS
      ? [{ name: "JR2_FENCE_PLACEHOLDERS", value: opts.ranges.placeholders }]
      : []),
  ];

  const items: KubeManifest[] = [
    ...fenceAttachments({ namespace: opts.namespace, labels, range: opts.range, ranges: opts.ranges }),
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: meta(CUSTODIAN_SERVICE),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta(CUSTODIAN_SERVICE),
      rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"], resourceNames: secretNames }],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: meta(CUSTODIAN_SERVICE),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: CUSTODIAN_SERVICE },
      subjects: [{ kind: "ServiceAccount", name: CUSTODIAN_SERVICE, namespace: opts.namespace }],
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(CUSTODIAN_DIAL_SECRET),
      type: "Opaque",
      stringData: { [CUSTODIAN_DIAL_KEY]: opts.dialToken },
    },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta(CUSTODIAN_SERVICE), data: config },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(CUSTODIAN_SERVICE),
      spec: {
        clusterIP: "None",
        selector: app,
        ports: [
          { name: "inbound", port: CUSTODIAN_INBOUND_PORT, targetPort: CUSTODIAN_INBOUND_PORT },
          { name: "control", port: CUSTODIAN_CONTROL_PORT, targetPort: CUSTODIAN_CONTROL_PORT },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(CUSTODIAN_SERVICE),
      spec: {
        podSelector: { matchLabels: app },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { app: ORCHESTRATOR_SERVICE, [LABEL_INSTANCE]: opts.name } } }],
            ports: [
              { protocol: "TCP", port: CUSTODIAN_INBOUND_PORT },
              { protocol: "TCP", port: CUSTODIAN_CONTROL_PORT },
            ],
          },
          // The health listener answers 200 and nothing else, to any peer.
          { ports: [{ protocol: "TCP", port: CUSTODIAN_HEALTH_PORT }] },
        ],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { ...meta(CUSTODIAN_SERVICE), labels: { ...labels, [LABEL_VERSION]: KIT_VERSION } },
      spec: {
        selector: { matchLabels: app },
        // One pod of a node at a time, and never two at once on a node: the VLAN interfaces of
        // each pod have the same fixed MACs, and two pods on one bridge would share them.
        updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } },
        template: {
          metadata: {
            labels: { ...labels, ...app },
            annotations: {
              // The text form, with the namespace: jr2's admission policy admits an attachment of
              // the Fence only in this form, and only of the pod's own namespace (ADR-0084).
              "k8s.v1.cni.cncf.io/networks": `${opts.namespace}/${FENCE_TRUNK_ATTACHMENT}@${FENCE_TRUNK_INTERFACE}`,
              [ANNOTATION_CUSTODIAN_CONFIG_DIGEST]: digest.digest("hex"),
            },
          },
          spec: {
            serviceAccountName: CUSTODIAN_SERVICE,
            // Only `control` gets a token, through its own projected volume.
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // Control tier (ADR-0060): every Harness pod on the node needs it.
            priorityClassName: priorityClassNames(opts.priorityClasses).control,
            // On each node where a Harness pod can be (ADR-0052): the Sandbox placement, as the
            // cache agent has it.
            ...(opts.placement?.nodeSelector ? { nodeSelector: opts.placement.nodeSelector } : {}),
            ...(opts.placement?.tolerations?.length ? { tolerations: opts.placement.tolerations } : {}),
            securityContext: { fsGroup: CUSTODIAN_POD_USER, seccompProfile: { type: "RuntimeDefault" } },
            initContainers: [
              {
                name: "uplink",
                image: opts.orchestratorImage,
                imagePullPolicy: "IfNotPresent",
                command: [
                  "sh",
                  "-c",
                  UPLINK_SCRIPT,
                  ...uplinkArgs({
                    range: opts.range,
                    ranges: opts.ranges,
                    state: CUSTODIAN_STATE,
                    group: CUSTODIAN_POD_USER,
                  }),
                ],
                terminationMessagePolicy: "FallbackToLogsOnError",
                volumeMounts: [{ name: "state", mountPath: CUSTODIAN_STATE }],
                resources: sized(KIT_POD_SIZES.custodianUplink),
                // Root in the pod's own network namespace, with NET_ADMIN and no other capability.
                securityContext: {
                  runAsUser: 0,
                  runAsGroup: 0,
                  runAsNonRoot: false,
                  readOnlyRootFilesystem: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] },
                  seccompProfile: { type: "RuntimeDefault" },
                },
              },
            ],
            containers: [
              {
                name: "control",
                image: opts.orchestratorImage,
                imagePullPolicy: "IfNotPresent",
                command: ["tsx", "node_modules/@jr2/orchestrator/bin/custodian-control.ts"],
                env: [
                  { name: "JR2_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                  { name: "JR2_FENCE_RANGE", value: String(opts.range) },
                  ...moved,
                  // The API server's trust: the client is built-in `fetch` (ADR-0063).
                  { name: "NODE_EXTRA_CA_CERTS", value: SERVICE_ACCOUNT_CA },
                ],
                ports: [{ name: "control", containerPort: CUSTODIAN_CONTROL_PORT }],
                volumeMounts: [
                  { name: "state", mountPath: CUSTODIAN_STATE },
                  { name: "kube-api", mountPath: serviceAccountDir, readOnly: true },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                // Ready once each slot that has rules is live in Envoy, and sticky after that.
                readinessProbe: {
                  httpGet: { path: "/healthz", port: CUSTODIAN_CONTROL_PORT },
                  initialDelaySeconds: 1,
                  periodSeconds: 2,
                  failureThreshold: 15,
                },
                resources: sized(KIT_POD_SIZES.custodianControl),
                securityContext: security,
              },
              {
                name: "envoy",
                image: opts.envoyImage,
                imagePullPolicy: "IfNotPresent",
                args: [...CUSTODIAN_POD_ARGS],
                ports: [
                  { name: "health", containerPort: CUSTODIAN_HEALTH_PORT },
                  { name: "inbound", containerPort: CUSTODIAN_INBOUND_PORT },
                ],
                volumeMounts: [
                  { name: "config", mountPath: CUSTODIAN_POD_CONFIG, readOnly: true },
                  { name: "trust", mountPath: CA_MOUNT, readOnly: true },
                  { name: "state", mountPath: CUSTODIAN_STATE, readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: CUSTODIAN_HEALTH_PORT },
                  initialDelaySeconds: 1,
                  periodSeconds: 2,
                  failureThreshold: 15,
                },
                resources: sized(KIT_POD_SIZES.custodianEnvoy),
                securityContext: security,
              },
            ],
            volumes: [
              {
                name: "config",
                configMap: {
                  name: CUSTODIAN_SERVICE,
                  items: [
                    { key: "envoy.json", path: posix.basename(CUSTODIAN_POD_BOOTSTRAP) },
                    { key: CUSTODIAN_PROGRAM_KEY, path: posix.basename(CUSTODIAN_POD_PROGRAM) },
                  ],
                },
              },
              {
                name: "trust",
                configMap: { name: CUSTODIAN_SERVICE, items: [{ key: "upstream.crt", path: "upstream.crt" }] },
              },
              // The LDS and CDS files and each slot's values, leaves and Lua tables: in the pod's
              // memory, never on the node's disk.
              { name: "state", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
              // tsx's cache of the control process's compiled files.
              { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
              {
                name: "kube-api",
                projected: {
                  sources: [
                    { serviceAccountToken: { path: "token", expirationSeconds: 3607 } },
                    { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
                    { downwardAPI: { items: [{ path: "namespace", fieldRef: { fieldPath: "metadata.namespace" } }] } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ];
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/**
 * What the Orchestrator reads of the Fence (ADR-0084, ADR-0020): `jr2-fence`, with `upstream.crt` (the
 * roots of the Node that runs `jr2 up`, and the user's `caBundle`) and the `caBundle` alone as
 * `ca.crt`. Each Sandbox's `bundle.crt` and `extra.crt` start with them. Its own manifest, apart
 * from the List: the roots are past what client-side apply's annotation can hold, so `jr2 up`
 * applies it server-side, before the Orchestrator that mounts it.
 */
export function fenceConfigObject(opts: {
  name: string;
  namespace: string;
  upstream: string;
  caBundle?: string;
}): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: FENCE_CONFIGMAP,
      namespace: opts.namespace,
      labels: { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" },
    },
    data: { "upstream.crt": opts.upstream, ...(opts.caBundle !== undefined ? { "ca.crt": opts.caBundle } : {}) },
  });
}

/** The label on each pod's `jr2-held-secrets-<pod>` Secret: its pod, so `jr2 up` finds and deletes
 * the one a pod no longer needs. */
export const LABEL_HELD_POD = "jr2.dev/held-pod";

/**
 * The held-secret Secrets (ADR-0059, ADR-0084), present while the Instance has a CA: while a secret
 * is held, or a Harness pod that `jr2 up` makes is on the Fence. The CA (which NO pod mounts —
 * `jr2 up` alone reads it back), each pod's literal values (the Custodian's alone) and the leaves
 * (`jr2 up` reads them back, and copies each into the slot Secret of a pod it makes).
 * `stringData` as written: no trailing newline is added to a value.
 */
function heldSecretObjects(held: HeldObjects, meta: (name: string) => KubeManifest): KubeManifest[] {
  if (!held.ca) return [];
  const secret = (name: string, stringData: Record<string, string>, pod?: string): KubeManifest => {
    const m = meta(name);
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: pod === undefined ? m : { ...m, labels: { ...(m.labels as object), [LABEL_HELD_POD]: pod } },
      type: "Opaque",
      stringData,
    };
  };
  const leaves: Record<string, string> = {};
  for (const [stem, pem] of Object.entries(held.leaves)) {
    leaves[`${stem}.crt`] = pem.cert;
    leaves[`${stem}.key`] = pem.key;
  }
  return [
    secret(HELD_CA_SECRET, { "ca.crt": held.ca.cert, "ca.key": held.ca.key }),
    ...held.pods.flatMap((p) =>
      Object.keys(p.values).length ? [secret(heldSecretsSecret(p.pod), p.values, p.pod)] : [],
    ),
    secret(HELD_TLS_SECRET, leaves),
  ];
}

/**
 * The trust ConfigMap (ADR-0020): the user's `caBundle` as `ca.crt`, which the Instance Effector and
 * each Harness pod read. Its own manifest, apart from the List, and `jr2 up` applies it server-side.
 * Undefined when there is no `caBundle`: then `jr2 up` deletes it.
 */
export function trustObject(opts: { name: string; namespace: string; caBundle?: string }): string | undefined {
  if (opts.caBundle === undefined) return undefined;
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CA_CONFIGMAP,
      namespace: opts.namespace,
      labels: { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" },
    },
    data: { "ca.crt": opts.caBundle },
  });
}

/**
 * The Instance Harness (ADR-0031): the per-instance Harness StatefulSet and its headless Service, which
 * `jr2 up` converges whenever an Agent a registered Machine CARRIES declares `workspace: "none"`
 * (ADR-0049's walk) — the placement for every Menu-only Agent's Turn, regardless of any enclosing
 * Workspace. The one Harness shape, minus the Workspace: the stock Harness image, the same
 * harness-config ConfigMap and env/envFrom wiring a Sandbox's Harness container gets — and NO
 * `/work` volume, no attach step and no container of the Custodian. It is on slot 0 of the Fence
 * (ADR-0084), as a Sandbox is on its slot: its one network leads to the Instance's Custodian, outside
 * the pod, at jr2's own name, and it takes the Sandbox placement, so a Custodian pod is on its node.
 * It runs the STOCK image permanently: `workspace: "none"` withholds the whole Working toolset
 * (ADR-0028), so there are no tools to carry and no Sandbox Image to resolve (ADR-0037). No config
 * key names, sizes, addresses, or enables it: the Machine walk is the entire surface.
 *
 * Its Fence objects (`podFenceObjects`: the slot Secret, `jr2-instance-harness-trust` and
 * `jr2-instance-harness-standins`) are not in this List: `jr2 up` applies them first, and waits
 * until the Custodian says that the slot's rules are live, before the pod starts.
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
   * this StatefulSet is supposed to roll when its image moves; the Orchestrator is not. */
  harnessImage: string;
  /** What this converge placed in the Instance Harness (ADR-0059): its own manifest — the model
   * keys its `"none"` Agents' providers read and the secrets of the remote MCP servers they name
   * (ADR-0079), and nothing else. The pod gets the Stand-in of each as a file. */
  held: HeldManifest;
  /** The Instance's two Fence ranges: slot 0's attachment and the uplink's address. */
  ranges: FenceRanges;
  /** A digest of the pod's trust files (`jr2-instance-harness-trust`), on the pod template: the
   * Harness reads them once, at start, so a new CA or `caBundle` must roll the pod. A held value
   * reaches the Custodian with no roll (ADR-0059). */
  trustDigest: string;
  harness?: HarnessConfig;
  /** The config's `mcp` block (ADR-0079): with `harness`, the text of the `jr2-harness` ConfigMap,
   * whose digest is on the pod template. */
  mcp?: JR2Config["mcp"];
  /** The instance ships a private-CA bundle (ADR-0020). */
  caBundle?: boolean;
  /** The digest of this placement's Harness bearer (ADR-0058; `harnessTokenDigest(key,
   * "jr2-instance-harness")`) — the wire's gate. The digest, never the bearer: the same shape
   * every Sandbox Harness container gets, so this pod can verify the Orchestrator and mint
   * nothing. */
  bearerSha256: string;
  /** The Sandbox placement (ADR-0052): the Instance Harness is on a Sandbox node, where a Custodian
   * pod is (ADR-0084). */
  placement?: SandboxPlacement;
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

  // On the Fence (ADR-0084), as a Sandbox is: the Custodian's URL at jr2's own name, the control
  // Stand-in's file and the trust variables; the trust files and the Stand-ins as files. The pod's
  // tokens are in its slot Secret, which only the Custodian reads (ADR-0076).
  const fence = fenceComposition(opts.held, {
    sandbox: INSTANCE_HARNESS_SERVICE,
    slot: INSTANCE_HARNESS_SLOT,
    ranges: opts.ranges,
    caBundle: opts.caBundle === true,
  });
  const network = fencePodNetwork(opts.namespace, fence.network);
  const probe = { exec: { command: harnessHealthcheck(INSTANCE_HARNESS_PORT) }, timeoutSeconds: 2 };

  const harnessContainer = {
    name: "harness",
    image: opts.harnessImage,
    imagePullPolicy: "IfNotPresent",
    ports: [{ containerPort: INSTANCE_HARNESS_PORT }],
    // The same asymmetry the Sandbox pod builds (ADR-0013/0020/0059): the mounted harness config
    // and the instance's valueFrom entries ride `env` (literal values live in the jr2-harness-env
    // Secret), then the Custodian's address and the trust variables, and no credential ever does.
    // Marked (ADR-0076, `harness-env.ts`): the stock image's command starts the Harness with
    // `effector nocore --harness-env`, which gives the Harness process jr2's names alone.
    ...markHarnessEnv(
      [
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
        ...fence.harnessEnv,
        // Where the conversations persist (ADR-0031): the claim below. Mechanism, as on a Sandbox.
        { name: CONVERSATIONS_DIR_ENV, value: CONVERSATIONS_DIR },
        // The wire's gate (ADR-0058), last — as on a Sandbox — so no `harness.env` entry chooses it.
        { name: "JR2_HARNESS_TOKEN_SHA256", value: opts.bearerSha256 },
      ],
      [{ secretRef: { name: HARNESS_ENV_SECRET } }, ...(opts.harness?.envFrom ?? [])],
    ),
    volumeMounts: [{ name: CONVERSATIONS_VOLUME, mountPath: CONVERSATIONS_DIR }, ...fence.harnessMounts],
    // The Harness's own route, not the port (ADR-0063): an exec probe from inside the container,
    // because no HTTP probe of the kubelet reaches a pod on the Fence (ADR-0084). Every second until
    // it first answers, then every 2 s with the threshold that carries a stall; a draining Harness
    // still answers it (ADR-0031). This pod is single-replica.
    startupProbe: { ...probe, periodSeconds: 1, failureThreshold: 120 },
    readinessProbe: { ...probe, periodSeconds: 2, failureThreshold: 15 },
    resources: sized(KIT_POD_SIZES.instanceHarness),
    securityContext: hardenedContainerSecurityContext(),
  };

  const items: KubeManifest[] = [
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { ...meta(), labels: { ...labels, [LABEL_VERSION]: KIT_VERSION } },
      spec: {
        // A StatefulSet of ONE (ADR-0031): the value is the stable volume — a restart or a rollout
        // brings the same conversations back — and the stable name is what N > 1 would pin a
        // conversation to. Never more than one pod on slot 0 for one conversation, and never an
        // HPA: a scale-down would kill conversations. At N = 1 a rollout has no surge, so
        // admissions are refused while the new pod starts, which the Orchestrator absorbs
        // (ADR-0042). And never two pods at once: they would share slot 0's address.
        replicas: 1,
        serviceName: INSTANCE_HARNESS_PODS_SERVICE,
        selector: { matchLabels: { app: INSTANCE_HARNESS_SERVICE } },
        // The conversations go with the StatefulSet, never with a scale-down: an instance whose
        // Machines dropped every `"none"` Agent keeps no history for them.
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Delete", whenScaled: "Retain" },
        volumeClaimTemplates: [
          {
            metadata: { name: CONVERSATIONS_VOLUME, labels },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "1Gi" } },
            },
          },
        ],
        template: {
          metadata: {
            labels: { ...labels, app: INSTANCE_HARNESS_SERVICE },
            // A new trust rolls this pod: the Harness reads it once, at start (ADR-0020). A move
            // costs a drain, not the conversations (the volume keeps them), yet no autoscaler may
            // choose one (ADR-0060) — a drain still can.
            // The same for the `jr2-harness` text, which the Harness reads once at start: a server
            // added to `mcp`, or a url, an argv or a timeout changed, reaches the pod (ADR-0079).
            annotations: {
              ...network.annotations,
              [ANNOTATION_HELD_DIGEST]: opts.trustDigest,
              [ANNOTATION_HARNESS_CONFIG_DIGEST]: createHash("sha256")
                .update(harnessConfigJson(opts.harness, opts.mcp))
                .digest("base64url")
                .slice(0, 32),
              ...NO_DISRUPT_ANNOTATIONS,
            },
          },
          spec: {
            // The drain (ADR-0031): on SIGTERM the Harness stops admitting and finishes the Turns
            // it holds, so the grace is a Turn's worst case — a deploy loses no Turn. The
            // Custodian is outside the pod and does not stop with it.
            terminationGracePeriodSeconds: INSTANCE_HARNESS_DRAIN_SECONDS,
            // The Sandbox tier's class (ADR-0060): it holds live conversations, as a Sandbox holds
            // `/work`, and it may wait rather than preempt.
            priorityClassName: priorityClassNames(opts.priorityClasses).sandbox,
            // On a Sandbox node (ADR-0052, ADR-0084): a Custodian pod is on each one.
            ...(opts.placement?.nodeSelector ? { nodeSelector: opts.placement.nodeSelector } : {}),
            ...(opts.placement?.tolerations?.length ? { tolerations: opts.placement.tolerations } : {}),
            containers: [harnessContainer],
            // The operator's isolation baseline (sandbox_controller.go), mirrored: same Harness
            // image, same "never reach the Kubernetes API" north star — JR2_MENU_ONLY makes code
            // execution here unlikely, not unimaginable. `fsGroup` makes the group-readable
            // Stand-in files readable, as a Sandbox pod's does.
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
              fsGroup: INSTANCE_HARNESS_FS_GROUP,
            },
            // On the Fence, the uplink's nameserver alone, as the operator gives a Sandbox.
            dnsPolicy: network.dnsPolicy,
            dnsConfig: network.dnsConfig,
            volumes: fence.volumes,
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { ...meta(), name: INSTANCE_HARNESS_PODS_SERVICE },
      spec: {
        // Headless — the StatefulSet's governing Service (`serviceName`), and no address routes to it
        // (ADR-0084). Its EndpointSlices name the pod's node, also while the pod drains, which is
        // how the Orchestrator finds the Custodian pod that carries a dial to slot 0.
        clusterIP: "None",
        publishNotReadyAddresses: true,
        selector: { app: INSTANCE_HARNESS_SERVICE },
        ports: [{ port: INSTANCE_HARNESS_PORT, targetPort: INSTANCE_HARNESS_PORT }],
      },
    },
  ];

  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** What the Instance can REACH (ADR-0018), as the `jr2-harness` ConfigMap carries it to every
 * Harness container: the custom provider without its key, the catalog gateways, and the MCP servers
 * (ADR-0079) — a remote one's url and the NAME of its secret, never a value. The check pod carries
 * the same text in its own ConfigMap (ADR-0019). */
export function harnessConfigJson(harness: HarnessConfig | undefined, mcp?: JR2Config["mcp"]): string {
  return JSON.stringify(
    {
      // apiKey is deliberately dropped: it is a held secret (ADR-0059) — the Custodian holds
      // it, the Harness's env holds its Stand-in, and a ConfigMap is no place for either.
      provider: harness?.provider
        ? {
            id: harness.provider.id,
            api: harness.provider.api,
            baseUrl: harness.provider.baseUrl,
            // Token limits are model properties, not credentials — they ride the ConfigMap
            // so the Harness can register the provider with them.
            contextWindow: harness.provider.contextWindow,
            maxTokens: harness.provider.maxTokens,
            models: harness.provider.models,
          }
        : undefined,
      // Where pi's catalog providers send their calls (ADR-0059): endpoints, not keys.
      catalog: harness?.catalog,
      // The MCP servers (ADR-0079), by the config's name: the Harness joins each Agent's `mcp` list
      // to them. In-cluster the config has no `.env`, so the url rides from here, as baseUrl does.
      mcp: mcp === undefined ? undefined : mcpSpecOf(mcp),
    },
    null,
    2,
  );
}

/** The `mcp` block as the Harness reads it (`McpServerSpec` in `@jr2/harness`): the timeout in
 * milliseconds, and a stdio server's `args` always a list. */
function mcpSpecOf(mcp: NonNullable<JR2Config["mcp"]>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mcp).map(([name, server]) => {
      const timeoutMs = mcpTimeoutMs(server.timeout);
      return [
        name,
        isStdioServer(server)
          ? { command: server.command, args: [...(server.args ?? [])], timeoutMs }
          : { url: server.url, ...(server.secret !== undefined ? { secret: server.secret } : {}), timeoutMs },
      ];
    }),
  );
}

/** The argv word of `provider-preflight.ts` before the MCP servers to list (`PREFLIGHT_MCP_ARG` in
 * `@jr2/harness`'s `preflight-line.ts`, which a test holds this to). */
export const PREFLIGHT_MCP_ARG = "--mcp";

/** The provider preflight's objects (ADR-0019): a check pod and its own copies of what it reads,
 * each named `jr2-provider-preflight-<run>-<n>` or that name and a suffix, unique to one `jr2 up`. */
export const PROVIDER_PREFLIGHT = "jr2-provider-preflight";
/** The label every one of them carries, its value the `jr2 up` run: how a later run finds the
 * leftovers of a run that did not end, and leaves another run's objects alone. */
export const LABEL_PROVIDER_PREFLIGHT = "jr2.dev/provider-preflight";
/** The check container in that pod, whose output `jr2 up` reads. An older `jr2 up` named it `probe`. */
export const CHECK_CONTAINER = "check";

/** Every object of one check pod (`checkPodObjects` and its Fence objects but the slot Secret, which
 * `jr2 up` deletes apart), for its deletion. `<object>-ca`, `<object>-tls` and `<object>` the Secret
 * are of a check pod before the Fence, whose Custodian was in the pod: a later run deletes them. */
export function checkPodObjectNames(object: string): Array<{ kind: string; name: string }> {
  return [
    { kind: "pod", name: object },
    { kind: "networkpolicy", name: object },
    { kind: "configmap", name: object },
    { kind: "configmap", name: `${object}-trust` },
    { kind: "configmap", name: `${object}-ca` },
    { kind: "secret", name: `${object}-standins` },
    { kind: "secret", name: object },
    { kind: "secret", name: `${object}-tls` },
    { kind: "secret", name: `${object}-env` },
  ];
}

/**
 * One check pod of the provider preflight (ADR-0019, ADR-0059, ADR-0084): a Harness pod with no
 * Harness in it, on slot 1 of the Fence, and its own copies of every object a Harness pod reads. So a
 * check pod writes nothing that a running pod of the Instance reads, and a check that fails leaves
 * the pods of the Instance as they were.
 *
 * - `<object>` (ConfigMap): the harness config (`harnessConfigJson`).
 * - `<object>-env` (Secret): the literal `harness.env` values, which `jr2-harness-env` would carry.
 *
 * Its Fence objects are not in this List (`podFenceObjects`: slot 1's Secret, with the copy of the
 * literal values of the keys it holds, `<object>-trust` and `<object>-standins`): `jr2 up` applies
 * them first, waits until the Custodian says that the slot's rules are live, and deletes them after
 * the check. The check reaches a provider as a Turn does, through the Instance's Custodian, which
 * holds the keys; the key never enters the pod, its argv or its log. The check container runs the
 * stock Harness image's `provider-preflight.ts` with the Harness container's env and the pod's
 * Stand-ins, so the call is the one a Turn makes. The argv is the model specifiers alone.
 *
 * The pod has the Sandbox placement and the priority class of the Harness pods it stands for
 * (ADR-0052, ADR-0060). Its labels are its own and match no Harness pod's. It has no probe: it ends
 * when the check does.
 */
export function checkPodObjects(opts: {
  name: string;
  namespace: string;
  /** This check pod's object name (`jr2-provider-preflight-<run>-<n>`) and its run, for the label. */
  object: string;
  run: string;
  /** The resolved stock Harness ref: the image a Turn's Harness runs, with pi-ai at the pin. */
  harnessImage: string;
  /** The bindings of the keys this check pod holds: each a part of a held pod's manifest. */
  held: HeldManifest;
  /** The Instance's two Fence ranges: slot 1's attachment and the uplink's address. */
  ranges: FenceRanges;
  /** The literal `harness.env` values. */
  harnessEnvData: Record<string, string>;
  /** The `<provider>/<model>` specifiers to check, in order. */
  models: readonly string[];
  /** The remote MCP servers whose tools to list, by the config's name, in order (ADR-0079). */
  servers?: readonly string[];
  /** The config's `mcp` block: the check pod's harness config carries it, as the Harness pods'
   * does, so the check reads each server's url and secret name where a Turn reads them. */
  mcp?: JR2Config["mcp"];
  /** The node predicate of the Harness pods this check pod stands for: the Sandbox placement. */
  placement?: SandboxPlacement;
  priorityClassName: string;
  harness?: HarnessConfig;
  caBundle?: boolean;
  /** The pod's whole budget: the kubelet ends it at this deadline, even when `jr2 up` is gone. */
  deadlineSeconds: number;
}): string {
  const labels = {
    [LABEL_INSTANCE]: opts.name,
    "app.kubernetes.io/managed-by": "jr2",
    [LABEL_PROVIDER_PREFLIGHT]: opts.run,
  };
  const meta = (name: string) => ({ name, namespace: opts.namespace, labels });
  const o = opts.object;
  const fence = fenceComposition(opts.held, {
    sandbox: o,
    slot: CHECK_POD_SLOT,
    ranges: opts.ranges,
    caBundle: opts.caBundle === true,
    caBundleFrom: `${o}-trust`,
  });
  const network = fencePodNetwork(opts.namespace, fence.network);
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { ...meta(o), labels: { ...labels, app: PROVIDER_PREFLIGHT }, annotations: network.annotations },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: opts.deadlineSeconds,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: opts.priorityClassName,
      ...(opts.placement?.nodeSelector ? { nodeSelector: opts.placement.nodeSelector } : {}),
      ...(opts.placement?.tolerations?.length ? { tolerations: opts.placement.tolerations } : {}),
      // The Instance Harness pod's baseline, and its `fsGroup` for the same reason: the Stand-in
      // files are group-readable.
      securityContext: {
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
        fsGroup: INSTANCE_HARNESS_FS_GROUP,
      },
      dnsPolicy: network.dnsPolicy,
      dnsConfig: network.dnsConfig,
      containers: [
        {
          name: CHECK_CONTAINER,
          image: opts.harnessImage,
          imagePullPolicy: "IfNotPresent",
          // Under tini, as the Harness runs (ADR-0061): PID 1 reaps, and forwards a stop.
          command: [
            "/opt/jr2/bin/tini",
            "--",
            "/opt/jr2/bin/node",
            "/opt/jr2/src/provider-preflight.ts",
            ...opts.models,
            ...(opts.servers?.length ? [PREFLIGHT_MCP_ARG, ...opts.servers] : []),
          ],
          // The Harness container's env, in its order (`instanceHarnessObjects`): no credential. And
          // the check pod's own Stand-ins (ADR-0019): it runs no Workspace code, so it may hold them
          // in env, where pi reads a provider's key; each is a `secretKeyRef`, never a value here.
          env: [
            { name: "JR2_HARNESS_JSON", valueFrom: { configMapKeyRef: { name: o, key: HARNESS_CONFIG_KEY } } },
            ...(opts.harness?.env ?? []).filter((v) => v.valueFrom !== undefined),
            ...fence.harnessEnv,
            ...opts.held.secrets.map((s) => ({
              name: s.name,
              valueFrom: { secretKeyRef: { name: `${o}-standins`, key: heldStandInKey(s.name) } },
            })),
          ],
          envFrom: [{ secretRef: { name: `${o}-env` } }, ...(opts.harness?.envFrom ?? [])],
          volumeMounts: fence.harnessMounts,
          resources: sized(KIT_POD_SIZES.checkContainer),
          securityContext: {
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
        },
      ],
      volumes: fence.volumes,
    },
  };
  const items: KubeManifest[] = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(o),
      data: { [HARNESS_CONFIG_KEY]: harnessConfigJson(opts.harness, opts.mcp) },
    },
    { apiVersion: "v1", kind: "Secret", metadata: meta(`${o}-env`), type: "Opaque", stringData: opts.harnessEnvData },
    pod,
  ];
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** The Orchestrator's pod template digest of the Instance Secret: it rolls the pod when a value
 * the process reads through `envFrom` changes (ADR-0069). */
export const ANNOTATION_SECRET_DIGEST = "jr2.dev/secret-digest";

/** A keyed digest of the Instance Secret's data, in key order. Keyed with the signing key it
 * holds, so the annotation reveals nothing about a token. */
export function instanceSecretDigest(secretData: Record<string, string>): string {
  const mac = createHmac("sha256", Buffer.from(secretData.JR2_SIGNING_KEY ?? "", "base64"));
  mac.update("jr2-instance-secret\n");
  for (const key of Object.keys(secretData).sort()) {
    const value = Buffer.from(secretData[key]!, "utf8");
    mac.update(`${key}\n${value.length}:`).update(value);
  }
  return mac.digest("base64url");
}

/** The Instance Effector's pod template digest (ADR-0068): an HMAC over every secret input, so an
 * edit to one rolls it, as `jr2.dev/held-digest` rolls the Instance Harness (ADR-0059). */
export const ANNOTATION_EFFECTOR_DIGEST = "jr2.dev/effector-digest";

/** The Instance Effector pod's `fsGroup`: its Secret files are readable by that group, and the pod
 * has one container. The group a Sandbox's and the Instance Harness's pods use (ADR-0005). */
const INSTANCE_EFFECTOR_FS_GROUP = 2000;

/** Where the Effector reads what it holds (ADR-0068): its secrets, one file each; its key and
 * its config. Its scratch is `$HOME`. */
const EFFECTOR_SECRETS_DIR = "/run/jr2/secrets";
const EFFECTOR_OWN_DIR = "/run/jr2/effector";
const EFFECTOR_SCRATCH = "/run/jr2/scratch";

/** How much more than the longest Effect timeout a stopping replica is given: room for the
 * Orchestrator's next poll to read the outcome it finished. */
export const EFFECTOR_READ_MARGIN_SECONDS = 30;

/** The Secret's key of one literal Effect secret: prefixed, so no secret's name is `key` or
 * `effector.json`. */
const effectorSecretKey = (name: string): string => `secret.${name}`;

/** The Instance Effector's grace period: the longest timeout among the Effects placed there, plus
 * the read margin. */
export const effectorGraceSeconds = (plan: EffectorPlan): number =>
  Math.ceil(plan.longestTimeoutMs / 1000) + EFFECTOR_READ_MARGIN_SECONDS;

/**
 * The Instance Effector (ADR-0068): the objects `jr2 up` converges when a registered Machine
 * places an Effect there — an `http` Effect — or a Hook needs it (a `mac` verifier, or a kind that
 * declares `posts`), and deletes otherwise.
 *
 * - A Deployment, not a StatefulSet: a rollout must run the new pod beside the old one (surge), so
 *   the old one finishes an Effect in flight while the new one takes new Effects. The Kit's
 *   `jr2-harness` image with `/opt/jr2/bin/effector` as its command; hardened, non-root, a read-only
 *   root filesystem, an emptyDir scratch as `$HOME`. Its grace period is the longest timeout among
 *   the Effects placed there, plus a margin for the outcome to be read.
 * - A headless Service that publishes addresses that are not ready: "ask every replica" is its
 *   name's addresses, a stopping replica included.
 * - A NetworkPolicy: ingress from this Instance's Orchestrator only.
 *   No egress rule: the pod holds real values and calls the hosts its Effects name.
 * - The Secret `jr2-instance-effector`: the literal Effect secrets placed here, the placement's key,
 *   and `effector.json` (the targets). A secret from the user's own Secret is projected from there
 *   by reference, never copied.
 */
export function instanceEffectorObjects(opts: {
  name: string;
  namespace: string;
  /** The resolved `jr2-harness` ref — it carries the binary (ADR-0037). */
  harnessImage: string;
  plan: EffectorPlan;
  /** `effectorKey(signingKey, "instance")`. */
  key: string;
  /** The HMAC over every secret input (`effectorDigest`). */
  digest: string;
  /** The instance ships a private-CA bundle (ADR-0020): it is mounted and trusted. */
  caBundle?: boolean;
  priorityClasses?: PriorityClasses;
}): string {
  const labels = { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2" };
  const meta = (): KubeManifest => ({ name: INSTANCE_EFFECTOR, namespace: opts.namespace, labels });
  const grace = effectorGraceSeconds(opts.plan);

  const literal = opts.plan.secrets.filter((s) => s.source.kind === "literal");
  const sources: KubeManifest[] = [
    ...(literal.length
      ? [
          {
            secret: {
              name: INSTANCE_EFFECTOR,
              items: literal.map((s) => ({ key: effectorSecretKey(s.name), path: s.name })),
            },
          },
        ]
      : []),
    ...opts.plan.secrets.flatMap((s) =>
      s.source.kind === "secret"
        ? [{ secret: { name: s.source.secret, items: [{ key: s.source.key, path: s.name }] } }]
        : [],
    ),
  ];
  // The servers its `mcp` Effects call (ADR-0079): each one's url, its secret's name, its timeout.
  const config = {
    version: 1,
    placement: opts.plan.placement,
    targets: opts.plan.targets,
    ...(Object.keys(opts.plan.mcp).length ? { mcp: opts.plan.mcp } : {}),
  };

  const container = {
    name: "effector",
    image: opts.harnessImage,
    imagePullPolicy: "IfNotPresent",
    command: ["/opt/jr2/bin/effector"],
    ports: [{ containerPort: EFFECTOR_PORT }],
    env: [
      { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
      { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
      { name: "JR2_EFFECTOR_PORT", value: String(EFFECTOR_PORT) },
      { name: "JR2_EFFECTOR_KEY", value: `${EFFECTOR_OWN_DIR}/key` },
      { name: "JR2_EFFECTOR_CONFIG", value: `${EFFECTOR_OWN_DIR}/effector.json` },
      { name: "JR2_EFFECTOR_SECRETS", value: EFFECTOR_SECRETS_DIR },
      // The drain ends a few seconds before the kubelet's kill, so the replica exits on its own.
      { name: "JR2_EFFECTOR_DRAIN_SECONDS", value: String(Math.max(grace - 5, 1)) },
      { name: "HOME", value: EFFECTOR_SCRATCH },
      ...(opts.caBundle ? [{ name: "JR2_CA_FILE", value: `${CA_MOUNT}/ca.crt` }] : []),
    ],
    volumeMounts: [
      { name: "secrets", mountPath: EFFECTOR_SECRETS_DIR, readOnly: true },
      { name: "effector", mountPath: EFFECTOR_OWN_DIR, readOnly: true },
      { name: "scratch", mountPath: EFFECTOR_SCRATCH },
      ...(opts.caBundle ? [{ name: "ca", mountPath: CA_MOUNT, readOnly: true }] : []),
    ],
    readinessProbe: { httpGet: { path: "/healthz", port: EFFECTOR_PORT }, periodSeconds: 2, failureThreshold: 3 },
    resources: sized(KIT_POD_SIZES.instanceEffector),
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
  };

  const items: KubeManifest[] = [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(),
      type: "Opaque",
      stringData: {
        key: opts.key,
        "effector.json": JSON.stringify(config, null, 2),
        ...Object.fromEntries(literal.map((s) => [effectorSecretKey(s.name), opts.plan.values[s.name] ?? ""])),
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { ...meta(), labels: { ...labels, [LABEL_VERSION]: KIT_VERSION } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: INSTANCE_EFFECTOR } },
        // Surge, never a gap: the new replica starts before the old one stops.
        strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        template: {
          metadata: {
            labels: { ...labels, app: INSTANCE_EFFECTOR },
            annotations: { [ANNOTATION_EFFECTOR_DIGEST]: opts.digest },
          },
          spec: {
            terminationGracePeriodSeconds: grace,
            priorityClassName: priorityClassNames(opts.priorityClasses).control,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
              fsGroup: INSTANCE_EFFECTOR_FS_GROUP,
            },
            containers: [container],
            volumes: [
              { name: "secrets", projected: { defaultMode: 0o400, sources } },
              {
                name: "effector",
                secret: {
                  secretName: INSTANCE_EFFECTOR,
                  defaultMode: 0o400,
                  items: [
                    { key: "key", path: "key" },
                    { key: "effector.json", path: "effector.json" },
                  ],
                },
              },
              { name: "scratch", emptyDir: {} },
              ...(opts.caBundle ? [{ name: "ca", configMap: { name: CA_CONFIGMAP } }] : []),
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(),
      spec: {
        clusterIP: "None",
        // A stopping replica still answers for the Effects it finishes: its address stays listed.
        publishNotReadyAddresses: true,
        selector: { app: INSTANCE_EFFECTOR },
        ports: [{ port: EFFECTOR_PORT, targetPort: EFFECTOR_PORT }],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(),
      spec: {
        podSelector: { matchLabels: { app: INSTANCE_EFFECTOR } },
        policyTypes: ["Ingress"],
        ingress: [
          { from: [{ podSelector: { matchLabels: { app: ORCHESTRATOR_SERVICE, [LABEL_INSTANCE]: opts.name } } }] },
        ],
      },
    },
  ];
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

/** A keyed digest of one key's value in the user's Secret, as the API returns it (base64): what a
 * template digest holds for a `valueFrom`, so an edit of the value rolls the pod and the annotation
 * reveals nothing about it. `jr2 up` keeps the digest, never the value. */
export function storedValueDigest(signingKey: Buffer, secret: string, key: string, base64: string): string {
  return createHmac("sha256", signingKey)
    .update(`jr2-secret-value\n${secret}\n${key}\n`)
    .update(Buffer.from(base64, "base64"))
    .digest("base64url");
}

/** The digest of each `valueFrom` value, by the user's Secret and key; undefined when not read. */
export type ValueDigest = (secret: string, key: string) => string | undefined;

/** The Instance Effector's template digest: an HMAC over every secret input — a literal's value, a
 * `valueFrom`'s reference and the digest of its value — keyed with the signing key so the
 * annotation reveals nothing about a value. */
export function effectorDigest(signingKey: Buffer, plan: EffectorPlan, key: string, valueDigest: ValueDigest): string {
  const mac = createHmac("sha256", signingKey);
  mac.update(
    JSON.stringify({
      secrets: plan.secrets,
      targets: plan.targets,
      longest: plan.longestTimeoutMs,
      ...(Object.keys(plan.mcp).length ? { mcp: plan.mcp } : {}),
    }),
  );
  for (const name of Object.keys(plan.values).sort()) mac.update(`${name}=${plan.values[name]}`);
  for (const s of plan.secrets) {
    if (s.source.kind === "secret") mac.update(`${s.name}<-${valueDigest(s.source.secret, s.source.key) ?? ""}`);
  }
  mac.update(key);
  return mac.digest("base64url").slice(0, 32);
}
