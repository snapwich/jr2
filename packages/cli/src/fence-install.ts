// The node prerequisites of the Fence (ADR-0084, ADR-0019), which `jr2 up` installs on any cluster
// with kubectl alone, after it asks:
//
//   Multus   the second network of a pod, with `namespaceIsolation` and no global namespace, so a
//            pod can name an attachment of its own namespace only. When the cluster has no Multus,
//            `jr2 up` applies the thick manifest that the CLI ships (`manifests/fence/`). Its
//            DaemonSet has the annotation `jr2.dev/multus`, so jr2 knows that it installed it.
//   plugins  the stock CNI plugins bridge, static and tuning on each node. The DaemonSet
//            `jr2-system/jr2-cni-plugins` runs the operator image, which holds the pinned v1.10.0
//            plugins (operator/Dockerfile). Its init container copies each plugin into the node's
//            /opt/cni/bin when the node has no file of that name, and never replaces a file. Then
//            the pod idles, so a node that joins later gets the plugins too.
//
// The boundary is the VLAN state that the bridge plugin makes from jr2's attachment objects
// (`fence.ts`): the bridge, its VLAN filtering and the VLANs of each port. Nothing else on a node is
// a prerequisite.
//
// `jr2 up` does not install when it cannot do so safely. It refuses, and applies nothing, when:
//   (a) a Multus that jr2 did not install has other settings (no `namespaceIsolation`, or a global
//       namespace). jr2 never changes a Multus that it did not install;
//   (b) Cilium has `cni-exclusive: "true"` for a Sandbox node, because then it removes each other
//       CNI configuration of the node;
//   (c) a Multus that jr2 did not install mounts a CNI directory other than /opt/cni/bin or
//       /etc/cni/net.d. The plugins' pod finds the same on a node where jr2 installs Multus: no
//       such directory, or no CNI configuration in it.
//
// In two steps: `planFenceInstall` reads and changes nothing (before the first-time question), and
// `installFence` applies (after the operator image exists, before the Custodian needs the Fence).

import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, KIT_VERSION, LABEL_VERSION, OPERATOR_NAMESPACE } from "./deploy.ts";
import type { KubeAdmin, KubeObject } from "./kube.ts";

/** The folder of the shipped Multus manifest. */
const FILES = fileURLToPath(new URL("../manifests/fence/", import.meta.url));
/** The version of the CNI plugins in the operator image (operator/Dockerfile's CNI_PLUGINS_VERSION). */
export const CNI_VERSION = "v1.10.0";
export const PLUGINS = ["bridge", "static", "tuning"] as const;
/** The node's CNI directories: where jr2 writes the plugins, and where the runtime reads its configuration. */
export const CNI_BIN_DIR = "/opt/cni/bin";
export const CNI_CONF_DIR = "/etc/cni/net.d";
/** The DaemonSet that puts the plugins on each node. */
export const PLUGINS_DAEMONSET = "jr2-cni-plugins";
/** The start of the plugins' result line (the init container's termination message). */
export const PLUGINS_PREFIX = "jr2.cni-plugins ";
export const MULTUS_DAEMONSET = "kube-multus-ds";
export const MULTUS_NAMESPACE = "kube-system";
/** The annotation of the Multus DaemonSet that jr2 installed: the version of the shipped manifest. */
export const MULTUS_ANNOTATION = "jr2.dev/multus";
/** Its value in the shipped manifest. Change both when the manifest changes. */
export const MULTUS_VERSION = "v4.3.2-thick-namespace-isolation-1";
/** The label of a Multus DaemonSet and its pods, as the Multus manifests set it. */
export const MULTUS_SELECTOR = "app=multus";
/** The page of the prerequisites. */
export const FENCE_PREREQUISITES_URL =
  "https://snapwich.github.io/jr2/guides/move-from-kind-to-a-shared-cluster.html#prerequisites-of-the-fence";
/** How long the plugins' pods may take on each Sandbox node: the image can be pulled there first. */
const PLUGINS_WAIT_MS = 300_000;
/** How long a pod may wait for a volume before the kubelet's reason counts. */
const MOUNT_GRACE_MS = 20_000;
const POLL_MS = 2_000;

type Json = Record<string, unknown>;
type Kube = Pick<KubeAdmin, "getJson" | "listJson">;

/** What `jr2 up` will do, read before it asks. */
export type FenceInstallPlan = {
  /** `install`: no Multus. `upgrade`: jr2's, of another version. `jr2`: jr2's, current. `foreign`: accepted. */
  multus: "install" | "upgrade" | "jr2" | "foreign";
  /** `install`: no DaemonSet. `present`: the DaemonSet is there (the converge updates it with no question). */
  plugins: "install" | "present";
};

/** The plan asks: it installs something on the cluster that the cluster does not have. */
export const planAsks = (plan: FenceInstallPlan): boolean =>
  plan.multus === "install" || plan.multus === "upgrade" || plan.plugins === "install";

/** What the plan installs, as the first-time question says it. Undefined when it installs nothing. */
export function describeInstall(plan: FenceInstallPlan): string | undefined {
  const said: string[] = [];
  if (plan.plugins === "install") {
    said.push(
      `apply the DaemonSet ${OPERATOR_NAMESPACE}/${PLUGINS_DAEMONSET}, which writes the CNI plugins ` +
        `${PLUGINS.join(", ")} ${CNI_VERSION} into ${CNI_BIN_DIR} on each node that has no file of that name ` +
        "(it never replaces a file, and the files stay after jr2 down --all)",
    );
  }
  if (plan.multus === "install") {
    said.push(
      `apply Multus v4.3.2 (thick, namespaceIsolation, no global namespace) to ${MULTUS_NAMESPACE}, from the ` +
        "manifest that the CLI ships",
    );
  }
  if (plan.multus === "upgrade") {
    said.push(`update the Multus that jr2 installed in ${MULTUS_NAMESPACE} to ${MULTUS_VERSION}`);
  }
  return said.length > 0 ? `install the Fence's prerequisites: ${said.join("; and ")}` : undefined;
}

/** The Multus manifest. Its DaemonSet's annotation must name `MULTUS_VERSION`. */
export async function multusManifest(files = FILES): Promise<string> {
  const text = await readFile(join(files, "multus-v4.3.2.yaml"), "utf8");
  if (!text.includes(`\n    ${MULTUS_ANNOTATION}: ${MULTUS_VERSION}\n`)) {
    throw new Error(`fence: the shipped Multus manifest does not have ${MULTUS_ANNOTATION}: ${MULTUS_VERSION}`);
  }
  return text;
}

// ---- the read: what the cluster has, and the refusals ---------------------------------------------

type Volume = { name?: string; hostPath?: { path?: string }; configMap?: { name?: string } };
type Container = {
  name?: string;
  command?: string[];
  args?: string[];
  volumeMounts?: Array<{ name?: string; mountPath?: string }>;
};
export type DaemonSetObject = KubeObject & {
  metadata: { namespace?: string };
  spec?: {
    template?: { spec?: { containers?: Container[]; initContainers?: Container[]; volumes?: Volume[] } };
  };
};
type ConfigMapObject = { metadata?: { name?: string }; data?: Record<string, string> };
type NodeLike = { metadata: { name: string; labels?: Record<string, string> } };
type LabelSelector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
};
type CiliumNodeConfig = {
  metadata: { name: string; namespace?: string };
  spec?: { nodeSelector?: LabelSelector; defaults?: Record<string, string> };
};

const refused = (text: string): Error => new Error(`fence: ${text} Nothing was applied.`);

/** Does a label selector select these labels? An empty selector selects each node, as Cilium reads it. */
export function selects(selector: LabelSelector | undefined, labels: Record<string, string> = {}): boolean {
  for (const [k, v] of Object.entries(selector?.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of selector?.matchExpressions ?? []) {
    const has = Object.hasOwn(labels, e.key);
    const value = labels[e.key];
    const inValues = has && (e.values ?? []).includes(value!);
    if (e.operator === "In" && !inValues) return false;
    if (e.operator === "NotIn" && inValues) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
  }
  return true;
}

/**
 * Refusal (b): Cilium with `cni-exclusive: "true"` for a Sandbox node. The ConfigMap
 * `kube-system/cilium-config` sets it for the cluster, and a `CiliumNodeConfig` whose node selector
 * selects a node sets it for that node, over the ConfigMap.
 */
export async function checkCilium(kube: Kube, opts: { nodes: readonly NodeLike[]; context?: string }): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const config = await kube.getJson<ConfigMapObject>({
    kind: "configmap",
    name: "cilium-config",
    namespace: "kube-system",
    ...ctx,
  });
  const crd = await kube.listJson({
    kind: "customresourcedefinition",
    fieldSelector: "metadata.name=ciliumnodeconfigs.cilium.io",
    ...ctx,
  });
  if (config === undefined && crd.length === 0) return;
  const clusterWide = config?.data?.["cni-exclusive"];
  const perNode =
    crd.length > 0
      ? await kube.listJson<CiliumNodeConfig>({ kind: "ciliumnodeconfigs.cilium.io", allNamespaces: true, ...ctx })
      : [];
  const byNode: string[] = [];
  for (const node of opts.nodes) {
    const matching = perNode.filter(
      (c) => c.spec?.defaults?.["cni-exclusive"] !== undefined && selects(c.spec?.nodeSelector, node.metadata.labels),
    );
    const exclusive = matching.find((c) => c.spec!.defaults!["cni-exclusive"] === "true");
    if (exclusive) {
      const where = `${exclusive.metadata.namespace ?? ""}/${exclusive.metadata.name}`.replace(/^\//, "");
      throw refused(
        `Cilium has cni-exclusive: "true" for the Sandbox node ${node.metadata.name} in the CiliumNodeConfig ` +
          `${where}, so Cilium removes each other CNI configuration on that node, and Multus cannot give a pod ` +
          `the Fence (ADR-0084). Set "cni-exclusive": "false" in spec.defaults of the CiliumNodeConfig ${where} ` +
          "(or remove that key there and set it in the ConfigMap kube-system/cilium-config), restart the Cilium " +
          "agent on the node, then run `jr2 up` again.",
      );
    }
    if (clusterWide === "true" && !matching.some((c) => c.spec!.defaults!["cni-exclusive"] === "false")) {
      byNode.push(node.metadata.name);
    }
  }
  if (byNode.length > 0) {
    throw refused(
      `Cilium has cni-exclusive: "true" in the ConfigMap kube-system/cilium-config, so Cilium removes each other ` +
        `CNI configuration on the Sandbox node${byNode.length === 1 ? "" : "s"} ${byNode.join(", ")}, and Multus ` +
        'cannot give a pod the Fence (ADR-0084). Set cni-exclusive: "false" in that ConfigMap (with Helm: ' +
        "--set cni.exclusive=false), restart the Cilium agents (kubectl -n kube-system rollout restart " +
        "daemonset/cilium), then run `jr2 up` again.",
    );
  }
}

/** The settings of a Multus that jr2 did not install: where they are, and what they say. */
export type MultusSettings = {
  namespaceIsolation: boolean;
  globalNamespaces: string;
  /** Where the settings are, in words that say where to change them. */
  source: string;
  /** What to set there for namespaceIsolation. */
  setIsolation: string;
  /** What to set there for no global namespace. */
  setGlobal: string;
};

/**
 * The settings of a Multus DaemonSet. The thick form (and a thin form with a configuration file)
 * reads them from JSON in a ConfigMap that the DaemonSet mounts (`multus-daemon-config`, key
 * `daemon-config.json`, for the thick form). The thin form with an automatic configuration reads
 * them from the arguments of its container (`--namespace-isolation`, `--global-namespaces`). A key
 * that is not set has Multus's default: no isolation, no global namespace. Undefined when a
 * ConfigMap that the DaemonSet mounts cannot be read.
 */
export async function multusSettings(
  kube: Kube,
  ds: DaemonSetObject,
  context?: string,
): Promise<MultusSettings | { unread: string }> {
  const ctx = context !== undefined ? { context } : {};
  const ns = ds.metadata.namespace ?? MULTUS_NAMESPACE;
  const spec = ds.spec?.template?.spec ?? {};
  for (const vol of spec.volumes ?? []) {
    const name = vol.configMap?.name;
    if (name === undefined) continue;
    const cm = await kube.getJson<ConfigMapObject>({ kind: "configmap", name, namespace: ns, ...ctx });
    if (cm === undefined) return { unread: `${ns}/${name}` };
    for (const [key, text] of Object.entries(cm.data ?? {})) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      // A daemon configuration, or a CNI configuration of Multus: each names its configuration folder or type.
      const isMultus =
        "namespaceIsolation" in json || "cniConfigDir" in json || "multusConfigFile" in json || json.type === "multus";
      if (!isMultus) continue;
      const where = `${key} of the ConfigMap ${ns}/${name}`;
      return {
        namespaceIsolation: json.namespaceIsolation === true,
        globalNamespaces: typeof json.globalNamespaces === "string" ? json.globalNamespaces.trim() : "",
        source: where,
        setIsolation: `set "namespaceIsolation": true in ${where}`,
        setGlobal: `set "globalNamespaces": "" in ${where}`,
      };
    }
  }
  const container = spec.containers?.[0];
  const words = [...(container?.command ?? []), ...(container?.args ?? [])];
  const arg = (flag: string): string | undefined =>
    words
      .find((w) => w.startsWith(`${flag}=`))
      ?.slice(flag.length + 1)
      .trim();
  const where = `the arguments of the container ${container?.name ?? "?"} of the DaemonSet ${ns}/${ds.metadata.name}`;
  return {
    namespaceIsolation: arg("--namespace-isolation") === "true",
    globalNamespaces: arg("--global-namespaces") ?? "",
    source: where,
    setIsolation: `set --namespace-isolation=true in ${where}`,
    setGlobal: `remove --global-namespaces from ${where}`,
  };
}

/** The node folders that a Multus DaemonSet mounts for the CNI bin and configuration directories. */
export function multusHostDirs(ds: DaemonSetObject): { bin?: string; conf?: string } {
  const spec = ds.spec?.template?.spec ?? {};
  const hostPathOf = (volume?: string) => spec.volumes?.find((v) => v.name === volume)?.hostPath?.path;
  const out: { bin?: string; conf?: string } = {};
  for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    for (const m of c.volumeMounts ?? []) {
      const path = m.mountPath ?? "";
      const host = hostPathOf(m.name);
      if (host === undefined) continue;
      if (out.bin === undefined && /\/cni\/bin\/?$/.test(path)) out.bin = host.replace(/\/$/, "");
      if (out.conf === undefined && /\/net\.d\/?$/.test(path)) out.conf = host.replace(/\/$/, "");
    }
  }
  return out;
}

/** Refusals (a) and (c) for one Multus DaemonSet that jr2 did not install. */
async function checkForeignMultus(kube: Kube, ds: DaemonSetObject, context?: string): Promise<void> {
  const name = `${ds.metadata.namespace ?? ""}/${ds.metadata.name}`;
  const settings = await multusSettings(kube, ds, context);
  if ("unread" in settings) {
    throw refused(
      `the cluster has a Multus that jr2 did not install (DaemonSet ${name}), and jr2 cannot read the ConfigMap ` +
        `${settings.unread} that holds its settings, so it cannot see that a pod can name an attachment of its ` +
        "own namespace only (namespaceIsolation, ADR-0084). Give the user of this context read access to that " +
        "ConfigMap, then run `jr2 up` again.",
    );
  }
  const fix = (what: string) =>
    `jr2 never changes a Multus that it did not install. ${what}, restart the DaemonSet ` +
    `(kubectl -n ${ds.metadata.namespace} rollout restart daemonset/${ds.metadata.name}), then run \`jr2 up\` again.`;
  if (!settings.namespaceIsolation) {
    throw refused(
      `the cluster's Multus (DaemonSet ${name}, which jr2 did not install) does not have namespaceIsolation in ` +
        `${settings.source}, so a pod of another namespace can name an attachment of the Instance and join its ` +
        `VLANs (ADR-0084). ${fix(settings.setIsolation.replace(/^set/, "Set"))}`,
    );
  }
  if (settings.globalNamespaces !== "") {
    throw refused(
      `the cluster's Multus (DaemonSet ${name}, which jr2 did not install) has the global namespaces ` +
        `"${settings.globalNamespaces}" in ${settings.source}, so a pod of each namespace can name an attachment ` +
        `of those namespaces (ADR-0084). ${fix(settings.setGlobal.replace(/^set/, "Set").replace(/^remove/, "Remove"))}`,
    );
  }
  const dirs = multusHostDirs(ds);
  for (const [dir, want, what] of [
    [dirs.bin, CNI_BIN_DIR, "CNI bin directory"],
    [dirs.conf, CNI_CONF_DIR, "CNI configuration directory"],
  ] as const) {
    if (dir !== undefined && dir !== want) {
      throw refused(
        `the cluster's Multus (DaemonSet ${name}) mounts the node's ${what} from ${dir}, not ${want}. jr2 puts ` +
          `the CNI plugins ${PLUGINS.join(", ")} into ${CNI_BIN_DIR}, and its Fence needs nodes whose container ` +
          `runtime reads ${CNI_BIN_DIR} and ${CNI_CONF_DIR} (ADR-0084). Keep such nodes out of the Sandbox nodes ` +
          "with sandbox.nodeSelector or a taint (ADR-0052), or use a cluster whose nodes use those directories.",
      );
    }
  }
}

/** Read what the cluster has, and refuse (a), (b) or (c). Changes nothing. */
export async function planFenceInstall(
  kube: Kube,
  opts: { nodes: readonly NodeLike[]; context?: string },
): Promise<FenceInstallPlan> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  await checkCilium(kube, opts);
  const multuses = await kube.listJson<DaemonSetObject>({
    kind: "daemonset",
    selector: MULTUS_SELECTOR,
    allNamespaces: true,
    ...ctx,
  });
  const ours = multuses.filter((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined);
  const foreign = multuses.filter((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] === undefined);
  for (const ds of foreign) await checkForeignMultus(kube, ds, opts.context);
  const multus: FenceInstallPlan["multus"] =
    foreign.length > 0
      ? "foreign"
      : ours.length === 0
        ? "install"
        : ours.every((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] === MULTUS_VERSION)
          ? "jr2"
          : "upgrade";
  const plugins = await kube.getJson({
    kind: "daemonset",
    name: PLUGINS_DAEMONSET,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  return { multus, plugins: plugins === undefined ? "install" : "present" };
}

// ---- the plugins' DaemonSet ------------------------------------------------------------------------

/**
 * The init container's script. It runs as root with no capability, so it can write a file into the
 * node's /opt/cni/bin (root's own folder) and nothing that needs a capability. It writes a plugin only
 * when the node has no file of that name: a plugin of another version stays (v1.9.1 was seen to make
 * the same VLAN state). Each one goes in under a name of its own and then moves, so the runtime never
 * runs half a file. A node with no CNI configuration in /etc/cni/net.d, or with an empty
 * /opt/cni/bin, does not use those folders: the script fails and says so.
 */
export const PLUGINS_SCRIPT = `set -eu
BIN=/host${CNI_BIN_DIR} CONF=/host${CNI_CONF_DIR} SRC=/opt/jr2/cni/bin
say() { echo "${PLUGINS_PREFIX}$1" > /dev/termination-log; echo "${PLUGINS_PREFIX}$1"; }
if ! ls "$CONF" | grep -qE '\\.(conf|conflist|json)$'; then
  say "fail no CNI configuration in ${CNI_CONF_DIR} on the node: the container runtime reads it from another folder"
  exit 1
fi
if [ -z "$(ls -A "$BIN")" ]; then
  say "fail ${CNI_BIN_DIR} on the node is empty: the container runtime reads its plugins from another folder"
  exit 1
fi
wrote="" kept=""
for p in ${PLUGINS.join(" ")}; do
  if [ -e "$BIN/$p" ]; then kept="$kept $p"; continue; fi
  cp "$SRC/$p" "$BIN/.$p.jr2-new"
  chmod 0755 "$BIN/.$p.jr2-new"
  mv -f "$BIN/.$p.jr2-new" "$BIN/$p"
  wrote="$wrote $p"
done
say "ok wrote=\${wrote# } kept=\${kept# }"
`;

/** The DaemonSet that puts the plugins on each node, from the operator image. */
export function pluginsDaemonSet(image: string): Json {
  const labels = { app: PLUGINS_DAEMONSET, "app.kubernetes.io/managed-by": "jr2" };
  const restricted = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  return {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: {
      name: PLUGINS_DAEMONSET,
      namespace: OPERATOR_NAMESPACE,
      labels: { ...labels, [LABEL_VERSION]: KIT_VERSION },
    },
    spec: {
      selector: { matchLabels: { app: PLUGINS_DAEMONSET } },
      updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: "100%" } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 1,
          nodeSelector: { "kubernetes.io/os": "linux" },
          // Where Multus runs: each node, also a tainted one, because any node can be a Sandbox node of
          // some Instance.
          tolerations: [
            { operator: "Exists", effect: "NoSchedule" },
            { operator: "Exists", effect: "NoExecute" },
          ],
          // Root, for the node's root-owned /opt/cni/bin, with no capability and no host namespace.
          securityContext: { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: "RuntimeDefault" } },
          initContainers: [
            {
              name: "install",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", PLUGINS_SCRIPT],
              terminationMessagePolicy: "FallbackToLogsOnError",
              resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
              securityContext: restricted,
              volumeMounts: [
                { name: "cni-bin", mountPath: `/host${CNI_BIN_DIR}` },
                { name: "cni-conf", mountPath: `/host${CNI_CONF_DIR}`, readOnly: true },
              ],
            },
          ],
          containers: [
            {
              name: "idle",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done"],
              resources: { requests: { cpu: "1m", memory: "4Mi" }, limits: { memory: "16Mi" } },
              securityContext: restricted,
            },
          ],
          // `Directory`, never `DirectoryOrCreate`: a node with no such folder uses another one, and
          // jr2 makes no CNI folder on it.
          volumes: [
            { name: "cni-bin", hostPath: { path: CNI_BIN_DIR, type: "Directory" } },
            { name: "cni-conf", hostPath: { path: CNI_CONF_DIR, type: "Directory" } },
          ],
        },
      },
    },
  };
}

type PluginsPod = {
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    initContainerStatuses?: Array<{
      state?: { terminated?: { exitCode?: number; message?: string }; waiting?: { reason?: string; message?: string } };
      lastState?: { terminated?: { exitCode?: number; message?: string } };
    }>;
  };
};

/** The result line of a plugins pod's init container, when it has ended. */
export function pluginsResultOf(pod: PluginsPod): string | undefined {
  const s = pod.status?.initContainerStatuses?.[0];
  const message = s?.state?.terminated?.message ?? s?.lastState?.terminated?.message ?? "";
  const at = message.lastIndexOf(PLUGINS_PREFIX);
  return at < 0
    ? undefined
    : message
        .slice(at + PLUGINS_PREFIX.length)
        .split("\n")[0]!
        .trim();
}

const isReady = (p: PluginsPod): boolean =>
  p.metadata?.deletionTimestamp === undefined &&
  (p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");

/** The refusal (c) of a node whose CNI folders are not the default ones. */
function folderRefusal(lines: readonly string[]): Error {
  return new Error(
    [
      `fence: the CNI plugins ${PLUGINS.join(", ")} cannot go onto ${lines.length === 1 ? "a Sandbox node" : `${lines.length} Sandbox nodes`} (ADR-0084):`,
      ...lines.map((l) => `  ${l}`),
      `jr2 puts the plugins into ${CNI_BIN_DIR}, and the Fence needs nodes whose container runtime reads ` +
        `${CNI_BIN_DIR} and ${CNI_CONF_DIR}. Keep such nodes out of the Sandbox nodes with sandbox.nodeSelector ` +
        `or a taint (ADR-0052), or use a cluster whose nodes use those folders. See ${FENCE_PREREQUISITES_URL}.`,
    ].join("\n"),
  );
}

/**
 * Wait until each Sandbox node has a Ready pod of the plugins' DaemonSet: its init container put the
 * plugins there, or found them. Returns each node's result line. A pod whose init container failed,
 * or whose folder the kubelet could not mount, refuses (c).
 */
export async function awaitPlugins(
  kube: Pick<KubeAdmin, "listJson">,
  opts: { nodes: readonly string[]; context?: string; pollMs?: number; now?: () => number },
): Promise<Map<string, string>> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const now = opts.now ?? Date.now;
  const started = now();
  for (;;) {
    const pods = await kube.listJson<PluginsPod>({
      kind: "pod",
      selector: `app=${PLUGINS_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    const results = new Map<string, string>();
    const failed: string[] = [];
    const waiting: string[] = [];
    for (const node of opts.nodes) {
      const mine = pods.filter((p) => p.spec?.nodeName === node && p.metadata?.deletionTimestamp === undefined);
      const ready = mine.find(isReady);
      if (ready) {
        results.set(node, pluginsResultOf(ready) ?? "ok");
        continue;
      }
      const result = mine.map(pluginsResultOf).find((r) => r?.startsWith("fail "));
      if (result) {
        failed.push(`${node}: ${result.slice("fail ".length)}`);
        continue;
      }
      waiting.push(node);
      // A folder that the node does not have: the kubelet says so only in the pod's events.
      if (now() - started >= MOUNT_GRACE_MS) {
        for (const p of mine) {
          const events = await kube
            .listJson<{ reason?: string; message?: string }>({
              kind: "event",
              fieldSelector: `involvedObject.name=${p.metadata?.name}`,
              namespace: OPERATOR_NAMESPACE,
              ...ctx,
            })
            .catch(() => []);
          const mount = events.filter((e) => e.reason === "FailedMount").pop();
          if (mount) {
            failed.push(`${node}: the kubelet cannot mount a CNI folder: ${(mount.message ?? "").slice(0, 300)}`);
            waiting.pop();
            break;
          }
        }
      }
    }
    if (failed.length > 0) throw folderRefusal(failed);
    if (waiting.length === 0) return results;
    if (now() - started >= PLUGINS_WAIT_MS) {
      throw new Error(
        `fence: no Ready pod of the DaemonSet ${OPERATOR_NAMESPACE}/${PLUGINS_DAEMONSET} on the Sandbox ` +
          `node${waiting.length === 1 ? "" : "s"} ${waiting.join(", ")} in ${PLUGINS_WAIT_MS / 1000} s, so jr2 cannot ` +
          `see the CNI plugins there (ADR-0084). See \`kubectl -n ${OPERATOR_NAMESPACE} describe pod -l ` +
          `app=${PLUGINS_DAEMONSET}\`.`,
      );
    }
    await sleep(opts.pollMs ?? POLL_MS);
  }
}

// ---- the install -----------------------------------------------------------------------------------

/** An apply, and once more after a short wait when it fails: two first converges on one cluster at
 * the same moment can each create the same object, and the second create fails (AlreadyExists). */
async function applyOnceMore(
  kube: Pick<KubeAdmin, "apply">,
  manifest: string,
  ctx: { context?: string },
  retryMs = 2000,
): Promise<void> {
  try {
    await kube.apply({ manifest, ...ctx });
  } catch {
    await sleep(retryMs);
    await kube.apply({ manifest, ...ctx });
  }
}

/**
 * Install what the plan says, after the question. The plugins first, so that a node whose CNI
 * folders are elsewhere refuses before Multus changes the cluster's CNI configuration; then Multus.
 * The DaemonSet is applied at each converge whose Kit is not older than the one it runs, as the
 * operator is, so it runs this Kit's image. One quiet line when the plan installed nothing.
 */
export async function installFence(
  kube: Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout">,
  plan: FenceInstallPlan,
  opts: {
    image: string;
    nodes: readonly string[];
    context?: string;
    log: (line: string) => void;
    pollMs?: number;
    now?: () => number;
    /** The wait before the second apply; a test gives 0. */
    retryMs?: number;
  },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const existing = await kube.getJson<DaemonSetObject>({
    kind: "daemonset",
    name: PLUGINS_DAEMONSET,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  const deployed = existing?.metadata.labels?.[LABEL_VERSION];
  const newer = deployed !== undefined && compareVersions(deployed, KIT_VERSION) > 0;
  const image = existing?.spec?.template?.spec?.containers?.[0] as { image?: string } | undefined;
  if (existing === undefined || (!newer && image?.image !== opts.image)) {
    if (plan.plugins === "install") {
      opts.log(`fence: applying the DaemonSet ${OPERATOR_NAMESPACE}/${PLUGINS_DAEMONSET} (${opts.image})`);
    }
    await applyOnceMore(kube, JSON.stringify(pluginsDaemonSet(opts.image)), ctx, opts.retryMs);
  }
  const results = await awaitPlugins(kube, opts);
  if (plan.plugins === "install") {
    for (const [node, line] of results) opts.log(`fence: ${node}: CNI plugins ${line}`);
  }
  if (plan.multus === "install" || plan.multus === "upgrade") {
    const text = await multusManifest();
    opts.log(`fence: applying Multus v4.3.2 (thick, namespaceIsolation) to ${MULTUS_NAMESPACE}`);
    await applyOnceMore(kube, text, ctx, opts.retryMs);
    await kube.waitRollout({
      kind: "daemonset",
      name: MULTUS_DAEMONSET,
      namespace: MULTUS_NAMESPACE,
      timeoutSeconds: 300,
      ...ctx,
    });
    opts.log("fence: Multus is ready on each node");
  }
  if (!planAsks(plan)) {
    opts.log(
      `fence: prerequisites in place — ${plan.multus === "foreign" ? "the cluster's" : "jr2's"} Multus, and the ` +
        `CNI plugins on ${results.size} Sandbox node${results.size === 1 ? "" : "s"}`,
    );
  }
}

// ---- jr2 down --all --------------------------------------------------------------------------------

/**
 * Remove what jr2 installed for the Fence on the cluster: the plugins' DaemonSet, and the Multus that
 * carries jr2's annotation. A Multus that jr2 did not install stays. The plugin files stay on the
 * nodes: jr2 cannot tell them from files that another tool put there.
 */
export async function uninstallFence(
  kube: Pick<KubeAdmin, "getJson" | "deleteObject" | "deleteManifest">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  if (await kube.getJson({ kind: "daemonset", name: PLUGINS_DAEMONSET, namespace: OPERATOR_NAMESPACE, ...ctx })) {
    opts.log(
      `uninstalling the DaemonSet ${OPERATOR_NAMESPACE}/${PLUGINS_DAEMONSET}; the CNI plugins ` +
        `${PLUGINS.join(", ")} stay in ${CNI_BIN_DIR} on each node`,
    );
    await kube.deleteObject({ kind: "daemonset", name: PLUGINS_DAEMONSET, namespace: OPERATOR_NAMESPACE, ...ctx });
  }
  const multus = await kube.getJson({ kind: "daemonset", name: MULTUS_DAEMONSET, namespace: MULTUS_NAMESPACE, ...ctx });
  if (multus?.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined) {
    opts.log(`uninstalling Multus (${MULTUS_NAMESPACE}), which jr2 installed`);
    await kube.deleteManifest({ manifest: await multusManifest(), ...ctx });
  }
}
