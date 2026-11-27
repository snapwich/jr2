// The Fence's objects that `jr2 up` writes for an Instance (ADR-0084): the claim of a VLAN range on
// the cluster, the attachment of each slot and of the Custodian's trunk, and the uplink script that
// the Custodian pod's `uplink` init container runs. Pure builders, except the claim, which reads and
// writes through the converge's KubeAdmin.
//
// Many Instances share one bridge on each node (`jr2fence0`), which the stock bridge plugin makes,
// with VLAN filtering, from these attachments. Each Instance claims a range of 128 VLANs, the same on
// every node, because a Harness pod's VLAN is chosen before the scheduler picks a node. Slot i of
// range k is VLAN 2 + 128k + i, and its address is the segment's network address plus the VLAN. The
// trunk port of an Instance's Custodian pod is a member of its range only, and no pod's port has
// VLAN 1, the VLAN of the bridge's own side (the node), so a frame of one Instance never reaches the
// trunk of another, and no frame of a pod reaches the node. This VLAN state keeps a Sandbox off the
// node and off other pods, also with no rule table; the node's rule table (`fence-install.ts`) keeps
// the node's NAT from changing a Sandbox's frames, and is a second barrier (ADR-0084).
//
// The uplink script is here, in TypeScript, and not in a file beside the package: a `files:` list
// cannot miss it, and the installed CLI writes the same script as a checkout does.

import {
  custodianXds,
  CUSTODIAN_SERVICE,
  DIAL_TOKEN_HEADER,
  CUSTODIAN_CONTROL_PORT,
  CUSTODIAN_INBOUND_PORT,
  CUSTODIAN_HEALTH_PORT,
  FENCE_LAST_RANGE,
  FENCE_SLOTS,
  FENCE_TRUNK_ATTACHMENT,
  fenceRangeClaim,
  fenceSlotAttachment,
  SLOT_LISTENER_BASE,
  SLOT_RESOLVER_BASE,
  slotAddress,
  slotVlan,
  type FenceRanges,
} from "@jr2/orchestrator/internal";
import type { KubeAdmin, KubeObject } from "./kube.ts";

/** Where the range claims are: the operator's namespace, one for each cluster. */
export const FENCE_CLAIM_NAMESPACE = "jr2-system";
/** The label of each range claim: its range. A selector on the key alone lists every claim. */
export const LABEL_FENCE_RANGE = "jr2.dev/fence-range";
/** The label of each range claim: the namespace that holds it, so that `jr2 down` finds its own. */
export const LABEL_FENCE_HOLDER = "jr2.dev/fence-holder";

/** The node's bridge that each Harness pod and each Custodian pod is a port of: the bridge plugin makes it. */
export const FENCE_BRIDGE = "jr2fence0";
/** The Custodian pod's interface on its trunk attachment. */
export const FENCE_TRUNK_INTERFACE = "net1";

type Json = Record<string, unknown>;

/** The prefix length and the uplink's address of a segment: its network address plus one. */
function segmentParts(segment: string): { prefix: number; uplink: string } {
  const prefix = Number(segment.split("/")[1]);
  return { prefix, uplink: slotAddress(segment, 1) };
}

/** A MAC address in the locally administered range: `02:00:c6:<kind>:<VLAN high>:<VLAN low>`. */
function vlanMac(kind: number, vlan: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return ["02", "00", "c6", hex(kind), hex(vlan >> 8), hex(vlan & 255)].join(":");
}

/** The MAC of a Harness pod on slot i: fixed, so that the slot's ARP rule and a pod's neighbor entry
 * never depend on the pod. */
export const slotMac = (vlan: number): string => vlanMac(0x13, vlan);

/** The MAC of the uplink's interface for a VLAN (`UPLINK_SCRIPT` sets it): what a Harness pod's
 * neighbour entry for the uplink holds, and what the Fence probe checks (`fence-probe.ts`). */
export const uplinkMac = (vlan: number): string => vlanMac(0x12, vlan);

function attachment(namespace: string, name: string, labels: Record<string, string>, plugins: Json[]): Json {
  return {
    apiVersion: "k8s.cni.cncf.io/v1",
    kind: "NetworkAttachmentDefinition",
    metadata: { name, namespace, labels },
    spec: { config: JSON.stringify({ cniVersion: "1.0.0", name, plugins }) },
  };
}

/**
 * The attachment of slot i (ADR-0084): the stock bridge plugin puts the pod on the node's bridge as
 * an access port of the slot's VLAN, with the slot's fixed MAC and its address. The pod's only
 * route leads to the uplink's address on that VLAN. The port is isolated: on the bridge it can
 * exchange frames with the trunk only. `preserveDefaultVlan: false` removes VLAN 1, the VLAN of the
 * bridge's own side, from the port, as on the trunk: the port is a member of its slot's VLAN only.
 */
export function slotAttachment(opts: {
  namespace: string;
  labels: Record<string, string>;
  range: number;
  slot: number;
  ranges: FenceRanges;
}): Json {
  const vlan = slotVlan(opts.range, opts.slot);
  const { prefix, uplink } = segmentParts(opts.ranges.segment);
  return attachment(opts.namespace, fenceSlotAttachment(opts.slot), opts.labels, [
    {
      type: "bridge",
      bridge: FENCE_BRIDGE,
      isGateway: false,
      isDefaultGateway: false,
      ipMasq: false,
      hairpinMode: false,
      portIsolation: true,
      mtu: 1500,
      vlan,
      preserveDefaultVlan: false,
      args: { cni: { mac: slotMac(vlan) } },
      ipam: {
        type: "static",
        addresses: [{ address: `${slotAddress(opts.ranges.segment, vlan)}/${prefix}`, gateway: uplink }],
        routes: [{ dst: "0.0.0.0/0", gw: uplink }],
      },
    },
  ]);
}

/**
 * The attachment of the Custodian pod's trunk (ADR-0084): a port of the node's bridge that is a
 * tagged member of each VLAN of the range and of no other VLAN. With `vlanTrunk` alone, the stock
 * bridge plugin also makes the port an untagged member of VLAN 1, so the trunks of two Instances on
 * a node would share VLAN 1. With `vlan` set to the first VLAN of the range and
 * `preserveDefaultVlan: false`, the plugin adds that VLAN first and then the whole range as tagged
 * VLANs, so the port has exactly the range, tagged, and the bridge drops each untagged frame from
 * it. The `tuning` plugin turns off forwarding and IPv6 in the pod and sets strict source checks.
 */
export function trunkAttachment(opts: { namespace: string; labels: Record<string, string>; range: number }): Json {
  const first = slotVlan(opts.range, 0);
  const last = slotVlan(opts.range, FENCE_SLOTS - 1);
  const sysctl: Record<string, string> = {};
  for (const dev of ["all", "default", FENCE_TRUNK_INTERFACE]) {
    sysctl[`net.ipv4.conf.${dev}.forwarding`] = "0";
    sysctl[`net.ipv6.conf.${dev}.disable_ipv6`] = "1";
    sysctl[`net.ipv4.conf.${dev}.rp_filter`] = "1";
    sysctl[`net.ipv4.conf.${dev}.arp_ignore`] = "1";
  }
  return attachment(opts.namespace, FENCE_TRUNK_ATTACHMENT, opts.labels, [
    {
      type: "bridge",
      bridge: FENCE_BRIDGE,
      isGateway: false,
      isDefaultGateway: false,
      ipMasq: false,
      hairpinMode: false,
      portIsolation: false,
      mtu: 1500,
      vlan: first,
      preserveDefaultVlan: false,
      vlanTrunk: [{ minID: first, maxID: last }],
    },
    { type: "tuning", sysctl },
  ]);
}

/** Each attachment of an Instance: one for each slot of its range, and the trunk. */
export function fenceAttachments(opts: {
  namespace: string;
  labels: Record<string, string>;
  range: number;
  ranges: FenceRanges;
}): Json[] {
  const slots = Array.from({ length: FENCE_SLOTS }, (_, slot) => slotAttachment({ ...opts, slot }));
  return [...slots, trunkAttachment(opts)];
}

/**
 * The script of the Custodian pod's `uplink` init container (ADR-0084), run as
 * `sh -c <script> uplink <range> <segment> <state folder> <group> <empty LDS> <empty CDS>`. It runs
 * once, as root with `NET_ADMIN` in the pod's own network namespace, never the node's. For each
 * slot i, VLAN v = 2 + 128k + i:
 *
 * - the interface `v<i>` on the trunk, with a fixed MAC (so that a Harness pod's neighbor entry for
 *   the uplink stays true when the Custodian pod is replaced), the uplink's address /32, and a /32
 *   route to the slot's address;
 * - the identity: on `v<i>`, IPv4 and ARP only from the slot's address;
 * - each TCP connection from `v<i>` goes to port 20000+i (the slot's Envoy listener), and DNS (port
 *   53, UDP and TCP) to port 25000+i (the slot's resolver). So the port names the slot, and no source
 *   address does.
 *
 * All else from a VLAN is dropped: other UDP, ICMP, IPv6 and other frame types. From `eth0`, the
 * cluster's network, only the health, inbound and control ports are open: no slot's listener and no
 * resolver. Nothing is forwarded. Then it writes Envoy's LDS and CDS files with no slot, when they are
 * not there yet, because Envoy does not start without them; the folder is for the pod's group, so
 * that the control process can replace each file. Nothing here changes while the pod lives: a
 * Harness pod's start writes nothing. A run again in the same network namespace first deletes what a
 * run before made, so a start again after a failure does not fail on it.
 */
export const UPLINK_SCRIPT = `set -eu
K=$1 SEGMENT=$2 STATE=$3 GROUP=$4 LDS=$5 CDS=$6
SLOTS=${FENCE_SLOTS}
TRUNK=${FENCE_TRUNK_INTERFACE}
FIRST=$((2 + SLOTS * K))

# The segment's network address as a number, and an address of it as text.
base=\${SEGMENT%/*}
o1=\${base%%.*}; r=\${base#*.}; o2=\${r%%.*}; r=\${r#*.}; o3=\${r%%.*}; o4=\${r#*.}
BASE=$(( (o1 << 24) | (o2 << 16) | (o3 << 8) | o4 ))
addr() { n=$((BASE + $1)); echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))"; }
UPLINK=$(addr 1)

# A run again in the same network namespace (the kubelet starts a failed init container again in
# the same pod) finds the interfaces and the tables of the run before: they go first, so that the
# script ends in the same state from each start.
stale() {
  i=0
  while [ $i -lt $SLOTS ]; do
    echo "link del v$i"
    i=$((i + 1))
  done
}
stale | ip -force -batch - 2>/dev/null || true

links() {
  echo "link set $TRUNK up"
  i=0
  while [ $i -lt $SLOTS ]; do
    v=$((FIRST + i))
    echo "link add link $TRUNK name v$i address $(printf '02:00:c6:12:%02x:%02x' $((v >> 8)) $((v & 255))) type vlan id $v"
    echo "addr add $UPLINK/32 dev v$i"
    echo "link set v$i up"
    echo "route add $(addr $v)/32 dev v$i"
    i=$((i + 1))
  done
}
links | ip -batch -

elements() {
  i=0
  sep=""
  while [ $i -lt $SLOTS ]; do
    case $1 in
      identity) printf '%s"v%s" . %s' "$sep" $i "$(addr $((FIRST + i)))" ;;
      tcp) printf '%s"v%s" : %s' "$sep" $i $((${SLOT_LISTENER_BASE} + i)) ;;
      dns) printf '%s"v%s" : %s' "$sep" $i $((${SLOT_RESOLVER_BASE} + i)) ;;
    esac
    sep=", "
    i=$((i + 1))
  done
}
IDS=$(elements identity)

nft -f - <<NFT
table netdev jr2_uplink_l2
delete table netdev jr2_uplink_l2
table inet jr2_uplink
delete table inet jr2_uplink
table arp jr2_uplink
delete table arp jr2_uplink
table netdev jr2_uplink_l2 {
  chain trunk {
    type filter hook ingress device "$TRUNK" priority -500; policy accept;
    ether type 8021q vlan type { ip, arp } accept
    counter drop comment "jr2: not IPv4 or ARP in a VLAN of the range"
  }
}
table inet jr2_uplink {
  set identity {
    type ifname . ipv4_addr
    elements = { $IDS }
  }
  map tcp_port {
    type ifname : inet_service
    elements = { $(elements tcp) }
  }
  map dns_port {
    type ifname : inet_service
    elements = { $(elements dns) }
  }
  chain identity {
    type filter hook prerouting priority -400; policy accept;
    iifname "v*" meta nfproto ipv4 iifname . ip saddr @identity counter accept
    iifname "v*" counter drop comment "jr2: source is not the Harness pod of this slot"
  }
  chain slot {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "v*" meta l4proto { tcp, udp } th dport 53 counter redirect to : iifname map @dns_port
    iifname "v*" meta l4proto tcp counter redirect to : iifname map @tcp_port
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    ct state established,related accept
    iifname "v*" ct status dnat counter accept
    iifname "eth0" tcp dport { ${CUSTODIAN_HEALTH_PORT}, ${CUSTODIAN_INBOUND_PORT}, ${CUSTODIAN_CONTROL_PORT} } accept
    counter drop comment "jr2: not a port of the Custodian"
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    counter drop comment "jr2: the Custodian forwards nothing"
  }
}
table arp jr2_uplink {
  set identity {
    type ifname . ipv4_addr
    elements = { $IDS }
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "v*" iifname . arp saddr ip @identity accept
    iifname "v*" counter drop comment "jr2: ARP not from the Harness pod of this slot"
    iifname "$TRUNK" counter drop comment "jr2: ARP outside a VLAN"
  }
}
NFT

mkdir -p "$STATE/xds"
chgrp "$GROUP" "$STATE/xds"
chmod 2770 "$STATE/xds"
[ -e "$STATE/xds/lds.json" ] || printf '%s' "$LDS" > "$STATE/xds/lds.json"
[ -e "$STATE/xds/cds.json" ] || printf '%s' "$CDS" > "$STATE/xds/cds.json"
echo "jr2.custodian uplink range=$K vlans=$FIRST-$((FIRST + SLOTS - 1)) slots=$SLOTS"
`;

/** The arguments after the script: what `UPLINK_SCRIPT` reads as `$1` … `$6`. */
export function uplinkArgs(opts: { range: number; ranges: FenceRanges; state: string; group: number }): string[] {
  slotVlan(opts.range, 0);
  const empty = custodianXds([]);
  return [
    "uplink",
    String(opts.range),
    opts.ranges.segment,
    opts.state,
    String(opts.group),
    JSON.stringify(empty.lds),
    JSON.stringify(empty.cds),
  ];
}

// ---- the claim of a VLAN range --------------------------------------------------------------------

/** What the claim needs of the converge's KubeAdmin. */
export type ClaimKube = Pick<KubeAdmin, "listJson" | "getJson" | "create" | "replace" | "deleteIf">;

type ClaimObject = KubeObject & {
  metadata: KubeObject["metadata"] & { resourceVersion?: string; uid?: string };
  spec?: { holderIdentity?: string };
};

/** The API path of the claim of range k, for a delete with preconditions. */
const claimPath = (name: string) => `/apis/coordination.k8s.io/v1/namespaces/${FENCE_CLAIM_NAMESPACE}/leases/${name}`;

/**
 * Delete a claim on the condition that it is still the claim that was read (its uid and
 * resourceVersion). A delete by name alone could remove a claim that another Instance took between
 * the read and the delete. True when it went; false when it changed or went first.
 */
async function deleteClaim(kube: Pick<KubeAdmin, "deleteIf">, claim: ClaimObject, ctx: { context?: string }) {
  const { uid, resourceVersion } = claim.metadata;
  if (uid === undefined || resourceVersion === undefined) return false;
  return (await kube.deleteIf({ apiPath: claimPath(claim.metadata.name), uid, resourceVersion, ...ctx })) === "deleted";
}

/** The claim of range k by the Instance in `holder`: a Kubernetes Lease object. */
export function rangeClaimObject(range: number, holder: string, resourceVersion?: string): Json {
  return {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: fenceRangeClaim(range),
      namespace: FENCE_CLAIM_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "jr2",
        [LABEL_FENCE_RANGE]: String(range),
        [LABEL_FENCE_HOLDER]: holder,
      },
      ...(resourceVersion !== undefined ? { resourceVersion } : {}),
    },
    spec: { holderIdentity: holder },
  };
}

const rangeOf = (claim: ClaimObject): number | undefined => {
  const m = /^jr2-fence-range-(\d+)$/.exec(claim.metadata.name);
  return m ? Number(m[1]) : undefined;
};

/**
 * Create a namespace that is not there, such as the operator's (`jr2-system`), which the range
 * claims and the Fence's CNI plugins need before the operator is applied. A read first: a user who
 * may write objects there but may not create a namespace gets Forbidden from a create, also when the
 * namespace exists.
 */
export async function ensureNamespace(
  kube: Pick<KubeAdmin, "getJson" | "create">,
  name: string,
  ctx: { context?: string },
): Promise<void> {
  if ((await kube.getJson({ kind: "namespace", name, ...ctx })) === undefined) {
    await kube.create({
      manifest: JSON.stringify({ apiVersion: "v1", kind: "Namespace", metadata: { name } }),
      ...ctx,
    });
  }
}

/**
 * The VLAN range of the Instance in `namespace` (ADR-0084): the range it holds, or the lowest range
 * that it can claim. A claim is the atomic create of `jr2-fence-range-<k>`. A claim whose holder's
 * namespace is NotFound is taken again, by a replace at the version that was read, so two converges
 * cannot both take it. A namespace that is still Terminating keeps its claim: a pod of it can still
 * be on a VLAN of that range. A namespace that holds two claims (two converges at one time) keeps
 * the lowest and gives the others back.
 */
export async function claimRange(
  kube: ClaimKube,
  opts: { namespace: string; context?: string; log: (line: string) => void },
): Promise<number> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const claims = await kube.listJson<ClaimObject>({
    kind: "lease",
    selector: LABEL_FENCE_RANGE,
    namespace: FENCE_CLAIM_NAMESPACE,
    ...ctx,
  });
  const holderOf = (c: ClaimObject) => c.spec?.holderIdentity;
  const mine = claims
    .filter((c) => holderOf(c) === opts.namespace && rangeOf(c) !== undefined)
    .sort((a, b) => rangeOf(a)! - rangeOf(b)!);
  if (mine.length > 0) {
    for (const extra of mine.slice(1)) {
      if (await deleteClaim(kube, extra, ctx)) opts.log(`fence: gave back the second claim ${extra.metadata.name}`);
    }
    return rangeOf(mine[0]!)!;
  }
  // The claims live in the operator's namespace, which an Instance whose operator is not managed by
  // jr2 may not have yet.
  await ensureNamespace(kube, FENCE_CLAIM_NAMESPACE, ctx);
  const read = (range: number) =>
    kube.getJson<ClaimObject>({
      kind: "lease",
      name: fenceRangeClaim(range),
      namespace: FENCE_CLAIM_NAMESPACE,
      ...ctx,
    });
  const held: string[] = [];
  for (let range = 0; range <= FENCE_LAST_RANGE; range++) {
    let claim = claims.find((c) => rangeOf(c) === range);
    if (claim === undefined) {
      const made = await kube.create({ manifest: JSON.stringify(rangeClaimObject(range, opts.namespace)), ...ctx });
      if (made === "created") return range;
      claim = await read(range);
      if (claim === undefined) continue;
    }
    const holder = holderOf(claim);
    if (holder === opts.namespace) return range;
    // NotFound only: a read that fails throws, and a Terminating namespace is still listed.
    const alive =
      holder !== undefined &&
      (await kube.listJson({ kind: "namespace", fieldSelector: `metadata.name=${holder}`, ...ctx })).length > 0;
    if (alive) {
      held.push(`${range} (${holder})`);
      continue;
    }
    const taken = await kube.replace({
      manifest: JSON.stringify(rangeClaimObject(range, opts.namespace, claim.metadata.resourceVersion)),
      ...ctx,
    });
    if (taken === "replaced") {
      opts.log(`fence: took range ${range} again: its holder, namespace "${holder ?? "(none)"}", is gone`);
      return range;
    }
    // Another converge came first. It may be a converge of this same namespace: then this range is
    // the namespace's, and a second claim would split the Instance over two ranges.
    if ((await read(range))?.spec?.holderIdentity === opts.namespace) return range;
  }
  throw new Error(
    `no VLAN range is free on this cluster: each of the ${FENCE_LAST_RANGE + 1} ranges is held, ` +
      `by ${held.join(", ")} (ADR-0084). Remove an Instance with \`jr2 down\`, or delete the claim ` +
      `${FENCE_CLAIM_NAMESPACE}/jr2-fence-range-<k> of an Instance whose namespace is gone`,
  );
}

/**
 * Give back each range that the Instance in `namespace` holds. Only `jr2 down` calls it, after the
 * namespace is NotFound (ADR-0084): while a pod of the namespace can still be on a VLAN of the range,
 * no other Instance may claim it. Each delete is conditional on the claim that was read, so a claim
 * that another Instance took in the meantime stays. The ranges given back.
 */
export async function releaseRanges(
  kube: Pick<KubeAdmin, "listJson" | "getJson" | "deleteIf">,
  opts: { namespace: string; context?: string },
): Promise<number[]> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const claims = await kube.listJson<ClaimObject>({
    kind: "lease",
    selector: `${LABEL_FENCE_HOLDER}=${opts.namespace}`,
    namespace: FENCE_CLAIM_NAMESPACE,
    ...ctx,
  });
  const given: number[] = [];
  for (const listed of claims) {
    // A claim that changed but is still this namespace's is read again and given back; one that
    // another Instance took stays with it.
    let claim: ClaimObject | undefined = listed;
    for (let tries = 0; tries < 3 && claim?.spec?.holderIdentity === opts.namespace; tries++) {
      if (await deleteClaim(kube, claim, ctx)) {
        const range = rangeOf(claim);
        if (range !== undefined) given.push(range);
        break;
      }
      claim = await kube.getJson<ClaimObject>({
        kind: "lease",
        name: listed.metadata.name,
        namespace: FENCE_CLAIM_NAMESPACE,
        ...ctx,
      });
    }
  }
  return given;
}

/**
 * The namespaces other than `namespace` that hold a range and are still on the cluster (a read by
 * name finds a Terminating one too). `jr2 down --all` refuses while one exists: the claims are in
 * `jr2-system`, which goes with the operator, and another Instance's next `jr2 up` would then claim
 * a range that a live Instance still uses (ADR-0084).
 */
export async function otherHolders(
  kube: Pick<KubeAdmin, "listJson">,
  opts: { namespace: string; context?: string },
): Promise<string[]> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const claims = await kube.listJson<ClaimObject>({
    kind: "lease",
    selector: LABEL_FENCE_RANGE,
    namespace: FENCE_CLAIM_NAMESPACE,
    ...ctx,
  });
  const holders = new Set<string>();
  for (const claim of claims) {
    const holder = claim.spec?.holderIdentity;
    if (holder === undefined || holder === "" || holder === opts.namespace) continue;
    const alive = await kube.listJson({ kind: "namespace", fieldSelector: `metadata.name=${holder}`, ...ctx });
    if (alive.length > 0) holders.add(holder);
  }
  return [...holders].sort();
}

/** What `makeSlotLive` reaches the Custodian pods through: the converge's API reads, and a
 * port-forward to one pod with a `fetch` over it. */
export type LiveKube = {
  listJson: KubeAdmin["listJson"];
  portForward(opts: {
    namespace: string;
    pod: string;
    port: number;
    context?: string;
  }): Promise<{ url: string; close: () => void }>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

/** How long `jr2 up` waits for the Custodian to make the rules of a slot of its own live. */
export const SLOT_LIVE_MS = 60_000;

/**
 * Make the rules of a slot that `jr2 up` gives (the Instance Harness's, the check pod's) live on
 * each Custodian pod of the Instance, and wait until each one says that the rules of one version are
 * live (ADR-0084: a Harness pod starts only after its rules are live). The Orchestrator does the same
 * for a Sandbox (`custodianClient.makeLive`). `jr2 up` runs outside the cluster, so it asks each pod
 * over a port-forward, with the Instance's dial token, as the Orchestrator does. The Custodian pods
 * are those that run and are not being deleted; with none (no Sandbox node took one), nothing is
 * asked, and the Harness pod cannot be placed either. Answers the version, or undefined with no pod.
 * Throws, with what each pod said, when the wait ends with no such answer.
 */
export async function makeSlotLive(
  kube: LiveKube,
  opts: {
    namespace: string;
    slot: number;
    dialToken: string;
    context?: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<string | undefined> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  type Pod = KubeObject & {
    metadata: { deletionTimestamp?: string };
    spec?: { nodeName?: string };
    status?: { phase?: string };
  };
  const pods = (
    await kube.listJson<Pod>({ kind: "pod", selector: `app=${CUSTODIAN_SERVICE}`, namespace: opts.namespace, ...ctx })
  ).filter((p) => p.status?.phase === "Running" && !p.metadata.deletionTimestamp);
  if (pods.length === 0) return undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? SLOT_LIVE_MS);
  const forwards = await Promise.all(
    pods.map(async (p) => ({
      pod: p.metadata.name,
      node: p.spec?.nodeName,
      fwd: await kube.portForward({
        namespace: opts.namespace,
        pod: p.metadata.name,
        port: CUSTODIAN_CONTROL_PORT,
        ...ctx,
      }),
    })),
  );
  try {
    let said = "";
    for (;;) {
      const answers = await Promise.all(
        forwards.map(async ({ pod, node, fwd }) => {
          const where = `${pod}${node ? ` on ${node}` : ""}`;
          try {
            const res = await kube.fetch(`${fwd.url.replace(/\/+$/, "")}/slots/${opts.slot}`, {
              method: "POST",
              headers: { [DIAL_TOKEN_HEADER]: opts.dialToken },
              signal: AbortSignal.timeout(10_000),
            });
            const text = await res.text();
            if (res.status !== 200) return { where, text: `${res.status} ${text.trim()}` };
            const body = JSON.parse(text) as { live?: boolean; version?: string; error?: string };
            return body.live && typeof body.version === "string"
              ? { where, version: body.version, text: `live at version ${body.version}` }
              : { where, text: `not live${body.error ? ` (${body.error})` : ""}` };
          } catch (err) {
            return { where, text: `no answer: ${(err as Error).message}` };
          }
        }),
      );
      const versions = new Set(answers.map((a) => a.version ?? null));
      const [only] = versions;
      if (versions.size === 1 && typeof only === "string") return only;
      said = answers.map((a) => `${a.where}: ${a.text}`).join("; ");
      const pause = opts.intervalMs ?? 500;
      if (Date.now() + pause > deadline) {
        throw new Error(
          `the Custodian did not make the rules of Fence slot ${opts.slot} live in ` +
            `${Math.round((opts.timeoutMs ?? SLOT_LIVE_MS) / 1000)} s (ADR-0084): ${said}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  } finally {
    for (const { fwd } of forwards) fwd.close();
  }
}
