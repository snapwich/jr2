// The node prerequisites of the Fence (ADR-0084, ADR-0019), which `jr2 up` installs on any cluster
// with kubectl alone, after it asks:
//
//   Multus     the second network of a pod. When the cluster has none, `jr2 up` applies the thick
//              manifest that the CLI ships (`manifests/fence/`). Its DaemonSet and its
//              CustomResourceDefinition have the annotation `jr2.dev/multus`, so jr2 knows that it
//              installed them. A cluster whose CustomResourceDefinition of the attachments has no
//              such annotation has a Multus of another owner: jr2 uses it and never changes it.
//              Whether a Multus works on a node is shown by behaviour: the probe's pod on the
//              Fence gets its slot's address (`fence-probe.ts`). jr2 does not read a Multus's
//              settings: its own admission policies (`fence-guard.ts`) keep a pod of another
//              namespace off an Instance's attachments, with any Multus.
//   DaemonSet  `jr2-system/jr2-fence-node`, which runs the operator image on each node,
//              on the node's network, in two init containers:
//              rules    with NET_ADMIN alone, first, so that each node gets it, also a node that
//                       `install` then refuses: it loads the rule table `inet jr2_fence` into the
//                       node (`FENCE_RULES`), at each start of the pod, so a restart of the node gets
//                       it again. The table replaces itself in one transaction: no window with no
//                       rule and no rule twice.
//              install  with no capability: it waits for the node's CNI folders, refuses a node's
//                       `bridge` older than v1.8.0 (or a link to a `bridge` that it cannot run), and
//                       copies the pinned v1.10.0 plugins bridge, static and tuning into the node's
//                       /opt/cni/bin when the node has no file of that name. It never replaces a
//                       file. It names the node's first CNI configuration and its type.
//              Then the pod idles as a user that is not root, so a node that joins later gets both.
//
// The VLAN state that the bridge plugin makes from jr2's attachment objects (`fence.ts`) keeps a
// Sandbox off the node and off other pods, also with no table. The table keeps the node's NAT from
// changing a Sandbox's frames, so that each dial reaches the Custodian, and it is a second barrier: a
// Sandbox's frame enters the bridge untagged at its access port, so on a node with
// `net.bridge.bridge-nf-call-iptables = 1` the node's prerouting rules see it before the bridge tags
// it, and kube-proxy's NAT changes a dial to a Service address. The table's `notrack` stops that, and
// its other chains drop each packet between the bridge and the node's own stack.
//
// `jr2 up` does not install when it cannot do so safely. Before it applies anything, it refuses when
// Cilium has `cni-exclusive: "true"` for a Sandbox node, because then it removes each other CNI
// configuration of the node. After it applied the namespace jr2-system and the DaemonSet, and before
// it applies Multus, a Sandbox node refuses when its pod of jr2-fence-node finds no CNI
// configuration or plugins in the default folders, a `bridge` older than v1.8.0, with no version or
// behind a link that it cannot run, a folder that it cannot write, or a rule table that does not
// load. Those parts stay; `jr2 down --all` removes them.
//
// In two steps: `planFenceInstall` reads and changes nothing (before the first-time question), and
// `installFence` applies (after the operator image exists, before the Custodian needs the Fence).

import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, KIT_VERSION, LABEL_VERSION, OPERATOR_NAMESPACE } from "./deploy.ts";
import { FENCE_BRIDGE } from "./fence.ts";
import { GUARD_NAMES, planFenceGuard, removeFenceGuard } from "./fence-guard.ts";
import { isMissingResourceType, type KubeAdmin, type KubeObject } from "./kube.ts";

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
/** The first version of the `bridge` plugin that does what the attachments say (`fence.ts`), for two
 * reasons. (1) The trunk's attachment sets `vlan` and `vlanTrunk` together, and v1.8.0 is the first
 * release that takes them (v1.3.0 to v1.7.1 refuse them: "cannot set vlan and vlanTrunk at the same
 * time"). (2) Each attachment sets `preserveDefaultVlan: false` (since v1.3.0), and a slot's sets
 * `portIsolation` (since v1.7.0): an older plugin ignores a key that it does not know, so it keeps
 * VLAN 1 on each port, puts the trunks of the Instances on a shared VLAN, and does not isolate a
 * slot's port. */
export const BRIDGE_MIN_VERSION = "1.8.0";
/** The DaemonSet that loads the rule table and puts the plugins on each node. */
export const FENCE_NODE_DAEMONSET = "jr2-fence-node";
/** The start of each result line (an init container's termination message). */
export const FENCE_NODE_PREFIX = "jr2.fence-node ";
export const MULTUS_DAEMONSET = "kube-multus-ds";
export const MULTUS_NAMESPACE = "kube-system";
/** The annotation of the Multus DaemonSet and CustomResourceDefinition that jr2 installed: the
 * version of the shipped manifest. */
export const MULTUS_ANNOTATION = "jr2.dev/multus";
/** Its value in the shipped manifest. Change both when the manifest changes. */
export const MULTUS_VERSION = "v4.3.2-thick-2";
/** The label of the pods of the Multus that jr2 installs, as the shipped manifest sets it. */
export const MULTUS_SELECTOR = "app=multus";
/** The CustomResourceDefinition of the attachments: Multus's. */
export const ATTACHMENT_CRD = "network-attachment-definitions.k8s.cni.cncf.io";
/** The objects of the shipped Multus manifest, as `kubectl delete` names them, for a person who
 * removes them by hand. */
const MULTUS_OBJECTS =
  `kubectl delete crd ${ATTACHMENT_CRD}; kubectl delete clusterrolebinding multus; kubectl delete clusterrole ` +
  "multus; kubectl -n kube-system delete daemonset kube-multus-ds configmap multus-daemon-config serviceaccount multus";
/** The page of the prerequisites. */
export const FENCE_PREREQUISITES_URL =
  "https://snapwich.github.io/jr2/guides/move-from-kind-to-a-shared-cluster.html#prerequisites-of-the-fence";
/** How long the pods of jr2-fence-node may take on each Sandbox node: the image can be pulled there first. */
const FENCE_NODE_WAIT_MS = 300_000;
/** How long the `install` container waits for the node's CNI configuration and plugins: on a new
 * node, the primary CNI writes them after this pod can start. Inside `FENCE_NODE_WAIT_MS`. */
const CNI_WAIT_S = 180;
/** How long a pod may wait for a volume before the kubelet's reason counts. */
const MOUNT_GRACE_MS = 20_000;
const POLL_MS = 2_000;

type Json = Record<string, unknown>;
type Kube = Pick<KubeAdmin, "getJson" | "listJson">;

/** What `jr2 up` will do, read before it asks. */
export type FenceInstallPlan = {
  /** `install`: no Multus, or jr2's that an earlier apply left without its DaemonSet. `upgrade`:
   * jr2's, of another version. `jr2`: jr2's, current. `foreign`: a Multus of another owner, which
   * jr2 uses and never changes. */
  multus: "install" | "upgrade" | "jr2" | "foreign";
  /** `install`: no DaemonSet. `present`: the DaemonSet is there (the converge updates it with no question). */
  node: "install" | "present";
  /** `install`: a policy or a binding of jr2's admission guard is missing. `present`: all four are
   * there (the converge updates them with no question). */
  guard: "install" | "present";
  /** `create`: the cluster has no namespace jr2-system, and the install makes it. */
  system: "create" | "present";
  /** Lines for the person: a check that jr2 could not make, and why. */
  notes: string[];
};

/** The plan asks: it installs something on the cluster that the cluster does not have. */
export const planAsks = (plan: FenceInstallPlan): boolean =>
  plan.multus === "install" || plan.multus === "upgrade" || plan.node === "install" || plan.guard === "install";

/** What Multus's install puts on the cluster, as the question says it. */
const MULTUS_PARTS =
  "a cluster-wide CustomResourceDefinition and ClusterRole, and a privileged DaemonSet " +
  `${MULTUS_NAMESPACE}/${MULTUS_DAEMONSET}. Multus writes the first CNI configuration of each node, so the ` +
  "cluster makes each new pod through Multus";

/**
 * What the plan installs, as the first-time question says it: a short list, one line for each part,
 * which `jr2 up` writes before it asks. Undefined when it installs nothing.
 */
export function describeInstall(plan: FenceInstallPlan): string[] | undefined {
  if (!planAsks(plan)) return undefined;
  const said = ["fence: this converge installs the Fence's prerequisites (ADR-0084):"];
  if (plan.system === "create") said.push(`  - the namespace ${OPERATOR_NAMESPACE}.`);
  if (plan.node === "install") {
    said.push(
      `  - the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET}, on each Linux node. Its pod runs as root ` +
        "on the node's network. At each start, it:",
      `      - loads the rule table "${RULES_TABLE}" into the node's nftables, with the capability NET_ADMIN alone;`,
      `      - runs the node's ${CNI_BIN_DIR}/bridge, if the node has one, to read its version;`,
      `      - writes the CNI plugins ${PLUGINS.join(", ")} ${CNI_VERSION} into ${CNI_BIN_DIR} where the node has ` +
        "no file of that name (it never replaces a file).",
    );
  }
  if (plan.guard === "install") {
    said.push(
      `  - the ValidatingAdmissionPolicies ${GUARD_NAMES.join(" and ")}, each with a ValidatingAdmissionPolicyBinding ` +
        "of the same name: cluster-wide objects. They refuse a pod that names an attachment of the Fence (the " +
        "prefix jr2-fence-) from outside its Instance's namespace, through v1.multus-cni.io/default-network or " +
        `k8s.v1.cni.cncf.io/networks, and a NetworkAttachmentDefinition on the bridge ${BRIDGE} outside an ` +
        "Instance's namespace.",
    );
  }
  const ownMultus = plan.multus !== "foreign";
  if (plan.multus === "install") {
    said.push(`  - Multus v4.3.2 (thick), from the manifest that the CLI ships: ${MULTUS_PARTS}.`);
  }
  if (plan.multus === "upgrade") {
    said.push(
      `  - an update of the Multus that jr2 installed to ${MULTUS_VERSION}, from the manifest that the CLI ships: ` +
        `${MULTUS_PARTS}.`,
    );
  }
  said.push(
    `  A later jr2 up of a newer Kit changes the DaemonSet ${FENCE_NODE_DAEMONSET} and the policies to its ` +
      "version, and does not ask. " +
      (ownMultus
        ? "It asks before it changes the Multus that jr2 installs."
        : "It never changes the cluster's Multus, which jr2 did not install."),
    ownMultus
      ? `  jr2 down --all removes the rule table, the bridge ${BRIDGE} that the bridge plugin makes, the DaemonSet, ` +
          "the policies with their bindings, and the Multus that jr2 installs. It keeps that Multus while the " +
          "cluster has a NetworkAttachmentDefinition of another owner. The plugin files and the kernel module 8021q " +
          "stay on the nodes."
      : `  jr2 down --all removes the rule table, the bridge ${BRIDGE} that the bridge plugin makes, the DaemonSet, ` +
          "and the policies with their bindings. The plugin files and the kernel module 8021q stay on the nodes.",
  );
  return said;
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

type Container = { name?: string; image?: string };
export type DaemonSetObject = KubeObject & {
  metadata: { namespace?: string };
  spec?: {
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: Container[]; initContainers?: Container[] };
    };
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
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
const isForbidden = (err: unknown): boolean => /\bforbidden\b/i.test(err instanceof Error ? err.message : String(err));

/**
 * One ConfigMap, read so that a missing one and a refused read are not the same: `missing` when the
 * namespace has none of that name, `{ forbidden }` when the API refused the read. Any other failure
 * throws. (`getJson` reads each failure as absent.)
 */
export async function readConfigMap(
  kube: Pick<KubeAdmin, "listJson">,
  opts: { namespace: string; name: string; context?: string },
): Promise<ConfigMapObject | "missing" | { forbidden: string }> {
  try {
    const items = await kube.listJson<ConfigMapObject>({
      kind: "configmap",
      fieldSelector: `metadata.name=${opts.name}`,
      namespace: opts.namespace,
      ...(opts.context !== undefined ? { context: opts.context } : {}),
    });
    return items[0] ?? "missing";
  } catch (err) {
    if (isForbidden(err)) return { forbidden: firstLine(err) };
    throw err;
  }
}

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

const imagesOf = (ds: DaemonSetObject): string[] => {
  const spec = ds.spec?.template?.spec;
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((c) => c.image ?? "");
};

/** A Cilium agent's DaemonSet: its name, its `k8s-app` label, or the image `…/cilium:<tag>`. */
export function isCiliumDaemonSet(ds: DaemonSetObject): boolean {
  return (
    ds.metadata.name === "cilium" ||
    ds.metadata.labels?.["k8s-app"] === "cilium" ||
    imagesOf(ds).some((i) => /(^|\/)cilium(:|@|$)/.test(i))
  );
}

/**
 * Refusal (b): Cilium with `cni-exclusive: "true"` for a Sandbox node. The ConfigMap `cilium-config`
 * in the namespace of the Cilium agent's DaemonSet sets it for the cluster, and a `CiliumNodeConfig`
 * whose node selector selects a node sets it for that node, over the ConfigMap. A cluster with no
 * Cilium passes. A read that the API refuses cannot tell: it gives a note, not a refusal, and the
 * check of the Fence after the Custodian finds a node where Multus has no configuration.
 */
export async function checkCilium(
  kube: Kube,
  opts: { nodes: readonly NodeLike[]; daemonSets: readonly DaemonSetObject[]; context?: string },
): Promise<string[]> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const notes: string[] = [];
  const cantTell = (what: string, why: string) =>
    notes.push(
      `fence: jr2 cannot read ${what} (${why}), so it cannot tell whether Cilium has cni-exclusive: "true" ` +
        "for a Sandbox node. With it, Cilium removes Multus's configuration, and the check of the Fence after " +
        "the Custodian fails on that node (ADR-0084).",
    );
  const namespaces = [
    ...new Set(opts.daemonSets.filter(isCiliumDaemonSet).map((d) => d.metadata.namespace ?? "kube-system")),
  ];
  let clusterWide: string | undefined;
  let where = "";
  for (const namespace of namespaces) {
    const config = await readConfigMap(kube, { namespace, name: "cilium-config", ...ctx });
    if (config === "missing") continue;
    if ("forbidden" in config) {
      cantTell(`the ConfigMap ${namespace}/cilium-config`, config.forbidden);
      continue;
    }
    if (config.data?.["cni-exclusive"] !== undefined) {
      clusterWide = config.data["cni-exclusive"];
      where = `${namespace}/cilium-config`;
    }
  }
  const crd = await kube.listJson({
    kind: "customresourcedefinition",
    fieldSelector: "metadata.name=ciliumnodeconfigs.cilium.io",
    ...ctx,
  });
  let perNode: CiliumNodeConfig[] = [];
  if (crd.length > 0) {
    try {
      perNode = await kube.listJson<CiliumNodeConfig>({
        kind: "ciliumnodeconfigs.cilium.io",
        allNamespaces: true,
        ...ctx,
      });
    } catch (err) {
      if (!isForbidden(err)) throw err;
      cantTell("the CiliumNodeConfigs", firstLine(err));
    }
  }
  const byNode: string[] = [];
  for (const node of opts.nodes) {
    const matching = perNode.filter(
      (c) => c.spec?.defaults?.["cni-exclusive"] !== undefined && selects(c.spec?.nodeSelector, node.metadata.labels),
    );
    const exclusive = matching.find((c) => c.spec!.defaults!["cni-exclusive"] === "true");
    if (exclusive) {
      const named = `${exclusive.metadata.namespace ?? ""}/${exclusive.metadata.name}`.replace(/^\//, "");
      throw refused(
        `Cilium has cni-exclusive: "true" for the Sandbox node ${node.metadata.name} in the CiliumNodeConfig ` +
          `${named}, so Cilium removes each other CNI configuration on that node, and Multus cannot give a pod ` +
          `the Fence (ADR-0084). Set "cni-exclusive": "false" in spec.defaults of the CiliumNodeConfig ${named} ` +
          "(or remove that key there and set it in the ConfigMap cilium-config), restart the Cilium agent on " +
          "the node, then run `jr2 up` again.",
      );
    }
    if (clusterWide === "true" && !matching.some((c) => c.spec!.defaults!["cni-exclusive"] === "false")) {
      byNode.push(node.metadata.name);
    }
  }
  if (byNode.length > 0) {
    const ns = where.split("/")[0]!;
    throw refused(
      `Cilium has cni-exclusive: "true" in the ConfigMap ${where}, so Cilium removes each other CNI ` +
        `configuration on the Sandbox node${byNode.length === 1 ? "" : "s"} ${byNode.join(", ")}, and Multus ` +
        'cannot give a pod the Fence (ADR-0084). Set cni-exclusive: "false" in that ConfigMap (with Helm: ' +
        `--set cni.exclusive=false), restart the Cilium agents (kubectl -n ${ns} rollout restart ` +
        "daemonset/cilium), then run `jr2 up` again.",
    );
  }
  return notes;
}

type CrdObject = { metadata: { name: string; annotations?: Record<string, string> } };

/**
 * Read what the cluster has, and refuse a Cilium with `cni-exclusive: "true"`. Changes nothing. Each
 * read throws when it fails: a part that reads as absent when the API could not be read would be
 * installed over a part that is there.
 *
 * Multus: a DaemonSet with jr2's annotation is jr2's (`jr2`, or `upgrade` for another version).
 * Else the CustomResourceDefinition of the attachments says it: none is `install`; one with jr2's
 * annotation is jr2's Multus that an earlier apply left without its DaemonSet, so `install` again;
 * one with no such annotation belongs to a Multus of another owner (`foreign`), which jr2 uses and
 * never changes. Whether that Multus works on a node, the probe shows (`fence-probe.ts`).
 */
export async function planFenceInstall(
  kube: Kube,
  opts: { nodes: readonly NodeLike[]; context?: string },
): Promise<FenceInstallPlan> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const daemonSets = await kube.listJson<DaemonSetObject>({ kind: "daemonset", allNamespaces: true, ...ctx });
  const notes = await checkCilium(kube, { nodes: opts.nodes, daemonSets, ...ctx });
  const ours = daemonSets.filter((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined);
  let multus: FenceInstallPlan["multus"];
  if (ours.length > 0) {
    multus = ours.every((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] === MULTUS_VERSION) ? "jr2" : "upgrade";
  } else {
    const [crd] = await kube.listJson<CrdObject>({
      kind: "customresourcedefinition",
      fieldSelector: `metadata.name=${ATTACHMENT_CRD}`,
      ...ctx,
    });
    multus = crd === undefined || crd.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined ? "install" : "foreign";
  }
  const node = daemonSets.some(
    (d) => d.metadata.name === FENCE_NODE_DAEMONSET && d.metadata.namespace === OPERATOR_NAMESPACE,
  );
  const system = await kube.listJson({
    kind: "namespace",
    fieldSelector: `metadata.name=${OPERATOR_NAMESPACE}`,
    ...ctx,
  });
  return {
    multus,
    node: node ? "present" : "install",
    guard: await planFenceGuard(kube, ctx),
    system: system.length === 0 ? "create" : "present",
    notes,
  };
}

// ---- the DaemonSet jr2-fence-node --------------------------------------------------------------------

/** The `say` function of each script: one result line, as the termination message and in the log. */
const SAY = `say() { echo "${FENCE_NODE_PREFIX}$1" > /dev/termination-log; echo "${FENCE_NODE_PREFIX}$1"; }`;

/**
 * The script of the `rules` init container. It loads the rule table in one nft transaction: the
 * first line makes the table when the node has none, the second deletes it, and the rest makes it
 * again, so a second load replaces the table, never adds rules to it, and the node has no moment
 * with no rule. Then it reads the table back and counts its chains. Each failure writes a result
 * line with its cause.
 */
export const RULES_SCRIPT = `set -eu
${SAY}
if ! out=$(printf '%s\\n' 'table ${RULES_TABLE}' 'delete table ${RULES_TABLE}' '${FENCE_RULES}' | nft -f - 2>&1); then
  say "fail rules nft could not load the table ${RULES_TABLE}: $(echo "$out" | tr '\\n' ' ' | cut -c1-300)"
  exit 1
fi
if ! listed=$(nft list table ${RULES_TABLE} 2>&1); then
  say "fail rules nft could not list the table ${RULES_TABLE} after the load: $(echo "$listed" | tr '\\n' ' ' | cut -c1-300)"
  exit 1
fi
chains=$(echo "$listed" | grep -c '^[[:space:]]*chain ' || true)
if [ "$chains" != 4 ]; then
  say "fail rules the table ${RULES_TABLE} has $chains chains after the load, not 4"
  exit 1
fi
say "ok rules=loaded"
`;

/**
 * The script of the removal (`jr2 down --all`). The table goes, whether the node has it or not. Then
 * the bridge goes, which the bridge plugin made at the node's first attachment and which nothing
 * else removes. `ip` (busybox's, in the operator image) deletes it with `NET_ADMIN` alone, and only
 * when it has no port: a port is a pod of some Instance that is still on the Fence, so the bridge
 * then stays, and the result line names the ports. The result line's `bridge=` is `removed`,
 * `absent` (a node where no pod joined the Fence), `kept ports=<a,b>`, or `kept error=<reason>`.
 * Only the table can fail the pod: a bridge that stays does not stop the removal of the DaemonSet.
 * The kernel module `8021q` stays loaded: another user of the node can need it.
 */
export const RULES_REMOVE_SCRIPT = `set -eu
${SAY}
oneline() { echo "$1" | tr '\\n' ' ' | cut -c1-200; }
if ! out=$(printf '%s\\n' 'table ${RULES_TABLE}' 'delete table ${RULES_TABLE}' | nft -f - 2>&1); then
  say "fail rules nft could not remove the table ${RULES_TABLE}: $(echo "$out" | tr '\\n' ' ' | cut -c1-300)"
  exit 1
fi
if ! links=$(ip -o link show 2>&1); then
  bridge="kept error=ip could not list the node's links: $(oneline "$links")"
elif ! echo "$links" | grep -q '^[0-9]*: ${BRIDGE}[:@]'; then
  bridge=absent
else
  ports=$(echo "$links" | grep ' master ${BRIDGE} ' | awk '{ print $2 }' | sed 's/[:@].*//' | tr '\\n' ',' | sed 's/,$//')
  if [ -n "$ports" ]; then
    bridge="kept ports=$ports"
  elif out=$(ip link delete ${BRIDGE} 2>&1); then
    bridge=removed
  elif ! ip link show ${BRIDGE} >/dev/null 2>&1; then
    bridge=absent
  else
    bridge="kept error=$(oneline "$out")"
  fi
fi
say "ok rules=removed bridge=$bridge"
`;

/** What the removal form did with a node's bridge, read from its result line. */
export function bridgeRemovalOf(line: string): { bridge: "removed" | "absent" | "kept"; detail?: string } | undefined {
  const m = /(?:^| )bridge=(removed|absent|kept)(?: (.*))?$/.exec(line);
  if (!m) return undefined;
  return { bridge: m[1] as "removed" | "absent" | "kept", ...(m[2] !== undefined ? { detail: m[2].trim() } : {}) };
}

/**
 * The script of the `install` init container, which runs after `rules`, so that each node gets the
 * table, also a node that this script refuses. It runs as root with no capability, so it can write
 * a file into the node's /opt/cni/bin (root's own folder) and nothing that needs a capability.
 *
 * 1. It waits, up to `CNI_WAIT_S` (`JR2_CNI_WAIT`), for a CNI configuration in /etc/cni/net.d and a
 *    file in /opt/cni/bin: on a new node, the primary CNI writes them after this pod can start. A
 *    node that has none then does not use those folders: the script fails and says so.
 * 2. When the node has a `bridge` (a file, or a link), it reads its version before it writes
 *    anything: it runs the file with no `CNI_COMMAND`, and a stock plugin prints
 *    `CNI bridge plugin v<version>` and stops. A version older than `BRIDGE_MIN_VERSION`, or none
 *    that it can read, fails. The pod sees only the node's /opt/cni/bin, so a link to a file in
 *    another folder (or to another link) fails too: jr2 cannot run it, so it cannot read its version.
 * 3. It writes each plugin that the node has no file or link of: a copy under a name of its own,
 *    then `ln` to the plugin's name, which refuses to replace a file that appeared after the check
 *    (that file is kept). So the runtime never runs half a file, and a link is never replaced. A
 *    copy that fails says why.
 * 4. It reads the version of the `bridge` that it wrote, and names the node's first CNI
 *    configuration and the first `type` in it, for the person who reads the line.
 */
export const PLUGINS_SCRIPT = `set -eu
BIN=/host${CNI_BIN_DIR} CONF=/host${CNI_CONF_DIR} SRC=/opt/jr2/cni/bin WAIT=\${JR2_CNI_WAIT:-${CNI_WAIT_S}}
${SAY}
oneline() { echo "$1" | tr '\\n' ' ' | cut -c1-200; }
confs() { ls "$CONF" 2>/dev/null | grep -E '\\.(conf|conflist|json)$' | LC_ALL=C sort || true; }
present() { [ -e "$1" ] || [ -L "$1" ]; }
waited=0
while [ -z "$(confs)" ] || [ -z "$(ls -A "$BIN")" ]; do
  [ "$waited" -ge "$WAIT" ] && break
  sleep 2
  waited=$((waited + 2))
done
if [ -z "$(confs)" ]; then
  say "fail folder no CNI configuration in ${CNI_CONF_DIR} on the node after $WAIT s: the container runtime reads it from another folder"
  exit 1
fi
if [ -z "$(ls -A "$BIN")" ]; then
  say "fail folder ${CNI_BIN_DIR} on the node is empty after $WAIT s: the container runtime reads its plugins from another folder"
  exit 1
fi
version=""
check_bridge() {
  if [ -L "$BIN/bridge" ]; then
    target=$(readlink "$BIN/bridge" || true)
    case "$target" in
      ""|*/*) runnable=no ;;
      *) if [ -f "$BIN/$target" ] && [ ! -L "$BIN/$target" ]; then runnable=yes; else runnable=no; fi ;;
    esac
    if [ "$runnable" = no ]; then
      say "fail link ${CNI_BIN_DIR}/bridge is a link to $target, which this pod cannot run (it sees only ${CNI_BIN_DIR} of the node), so jr2 cannot read the version of that bridge plugin"
      exit 1
    fi
  fi
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
}
if present "$BIN/bridge"; then check_bridge; fi
wrote="" kept=""
for p in ${PLUGINS.join(" ")}; do
  if present "$BIN/$p"; then kept="$kept $p"; continue; fi
  tmp="$BIN/.$p.jr2-new"
  rm -f "$tmp" 2>/dev/null || true
  if ! out=$( { cp "$SRC/$p" "$tmp" && chmod 0755 "$tmp"; } 2>&1); then
    rm -f "$tmp" 2>/dev/null || true
    say "fail write cannot write $p into ${CNI_BIN_DIR} on the node: $(oneline "$out")"
    exit 1
  fi
  if out=$(ln "$tmp" "$BIN/$p" 2>&1); then
    wrote="$wrote $p"
  elif present "$BIN/$p"; then
    kept="$kept $p"
  else
    rm -f "$tmp" 2>/dev/null || true
    say "fail write cannot write $p into ${CNI_BIN_DIR} on the node: $(oneline "$out")"
    exit 1
  fi
  rm -f "$tmp"
done
if [ -z "$version" ]; then check_bridge; fi
first=$(confs | head -n 1)
type=$(grep -o '"type"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONF/$first" 2>/dev/null | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/') || true
say "ok wrote=\${wrote# } kept=\${kept# } bridge=v$version cni=$first type=\${type:-unknown}"
`;

/** The user of the idle container: no root, as the Custodian's. */
const IDLE_USER = 65532;

/**
 * The DaemonSet jr2-fence-node, from the operator image. `remove` is its form for
 * `jr2 down --all`: its one init container removes the rule table and the bridge, and it writes no
 * plugin.
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
    // NET_ADMIN alone, for nft (and, in the removal form, `ip link delete`) in the node's network namespace.
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
          // Root, for nft and for the node's root-owned /opt/cni/bin; the idle container is not root.
          securityContext: { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: "RuntimeDefault" } },
          // The table first, so that each node gets it, also a node that the checks of `install`
          // (its folders, its `bridge`) then refuse.
          initContainers: opts.remove ? [rules] : [rules, install],
          containers: [
            {
              name: "idle",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done"],
              resources: { requests: { cpu: "1m", memory: "4Mi" }, limits: { memory: "16Mi" } },
              securityContext: { ...restricted, runAsUser: IDLE_USER, runAsGroup: IDLE_USER, runAsNonRoot: true },
            },
          ],
          // `Directory`, never `DirectoryOrCreate`: jr2 makes no CNI folder on a node. On a new node,
          // the kubelet mounts the folder when the primary CNI makes it; the wait gives it
          // `CNI_WAIT_S`, and then names the kubelet's reason.
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
  metadata?: {
    name?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ uid?: string }>;
  };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    initContainerStatuses?: Array<{
      name?: string;
      state?: { running?: object; terminated?: Terminated; waiting?: { reason?: string; message?: string } };
      lastState?: { terminated?: Terminated };
    }>;
  };
};

/** The DaemonSet's template generation (its annotation), which each of its pods carries as a label. */
const TEMPLATE_GENERATION_ANNOTATION = "deprecated.daemonset.template.generation";
const TEMPLATE_GENERATION_LABEL = "pod-template-generation";

/** Which pods are of the DaemonSet as it is now: its uid (a DaemonSet made again has another, and its
 * generation starts again at 1) and its template generation. */
export type FenceNodeOwner = { uid: string; generation: number };

/**
 * Read the DaemonSet jr2-fence-node: its uid and its template generation, `undefined` when it is
 * NotFound. A read that fails throws: a wait that takes a failed read for "any pod counts" would
 * accept a Ready pod of another template.
 */
export async function readFenceNode(
  kube: Pick<KubeAdmin, "listJson">,
  ctx: { context?: string } = {},
): Promise<(DaemonSetObject & { metadata: { uid?: string } }) | undefined> {
  const [ds] = await kube.listJson<DaemonSetObject & { metadata: { uid?: string } }>({
    kind: "daemonset",
    fieldSelector: `metadata.name=${FENCE_NODE_DAEMONSET}`,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  return ds;
}

/** The owner of a DaemonSet that was read, or a throw when it has no uid or no generation. */
function ownerOf(ds: (DaemonSetObject & { metadata: { uid?: string } }) | undefined): FenceNodeOwner {
  const uid = ds?.metadata.uid;
  const generation = Number(ds?.metadata.annotations?.[TEMPLATE_GENERATION_ANNOTATION]);
  if (ds === undefined) {
    throw new Error(`fence: the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} is gone after its apply`);
  }
  if (uid === undefined || !Number.isInteger(generation)) {
    throw new Error(
      `fence: the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} has no uid or no template generation ` +
        `(${TEMPLATE_GENERATION_ANNOTATION}), so jr2 cannot tell its pods from older ones`,
    );
  }
  return { uid, generation };
}

/** A pod of this owner, of its template or a later one. */
const ofOwner = (p: FenceNodePod, owner: FenceNodeOwner): boolean =>
  (p.metadata?.ownerReferences ?? []).some((o) => o.uid === owner.uid) &&
  Number(p.metadata?.labels?.[TEMPLATE_GENERATION_LABEL]) >= owner.generation;

/** An init container of the pod has started: the kubelet mounted its volumes. */
const initStarted = (p: FenceNodePod): boolean =>
  (p.status?.initContainerStatuses ?? []).some(
    (s) => s.state?.running !== undefined || s.state?.terminated !== undefined || s.lastState?.terminated !== undefined,
  );

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

/** What a pod of jr2-fence-node failed: the CNI folders, a write into them, the `bridge` plugin, a
 * link to a `bridge` that it cannot run, the rule table, or the pod's create. */
type NodeFailure = {
  node: string;
  what: "folder" | "write" | "bridge" | "link" | "rules" | "create";
  text: string;
};

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
      ...(has("write")
        ? [
            `The pod writes as root into the node's ${CNI_BIN_DIR}. On a node where that folder is read-only (an ` +
              "immutable operating system), put the stock plugins there with the node's own tools, or keep the " +
              "node out of the Sandbox nodes with sandbox.nodeSelector or a taint (ADR-0052).",
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
      ...(has("link")
        ? [
            `jr2 never replaces a plugin file or link, and its pod sees only the node's ${CNI_BIN_DIR}, so it ` +
              "cannot run a link to a file in another folder, and cannot read the version of that bridge plugin. " +
              `Put the stock bridge plugin of v${BRIDGE_MIN_VERSION} or later in ${CNI_BIN_DIR} as a file, not a ` +
              `link, or delete the link so that jr2 writes ${CNI_VERSION}; then delete the node's pod of ` +
              `${FENCE_NODE_DAEMONSET}.`,
          ]
        : []),
      ...(has("rules")
        ? [
            `The node must have nftables with the inet family, and the pod needs the capability NET_ADMIN on the ` +
              "node's network. A policy of the cluster that refuses a host-network pod or that capability in " +
              `${OPERATOR_NAMESPACE} stops it.`,
          ]
        : []),
      ...(has("create")
        ? [
            `The cluster refused the pod. It needs, in the namespace ${OPERATOR_NAMESPACE}: the node's network, ` +
              `root, the capability NET_ADMIN, and the node's folders ${CNI_BIN_DIR} and ${CNI_CONF_DIR}. With Pod ` +
              `Security admission, label the namespace: kubectl label namespace ${OPERATOR_NAMESPACE} ` +
              "pod-security.kubernetes.io/enforce=privileged.",
          ]
        : []),
      ...KEPT,
      `See ${FENCE_PREREQUISITES_URL}. Then run \`jr2 up\` again.`,
    ].join("\n"),
  );
}

/** What a refusal after the apply of the DaemonSet leaves on the cluster. */
const KEPT = [
  `jr2 applied the namespace ${OPERATOR_NAMESPACE} and the DaemonSet ${FENCE_NODE_DAEMONSET}. They stay, with the ` +
    "plugins that the DaemonSet wrote and the rule table on each node where it loaded. This converge applied no " +
    "Multus. `jr2 down --all` removes the DaemonSet and the table.",
];

/** A failed result line as a node failure. */
function failureOf(node: string, result: string): NodeFailure {
  const rest = result.slice("fail ".length);
  for (const what of ["folder", "write", "bridge", "link", "rules"] as const) {
    if (rest.startsWith(`${what} `)) return { node, what, text: rest.slice(what.length + 1) };
  }
  return { node, what: "folder", text: rest };
}

/** An event of the DaemonSet or of a pod, as the wait reads it. */
type EventObject = {
  metadata?: { name?: string };
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
};

/**
 * One event at one moment: its name, and the count and time that the API changes each time the
 * event comes again. An event whose print is in the set that the install read before its apply is
 * older than this converge.
 */
export const eventPrint = (e: EventObject): string =>
  [
    e.metadata?.name ?? "",
    e.count ?? "",
    e.lastTimestamp ?? "",
    e.eventTime ?? "",
    e.series?.count ?? "",
    e.series?.lastObservedTime ?? "",
  ].join("|");

/** The field selector of the DaemonSet's own events. */
const DAEMONSET_EVENTS = `involvedObject.kind=DaemonSet,involvedObject.name=${FENCE_NODE_DAEMONSET}`;

/**
 * Wait until each Sandbox node has a Ready pod of the DaemonSet jr2-fence-node: its init containers
 * loaded the rule table and put the plugins there or found them. Returns each node's result lines.
 * A pod whose init container failed, whose folder the kubelet could not mount in `CNI_WAIT_S`, or
 * that the cluster did not create, refuses.
 *
 * - `owner` reads the DaemonSet at each poll: only a pod that it owns (by its uid), of its template
 *   generation or a later one, counts. So a Ready pod of an earlier template, or of a DaemonSet that
 *   was made again (its generation starts again at 1), does not, and a converge whose template a
 *   later converge replaced accepts the pods of the later one. A read that fails throws.
 * - `seenEvents` holds the prints of the DaemonSet's events before the apply: such an event is
 *   older than this converge, and does not refuse.
 * - A `FailedMount` event of a pod counts only while no init container of that pod has started,
 *   and only after `CNI_WAIT_S`: once one has started, the kubelet mounted the folders, and the
 *   event is old.
 */
export async function awaitFenceNodes(
  kube: Pick<KubeAdmin, "listJson">,
  opts: {
    nodes: readonly string[];
    owner?: () => Promise<FenceNodeOwner>;
    seenEvents?: ReadonlySet<string>;
    context?: string;
    pollMs?: number;
    now?: () => number;
  },
): Promise<Map<string, string>> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const now = opts.now ?? Date.now;
  const started = now();
  const events = (fieldSelector: string) =>
    kube
      .listJson<EventObject>({ kind: "event", fieldSelector, namespace: OPERATOR_NAMESPACE, ...ctx })
      .catch(() => [] as EventObject[]);
  for (;;) {
    const owner = await opts.owner?.();
    const pods = await kube.listJson<FenceNodePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    const current = (p: FenceNodePod) => owner === undefined || ofOwner(p, owner);
    const results = new Map<string, string>();
    const failed: NodeFailure[] = [];
    const waiting: string[] = [];
    let unmade = false;
    for (const node of opts.nodes) {
      const mine = pods.filter(
        (p) => p.spec?.nodeName === node && p.metadata?.deletionTimestamp === undefined && current(p),
      );
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
      if (mine.length === 0) unmade = true;
      // A folder that the node does not have: the kubelet says so only in the pod's events. On a new
      // node, the primary CNI makes the folder after this pod can start, and the kubelet mounts it
      // then: it counts after the wait of `install` for the CNI folders.
      if (now() - started >= CNI_WAIT_S * 1000) {
        for (const p of mine.filter((q) => !initStarted(q))) {
          const mount = (await events(`involvedObject.name=${p.metadata?.name}`))
            .filter((e) => e.reason === "FailedMount")
            .pop();
          if (mount) {
            failed.push({
              node,
              what: "folder",
              text: `the kubelet cannot mount a CNI folder of the node after ${CNI_WAIT_S} s: ${(mount.message ?? "").slice(0, 300)}`,
            });
            waiting.pop();
            break;
          }
        }
      }
    }
    // No pod: the cluster can have refused to create it (Pod Security admission, a webhook). The
    // DaemonSet's controller says so only in the DaemonSet's events.
    if (unmade && now() - started >= MOUNT_GRACE_MS) {
      const create = (await events(DAEMONSET_EVENTS))
        .filter((e) => e.reason === "FailedCreate" && !(opts.seenEvents?.has(eventPrint(e)) ?? false))
        .pop();
      if (create) {
        for (const node of waiting.splice(0)) {
          if (!pods.some((p) => p.spec?.nodeName === node && current(p))) {
            failed.push({ node, what: "create", text: `no pod: ${(create.message ?? "").slice(0, 300)}` });
          } else waiting.push(node);
        }
      }
    }
    if (failed.length > 0) throw nodeRefusal(failed);
    if (waiting.length === 0) return results;
    if (now() - started >= FENCE_NODE_WAIT_MS) {
      throw new Error(
        [
          `fence: no Ready pod of the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} on the Sandbox ` +
            `node${waiting.length === 1 ? "" : "s"} ${waiting.join(", ")} in ${FENCE_NODE_WAIT_MS / 1000} s, so jr2 ` +
            `cannot see the rule table and the CNI plugins there (ADR-0084). See \`kubectl -n ${OPERATOR_NAMESPACE} ` +
            `describe pod -l app=${FENCE_NODE_DAEMONSET}\`.`,
          ...KEPT,
        ].join("\n"),
      );
    }
    await sleep(opts.pollMs ?? POLL_MS);
  }
}

/** The first CNI configuration that a node's pod of jr2-fence-node read (`cni=`), and its type (`type=`). */
export function firstCniOf(line: string): { file: string; type: string } | undefined {
  const file = /(?:^| )cni=(\S+)/.exec(line)?.[1];
  const type = /(?:^| )type=(\S+)/.exec(line)?.[1];
  if (file === undefined) return undefined;
  return { file, type: type ?? "unknown" };
}

// ---- the install -----------------------------------------------------------------------------------

/**
 * Install what the plan says, after the question. The DaemonSet first, so that a node that it
 * refuses (its CNI folders, its `bridge`) refuses before Multus changes the cluster's CNI
 * configuration; then jr2's Multus, when the plan has it. The DaemonSet is applied at each converge
 * whose Kit is not older than the one it runs, as the operator is: an apply that changes nothing
 * rolls nothing, and one that changes the image or the template (a newer Kit, or the removal form
 * that an interrupted `jr2 down --all` left) rolls each pod, which loads the table again. Each
 * read that it decides on throws when it fails. One quiet line when the plan installed nothing.
 */
export async function installFence(
  kube: Pick<KubeAdmin, "listJson" | "apply" | "waitRollout">,
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
  const deployed = (await readFenceNode(kube, ctx))?.metadata.labels?.[LABEL_VERSION];
  const newer = deployed !== undefined && compareVersions(deployed, KIT_VERSION) > 0;
  // Before the apply: the DaemonSet's events, so that the wait reads only what this converge made.
  const seenEvents = new Set(
    (
      await kube
        .listJson<EventObject>({
          kind: "event",
          fieldSelector: DAEMONSET_EVENTS,
          namespace: OPERATOR_NAMESPACE,
          ...ctx,
        })
        .catch(() => [] as EventObject[])
    ).map(eventPrint),
  );
  if (!newer) {
    if (plan.node === "install") {
      opts.log(`fence: applying the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} (${opts.image})`);
    }
    await kube.apply({ manifest: JSON.stringify(fenceNodeDaemonSet(opts.image)), ...ctx });
  }
  // The DaemonSet as it is at each poll: a Ready pod of an earlier template does not count.
  const results = await awaitFenceNodes(kube, {
    ...opts,
    owner: async () => ownerOf(await readFenceNode(kube, ctx)),
    seenEvents,
  });
  if (plan.node === "install") {
    for (const [node, line] of results) opts.log(`fence: ${node}: ${line}`);
  }
  if (plan.multus === "install" || plan.multus === "upgrade") {
    const text = await multusManifest();
    opts.log(`fence: applying Multus v4.3.2 (thick) to ${MULTUS_NAMESPACE}`);
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
      `fence: prerequisites in place — ${plan.multus === "foreign" ? "the cluster's" : "jr2's"} Multus, the ` +
        `admission policies, and the rule table and the CNI plugins on ${results.size} Sandbox ` +
        `node${results.size === 1 ? "" : "s"}`,
    );
  }
}

// ---- jr2 down --all --------------------------------------------------------------------------------

/** How long the removal form of the DaemonSet may take on each node. */
const REMOVE_WAIT_S = 120;
/** How a person removes the table and the bridge on a node, as root. */
const BY_HAND = `run \`nft delete table ${RULES_TABLE}\` as root, and \`ip link delete ${BRIDGE}\` when the bridge has no port`;

/**
 * After the removal form's rollout: a warning for each node whose pod kept the bridge (a port on it,
 * so a pod is still on the Fence there, or an error of `ip`). A read that fails warns too.
 */
async function warnKeptBridges(
  kube: Pick<KubeAdmin, "getJson" | "listJson">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  let pods: FenceNodePod[];
  let owner: FenceNodeOwner;
  try {
    owner = ownerOf(await readFenceNode(kube, ctx));
    pods = await kube.listJson<FenceNodePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
  } catch (err) {
    opts.log(
      `warning: jr2 cannot read the pods of ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} (${firstLine(err)}), so ` +
        `it cannot tell whether each node removed the bridge ${BRIDGE}; on a node that keeps it, ${BY_HAND}`,
    );
    return;
  }
  for (const pod of pods) {
    // The removal form's pods only: of this DaemonSet, of its template.
    if (!ofOwner(pod, owner)) continue;
    const node = pod.spec?.nodeName ?? pod.metadata?.name ?? "?";
    const removal = bridgeRemovalOf(fenceNodeResultsOf(pod).join(" "));
    if (removal?.bridge !== "kept") continue;
    const ports = removal.detail?.startsWith("ports=") ? removal.detail.slice("ports=".length) : undefined;
    opts.log(
      ports !== undefined
        ? `warning: the node ${node} keeps the bridge ${BRIDGE}, because it has the ports ${ports.split(",").join(", ")}: ` +
            `a pod is still on the Fence there. When that pod is gone, run \`ip link delete ${BRIDGE}\` as root on ` +
            "the node"
        : `warning: the node ${node} keeps the bridge ${BRIDGE} (${(removal.detail ?? "").replace(/^error=/, "")}); ` +
            `run \`ip link delete ${BRIDGE}\` as root on the node when the bridge has no port`,
    );
  }
}

/**
 * Remove what jr2 installed for the Fence on the cluster: the rule table and the bridge on each node,
 * the fence node's DaemonSet, the admission policies with their bindings, and the Multus that
 * carries jr2's annotation. A Multus that jr2 did not
 * install stays. The plugin files stay on the nodes: jr2 cannot tell them from files that another
 * tool put there. The kernel module `8021q` stays loaded: another user of the node can need it.
 *
 * The table and the bridge go by the DaemonSet itself: its removal form, applied with the image that
 * it runs, removes them in each pod's init container, and the DaemonSet goes when each pod is Ready.
 * No pod of jr2 is then left on a node with a capability. A node where no pod became Ready in time
 * (a node that is down) keeps both: the warning names the commands that remove them. A bridge with a
 * port stays, and a warning names its node and ports.
 *
 * jr2's Multus goes with the objects of its manifest, its CustomResourceDefinition too, which deletes
 * each NetworkAttachmentDefinition of the cluster. So when the cluster has a NetworkAttachmentDefinition
 * (the Instance's namespace is gone by now, so it is not jr2's), or jr2 cannot list them, jr2's Multus
 * and the definition stay, and a warning names them and the commands that remove them. A read that
 * fails never skips a removal in silence: it warns.
 */
export async function uninstallFence(
  kube: Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout" | "deleteObject" | "deleteManifest">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  let existing: DaemonSetObject | undefined;
  try {
    [existing] = await kube.listJson<DaemonSetObject>({
      kind: "daemonset",
      fieldSelector: `metadata.name=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
  } catch (err) {
    opts.log(
      `warning: jr2 cannot read the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} (${firstLine(err)}), ` +
        `so it did not remove the rule table "${RULES_TABLE}" and the bridge ${BRIDGE} from the nodes. On each ` +
        `node that keeps them, ${BY_HAND}; then delete the DaemonSet ` +
        `(kubectl -n ${OPERATOR_NAMESPACE} delete daemonset ${FENCE_NODE_DAEMONSET})`,
    );
  }
  if (existing) {
    const image = existing.spec?.template?.spec?.containers?.[0]?.image;
    if (image !== undefined) {
      opts.log(`removing the rule table "${RULES_TABLE}" and the bridge ${BRIDGE} from each node`);
      await kube.apply({ manifest: JSON.stringify(fenceNodeDaemonSet(image, { remove: true })), ...ctx });
      let done = false;
      try {
        await kube.waitRollout({
          kind: "daemonset",
          name: FENCE_NODE_DAEMONSET,
          namespace: OPERATOR_NAMESPACE,
          timeoutSeconds: REMOVE_WAIT_S,
          ...ctx,
        });
        done = true;
      } catch (err) {
        opts.log(
          `warning: the rule table "${RULES_TABLE}" and the bridge ${BRIDGE} were not removed from each node in ` +
            `${REMOVE_WAIT_S} s (${firstLine(err)}); on a node that keeps them, ${BY_HAND}`,
        );
      }
      if (done) await warnKeptBridges(kube, { ...ctx, log: opts.log });
    } else {
      opts.log(
        `warning: the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} names no image, so jr2 did not ` +
          `remove the rule table "${RULES_TABLE}" and the bridge ${BRIDGE} from the nodes; on each node that ` +
          `keeps them, ${BY_HAND}`,
      );
    }
    opts.log(
      `uninstalling the DaemonSet ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET}; the CNI plugins ` +
        `${PLUGINS.join(", ")} stay in ${CNI_BIN_DIR} on each node`,
    );
    await kube.deleteObject({ kind: "daemonset", name: FENCE_NODE_DAEMONSET, namespace: OPERATOR_NAMESPACE, ...ctx });
  }
  // The Instance's namespace is gone, and `jr2 down --all` refuses while another Instance holds a
  // range, so no attachment of the Fence is left for the policies to guard.
  await removeFenceGuard(kube, { ...ctx, log: opts.log });
  let multus: DaemonSetObject | undefined;
  try {
    [multus] = await kube.listJson<DaemonSetObject>({
      kind: "daemonset",
      fieldSelector: `metadata.name=${MULTUS_DAEMONSET}`,
      namespace: MULTUS_NAMESPACE,
      ...ctx,
    });
  } catch (err) {
    opts.log(
      `warning: jr2 cannot read the DaemonSet ${MULTUS_NAMESPACE}/${MULTUS_DAEMONSET} (${firstLine(err)}), so it ` +
        `did not remove a Multus that it installed. To remove it: ${MULTUS_OBJECTS}`,
    );
    return;
  }
  if (multus?.metadata.annotations?.[MULTUS_ANNOTATION] === undefined) return;
  let others: Array<{ metadata: { name: string; namespace?: string } }>;
  try {
    others = await kube.listJson({ kind: ATTACHMENT_CRD, allNamespaces: true, ...ctx });
  } catch (err) {
    if (!isMissingResourceType(err)) {
      opts.log(
        `warning: jr2 cannot list the NetworkAttachmentDefinitions of the cluster (${firstLine(err)}), so it keeps ` +
          "the Multus that it installed and its CustomResourceDefinition: their removal deletes each " +
          `NetworkAttachmentDefinition. To remove them: ${MULTUS_OBJECTS}`,
      );
      return;
    }
    others = [];
  }
  if (others.length > 0) {
    const names = others.map((o) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`);
    opts.log(
      `warning: the cluster has NetworkAttachmentDefinitions that are not jr2's (${names.slice(0, 10).join(", ")}` +
        `${names.length > 10 ? `, and ${names.length - 10} more` : ""}), so jr2 keeps the Multus that it installed ` +
        "and its CustomResourceDefinition: their removal deletes each NetworkAttachmentDefinition. When nothing " +
        `uses them, remove them: ${MULTUS_OBJECTS}`,
    );
    return;
  }
  opts.log(
    `uninstalling Multus (${MULTUS_NAMESPACE}), which jr2 installed, and its CustomResourceDefinition ${ATTACHMENT_CRD}`,
  );
  await kube.deleteManifest({ manifest: await multusManifest(), ...ctx });
}
