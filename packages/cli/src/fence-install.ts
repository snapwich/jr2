// The node prerequisites of the Fence (ADR-0084, ADR-0019), which `jr2 up` installs on any cluster
// with kubectl alone, after it asks:
//
//   Multus     the second network of a pod, with `namespaceIsolation` and no global namespace, so a
//              pod can name an attachment of its own namespace only. When the cluster has no Multus,
//              `jr2 up` applies the thick manifest that the CLI ships (`manifests/fence/`). Its
//              DaemonSet has the annotation `jr2.dev/multus`, so jr2 knows that it installed it.
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
//                       file. It reports the node's first CNI configuration (and, for a Multus
//                       configuration of the thin form, its isolation settings), so that `jr2 up`
//                       sees a Multus that the API does not show, and what the node really uses.
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
// A Multus is a DaemonSet whose container runs the thick `multus-daemon`, the thin `/thin_entrypoint`
// or the v3 `/entrypoint.sh` of a multus-cni image, or that runs a multus-cni image at all (then jr2
// cannot tell its form, and refuses). An add-on (a dynamic-networks controller, a DHCP daemon) is
// not a Multus, whatever its name. jr2 reads each form's settings from the place that the form uses
// (`multusSettings`), and accepts only what it positively reads.
//
// `jr2 up` does not install when it cannot do so safely. Before it applies anything, it refuses when:
//   (a) a Multus that jr2 did not install has other settings (no `namespaceIsolation`, or a global
//       namespace), or jr2 cannot tell them. jr2 never changes a Multus that it did not install;
//   (b) Cilium has `cni-exclusive: "true"` for a Sandbox node, because then it removes each other
//       CNI configuration of the node;
//   (c) a Multus that jr2 did not install mounts a CNI directory other than /opt/cni/bin or
//       /etc/cni/net.d;
//   (d) the cluster has Multus's CustomResourceDefinition, and jr2 finds no Multus DaemonSet.
// After it applied the namespace jr2-system and the DaemonSet, and before it applies Multus, a
// Sandbox node refuses when its pod of jr2-fence-node finds no CNI configuration or plugins in the
// default folders, a `bridge` older than v1.8.0, with no version or behind a link that it cannot
// run, a folder that it cannot write, a first CNI configuration of a Multus that the API does not
// show (when jr2 is to install its own), a first CNI configuration of a thin Multus with no
// isolation or with a global namespace, or a rule table that does not load. Those parts stay;
// `jr2 down --all` removes them.
//
// In two steps: `planFenceInstall` reads and changes nothing (before the first-time question), and
// `installFence` applies (after the operator image exists, before the Custodian needs the Fence).

import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, KIT_VERSION, LABEL_VERSION, OPERATOR_NAMESPACE } from "./deploy.ts";
import { FENCE_BRIDGE } from "./fence.ts";
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
/** The annotation of the Multus DaemonSet that jr2 installed: the version of the shipped manifest. */
export const MULTUS_ANNOTATION = "jr2.dev/multus";
/** Its value in the shipped manifest. Change both when the manifest changes. */
export const MULTUS_VERSION = "v4.3.2-thick-namespace-isolation-1";
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
/** How long the read waits for a Multus DaemonSet when the cluster has Multus's definition and no
 * DaemonSet: another converge can be in the middle of the apply of the same manifest. */
const MULTUS_SETTLE_MS = 10_000;
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
  /** `create`: the cluster has no namespace jr2-system, and the install makes it. */
  system: "create" | "present";
  /** Where the pods of each Multus are: the namespace and the label selector of its DaemonSet. */
  multusPods: Array<{ namespace: string; selector: string }>;
  /** Lines for the person: a check that jr2 could not make, and why. */
  notes: string[];
};

/** The plan asks: it installs something on the cluster that the cluster does not have. */
export const planAsks = (plan: FenceInstallPlan): boolean =>
  plan.multus === "install" || plan.multus === "upgrade" || plan.node === "install";

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
  const ownMultus = plan.multus !== "foreign";
  if (plan.multus === "install") {
    said.push(
      "  - Multus v4.3.2 (thick, namespaceIsolation, no global namespace), from the manifest that the CLI ships: " +
        `${MULTUS_PARTS}.`,
    );
  }
  if (plan.multus === "upgrade") {
    said.push(
      `  - an update of the Multus that jr2 installed to ${MULTUS_VERSION}, from the manifest that the CLI ships: ` +
        `${MULTUS_PARTS}.`,
    );
  }
  said.push(
    `  A later jr2 up of a newer Kit changes the DaemonSet ${FENCE_NODE_DAEMONSET} to its version, and does not ` +
      "ask. " +
      (ownMultus
        ? "It asks before it changes the Multus that jr2 installs."
        : "It never changes the cluster's Multus, which jr2 did not install."),
    ownMultus
      ? `  jr2 down --all removes the rule table, the bridge ${BRIDGE} that the bridge plugin makes, the DaemonSet ` +
          "and the Multus that jr2 installs. It keeps that Multus while the cluster has a " +
          "NetworkAttachmentDefinition of another owner. The plugin files and the kernel module 8021q stay on the nodes."
      : `  jr2 down --all removes the rule table, the bridge ${BRIDGE} that the bridge plugin makes, and the ` +
          "DaemonSet. The plugin files and the kernel module 8021q stay on the nodes.",
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

type Volume = {
  name?: string;
  hostPath?: { path?: string };
  configMap?: { name?: string; items?: Array<{ key?: string; path?: string }> };
};
type Container = {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  volumeMounts?: Array<{ name?: string; mountPath?: string; subPath?: string }>;
};
export type DaemonSetObject = KubeObject & {
  metadata: { namespace?: string };
  spec?: {
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: Container[]; initContainers?: Container[]; volumes?: Volume[] };
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

/**
 * The form of a Multus, by the command of its container: the thick `multus-daemon`, the thin
 * `/thin_entrypoint` (v4), or the script `/entrypoint.sh` of a multus-cni image (v3). Each reads its
 * settings from another place (`multusSettings`).
 */
export type MultusForm = "thick" | "thin" | "v3";

/** The settings of a Multus that jr2 did not install: where they are, and what they say. */
export type MultusSettings = {
  form: MultusForm;
  namespaceIsolation: boolean;
  globalNamespaces: string;
  /** Where the settings are, in words that say where to change them. */
  source: string;
  /** What to set there for namespaceIsolation. */
  setIsolation: string;
  /** What to set there for no global namespace. */
  setGlobal: string;
};

/** The settings of a Multus that jr2 cannot read: a ConfigMap that is missing or that the API refuses
 * (`unread`), or a form or a place that jr2 does not know (`cannotTell`, with what jr2 saw). */
export type MultusUnread = { unread: string; why: "missing" | "forbidden"; reason?: string } | { cannotTell: string };

/** The repository of an image: its name with no tag and no digest. */
function repositoryOf(image: string): string {
  const name = image.split("@")[0]!;
  const colon = name.lastIndexOf(":");
  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
}

/**
 * A Multus CNI image: the last part of its repository is `multus-cni`, ends in `-multus-cni` (RKE2's
 * `hardened-multus-cni`), or is `multus` (v3's `nfvpe/multus`). An add-on's image
 * (`multus-dynamic-networks-controller`, `hardened-multus-dynamic-networks-controller`) is not.
 */
export function isMultusImage(image: string): boolean {
  return /^(multus|(.+-)?multus-cni)$/.test(repositoryOf(image).split("/").pop() ?? "");
}

const basename = (path: string): string => path.split("/").pop() ?? path;

/** The form of one container, by its command; `image` for a multus-cni image whose command jr2 does
 * not know; undefined for a container that is not a Multus. */
function containerForm(c: Container): MultusForm | "image" | undefined {
  const exe = c.command?.[0];
  if (exe !== undefined) {
    if (basename(exe) === "multus-daemon") return "thick";
    if (basename(exe) === "thin_entrypoint") return "thin";
    if (exe === "/entrypoint.sh" && isMultusImage(c.image ?? "")) return "v3";
  }
  return isMultusImage(c.image ?? "") ? "image" : undefined;
}

/**
 * A Multus DaemonSet, of jr2 or of another owner: jr2's annotation, or a container that runs the
 * thick `multus-daemon`, the thin `/thin_entrypoint`, or a multus-cni image (the v3
 * `/entrypoint.sh`, or a command that jr2 does not know). A name or a label does not count, so an
 * add-on (RKE2's `rke2-multus-dnc` or `rke2-multus-dhcp`, the upstream
 * `multus-dynamic-networks-controller`) is not a Multus.
 */
export function isMultusDaemonSet(ds: DaemonSetObject): boolean {
  if (ds.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined) return true;
  return (ds.spec?.template?.spec?.containers ?? []).some((c) => containerForm(c) !== undefined);
}

/** A container's command line, as words: the command and then the arguments. */
const commandOf = (c: Container): string[] => [...(c.command ?? []), ...(c.args ?? [])];
const shown = (c: Container): string => commandOf(c).join(" ") || "(the image's own entrypoint)";

/** The Multus container of a DaemonSet and its form, or what jr2 cannot tell. */
function multusContainer(ds: DaemonSetObject): { form: MultusForm; container: Container } | { cannotTell: string } {
  const found = (ds.spec?.template?.spec?.containers ?? [])
    .map((container) => ({ container, form: containerForm(container) }))
    .filter((x) => x.form !== undefined);
  if (found.length !== 1) {
    return {
      cannotTell: `it has ${found.length} containers of Multus (${found.map((x) => x.container.name).join(", ")})`,
    };
  }
  const [{ container, form }] = found as [{ container: Container; form: MultusForm | "image" }];
  if (form === "image") {
    return {
      cannotTell:
        `its container ${container.name ?? "?"} runs the image ${container.image ?? "?"} with the command ` +
        `"${shown(container)}", which is not the thick multus-daemon, the thin /thin_entrypoint or the v3 /entrypoint.sh`,
    };
  }
  return { form, container };
}

/** pflag's true and false values (Go's strconv.ParseBool). */
const PFLAG_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const PFLAG_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False"]);

/**
 * The flags of the thin `/thin_entrypoint`, as its parser (pflag) reads the words after the
 * command: each value of `--namespace-isolation` (bool: bare is `true`, a value only after `=`),
 * `--global-namespaces` and `--multus-conf-file` (string: `=value` or the next word), in order. The
 * words after `--` are not flags. A flag that jr2 does not know, with no `=`, can take the next word
 * as its value; when that next word is one of the three flags, jr2 cannot tell.
 */
export function thinFlags(words: readonly string[]): { values: Map<string, string[]> } | { cannotTell: string } {
  const bools = new Set(["--namespace-isolation"]);
  const strings = new Set(["--global-namespaces", "--multus-conf-file"]);
  const ours = (w: string | undefined) =>
    w !== undefined && [...bools, ...strings].some((f) => w === f || w.startsWith(`${f}=`));
  const values = new Map<string, string[]>();
  const add = (flag: string, value: string) => values.set(flag, [...(values.get(flag) ?? []), value]);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") break;
    if (!w.startsWith("-")) continue;
    const eq = w.indexOf("=");
    const flag = eq >= 0 ? w.slice(0, eq) : w;
    if (bools.has(flag)) add(flag, eq >= 0 ? w.slice(eq + 1) : "true");
    else if (strings.has(flag)) {
      if (eq >= 0) add(flag, w.slice(eq + 1));
      else if (i + 1 < words.length) add(flag, words[++i]!);
      else return { cannotTell: `the flag ${w} is the last word and has no value` };
    } else if (eq < 0 && ours(words[i + 1])) {
      return { cannotTell: `the flag ${w} can take the next word, ${words[i + 1]}, as its value` };
    }
  }
  return { values };
}

/**
 * The flag `-config` of the thick `multus-daemon`, as Go's flag parser reads the words after the
 * command: `-config` or `--config`, with `=value` or the next word; the last one counts; the first
 * word that is not a flag, or `--`, ends the flags. A flag that jr2 does not know, with no `=` and a
 * next word, can take that word as its value: then jr2 cannot tell.
 */
export function thickConfigFlag(words: readonly string[]): { config?: string } | { cannotTell: string } {
  let config: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--" || !w.startsWith("-") || w === "-") break;
    const body = w.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (name === "config") {
      if (eq >= 0) config = body.slice(eq + 1);
      else if (i + 1 < words.length) config = words[++i]!;
      else return { cannotTell: `the flag ${w} is the last word and has no value` };
    } else if (eq < 0 && i + 1 < words.length) {
      return { cannotTell: `the flag ${w} can take the next word, ${words[i + 1]}, as its value` };
    }
  }
  return config !== undefined ? { config } : {};
}

/** The path of the thick daemon's configuration when it has no `-config`. */
export const MULTUS_DAEMON_CONFIG = "/etc/cni/net.d/multus.d/daemon-config.json";

/**
 * The ConfigMap and its key that a container sees at a file path: the volume mount whose folder holds
 * the path (the longest), a ConfigMap volume, and its key at that place (by `items`, or by name).
 * Any other volume, or no volume (a file of the image), and jr2 cannot tell.
 */
export function mountedConfigMapKey(
  ds: DaemonSetObject,
  container: Container,
  path: string,
): { configMap: string; key: string } | { cannotTell: string } {
  const under = (m: { mountPath?: string }) => {
    const at = (m.mountPath ?? "").replace(/\/+$/, "");
    return at !== "" && (path === at || path.startsWith(`${at}/`));
  };
  const mount = (container.volumeMounts ?? [])
    .filter(under)
    .sort((a, b) => (b.mountPath ?? "").length - (a.mountPath ?? "").length)[0];
  if (mount === undefined) {
    return { cannotTell: `no volume of the container ${container.name ?? "?"} is mounted at ${path}` };
  }
  const volume = ds.spec?.template?.spec?.volumes?.find((v) => v.name === mount.name);
  const name = volume?.configMap?.name;
  if (name === undefined) {
    return { cannotTell: `${path} is on the volume ${mount.name ?? "?"}, which is not a ConfigMap` };
  }
  const rest = path.slice((mount.mountPath ?? "").replace(/\/+$/, "").length).replace(/^\/+/, "");
  const inVolume = [mount.subPath ?? "", rest].filter((p) => p !== "").join("/");
  const items = volume!.configMap!.items;
  const key = items !== undefined ? items.find((it) => it.path === inVolume)?.key : inVolume;
  if (key === undefined || key === "" || key.includes("/")) {
    return { cannotTell: `the ConfigMap volume ${mount.name ?? "?"} (${name}) has no key at ${path}` };
  }
  return { configMap: name, key };
}

/**
 * The settings of a Multus DaemonSet that jr2 did not install, read from the place that its form
 * uses:
 *
 * - thick (`multus-daemon`): the daemon's configuration file (`-config`, by default
 *   `MULTUS_DAEMON_CONFIG`), which is a key of a ConfigMap that the container mounts there.
 * - thin (`/thin_entrypoint`): `--multus-conf-file`, as pflag reads it. For `auto` (the default),
 *   the settings are the flags `--namespace-isolation` and `--global-namespaces`, as pflag reads
 *   them. For a path, they are in the Multus configuration that is the ConfigMap key mounted at that
 *   path.
 * - v3 (`/entrypoint.sh`): the same, but the script reads only `--flag=value`, and isolation is on
 *   only for the exact text `--namespace-isolation=true`.
 *
 * A key that is not set has Multus's default: no isolation, no global namespace. Anything that jr2
 * does not recognise is `cannotTell`, with what it saw: it never accepts on a generous parse.
 */
export async function multusSettings(
  kube: Pick<KubeAdmin, "listJson">,
  ds: DaemonSetObject,
  context?: string,
): Promise<MultusSettings | MultusUnread> {
  const ns = ds.metadata.namespace ?? MULTUS_NAMESPACE;
  const which = multusContainer(ds);
  if ("cannotTell" in which) return which;
  const { form, container } = which;
  const after = commandOf(container).slice(container.command?.length ? 1 : 0);
  const inArgs = `the arguments of the container ${container.name ?? "?"} of the DaemonSet ${ns}/${ds.metadata.name}`;

  /** The settings in a JSON file that is a ConfigMap key: the daemon's configuration, or a Multus
   * CNI configuration (`type: "multus"`). */
  const fromFile = async (path: string, what: string): Promise<MultusSettings | MultusUnread> => {
    const at = mountedConfigMapKey(ds, container, path);
    if ("cannotTell" in at) return { cannotTell: `the ${what} ${path}: ${at.cannotTell}` };
    const cm = await readConfigMap(kube, {
      namespace: ns,
      name: at.configMap,
      ...(context !== undefined ? { context } : {}),
    });
    if (cm === "missing") return { unread: `${ns}/${at.configMap}`, why: "missing" };
    if ("forbidden" in cm) return { unread: `${ns}/${at.configMap}`, why: "forbidden", reason: cm.forbidden };
    const where = `${at.key} of the ConfigMap ${ns}/${at.configMap}`;
    const text = cm.data?.[at.key];
    if (text === undefined) return { cannotTell: `the ${what} ${path} is ${where}, which does not exist` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { cannotTell: `the ${what} ${path} is ${where}, which is not JSON` };
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { cannotTell: `the ${what} ${path} is ${where}, which is not a JSON object` };
    }
    const o = json as Record<string, unknown>;
    if (form !== "thick" && o.type !== "multus") {
      return { cannotTell: `the ${what} ${path} is ${where}, whose type is not "multus"` };
    }
    if (o.namespaceIsolation !== undefined && typeof o.namespaceIsolation !== "boolean") {
      return { cannotTell: `"namespaceIsolation" in ${where} is not true or false` };
    }
    if (o.globalNamespaces !== undefined && typeof o.globalNamespaces !== "string") {
      return { cannotTell: `"globalNamespaces" in ${where} is not a string` };
    }
    return {
      form,
      namespaceIsolation: o.namespaceIsolation === true,
      globalNamespaces: ((o.globalNamespaces as string | undefined) ?? "").trim(),
      source: where,
      setIsolation: `set "namespaceIsolation": true in ${where}`,
      setGlobal: `set "globalNamespaces": "" in ${where}`,
    };
  };

  if (form === "thick") {
    const flag = thickConfigFlag(after);
    if ("cannotTell" in flag) return { cannotTell: `in ${inArgs}, ${flag.cannotTell}` };
    return fromFile(flag.config ?? MULTUS_DAEMON_CONFIG, "configuration file of multus-daemon");
  }
  if (form === "thin") {
    const flags = thinFlags(after);
    if ("cannotTell" in flags) return { cannotTell: `in ${inArgs}, ${flags.cannotTell}` };
    const last = (flag: string) => flags.values.get(flag)?.at(-1);
    const conf = last("--multus-conf-file") ?? "auto";
    if (conf !== "auto") {
      if (!conf.startsWith("/")) return { cannotTell: `--multus-conf-file=${conf} in ${inArgs} is not auto or a path` };
      return fromFile(conf, "Multus configuration (--multus-conf-file)");
    }
    const isolation = last("--namespace-isolation");
    if (isolation !== undefined && !PFLAG_TRUE.has(isolation) && !PFLAG_FALSE.has(isolation)) {
      return {
        cannotTell: `--namespace-isolation=${isolation} in ${inArgs} is not a value that pflag reads as true or false`,
      };
    }
    return {
      form,
      namespaceIsolation: isolation !== undefined && PFLAG_TRUE.has(isolation),
      globalNamespaces: (last("--global-namespaces") ?? "").trim(),
      source: inArgs,
      setIsolation: `set --namespace-isolation=true in ${inArgs}`,
      setGlobal: `remove --global-namespaces from ${inArgs}`,
    };
  }
  // v3: the script reads each word `--flag=value` alone, and the last one counts.
  const last = (flag: string) =>
    after
      .filter((w) => w.startsWith(`${flag}=`))
      .map((w) => w.slice(flag.length + 1))
      .at(-1);
  const conf = last("--multus-conf-file") ?? "auto";
  if (conf !== "auto") {
    if (!conf.startsWith("/")) return { cannotTell: `--multus-conf-file=${conf} in ${inArgs} is not auto or a path` };
    return fromFile(conf, "Multus configuration (--multus-conf-file)");
  }
  return {
    form,
    namespaceIsolation: last("--namespace-isolation") === "true",
    // The script removes each space of the value.
    globalNamespaces: (last("--global-namespaces") ?? "").replaceAll(" ", ""),
    source: inArgs,
    setIsolation:
      `set --namespace-isolation=true in ${inArgs} (that exact text: the script /entrypoint.sh compares the ` +
      'value with "true")',
    setGlobal: `remove --global-namespaces from ${inArgs}`,
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

/** The label selector of a DaemonSet's pods, as `kubectl -l` takes it. */
export function podSelectorOf(ds: DaemonSetObject): string {
  const labels = ds.spec?.selector?.matchLabels ?? ds.spec?.template?.metadata?.labels ?? {};
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** What jr2 reads for each form, as a refusal says it. */
const MULTUS_FORMS =
  "jr2 reads the settings of the thick multus-daemon from its configuration file, of the thin " +
  "/thin_entrypoint from its flags (--multus-conf-file=auto) or from the file that --multus-conf-file names, " +
  "and of the v3 /entrypoint.sh of a multus-cni image in the same way; a file must be a key of a ConfigMap " +
  "that the container mounts.";

/** Refusals (a) and (c) for one Multus DaemonSet that jr2 did not install. `refuse` makes the error:
 * before anything is applied, or after the DaemonSet jr2-fence-node. Returns the settings. */
async function checkForeignMultus(
  kube: Kube,
  ds: DaemonSetObject,
  refuse: (text: string) => Error,
  context?: string,
): Promise<MultusSettings> {
  const name = `${ds.metadata.namespace ?? ""}/${ds.metadata.name}`;
  const settings = await multusSettings(kube, ds, context);
  if ("cannotTell" in settings) {
    throw refuse(
      `the cluster has a Multus that jr2 did not install (DaemonSet ${name}), and jr2 cannot tell its settings: ` +
        `${settings.cannotTell}. ${MULTUS_FORMS} jr2 never changes a Multus that it did not install, and it does ` +
        "not accept one whose isolation it cannot see (namespaceIsolation, ADR-0084). Run that Multus in one of " +
        "those forms, with namespaceIsolation and no global namespace, then run `jr2 up` again.",
    );
  }
  if ("unread" in settings) {
    throw refuse(
      settings.why === "forbidden"
        ? `the cluster has a Multus that jr2 did not install (DaemonSet ${name}), and the API refused the read ` +
            `of the ConfigMap ${settings.unread} that holds its settings (${settings.reason}), so jr2 cannot see ` +
            "that a pod can name an attachment of its own namespace only (namespaceIsolation, ADR-0084). Give the " +
            "user of this context read access to that ConfigMap, then run `jr2 up` again."
        : `the cluster has a Multus that jr2 did not install (DaemonSet ${name}), and the ConfigMap ` +
            `${settings.unread} that its pods mount, and that holds its settings, does not exist, so jr2 cannot ` +
            "see that a pod can name an attachment of its own namespace only (namespaceIsolation, ADR-0084). " +
            "Make the cluster's Multus whole (its ConfigMap, or its DaemonSet without that volume), then run " +
            "`jr2 up` again.",
    );
  }
  const fix = (what: string) =>
    `jr2 never changes a Multus that it did not install. ${what}, restart the DaemonSet ` +
    `(kubectl -n ${ds.metadata.namespace} rollout restart daemonset/${ds.metadata.name}), then run \`jr2 up\` again.`;
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (!settings.namespaceIsolation) {
    throw refuse(
      `the cluster's Multus (DaemonSet ${name}, which jr2 did not install) does not have namespaceIsolation in ` +
        `${settings.source}, so a pod of another namespace can name an attachment of the Instance and join its ` +
        `VLANs (ADR-0084). ${fix(capital(settings.setIsolation))}`,
    );
  }
  if (settings.globalNamespaces !== "") {
    throw refuse(
      `the cluster's Multus (DaemonSet ${name}, which jr2 did not install) has the global namespaces ` +
        `"${settings.globalNamespaces}" in ${settings.source}, so a pod of each namespace can name an attachment ` +
        `of those namespaces (ADR-0084). ${fix(capital(settings.setGlobal))}`,
    );
  }
  const dirs = multusHostDirs(ds);
  for (const [dir, want, what] of [
    [dirs.bin, CNI_BIN_DIR, "CNI bin directory"],
    [dirs.conf, CNI_CONF_DIR, "CNI configuration directory"],
  ] as const) {
    if (dir !== undefined && dir !== want) {
      throw refuse(
        `the cluster's Multus (DaemonSet ${name}) mounts the node's ${what} from ${dir}, not ${want}. jr2 puts ` +
          `the CNI plugins ${PLUGINS.join(", ")} into ${CNI_BIN_DIR}, and its Fence needs nodes whose container ` +
          `runtime reads ${CNI_BIN_DIR} and ${CNI_CONF_DIR} (ADR-0084). Keep such nodes out of the Sandbox nodes ` +
          "with sandbox.nodeSelector or a taint (ADR-0052), or use a cluster whose nodes use those directories.",
      );
    }
  }
  return settings;
}

/** The words of refusal (d), and of the node's refusal for a Multus that the API does not show. */
const MULTUS_SEARCH =
  "jr2 looked in each namespace for a DaemonSet whose container runs the thick multus-daemon, the thin " +
  "/thin_entrypoint, or a multus-cni image.";

/** What the cluster's Multus DaemonSets give the plan: jr2's, another owner's (each checked), or none. */
async function readMultus(
  kube: Kube,
  daemonSets: readonly DaemonSetObject[],
  refuse: (text: string) => Error,
  context?: string,
): Promise<Pick<FenceInstallPlan, "multus" | "multusPods">> {
  const multuses = daemonSets.filter(isMultusDaemonSet);
  const ours = multuses.filter((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] !== undefined);
  const foreign = multuses.filter((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] === undefined);
  for (const ds of foreign) await checkForeignMultus(kube, ds, refuse, context);
  const multus: FenceInstallPlan["multus"] =
    foreign.length > 0
      ? "foreign"
      : ours.length === 0
        ? "install"
        : ours.every((d) => d.metadata.annotations?.[MULTUS_ANNOTATION] === MULTUS_VERSION)
          ? "jr2"
          : "upgrade";
  const multusPods =
    multus === "install"
      ? [{ namespace: MULTUS_NAMESPACE, selector: MULTUS_SELECTOR }]
      : multuses.map((d) => ({
          namespace: d.metadata.namespace ?? MULTUS_NAMESPACE,
          selector: podSelectorOf(d) || MULTUS_SELECTOR,
        }));
  return { multus, multusPods };
}

/** Read what the cluster has, and refuse (a), (b), (c) or (d). Changes nothing. */
export async function planFenceInstall(
  kube: Kube,
  opts: { nodes: readonly NodeLike[]; context?: string; settleMs?: number; pollMs?: number },
): Promise<FenceInstallPlan> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const listDaemonSets = () => kube.listJson<DaemonSetObject>({ kind: "daemonset", allNamespaces: true, ...ctx });
  let daemonSets = await listDaemonSets();
  const notes = await checkCilium(kube, { nodes: opts.nodes, daemonSets, ...ctx });
  if (!daemonSets.some(isMultusDaemonSet)) {
    const crd = await kube.listJson({
      kind: "customresourcedefinition",
      fieldSelector: `metadata.name=${ATTACHMENT_CRD}`,
      ...ctx,
    });
    if (crd.length > 0) {
      // Another converge can be between the definition and the DaemonSet of the same apply.
      const settle = opts.settleMs ?? MULTUS_SETTLE_MS;
      for (let waited = 0; !daemonSets.some(isMultusDaemonSet) && waited < settle; waited += opts.pollMs ?? POLL_MS) {
        await sleep(opts.pollMs ?? POLL_MS);
        daemonSets = await listDaemonSets();
      }
      if (!daemonSets.some(isMultusDaemonSet)) {
        throw refused(
          `the cluster has the CustomResourceDefinition ${ATTACHMENT_CRD}, which Multus uses, but jr2 found no ` +
            `Multus DaemonSet. ${MULTUS_SEARCH} A second Multus beside the cluster's own can lose the isolation of ` +
            "the attachments (ADR-0084). If the cluster has a Multus in another form, jr2 cannot use it: run it in " +
            "one of those forms. If the definition stays from a Multus that is gone and no " +
            `NetworkAttachmentDefinition uses it, delete it (kubectl delete crd ${ATTACHMENT_CRD}). Then run ` +
            "`jr2 up` again.",
        );
      }
    }
  }
  const { multus, multusPods } = await readMultus(kube, daemonSets, refused, opts.context);
  const node = daemonSets.find(
    (d) => d.metadata.name === FENCE_NODE_DAEMONSET && d.metadata.namespace === OPERATOR_NAMESPACE,
  );
  const system = await kube.getJson({ kind: "namespace", name: OPERATOR_NAMESPACE, ...ctx });
  return {
    multus,
    node: node === undefined ? "install" : "present",
    system: system === undefined ? "create" : "present",
    multusPods,
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
 *    configuration and its type, so that `jr2 up` sees a Multus that is on the node but not in the
 *    API. For a Multus configuration of the thin form (`type: "multus"`), which holds the settings
 *    that the node uses, it also writes `isolation=` (`true`, `false` or `unknown`) and `globals=`
 *    (the global namespaces with no space, or `?` when it cannot read them). It reads only what is
 *    plain: a key that is in the file more than once, or whose value is not plain JSON on its line,
 *    is `unknown` or `?`.
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
file="$CONF/$first"
if grep -q '"type"[[:space:]]*:[[:space:]]*"multus"' "$file" 2>/dev/null; then type=multus
elif grep -q '"type"[[:space:]]*:[[:space:]]*"multus-shim"' "$file" 2>/dev/null; then type=multus-shim
else type=$(grep -o '"type"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" 2>/dev/null | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/') || true
fi
extra=""
if [ "$type" = multus ]; then
  keys=$(( $(grep -o '"namespaceIsolation"' "$file" | wc -l) ))
  values=$(grep -o '"namespaceIsolation"[[:space:]]*:[[:space:]]*[a-z]*' "$file" | sed 's/.*:[[:space:]]*//' | tr '\\n' ' ')
  case "$keys/$values" in
    0/) isolation=false ;;
    "1/true ") isolation=true ;;
    "1/false ") isolation=false ;;
    *) isolation=unknown ;;
  esac
  keys=$(( $(grep -o '"globalNamespaces"' "$file" | wc -l) ))
  values=$(grep -o '"globalNamespaces"[[:space:]]*:[[:space:]]*"[^"\\]*"' "$file" || true)
  if [ "$keys" = 0 ]; then globals=""
  elif [ "$keys" = 1 ] && [ -n "$values" ]; then globals=$(echo "$values" | sed 's/^.*:[[:space:]]*"//; s/"$//' | tr -d ' \\t')
  else globals="?"
  fi
  extra=" isolation=$isolation globals=$globals"
fi
say "ok wrote=\${wrote# } kept=\${kept# } bridge=v$version cni=$first type=\${type:-unknown}$extra"
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
  metadata?: { name?: string; deletionTimestamp?: string; labels?: Record<string, string> };
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

/** The DaemonSet's template generation (its annotation), which each of its pods carries as a label. */
const TEMPLATE_GENERATION_ANNOTATION = "deprecated.daemonset.template.generation";
const TEMPLATE_GENERATION_LABEL = "pod-template-generation";

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

/** A refusal after the apply of the DaemonSet: the text, what stays, and where to read more. */
const refusedAfterApply = (text: string): Error =>
  new Error([`fence: ${text}`, ...KEPT, `See ${FENCE_PREREQUISITES_URL}.`].join("\n"));

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
 * - `generation` reads the DaemonSet's template generation at each poll: only a pod of that
 *   generation or a later one counts, so a Ready pod of an earlier template does not, and a converge
 *   whose template a later converge replaced accepts the pods of the later one.
 * - `ignore` names pods that started before this converge (the install replaces them when it needs
 *   a node's file as it is now): none of them counts.
 * - `seenEvents` holds the prints of the DaemonSet's events before the apply: such an event is
 *   older than this converge, and does not refuse.
 */
export async function awaitFenceNodes(
  kube: Pick<KubeAdmin, "listJson">,
  opts: {
    nodes: readonly string[];
    generation?: () => Promise<string | undefined>;
    ignore?: ReadonlySet<string>;
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
    const generation = Number((await opts.generation?.()) ?? Number.NaN);
    const pods = await kube.listJson<FenceNodePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    const current = (p: FenceNodePod) =>
      !(opts.ignore?.has(p.metadata?.name ?? "") ?? false) &&
      (Number.isNaN(generation) || Number(p.metadata?.labels?.[TEMPLATE_GENERATION_LABEL]) >= generation);
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
        for (const p of mine) {
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

/**
 * The first CNI configuration that a node's pod of jr2-fence-node read (`cni=`), its type (`type=`),
 * and, for a Multus configuration of the thin form, its isolation (`isolation=`: `true`, `false` or
 * `unknown`) and its global namespaces (`globals=`: empty, the names, or `?`).
 */
export function firstCniOf(
  line: string,
): { file: string; type: string; isolation?: string; globals?: string } | undefined {
  const file = /(?:^| )cni=(\S+)/.exec(line)?.[1];
  const type = /(?:^| )type=(\S+)/.exec(line)?.[1];
  const isolation = /(?:^| )isolation=(\S+)/.exec(line)?.[1];
  const globals = /(?:^| )globals=(\S*)/.exec(line)?.[1];
  if (file === undefined) return undefined;
  return {
    file,
    type: type ?? "unknown",
    ...(isolation !== undefined ? { isolation } : {}),
    ...(globals !== undefined ? { globals } : {}),
  };
}

// ---- the install -----------------------------------------------------------------------------------

/**
 * The second check of a Multus of another owner, on the node: a first CNI configuration of type
 * `multus` (the thin form writes its settings there, and the node uses that file) must have
 * namespaceIsolation and no global namespace, whatever the API said. A node file that jr2 cannot read
 * refuses too.
 */
function checkNodeMultusFiles(results: ReadonlyMap<string, string>, multusPods: FenceInstallPlan["multusPods"]): void {
  const bad: string[] = [];
  for (const [node, line] of results) {
    const first = firstCniOf(line);
    if (first?.type !== "multus") continue;
    const file = `${CNI_CONF_DIR}/${first.file}`;
    if (first.isolation === "unknown" || first.isolation === undefined || first.globals === "?") {
      bad.push(`  ${node}: ${file}: jr2 cannot tell its namespaceIsolation or its globalNamespaces`);
    } else if (first.isolation !== "true") {
      bad.push(`  ${node}: ${file} has no namespaceIsolation`);
    } else if ((first.globals ?? "") !== "") {
      bad.push(`  ${node}: ${file} has the global namespaces "${first.globals}"`);
    }
  }
  if (bad.length === 0) return;
  const restart = multusPods.map((w) => `kubectl -n ${w.namespace} delete pod -l ${w.selector}`).join("; ");
  throw new Error(
    [
      `fence: the Multus configuration that a Sandbox node uses does not have the isolation of the attachments ` +
        "(ADR-0084), whatever the API shows:",
      ...bad,
      "A Multus of the thin form writes this file from its settings when its pod starts, and the node reads the " +
        `file, not the API. Restart the pods of the cluster's Multus (${restart}), so that they write the file ` +
        "again from the settings that jr2 read. When the file stays, " +
        "another Multus writes it on that node, or it stays from a Multus that is gone: delete it on the node.",
      ...KEPT,
      `See ${FENCE_PREREQUISITES_URL}. Then run \`jr2 up\` again.`,
    ].join("\n"),
  );
}

/**
 * Install what the plan says, after the question. The DaemonSet first, so that a node that it
 * refuses (its CNI folders, its `bridge`, a Multus on the node that the API does not show, a thin
 * Multus whose node file has no isolation) refuses before Multus changes the cluster's CNI
 * configuration; then Multus. The DaemonSet is applied at each converge whose Kit is not older than
 * the one it runs, as the operator is: an apply that changes nothing rolls nothing, and one that
 * changes the image or the template (a newer Kit, or the removal form that an interrupted
 * `jr2 down --all` left) rolls each pod, which loads the table again.
 *
 * When jr2 needs each node's first CNI configuration as it is now (the plan installs Multus, or the
 * cluster has a Multus of another owner), it replaces each pod of the DaemonSet that started before
 * this converge, and reads only the lines of the pods that started after: a line of an earlier pod
 * can be old. A Multus that the read before the question did not see, and that a node shows, gets
 * the same check as one that it saw. Returns the plan as the install found it: a Multus of another
 * owner that the install found makes it `foreign`, and jr2 then installs no Multus. One quiet line
 * when the plan installed nothing.
 */
export async function installFence(
  kube: Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout" | "deleteObject">,
  plan: FenceInstallPlan,
  opts: {
    image: string;
    nodes: readonly string[];
    context?: string;
    log: (line: string) => void;
    pollMs?: number;
    now?: () => number;
  },
): Promise<FenceInstallPlan> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const read = () =>
    kube.getJson<DaemonSetObject>({
      kind: "daemonset",
      name: FENCE_NODE_DAEMONSET,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
  const listPods = () =>
    kube.listJson<FenceNodePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
  const existing = await read();
  const deployed = existing?.metadata.labels?.[LABEL_VERSION];
  const newer = deployed !== undefined && compareVersions(deployed, KIT_VERSION) > 0;
  // Before the apply: the pods that run now, and the DaemonSet's events, so that the wait reads only
  // what this converge made.
  const fresh = plan.multus === "install" || plan.multus === "foreign";
  const before = existing !== undefined ? await listPods() : [];
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
  const ignore = new Set<string>();
  if (fresh) {
    for (const pod of before) {
      const name = pod.metadata?.name;
      if (name === undefined) continue;
      ignore.add(name);
      if (pod.metadata?.deletionTimestamp === undefined) {
        await kube.deleteObject({ kind: "pod", name, namespace: OPERATOR_NAMESPACE, wait: false, ...ctx });
      }
    }
  }
  // The template generation at each poll: a Ready pod of an earlier template does not count.
  const results = await awaitFenceNodes(kube, {
    ...opts,
    generation: async () => (await read())?.metadata.annotations?.[TEMPLATE_GENERATION_ANNOTATION],
    ignore,
    seenEvents,
  });
  if (plan.node === "install") {
    for (const [node, line] of results) opts.log(`fence: ${node}: ${line}`);
  }
  let found: Pick<FenceInstallPlan, "multus" | "multusPods"> = { multus: plan.multus, multusPods: plan.multusPods };
  if (plan.multus === "install") {
    // A node whose first CNI configuration is a Multus's: a Multus that the read before the question
    // did not see. When the API shows it now, it gets the same check; when not, jr2 cannot see it,
    // and a second Multus would replace its file.
    const multusFirst = [...results]
      .map(([node, line]) => ({ node, first: firstCniOf(line) }))
      .filter((n) => n.first !== undefined && /multus/i.test(n.first.type));
    if (multusFirst.length > 0) {
      const daemonSets = await kube.listJson<DaemonSetObject>({ kind: "daemonset", allNamespaces: true, ...ctx });
      if (!daemonSets.some(isMultusDaemonSet)) {
        throw new Error(
          [
            `fence: ${multusFirst.length === 1 ? "a Sandbox node has" : `${multusFirst.length} Sandbox nodes have`} ` +
              "a Multus CNI configuration first in its CNI folder, but jr2 found no Multus DaemonSet in the API " +
              "(ADR-0084):",
            ...multusFirst.map((n) => `  ${n.node}: ${CNI_CONF_DIR}/${n.first!.file} (type ${n.first!.type})`),
            `${MULTUS_SEARCH} A second Multus would replace the configuration of that Multus, and the isolation ` +
              "of the attachments can be lost. If the cluster has a Multus in another form, jr2 cannot use it: run " +
              "it as one of those. If the file stays from a Multus that is gone, delete it on the node.",
            ...KEPT,
            `See ${FENCE_PREREQUISITES_URL}. Then run \`jr2 up\` again.`,
          ].join("\n"),
        );
      }
      found = await readMultus(kube, daemonSets, refusedAfterApply, opts.context);
      if (found.multus === "foreign") {
        opts.log(
          "fence: the cluster has a Multus that jr2 did not install, with namespaceIsolation and no global " +
            "namespace; jr2 installs no Multus beside it",
        );
      } else found = { multus: plan.multus, multusPods: plan.multusPods };
    }
  }
  if (found.multus === "foreign") checkNodeMultusFiles(results, found.multusPods);
  if (found.multus === "install" || found.multus === "upgrade") {
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
      `fence: prerequisites in place — ${found.multus === "foreign" ? "the cluster's" : "jr2's"} Multus, and the ` +
        `rule table and the CNI plugins on ${results.size} Sandbox node${results.size === 1 ? "" : "s"}`,
    );
  }
  return { ...plan, ...found };
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
  let generation: string | undefined;
  try {
    const ds = await kube.getJson<DaemonSetObject>({
      kind: "daemonset",
      name: FENCE_NODE_DAEMONSET,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    generation = ds?.metadata.annotations?.[TEMPLATE_GENERATION_ANNOTATION];
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
    if (generation !== undefined && pod.metadata?.labels?.[TEMPLATE_GENERATION_LABEL] !== generation) continue;
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
 * the fence node's DaemonSet, and the Multus that carries jr2's annotation. A Multus that jr2 did not
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
