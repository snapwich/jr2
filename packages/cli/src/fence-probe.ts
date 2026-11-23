// `jr2 up` probes the Fence on each Sandbox node (ADR-0084, ADR-0019), after it installed or found
// the prerequisites (`fence-install.ts`, `fence-guard.ts`): the admission policies, Multus, and the
// DaemonSet jr2-fence-node, which puts the CNI plugins bridge, static and tuning on each node and
// loads the rule table there. It refuses to converge while a Sandbox node fails, and it names the
// node, the part and the likely causes.
//
// From the API, before the Custodian is applied: the CustomResourceDefinition of the attachments
// exists; when jr2 installed Multus, a Ready pod of it runs on each Sandbox node; and the server-side
// dry runs of the guard are denied by jr2's policies. A Multus of another owner is judged by what it
// does: the probe pod's address. After the Custodian's pods are Ready, on
// each node where one runs, a one-shot pod that `nodeName` pins there, on slot 2 of the Instance's
// range (the same slot on each node: the bridges are separate, and nothing dials it). Its own address
// must be the slot's address (else Multus did not give it the attachment). A DNS query to the
// uplink's address must get an answer from the Custodian's resolver. When none comes, the pod's own
// ARP table tells the two causes apart: an answer from the uplink's MAC says that the bridge carries
// the frames of the VLAN, so the node changed them (NAT or conntrack on bridged VLAN frames); no
// answer says that the bridge, its VLAN filtering, or the Custodian pod of the node does not carry
// them. Then a dial to the API Service's cluster address must get the Custodian's answer at once:
// with no rule table of the Fence on the node (`FENCE_RULES`), the node's NAT changes the dial
// before the bridge carries it, and its SYN gets no answer at all. Then the kubelet's port on the
// node's address must give no answer but the Custodian's: the node's own side of the bridge is in
// no VLAN of a pod.
//
// A behaviour probe with no privilege: the pod has no node network, no capability, no writable root
// and no token. It writes its result as its termination message, as the Repo cache agent writes a
// missing Landlock (`landlock.ts`). The limit: it sees the effect of the VLAN state and of the rule
// table, not the state.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CUSTODIAN_SERVICE,
  fenceSlotAttachment,
  slotAddress,
  slotVlan,
  type FenceRanges,
  type SandboxPlacement,
} from "@jr2/orchestrator/internal";
import { KIT_POD_SIZES, LABEL_INSTANCE } from "./deploy.ts";
import { uplinkMac } from "./fence.ts";
import {
  ATTACHMENT_CRD,
  CNI_BIN_DIR,
  CNI_CONF_DIR,
  FENCE_NODE_DAEMONSET,
  FENCE_PREREQUISITES_URL,
  MULTUS_NAMESPACE,
  MULTUS_SELECTOR,
  RULES_TABLE,
} from "./fence-install.ts";
import { OPERATOR_NAMESPACE } from "./deploy.ts";
import { checkFenceGuard } from "./fence-guard.ts";
import type { FenceInstallPlan } from "./fence-install.ts";
import type { KubeAdmin } from "./kube.ts";

/** The slot of the Fence probe in each range (ADR-0084: slot 0 the Instance Harness, slot 1 the check
 * pod, slot 2 the node probes). */
export const FENCE_PROBE_SLOT = 2;
/** The `app` label of the probe pods. */
export const FENCE_PROBE_APP = "jr2-fence-probe";
/** The start of each probe's result line (its termination message). */
export const FENCE_PROBE_PREFIX = "jr2.fence-probe ";
export { ATTACHMENT_CRD };
/** The port of the node that the Fence probe dials: the kubelet's, which answers on every node. */
const NODE_PORT = 10250;
/** The user of the probe pods: the Custodian's, no root. */
const PROBE_USER = 65532;
/** How long a probe pod may take to start (its image is on the node: the Custodian runs it), and
 * then to end. */
const START_MS = 120_000;
const RUN_MS = 60_000;
/** How long a pod may wait for its network before the kubelet's reason counts. */
const SANDBOX_GRACE_MS = 15_000;
const POLL_MS = 1_000;

// ---- the probe: it runs in its pod as `node -e`, and is called directly by its test --------------

/** What a probe reads and writes through: Node's own modules in the pod, the same or fakes in a test. */
export type ProbeSys = {
  dgram: typeof import("node:dgram");
  net: typeof import("node:net");
  os: typeof import("node:os");
  fs: typeof import("node:fs");
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  exit: (code: number) => void;
};

/** One probe's result, as its termination message carries it after `FENCE_PROBE_PREFIX`. */
export type ProbeResult = {
  probe: "fence";
  ok: boolean;
  /** The part that a failed probe names. */
  part?: "attachment" | "bridge" | "frames" | "rules" | "service" | "node";
  /** What the probe saw, in words a person acts on. */
  why?: string;
};

/**
 * The Fence probe (on slot 2 of the range). Self-contained: its text is the pod's program, so it
 * names nothing outside itself. Its inputs are env variables that the pod sets: `JR2_PROBE_ADDRESS`
 * (the slot's address), `JR2_PROBE_UPLINK` (the uplink's address), `JR2_PROBE_UPLINK_MAC`,
 * `JR2_PROBE_VLAN`, `JR2_PROBE_SERVICE` and `JR2_PROBE_SERVICE_PORT` (the API Service's cluster
 * address), `JR2_PROBE_NODE` (the node's address), `JR2_PROBE_NODE_PORT`, `JR2_PROBE_DNS_PORT`,
 * `JR2_PROBE_ARP` (the ARP table) and `JR2_PROBE_MESSAGE` (where the result goes).
 */
export async function fenceProbeMain(sys: ProbeSys): Promise<void> {
  const env = sys.env;
  const end = (r: Record<string, unknown>) => {
    const line = "jr2.fence-probe " + JSON.stringify({ probe: "fence", ...r });
    try {
      sys.fs.writeFileSync(env.JR2_PROBE_MESSAGE ?? "/dev/termination-log", line);
    } catch {
      // The log carries it too (FallbackToLogsOnError).
    }
    sys.log(line);
    sys.exit(r.ok ? 0 : 1);
  };
  const want = env.JR2_PROBE_ADDRESS ?? "";
  const uplink = env.JR2_PROBE_UPLINK ?? "";
  const mac = (env.JR2_PROBE_UPLINK_MAC ?? "").toLowerCase();
  const vlan = env.JR2_PROBE_VLAN ?? "?";
  const dnsPort = Number(env.JR2_PROBE_DNS_PORT ?? "53");

  // 1. The pod's own address: Multus gave it the slot's attachment as its default network.
  const mine: string[] = [];
  for (const list of Object.values(sys.os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) mine.push(a.address);
  }
  if (mine.length !== 1 || mine[0] !== want) {
    return end({
      ok: false,
      part: "attachment",
      why:
        `the probe pod's address is ${mine.join(", ") || "none"}, not the slot's address ${want}: ` +
        "Multus did not give the pod the slot's attachment as its default network. Look at the Multus pod of " +
        "this node (it must be Ready) and at the node's first CNI configuration in /etc/cni/net.d (it must be " +
        "Multus's)",
    });
  }

  // 2. A DNS query to the uplink's address: the Custodian's resolver answers it, whatever it says.
  const question = (id: number): Buffer => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(0x0100, 2);
    head.writeUInt16BE(1, 4);
    const labels = "custodian.jr2.internal"
      .split(".")
      .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    return Buffer.concat([head, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
  };
  const ask = (): Promise<boolean> =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 65536);
      const socket = sys.dgram.createSocket("udp4");
      const done = (answered: boolean) => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // closed already
        }
        resolve(answered);
      };
      const timer = setTimeout(() => done(false), 1000);
      socket.on("message", (msg, from) => {
        if (msg.length >= 12 && msg.readUInt16BE(0) === id && (msg[2]! & 0x80) !== 0 && from.address === uplink) {
          done(true);
        }
      });
      socket.on("error", () => done(false));
      socket.send(question(id), dnsPort, uplink);
    });
  let answered = false;
  for (let i = 0; i < 3 && !answered; i++) answered = await ask();
  if (!answered) {
    let table = "";
    try {
      table = sys.fs.readFileSync(env.JR2_PROBE_ARP ?? "/proc/net/arp", "utf8");
    } catch {
      // No table: read as no answer.
    }
    const seen = table
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .find((c) => c[0] === uplink && (Number(c[2]) & 0x2) !== 0)?.[3]
      ?.toLowerCase();
    if (seen === mac) {
      return end({
        ok: false,
        part: "frames",
        why:
          `the uplink answers on VLAN ${vlan} of the bridge (ARP from ${mac}), but no DNS query to ${uplink} got ` +
          "an answer: the node changes the frames that it bridges (NAT or conntrack on bridged VLAN frames, as " +
          "with net.bridge.bridge-nf-filter-vlan-tagged = 1), and the uplink drops a frame whose source is not " +
          "the slot's address",
      });
    }
    return end({
      ok: false,
      part: "bridge",
      why:
        seen === undefined
          ? `no answer from the uplink at ${uplink} on VLAN ${vlan} (no ARP answer, no DNS answer): the bridge does ` +
            "not carry the VLAN's frames to the Custodian pod of this node"
          : `${uplink} on VLAN ${vlan} answers from ${seen}, not from the uplink's ${mac}, and no DNS query got an answer`,
    });
  }

  // 3. A dial to the API Service's cluster address gets the Custodian's answer: the uplink takes the
  // connection whatever its address, and the Custodian refuses it (a reset for the probe's slot,
  // which has no rules; a line with jr2's reason for a slot that has rules). A SYN with no answer in
  // 3 s (`timeout`) is the sign of the node's NAT: kube-proxy's DNAT, which the node's prerouting
  // rules apply to a frame that enters the bridge untagged when net.bridge.bridge-nf-call-iptables
  // is 1, and which the rule table of the Fence stops. A connection that something took and that
  // stays silent (`silent`), or another error, is not that sign: it has a cause of its own.
  const service = env.JR2_PROBE_SERVICE ?? "";
  const servicePort = Number(env.JR2_PROBE_SERVICE_PORT ?? "443");
  const dialed = await new Promise<{ how: string; data: string }>((resolve) => {
    let data = "";
    let connected = false;
    const socket = sys.net.connect({ host: service, port: servicePort });
    const done = (how: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ how, data });
    };
    const timer = setTimeout(() => done(connected ? "silent" : "timeout"), 3000);
    socket.on("connect", () => {
      connected = true;
      socket.write(`GET / HTTP/1.0\r\nHost: ${service}\r\n\r\n`);
    });
    socket.on("data", (b: Buffer) => {
      data += b.toString("latin1");
      if (data.length >= 256) done("data");
    });
    socket.on("end", () => done("end"));
    socket.on("error", (e: NodeJS.ErrnoException) => done(e.code ?? "error"));
  });
  const custodians =
    dialed.how === "ECONNREFUSED" ||
    dialed.how === "ECONNRESET" ||
    (dialed.data === "" && dialed.how === "end") ||
    dialed.data.includes("jr2");
  if (!custodians) {
    const to = `a connection to the API Service's address ${service}:${servicePort}`;
    return end(
      dialed.data !== ""
        ? {
            ok: false,
            part: "node",
            why:
              `${to} got an answer that is not the Custodian's (${JSON.stringify(dialed.data.slice(0, 60))}): ` +
              "a Sandbox reaches a server of the cluster",
          }
        : dialed.how === "timeout"
          ? {
              ok: false,
              part: "rules",
              why:
                `${to} got no answer to its SYN in 3 s (timeout), where the Custodian refuses it at once: the node ` +
                "changes a Sandbox's frames before the bridge carries them to the uplink (the NAT of kube-proxy, " +
                "with net.bridge.bridge-nf-call-iptables = 1), so the rule table inet jr2_fence is not loaded on " +
                "the node",
            }
          : {
              ok: false,
              part: "service",
              why:
                dialed.how === "silent"
                  ? `${to} was accepted, but no byte and no close came in 3 s, where the Custodian refuses it at ` +
                    "once: a peer that is not the Custodian took the connection"
                  : `${to} failed (${dialed.how}), where the Custodian refuses it at once`,
            },
    );
  }

  // 4. The node's address gives no answer but the Custodian's: the uplink takes each TCP connection.
  const node = env.JR2_PROBE_NODE ?? "";
  const nodePort = Number(env.JR2_PROBE_NODE_PORT ?? "10250");
  const said = await new Promise<string>((resolve) => {
    let data = "";
    const socket = sys.net.connect({ host: node, port: nodePort });
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, 3000);
    socket.on("connect", () => socket.write(`GET / HTTP/1.0\r\nHost: ${node}\r\n\r\n`));
    socket.on("data", (b: Buffer) => {
      data += b.toString("latin1");
      if (data.length >= 256) done();
    });
    socket.on("end", done);
    socket.on("error", done);
  });
  if (said !== "" && !said.includes("jr2")) {
    return end({
      ok: false,
      part: "node",
      why:
        `the node answers on the bridge (its own side of the bridge is in the slot's VLAN): a connection to its address ${node}:${nodePort} got an answer that is ` +
        `not the Custodian's (${JSON.stringify(said.slice(0, 60))})`,
    });
  }
  return end({ ok: true });
}

/** A probe as the text of `node -e`: the function, called with Node's own modules. */
function programOf(main: (sys: ProbeSys) => Promise<void>): string {
  return (
    `(${main.toString()})({ dgram: require("node:dgram"), net: require("node:net"), os: require("node:os"), ` +
    `fs: require("node:fs"), env: process.env, log: (l) => console.log(l), exit: (c) => process.exit(c) })` +
    `.catch((e) => { console.log(String(e && e.stack || e)); process.exit(2); });`
  );
}

export const FENCE_PROBE_PROGRAM = programOf(fenceProbeMain);

// ---- the pods -------------------------------------------------------------------------------------

/** A short, stable part of a pod name for a node: node names can be 253 characters long. */
const nodeKey = (node: string): string => createHash("sha256").update(node).digest("hex").slice(0, 10);

/** The name of the probe pod of a node. */
export const probePodName = (node: string): string => `jr2-fence-probe-${nodeKey(node)}`;

type Json = Record<string, unknown>;

/** The probe pod of each node, as one List. */
export function fenceProbePods(opts: {
  name: string;
  namespace: string;
  nodes: readonly string[];
  range: number;
  ranges: FenceRanges;
  /** The Orchestrator Kit image: the Custodian's `control` image, so each node has it. */
  image: string;
  /** The API Service's cluster address and port (`default/kubernetes`). */
  service: { address: string; port: number };
  placement?: SandboxPlacement;
}): string {
  const vlan = slotVlan(opts.range, FENCE_PROBE_SLOT);
  const uplink = slotAddress(opts.ranges.segment, 1);
  const size = KIT_POD_SIZES.fenceProbe;
  const pod = (podName: string, node: string, env: Json[]): Json => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: opts.namespace,
      labels: { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2", app: FENCE_PROBE_APP },
      annotations: {
        "jr2.dev/node": node,
        "v1.multus-cni.io/default-network": `${opts.namespace}/${fenceSlotAttachment(FENCE_PROBE_SLOT)}`,
      },
    },
    spec: {
      nodeName: node,
      restartPolicy: "Never",
      activeDeadlineSeconds: (START_MS + RUN_MS) / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // On the Fence, the uplink is the only nameserver, as for a Harness pod.
      dnsPolicy: "None",
      dnsConfig: { nameservers: [uplink] },
      ...(opts.placement?.tolerations?.length ? { tolerations: opts.placement.tolerations } : {}),
      securityContext: {
        runAsUser: PROBE_USER,
        runAsGroup: PROBE_USER,
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: opts.image,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "-e", FENCE_PROBE_PROGRAM],
          env: [...env, { name: "JR2_PROBE_MESSAGE", value: "/dev/termination-log" }],
          terminationMessagePolicy: "FallbackToLogsOnError",
          resources: { requests: { ...size.requests }, limits: { ...size.limits } },
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  });
  const items: Json[] = [];
  for (const node of opts.nodes) {
    items.push(
      pod(probePodName(node), node, [
        { name: "JR2_PROBE_ADDRESS", value: slotAddress(opts.ranges.segment, vlan) },
        { name: "JR2_PROBE_UPLINK", value: uplink },
        { name: "JR2_PROBE_UPLINK_MAC", value: uplinkMac(vlan) },
        { name: "JR2_PROBE_VLAN", value: String(vlan) },
        { name: "JR2_PROBE_SERVICE", value: opts.service.address },
        { name: "JR2_PROBE_SERVICE_PORT", value: String(opts.service.port) },
        { name: "JR2_PROBE_NODE", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
        { name: "JR2_PROBE_NODE_PORT", value: String(NODE_PORT) },
        { name: "JR2_PROBE_DNS_PORT", value: "53" },
        { name: "JR2_PROBE_ARP", value: "/proc/net/arp" },
      ]),
    );
  }
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

// ---- what the probes said -------------------------------------------------------------------------

/** One part that a Sandbox node lacks, in words a person acts on, and what `jr2 up` did for it. */
export type FenceGap = { node: string; part: string; why: string; replaced?: string };

/** The words for each part a probe names. */
const PART: Record<NonNullable<ProbeResult["part"]>, string> = {
  attachment: "Multus or the attachment",
  bridge: "the bridge, its VLAN filtering, or the Custodian pod of this node",
  frames: "the node's firewall on the bridge",
  rules: `the rule table ${RULES_TABLE}`,
  service: "the dial to a Service address",
  node: "the VLANs of the bridge",
};

type ProbePod = {
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      state?: { terminated?: { message?: string; exitCode?: number; reason?: string }; waiting?: { reason?: string } };
    }>;
  };
};

/** The result in a probe pod's termination message, when it has one. */
export function probeResultOf(pod: ProbePod | undefined): ProbeResult | undefined {
  const message = pod?.status?.containerStatuses?.[0]?.state?.terminated?.message ?? "";
  // Not anchored: with FallbackToLogsOnError the message can be the log, which has the line too.
  const at = message.lastIndexOf(FENCE_PROBE_PREFIX);
  if (at < 0) return undefined;
  try {
    const parsed = JSON.parse(message.slice(at + FENCE_PROBE_PREFIX.length).split("\n")[0]!) as ProbeResult;
    return typeof parsed.ok === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The gap of one ended probe pod, or undefined when it passed. */
export function gapOf(node: string, pod: ProbePod | undefined): FenceGap | undefined {
  const result = probeResultOf(pod);
  if (result?.ok === true) return undefined;
  if (result?.part !== undefined) return { node, part: PART[result.part], why: result.why ?? "" };
  const t = pod?.status?.containerStatuses?.[0]?.state?.terminated;
  return {
    node,
    part: "the probe",
    why:
      `the probe ended with no result (${t?.reason ?? pod?.status?.phase ?? "unknown"}` +
      `${t?.exitCode !== undefined ? `, exit ${t.exitCode}` : ""}): ${(t?.message ?? "").trim().slice(-300) || "no message"}`,
  };
}

/**
 * The refusal (ADR-0084, ADR-0019): each node, its part, why, what `jr2 up` replaced for it, and the
 * likely causes. `jr2 up` installed or found the admission policies, Multus and the DaemonSet
 * jr2-fence-node before the check, so a node that fails it differs from what jr2 can see from the API.
 */
export function fenceRefusal(gaps: readonly FenceGap[]): Error {
  const nodes = new Set(gaps.map((g) => g.node)).size;
  return new Error(
    [
      `fence: ${nodes === 1 ? "a Sandbox node fails" : `${nodes} Sandbox nodes fail`} the check of the Fence (ADR-0084):`,
      ...gaps.map((g) => `  ${g.node}: ${g.part} — ${g.why}${g.replaced !== undefined ? `. ${g.replaced}` : ""}`),
      "The likely causes: the node's container runtime reads its CNI plugins or configuration from a folder other " +
        `than ${CNI_BIN_DIR} and ${CNI_CONF_DIR}; a file bridge, static or tuning in ${CNI_BIN_DIR} that is not ` +
        "a stock CNI plugin that knows vlanTrunk and preserveDefaultVlan (jr2 never replaces one); a primary CNI " +
        "that removes Multus's configuration; a node firewall that changes bridged VLAN frames; or a node with no " +
        `rule table ${RULES_TABLE} (the pod of ${OPERATOR_NAMESPACE}/${FENCE_NODE_DAEMONSET} on the node loads it ` +
        "at its start). See " +
        `${FENCE_PREREQUISITES_URL}. Or keep the node out of the Sandbox nodes with sandbox.nodeSelector or a ` +
        "taint (ADR-0052). Then run `jr2 up` again.",
    ].join("\n"),
  );
}

// ---- from the API, before the Custodian is applied ------------------------------------------------

type MultusPod = {
  spec?: { nodeName?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
  metadata?: { deletionTimestamp?: string };
};

/** The nodes of `nodes` with no Ready Multus pod. */
export function nodesWithoutMultus(nodes: readonly string[], pods: readonly MultusPod[]): string[] {
  const ready = new Set(
    pods
      .filter(
        (p) =>
          p.metadata?.deletionTimestamp === undefined &&
          (p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
      )
      .map((p) => p.spec?.nodeName),
  );
  return nodes.filter((n) => !ready.has(n));
}

/**
 * The API's part of the probe, before the Custodian is applied: the attachments'
 * CustomResourceDefinition exists; when jr2 installed Multus, each Sandbox node has a Ready pod of
 * it (a Multus of another owner is judged by the probe pod's address, after the Custodian); and the
 * server-side dry runs of the guard are each denied by jr2's admission policy (`checkFenceGuard`).
 * A read that fails throws: a check that passes when it could not look is no check.
 */
export async function checkFenceApi(
  kube: Pick<KubeAdmin, "listJson" | "dryRunCreate">,
  opts: {
    nodes: readonly string[];
    multus: FenceInstallPlan["multus"];
    namespace: string;
    context?: string;
    guardSettleMs?: number;
  },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const crds = await kube.listJson({
    kind: "customresourcedefinition",
    fieldSelector: `metadata.name=${ATTACHMENT_CRD}`,
    ...ctx,
  });
  if (crds.length === 0) {
    throw new Error(
      `fence: the cluster has no CustomResourceDefinition ${ATTACHMENT_CRD}, so Multus is not installed, and ` +
        "no Harness pod can have the Fence as its network (ADR-0084). It was there when this converge began: " +
        "run `jr2 up` again, and it installs Multus when the cluster has none.",
    );
  }
  if (opts.multus !== "foreign") {
    const pods = await kube.listJson<MultusPod>({
      kind: "pod",
      selector: MULTUS_SELECTOR,
      namespace: MULTUS_NAMESPACE,
      ...ctx,
    });
    const missing = nodesWithoutMultus(opts.nodes, pods);
    if (missing.length > 0) {
      throw fenceRefusal(
        missing.map((node) => ({
          node,
          part: "Multus",
          why:
            `no Ready pod of jr2's Multus (${MULTUS_NAMESPACE}: ${MULTUS_SELECTOR}) on the node, so no pod there ` +
            "gets the Fence as its network",
        })),
      );
    }
  }
  await checkFenceGuard(kube, {
    namespace: opts.namespace,
    ...ctx,
    ...(opts.guardSettleMs !== undefined ? { settleMs: opts.guardSettleMs } : {}),
  });
}

// ---- after the Custodian is Ready: the probe pod on each of its nodes -----------------------------

/** What the probe of the nodes needs of the converge's KubeAdmin. */
export type ProbeKube = Pick<KubeAdmin, "apply" | "getJson" | "listJson" | "deleteObject">;

/**
 * Run the probe pod on each node where a Custodian pod of the Instance runs, wait for each to end,
 * and return each part that a node fails (none when each passed). The pods go again in every case. A
 * node whose probe saw no answer at all from the uplink has a Custodian pod whose trunk is not on the
 * bridge that the node has now (a bridge deleted while the pod ran): that pod is replaced, so that
 * the bridge plugin puts its new trunk on the bridge, and the next converge finds it there.
 */
export async function probeFenceNodes(
  kube: ProbeKube,
  opts: {
    name: string;
    namespace: string;
    range: number;
    ranges: FenceRanges;
    image: string;
    placement?: SandboxPlacement;
    context?: string;
    log: (line: string) => void;
    pollMs?: number;
    now?: () => number;
  },
): Promise<FenceGap[]> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const now = opts.now ?? Date.now;
  const custodians = await kube.listJson<ProbePod>({
    kind: "pod",
    selector: `app=${CUSTODIAN_SERVICE}`,
    namespace: opts.namespace,
    ...ctx,
  });
  const byNode = new Map<string, string>();
  for (const p of custodians) {
    if (p.spec?.nodeName && p.metadata?.name && !p.metadata.deletionTimestamp)
      byNode.set(p.spec.nodeName, p.metadata.name);
  }
  const nodes = [...byNode.keys()].sort();
  if (nodes.length === 0) return [];
  // The API Service's cluster address: each cluster has it, and kube-proxy (or what stands in its
  // place) rewrites a dial to it. A read that fails throws: a probe that cannot look is no probe.
  const api = await kube.getJson<{ spec?: { clusterIP?: string; ports?: Array<{ name?: string; port?: number }> } }>({
    kind: "service",
    name: "kubernetes",
    namespace: "default",
    ...ctx,
  });
  const apiPort = api?.spec?.ports?.find((p) => p.name === "https")?.port ?? api?.spec?.ports?.[0]?.port;
  if (!api?.spec?.clusterIP || api.spec.clusterIP === "None" || apiPort === undefined) {
    throw new Error(
      "fence: the cluster's Service default/kubernetes has no cluster address and port, and the check of the " +
        "Fence dials it from each Sandbox node (ADR-0084)",
    );
  }
  const service = { address: api.spec.clusterIP, port: apiPort };
  const removeAll = async () => {
    const left = await kube.listJson<ProbePod>({
      kind: "pod",
      selector: `app=${FENCE_PROBE_APP}`,
      namespace: opts.namespace,
      ...ctx,
    });
    for (const p of left) {
      if (p.metadata?.name) {
        await kube.deleteObject({ kind: "pod", name: p.metadata.name, namespace: opts.namespace, wait: true, ...ctx });
      }
    }
  };
  // A pod of an earlier converge holds slot 2's address on its node: it goes first.
  await removeAll();
  opts.log(`fence: probing the bridge on ${nodes.length} Sandbox node(s): ${nodes.join(", ")}`);
  await kube.apply({
    manifest: fenceProbePods({
      name: opts.name,
      namespace: opts.namespace,
      nodes,
      range: opts.range,
      ranges: opts.ranges,
      image: opts.image,
      service,
      ...(opts.placement ? { placement: opts.placement } : {}),
    }),
    ...ctx,
  });
  const gaps: FenceGap[] = [];
  const bridgeless: string[] = [];
  const ruleless: string[] = [];
  try {
    const waits = nodes.map((node) => ({ node, pod: probePodName(node) }));
    const started = now();
    const ended = new Map<string, ProbePod>();
    while (ended.size < waits.length) {
      for (const w of waits) {
        if (ended.has(w.pod)) continue;
        const pod = await kube.getJson<ProbePod>({ kind: "pod", name: w.pod, namespace: opts.namespace, ...ctx });
        const phase = pod?.status?.phase;
        if (phase === "Succeeded" || phase === "Failed") {
          ended.set(w.pod, pod!);
          const gap = gapOf(w.node, pod);
          if (gap) gaps.push(gap);
          if (probeResultOf(pod)?.part === "bridge") bridgeless.push(w.node);
          if (probeResultOf(pod)?.part === "rules") ruleless.push(w.node);
          continue;
        }
        const running = pod?.status?.containerStatuses?.[0]?.state?.terminated === undefined && phase === "Running";
        const waited = now() - started;
        // A pod that gets no network says why only in its events (FailedCreatePodSandBox).
        if (!running && waited >= SANDBOX_GRACE_MS) {
          const events = await kube
            .listJson<{ reason?: string; message?: string }>({
              kind: "event",
              fieldSelector: `involvedObject.name=${w.pod}`,
              namespace: opts.namespace,
              ...ctx,
            })
            .catch(() => []);
          const failed = events.filter((e) => e.reason === "FailedCreatePodSandBox").pop();
          if (failed) {
            ended.set(w.pod, pod ?? {});
            gaps.push({
              node: w.node,
              part: PART.attachment,
              why: `the probe pod got no network: ${(failed.message ?? "").slice(0, 400)}`,
            });
            continue;
          }
        }
        if (waited >= START_MS + RUN_MS) {
          ended.set(w.pod, pod ?? {});
          const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason;
          gaps.push({
            node: w.node,
            part: "the probe",
            why: `the probe pod did not end in ${(START_MS + RUN_MS) / 1000} s (${waiting ?? phase ?? "no pod"})`,
          });
        }
      }
      if (ended.size < waits.length) await sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    await removeAll().catch(() => {});
  }
  const note = (node: string, part: string, text: string) => {
    for (const g of gaps) if (g.node === node && g.part === part) g.replaced = text;
  };
  for (const node of bridgeless) {
    const pod = byNode.get(node)!;
    opts.log(
      `fence: ${node}: replacing the Custodian pod ${pod}, whose trunk did not answer on the bridge, so that it ` +
        "joins the bridge that the node has now",
    );
    await kube.deleteObject({ kind: "pod", name: pod, namespace: opts.namespace, ...ctx });
    note(
      node,
      PART.bridge,
      `jr2 up replaced the Custodian pod ${pod}, so that it joins the bridge that the node has now`,
    );
  }
  // A node with no rule table: its pod of jr2-fence-node loads the table at its start, so a new pod
  // loads it again (after a `nft flush ruleset` on the node, for example).
  if (ruleless.length > 0) {
    const pods = await kube.listJson<ProbePod>({
      kind: "pod",
      selector: `app=${FENCE_NODE_DAEMONSET}`,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    for (const node of ruleless) {
      for (const p of pods.filter((p) => p.spec?.nodeName === node && p.metadata?.name)) {
        opts.log(
          `fence: ${node}: replacing the pod ${OPERATOR_NAMESPACE}/${p.metadata!.name}, so that it loads the rule ` +
            `table ${RULES_TABLE} again`,
        );
        await kube.deleteObject({ kind: "pod", name: p.metadata!.name!, namespace: OPERATOR_NAMESPACE, ...ctx });
        note(
          node,
          PART.rules,
          `jr2 up replaced the pod ${OPERATOR_NAMESPACE}/${p.metadata!.name}, which loads the table again at its start`,
        );
      }
    }
  }
  return gaps.sort((a, b) => a.node.localeCompare(b.node));
}
