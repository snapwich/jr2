// The node prerequisites of the Fence (ADR-0084, ADR-0019), which `jr2 up` installs on any cluster
// with kubectl alone, after it asks:
//
//   Multus     the second network of a pod, with `namespaceIsolation` and no global namespace, so a
//              pod can name an attachment of its own namespace only. When the cluster has no Multus,
//              `jr2 up` applies the thick manifest that the CLI ships (`manifests/fence/`). Its
//              DaemonSet has the annotation `jr2.dev/multus`, so jr2 knows that it installed it.
//   DaemonSet  `jr2-system/jr2-fence-node`, which runs the operator image on each node,
//              on the node's network, in two init containers:
//              rules    with NET_ADMIN alone, it loads the rule table `inet jr2_fence` into the node
//                       (`FENCE_RULES`), at each start of the pod, so a restart of the node gets it
//                       again. The table replaces itself in one transaction: no window with no rule
//                       and no rule twice.
//              install  with no capability, it copies the pinned v1.10.0 plugins bridge, static and
//                       tuning into the node's /opt/cni/bin when the node has no file of that name,
//                       never replaces a file, and refuses a `bridge` older than v1.8.0.
//              Then the pod idles, so a node that joins later gets both too.
//
// The boundary is the VLAN state that the bridge plugin makes from jr2's attachment objects
// (`fence.ts`). The rule table keeps the node's own network stack off the bridge: a Sandbox's frame
// enters the bridge untagged at its access port, so on a node with
// `net.bridge.bridge-nf-call-iptables = 1` the node's prerouting rules see it before the bridge
// tags it, and kube-proxy's NAT changes a dial to a Service address. The table's `notrack` stops
// that, and its other chains drop each packet between the bridge and the node's own stack.
//
// `jr2 up` does not install when it cannot do so safely. It refuses, and applies nothing, when:
//   (a) a Multus that jr2 did not install has other settings (no `namespaceIsolation`, or a global
//       namespace). jr2 never changes a Multus that it did not install;
//   (b) Cilium has `cni-exclusive: "true"` for a Sandbox node, because then it removes each other
//       CNI configuration of the node;
//   (c) a Multus that jr2 did not install mounts a CNI directory other than /opt/cni/bin or
//       /etc/cni/net.d. The pod of jr2-fence-node finds the same on a node where jr2 installs Multus:
//       no such directory, or no CNI configuration in it.
// After the DaemonSet is applied, a Sandbox node whose `bridge` plugin is older than v1.8.0, or
// whose rule table did not load, refuses too.
//
// In two steps: `planFenceInstall` reads and changes nothing (before the first-time question), and
// `installFence` applies (after the operator image exists, before the Custodian needs the Fence).

import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, KIT_VERSION, LABEL_VERSION, OPERATOR_NAMESPACE } from "./deploy.ts";
import { FENCE_BRIDGE } from "./fence.ts";
import type { KubeAdmin, KubeObject } from "./kube.ts";

/** The folder of the shipped Multus manifest. */
const FILES = fileURLToPath(new URL("../manifests/fence/", import.meta.url));
/** The version of the CNI plugins in the operator image (operator/Dockerfile's CNI_PLUGINS_VERSION). */
export const CNI_VERSION = "v1.10.0";
export const PLUGINS = ["bridge", "static", "tuning"] as const;
const BRIDGE = FENCE_BRIDGE;
/** The node's rule table of the Fence: its family and name. */
export const RULES_TABLE = "inet jr2_fence";

/**
 * The rule table of the Fence on each node (ADR-0084). It matches the bridge only, so it changes
 * nothing else on the node.
 *
 * - `pre`: each packet that enters from the bridge skips the node's connection tracking, before
 *   conntrack (-200) and NAT (-100) see it. Without it, kube-proxy's DNAT changes a Sandbox's dial
 *   to a Service address, and the bridge then drops the frame: the dial times out, and the
 *   Custodian sees nothing.
 * - `input`, `forward`, `out`: no packet goes from the bridge to the node's own stack, is routed
 *   between the bridge and another interface, or goes from the node's stack to the bridge. The VLAN
 *   state already keeps the node's side of the bridge off each pod's VLAN; these chains hold when
 *   that side is put into a pod's VLAN.
 */
export const FENCE_RULES = `table ${RULES_TABLE} {
  chain pre {
    type filter hook prerouting priority -350; policy accept;
    iifname "${BRIDGE}" counter notrack
  }
  chain input {
    type filter hook input priority -200; policy accept;
    iifname "${BRIDGE}" counter drop
  }
  chain forward {
    type filter hook forward priority -200; policy accept;
    iifname "${BRIDGE}" oifname != "${BRIDGE}" counter drop
    iifname != "${BRIDGE}" oifname "${BRIDGE}" counter drop
  }
  chain out {
    type filter hook output priority -200; policy accept;
    oifname "${BRIDGE}" counter drop
  }
}`;
/** The node's CNI directories: where jr2 writes the plugins, and where the runtime reads its configuration. */
export const CNI_BIN_DIR = "/opt/cni/bin";
export const CNI_CONF_DIR = "/etc/cni/net.d";
/** The first version of the `bridge` plugin that does what the attachments say (`fence.ts`):
 * `preserveDefaultVlan` came in v1.3.0, `portIsolation` in v1.7.0, and v1.8.0 is the first that
 * takes `vlan` and `vlanTrunk` together (v1.3.0 to v1.7.1 refuse them: "cannot set vlan and
 * vlanTrunk at the same time"). */
export const BRIDGE_MIN_VERSION = "1.8.0";
/** The DaemonSet that loads the rule table and puts the plugins on each node. */
export const FENCE_NODE_DAEMONSET = "jr2-fence-node";
/** The start of each result line (an init container's termination message). */
export const FENCE_NODE_PREFIX = "jr2.fence-node ";
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
/** How long the pods of jr2-fence-node may take on each Sandbox node: the image can be pulled there first. */
const FENCE_NODE_WAIT_MS = 300_000;
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
  node: "install" | "present";
};

/** The plan asks: it installs something on the cluster that the cluster does not have. */
export const planAsks = (plan: FenceInstallPlan): boolean =>
  plan.multus === "install" || plan.multus === "upgrade" || plan.node === "install";

/** What the plan installs, as the first-time question says it. Undefined when it installs nothing. */
export function describeInstall(plan: FenceInstallPlan): string | undefined {
  const said: string[] = [];
  if (plan.node === "install") {
    said.push(
      `apply the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} to each node. It runs on the node's ` +
        `network with the capability NET_ADMIN (each other capability dropped), and at each start it loads the ` +
        `rule table "${RULES_TABLE}" into the node's nftables, which keeps the node's own network stack off ` +
        `the bridge ${BRIDGE}; jr2 down --all removes the table. It also writes the CNI plugins ` +
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
  const node = await kube.getJson({
    kind: "daemonset",
    name: FENCE_NODE_DAEMONSET,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  return { multus, node: node === undefined ? "install" : "present" };
}

// ---- the DaemonSet jr2-fence-node --------------------------------------------------------------------

/** The `say` function of each script: one result line, as the termination message and in the log. */
const SAY = `say() { echo "${FENCE_NODE_PREFIX}$1" > /dev/termination-log; echo "${FENCE_NODE_PREFIX}$1"; }`;

/**
 * The script of the `rules` init container. It loads the rule table in one nft transaction: the
 * first line makes the table when the node has none, the second deletes it, and the rest makes it
 * again, so a second load replaces the table, never adds rules to it, and the node has no moment
 * with no rule. Then it reads the table back and counts its chains.
 */
export const RULES_SCRIPT = `set -eu
${SAY}
if ! out=$(printf '%s\\n' 'table ${RULES_TABLE}' 'delete table ${RULES_TABLE}' '${FENCE_RULES}' | nft -f - 2>&1); then
  say "fail rules nft could not load the table ${RULES_TABLE}: $(echo "$out" | tr '\\n' ' ' | cut -c1-300)"
  exit 1
fi
chains=$(nft list table ${RULES_TABLE} | grep -c '^[[:space:]]*chain ')
if [ "$chains" != 4 ]; then
  say "fail rules the table ${RULES_TABLE} has $chains chains after the load, not 4"
  exit 1
fi
say "ok rules=loaded"
`;

/** The script of the removal (`jr2 down --all`): the table goes, whether the node has it or not. */
export const RULES_REMOVE_SCRIPT = `set -eu
${SAY}
if ! out=$(printf '%s\\n' 'table ${RULES_TABLE}' 'delete table ${RULES_TABLE}' | nft -f - 2>&1); then
  say "fail rules nft could not remove the table ${RULES_TABLE}: $(echo "$out" | tr '\\n' ' ' | cut -c1-300)"
  exit 1
fi
say "ok rules=removed"
`;

/**
 * The script of the `install` init container. It runs as root with no capability, so it can write a
 * file into the node's /opt/cni/bin (root's own folder) and nothing that needs a capability. It
 * writes a plugin only when the node has no file of that name. Each one goes in under a name of its
 * own and then moves, so the runtime never runs half a file. A node with no CNI configuration in
 * /etc/cni/net.d, or with an empty /opt/cni/bin, does not use those folders: the script fails and
 * says so.
 *
 * Then it reads the version of the node's `bridge`, which can be a file of another tool: it runs the
 * file with no `CNI_COMMAND`, and a stock plugin prints `CNI bridge plugin v<version>` and stops. A
 * version older than `BRIDGE_MIN_VERSION`, or none that it can read, fails: such a plugin puts the
 * trunks of the Instances on a shared VLAN, or refuses the trunk's attachment.
 */
export const PLUGINS_SCRIPT = `set -eu
BIN=/host${CNI_BIN_DIR} CONF=/host${CNI_CONF_DIR} SRC=/opt/jr2/cni/bin
${SAY}
if ! ls "$CONF" | grep -qE '\\.(conf|conflist|json)$'; then
  say "fail folder no CNI configuration in ${CNI_CONF_DIR} on the node: the container runtime reads it from another folder"
  exit 1
fi
if [ -z "$(ls -A "$BIN")" ]; then
  say "fail folder ${CNI_BIN_DIR} on the node is empty: the container runtime reads its plugins from another folder"
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
printed=$(env -u CNI_COMMAND timeout 10 "$BIN/bridge" </dev/null 2>&1 | head -n 1) || true
version=$(echo "$printed" | sed -n 's/^CNI bridge plugin v\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p')
if [ -z "$version" ]; then
  say "fail bridge ${CNI_BIN_DIR}/bridge prints no version (it printed: $(echo "$printed" | cut -c1-120))"
  exit 1
fi
num() { echo "$1" | awk -F. '{ print $1 * 1000000 + $2 * 1000 + $3 }'; }
if [ "$(num "$version")" -lt "$(num ${BRIDGE_MIN_VERSION})" ]; then
  say "fail bridge ${CNI_BIN_DIR}/bridge is v$version, older than v${BRIDGE_MIN_VERSION}"
  exit 1
fi
say "ok wrote=\${wrote# } kept=\${kept# } bridge=v$version"
`;

/**
 * The DaemonSet jr2-fence-node, from the operator image. `remove` is its form for
 * `jr2 down --all`: its one init container removes the rule table, and it writes no plugin.
 */
export function fenceNodeDaemonSet(image: string, opts: { remove?: boolean } = {}): Json {
  const labels = { app: FENCE_NODE_DAEMONSET, "app.kubernetes.io/managed-by": "jr2" };
  const restricted = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const rules = {
    name: "rules",
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["sh", "-c", opts.remove ? RULES_REMOVE_SCRIPT : RULES_SCRIPT],
    terminationMessagePolicy: "FallbackToLogsOnError",
    resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
    // NET_ADMIN alone, for nft in the node's network namespace.
    securityContext: { ...restricted, capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] } },
  };
  const install = {
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
  };
  return {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: {
      name: FENCE_NODE_DAEMONSET,
      namespace: OPERATOR_NAMESPACE,
      labels: { ...labels, [LABEL_VERSION]: KIT_VERSION },
    },
    spec: {
      selector: { matchLabels: { app: FENCE_NODE_DAEMONSET } },
      updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: "100%" } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 1,
          // The node's network namespace, where the rule table must be. No other host namespace.
          hostNetwork: true,
          nodeSelector: { "kubernetes.io/os": "linux" },
          // Where Multus runs: each node, also a tainted one, because any node can be a Sandbox node of
          // some Instance.
          tolerations: [
            { operator: "Exists", effect: "NoSchedule" },
            { operator: "Exists", effect: "NoExecute" },
          ],
          // Root, for nft and for the node's root-owned /opt/cni/bin.
          securityContext: { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: "RuntimeDefault" } },
          initContainers: opts.remove ? [rules] : [rules, install],
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
          ...(opts.remove
            ? {}
            : {
                volumes: [
                  { name: "cni-bin", hostPath: { path: CNI_BIN_DIR, type: "Directory" } },
                  { name: "cni-conf", hostPath: { path: CNI_CONF_DIR, type: "Directory" } },
                ],
              }),
        },
      },
    },
  };
}

type Terminated = { exitCode?: number; message?: string };
type FenceNodePod = {
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    initContainerStatuses?: Array<{
      name?: string;
      state?: { terminated?: Terminated; waiting?: { reason?: string; message?: string } };
      lastState?: { terminated?: Terminated };
    }>;
  };
};

/** The result line of each init container of a pod of jr2-fence-node that has ended, in their order. */
export function fenceNodeResultsOf(pod: FenceNodePod): string[] {
  const out: string[] = [];
  for (const s of pod.status?.initContainerStatuses ?? []) {
    const message = s.state?.terminated?.message ?? s.lastState?.terminated?.message ?? "";
    const at = message.lastIndexOf(FENCE_NODE_PREFIX);
    if (at >= 0) {
      out.push(
        message
          .slice(at + FENCE_NODE_PREFIX.length)
          .split("\n")[0]!
          .trim(),
      );
    }
  }
  return out;
}

const isReady = (p: FenceNodePod): boolean =>
  p.metadata?.deletionTimestamp === undefined &&
  (p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");

/** What a pod of jr2-fence-node failed: the CNI folders, the `bridge` plugin, or the rule table. */
type NodeFailure = { node: string; what: "folder" | "bridge" | "rules"; text: string };

/** The refusal of the Sandbox nodes that a pod of jr2-fence-node failed on. */
function nodeRefusal(failures: readonly NodeFailure[]): Error {
  const has = (what: NodeFailure["what"]) => failures.some((f) => f.what === what);
  const nodes = new Set(failures.map((f) => f.node)).size;
  return new Error(
    [
      `fence: the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} failed on ` +
        `${nodes === 1 ? "a Sandbox node" : `${nodes} Sandbox nodes`} (ADR-0084):`,
      ...failures.map((f) => `  ${f.node}: ${f.text}`),
      ...(has("folder")
        ? [
            `jr2 puts the plugins ${PLUGINS.join(", ")} into ${CNI_BIN_DIR}, and the Fence needs nodes whose ` +
              `container runtime reads ${CNI_BIN_DIR} and ${CNI_CONF_DIR}. Keep such nodes out of the Sandbox ` +
              "nodes with sandbox.nodeSelector or a taint (ADR-0052), or use a cluster whose nodes use those folders.",
          ]
        : []),
      ...(has("bridge")
        ? [
            `jr2 never replaces a plugin file. A bridge plugin older than v${BRIDGE_MIN_VERSION} does not do what ` +
              "jr2's attachments say: it puts the trunks of the Instances on a shared VLAN, or refuses a trunk " +
              `that has vlan and vlanTrunk. Replace ${CNI_BIN_DIR}/bridge on the node with the stock plugin of ` +
              `v${BRIDGE_MIN_VERSION} or later, or delete it so that jr2 writes ${CNI_VERSION}; then delete the ` +
              `node's pod of ${FENCE_NODE_DAEMONSET}.`,
          ]
        : []),
      ...(has("rules")
        ? [
            `The node must have nftables with the inet family, and the pod needs the capability NET_ADMIN on the ` +
              "node's network. A policy of the cluster that refuses a host-network pod or that capability in " +
              `${OPERATOR_NAMESPACE} stops it.`,
          ]
        : []),
      `See ${FENCE_PREREQUISITES_URL}. Then run \`jr2 up\` again.`,
    ].join("\n"),
  );
}

/** A failed result line as a node failure. */
function failureOf(node: string, result: string): NodeFailure {
  const rest = result.slice("fail ".length);
  for (const what of ["folder", "bridge", "rules"] as const) {
    if (rest.startsWith(`${what} `)) return { node, what, text: rest.slice(what.length + 1) };
  }
  return { node, what: "folder", text: rest };
}

/**
 * Wait until each Sandbox node has a Ready pod of the DaemonSet jr2-fence-node: its init containers
 * loaded the rule table, and put the plugins there or found them. Returns each node's result
 * lines. A pod whose init container failed, or whose folder the kubelet could not mount, refuses.
 */
export async function awaitFenceNodes(
  kube: Pick<KubeAdmin, "listJson">,
  opts: { nodes: readonly string[]; context?: string; pollMs?: number; now?: () => number },
): Promise<Map<string, string>> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const now = opts.now ?? Date.now;
  const started = now();
  for (;;) {
    const pods = await kube.listJson<FenceNodePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    const results = new Map<string, string>();
    const failed: NodeFailure[] = [];
    const waiting: string[] = [];
    for (const node of opts.nodes) {
      const mine = pods.filter((p) => p.spec?.nodeName === node && p.metadata?.deletionTimestamp === undefined);
      const ready = mine.find(isReady);
      if (ready) {
        results.set(
          node,
          fenceNodeResultsOf(ready)
            .map((r) => r.replace(/^ok /, ""))
            .join(" ") || "ok",
        );
        continue;
      }
      const result = mine.flatMap(fenceNodeResultsOf).find((r) => r.startsWith("fail "));
      if (result) {
        failed.push(failureOf(node, result));
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
            failed.push({
              node,
              what: "folder",
              text: `the kubelet cannot mount a CNI folder: ${(mount.message ?? "").slice(0, 300)}`,
            });
            waiting.pop();
            break;
          }
        }
      }
    }
    if (failed.length > 0) throw nodeRefusal(failed);
    if (waiting.length === 0) return results;
    if (now() - started >= FENCE_NODE_WAIT_MS) {
      throw new Error(
        `fence: no Ready pod of the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} on the Sandbox ` +
          `node${waiting.length === 1 ? "" : "s"} ${waiting.join(", ")} in ${FENCE_NODE_WAIT_MS / 1000} s, so jr2 ` +
          `cannot see the rule table and the CNI plugins there (ADR-0084). See \`kubectl -n ${OPERATOR_NAMESPACE} ` +
          `describe pod -l app=${FENCE_NODE_DAEMONSET}\`.`,
      );
    }
    await sleep(opts.pollMs ?? POLL_MS);
  }
}

// ---- the install -----------------------------------------------------------------------------------

/**
 * Install what the plan says, after the question. The DaemonSet first, so that a node whose CNI
 * folders are elsewhere refuses before Multus changes the cluster's CNI configuration; then Multus.
 * The DaemonSet is applied at each converge whose Kit is not older than the one it runs, as the
 * operator is: an apply that changes nothing rolls nothing, and one that changes the image or the
 * template (a newer Kit, or the removal form that an interrupted `jr2 down --all` left) rolls each
 * pod, which loads the table again. One quiet line when the plan installed nothing.
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
  },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const existing = await kube.getJson<DaemonSetObject>({
    kind: "daemonset",
    name: FENCE_NODE_DAEMONSET,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  const deployed = existing?.metadata.labels?.[LABEL_VERSION];
  const newer = deployed !== undefined && compareVersions(deployed, KIT_VERSION) > 0;
  if (!newer) {
    if (plan.node === "install") {
      opts.log(`fence: applying the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} (${opts.image})`);
    }
    await kube.apply({ manifest: JSON.stringify(fenceNodeDaemonSet(opts.image)), ...ctx });
  }
  const results = await awaitFenceNodes(kube, opts);
  if (plan.node === "install") {
    for (const [node, line] of results) opts.log(`fence: ${node}: ${line}`);
  }
  if (plan.multus === "install" || plan.multus === "upgrade") {
    const text = await multusManifest();
    opts.log(`fence: applying Multus v4.3.2 (thick, namespaceIsolation) to ${MULTUS_NAMESPACE}`);
    await kube.apply({ manifest: text, ...ctx });
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
        `rule table and the CNI plugins on ${results.size} Sandbox node${results.size === 1 ? "" : "s"}`,
    );
  }
}

// ---- jr2 down --all --------------------------------------------------------------------------------

/** How long the removal form of the DaemonSet may take on each node. */
const REMOVE_WAIT_S = 120;

/**
 * Remove what jr2 installed for the Fence on the cluster: the rule table on each node, the fence
 * node's DaemonSet, and the Multus that carries jr2's annotation. A Multus that jr2 did not install
 * stays. The plugin files stay on the nodes: jr2 cannot tell them from files that another tool put
 * there.
 *
 * The table goes by the DaemonSet itself: its removal form, applied with the image that it runs,
 * removes the table in each pod's init container, and the DaemonSet goes when each pod is Ready.
 * No pod of jr2 is then left on a node with a capability. A node where no pod became Ready in time
 * (a node that is down) keeps its table: the warning names the command that removes it.
 */
export async function uninstallFence(
  kube: Pick<KubeAdmin, "getJson" | "apply" | "waitRollout" | "deleteObject" | "deleteManifest">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const existing = await kube.getJson<DaemonSetObject>({
    kind: "daemonset",
    name: FENCE_NODE_DAEMONSET,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  if (existing) {
    const image = (existing.spec?.template?.spec?.containers?.[0] as { image?: string } | undefined)?.image;
    if (image !== undefined) {
      opts.log(`removing the rule table "${RULES_TABLE}" from each node`);
      await kube.apply({ manifest: JSON.stringify(fenceNodeDaemonSet(image, { remove: true })), ...ctx });
      try {
        await kube.waitRollout({
          kind: "daemonset",
          name: FENCE_NODE_DAEMONSET,
          namespace: OPERATOR_NAMESPACE,
          timeoutSeconds: REMOVE_WAIT_S,
          ...ctx,
        });
      } catch (err) {
        opts.log(
          `warning: the rule table "${RULES_TABLE}" was not removed from each node in ${REMOVE_WAIT_S} s ` +
            `(${(err as Error).message.split("\n")[0]}); on a node that keeps it, run \`nft delete table ` +
            `${RULES_TABLE}\` as root`,
        );
      }
    }
    opts.log(
      `uninstalling the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET}; the CNI plugins ` +
        `${PLUGINS.join(", ")} stay in ${CNI_BIN_DIR} on each node`,
    );
    await kube.deleteObject({ kind: "daemonset", name: FENCE_NODE_DAEMONSET, namespace: OPERATOR_NAMESPACE, ...ctx });
  }
  const multus = await kube.getJson({ kind: "daemonset", name: MULTUS_DAEMONSET, namespace: MULTUS_NAMESPACE, ...ctx });
  if (multus?.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined) {
    opts.log(`uninstalling Multus (${MULTUS_NAMESPACE}), which jr2 installed`);
    await kube.deleteManifest({ manifest: await multusManifest(), ...ctx });
  }
}
