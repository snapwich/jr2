// `jr2 up` probes the parts of the Fence that it does not install (ADR-0084, ADR-0019): the second
// network of a pod (Multus), the bridge of each Sandbox node and the node's rule set. It refuses to
// converge while a Sandbox node lacks one, and it names the node and the part. One exception: a
// route probe with no answer in each try warns and does not refuse (below).
//
// From the API, before the Custodian is applied: the CustomResourceDefinition of the attachments
// exists, and a Ready Multus pod runs on each Sandbox node. After the Custodian's pods are Ready, on
// each node where one runs, two one-shot pods that `nodeName` pins there:
//
//   the Fence probe   a pod on slot 2 of the Instance's range (the same slot on each node: the
//                     bridges are separate, and nothing dials it). Its own address must be the
//                     slot's address (else Multus did not give it the attachment). A DNS query to the
//                     uplink's address must get an answer from the Custodian's resolver. When none
//                     comes, the pod's own ARP table tells the two causes apart: an answer from the
//                     uplink's MAC says that the bridge carries the frames of the VLAN, so the node
//                     changed them (NAT or conntrack: the rule set); no answer says that the bridge,
//                     its VLAN filtering, or the Custodian pod of the node does not carry them. Then
//                     the node's address must give no answer but the Custodian's.
//   the route probe   a pod on the cluster's network that dials the last address of the segment
//                     and must get "no route to host" within 1 s: the node's unreachable route.
//                     When each try gets no answer, it passes with a warning, whatever the cause.
//                     The probe cannot tell two causes apart: the node has no such route (or
//                     something drops the probe's packets), and nothing on the default route
//                     answers; or the cluster gives a pod no answer although the node has the route
//                     (seen on Cilium with BPF host routing). So on any cluster, a node with no
//                     route can pass with the warning. On a kind cluster, `jr2 up` made the route
//                     before the probe (`kind-fence.ts`).
//
// A behaviour probe with no privilege: neither pod has the node's network, a capability, a writable
// root or a token. It writes its result as its termination message, as the Repo cache agent writes
// a missing Landlock (`landlock.ts`). The limit: it sees the effect of the rule set, not the rule
// set. A node that does not change bridged frames today passes without the `notrack` rule, and the
// probe does not see the bridge's `vlan_default_pvid` or the node's IPv6 link-local address, which
// no pod without a privilege can learn.

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
import type { KubeAdmin } from "./kube.ts";

/** The slot of the Fence probe in each range (ADR-0084: slot 0 the Instance Harness, slot 1 the check
 * pod, slot 2 the node probes). */
export const FENCE_PROBE_SLOT = 2;
/** The `app` label of the probe pods. */
export const FENCE_PROBE_APP = "jr2-fence-probe";
/** The start of each probe's result line (its termination message). */
export const FENCE_PROBE_PREFIX = "jr2.fence-probe ";
/** The CustomResourceDefinition of the attachments: Multus's. */
export const ATTACHMENT_CRD = "network-attachment-definitions.k8s.cni.cncf.io";
/** The label of a Multus pod, as the Multus manifests set it. */
export const MULTUS_SELECTOR = "app=multus";
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

// ---- the two probes: each runs in its pod as `node -e`, and is called directly by its test --------

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
  probe: "fence" | "route";
  ok: boolean;
  /** The part that a failed probe names. */
  part?: "attachment" | "bridge" | "rule-set";
  /** What the probe saw, in words a person acts on. */
  why?: string;
  /** A probe that passed but could not see its part: what `jr2 up` prints as a warning. */
  warn?: string;
};

/**
 * The Fence probe (on slot 2 of the range). Self-contained: its text is the pod's program, so it
 * names nothing outside itself. Its inputs are env variables that the pod sets: `JR2_PROBE_ADDRESS`
 * (the slot's address), `JR2_PROBE_UPLINK` (the uplink's address), `JR2_PROBE_UPLINK_MAC`,
 * `JR2_PROBE_VLAN`, `JR2_PROBE_NODE` (the node's address), `JR2_PROBE_NODE_PORT`,
 * `JR2_PROBE_DNS_PORT`, `JR2_PROBE_ARP` (the ARP table) and `JR2_PROBE_MESSAGE` (where the result
 * goes).
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
        "Multus did not give the pod the slot's attachment as its default network",
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
        part: "rule-set",
        why:
          `the uplink answers on VLAN ${vlan} of the bridge (ARP from ${mac}), but no DNS query to ${uplink} got ` +
          "an answer: the node changes the frames that it bridges (NAT or conntrack: no notrack rule for the " +
          "bridge), and the uplink drops a frame whose source is not the slot's address",
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

  // 3. The node's address gives no answer but the Custodian's: the uplink takes each TCP connection.
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
      part: "rule-set",
      why:
        `the node answers on the bridge: a connection to its address ${node}:${nodePort} got an answer that is ` +
        `not the Custodian's (${JSON.stringify(said.slice(0, 60))})`,
    });
  }
  return end({ ok: true });
}

/**
 * The route probe (on the cluster's network). Self-contained, as the Fence probe is. Its inputs:
 * `JR2_PROBE_TARGET` (the last address of the segment), `JR2_PROBE_SEGMENT`, `JR2_PROBE_NODE_NAME`,
 * `JR2_PROBE_MESSAGE`.
 */
export async function routeProbeMain(sys: ProbeSys): Promise<void> {
  const env = sys.env;
  const end = (r: Record<string, unknown>) => {
    const line = "jr2.fence-probe " + JSON.stringify({ probe: "route", ...r });
    try {
      sys.fs.writeFileSync(env.JR2_PROBE_MESSAGE ?? "/dev/termination-log", line);
    } catch {
      // The log carries it too (FallbackToLogsOnError).
    }
    sys.log(line);
    sys.exit(r.ok ? 0 : 1);
  };
  const target = env.JR2_PROBE_TARGET ?? "";
  const segment = env.JR2_PROBE_SEGMENT ?? "";
  const node = env.JR2_PROBE_NODE_NAME ?? "the node";
  const port = Number(env.JR2_PROBE_TARGET_PORT ?? "9");
  // A try with no answer in 1 s is made again with a new socket, at most 3 times: on a loaded node the
  // refusal can come after the timer, and TCP sends the SYN again only at 1 s. "No route to host"
  // passes; any other answer refuses at once. No answer in each try passes with a warning that names
  // both causes, because the probe cannot tell them apart: no route, or a cluster that gives a pod no
  // answer although the node has the route (seen on Cilium with BPF host routing).
  const tries = 3;
  let started = Date.now();
  let code = "";
  for (let i = 0; i < tries && code === ""; i++) {
    started = Date.now();
    code = await new Promise<string>((resolve) => {
      const socket = sys.net.connect({ host: target, port });
      const done = (c: string) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(c);
      };
      const timer = setTimeout(() => done(""), 1000);
      socket.on("connect", () => done("CONNECTED"));
      socket.on("error", (e: NodeJS.ErrnoException) => done(e.code ?? e.message));
    });
  }
  if (code === "EHOSTUNREACH") return end({ ok: true });
  if (code === "") {
    return end({
      ok: true,
      warn:
        `the check could not see the unreachable route for ${segment} on ${node}, because a connection to ` +
        `${target}:${port} from the cluster's network got no answer in 1 s in each of ${tries} tries. The check ` +
        "cannot tell two causes apart. The node has no such route, or something drops the probe's packets. Or the " +
        "cluster gives a pod no answer although the node has the route (this was seen on Cilium with BPF host " +
        "routing). Make sure that the node has the route (ADR-0084)",
    });
  }
  return end({
    ok: false,
    part: "rule-set",
    why:
      `no unreachable route for ${segment} on the node: a connection to ${target}:${port} from the cluster's network ` +
      `got ${code} after ${Date.now() - started} ms, not "no route to host"`,
  });
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
export const ROUTE_PROBE_PROGRAM = programOf(routeProbeMain);

// ---- the pods -------------------------------------------------------------------------------------

/** The last address of a segment but one: no slot has it, because a range ends at VLAN 3969. */
export function routeProbeTarget(segment: string): string {
  const prefix = Number(segment.split("/")[1]);
  return slotAddress(segment, 2 ** (32 - prefix) - 2);
}

/** A short, stable part of a pod name for a node: node names can be 253 characters long. */
const nodeKey = (node: string): string => createHash("sha256").update(node).digest("hex").slice(0, 10);

/** The names of the two probe pods of a node. */
export function probePodNames(node: string): { fence: string; route: string } {
  return { fence: `jr2-fence-probe-${nodeKey(node)}`, route: `jr2-fence-route-${nodeKey(node)}` };
}

type Json = Record<string, unknown>;

/** The two probe pods of each node, as one List. */
export function fenceProbePods(opts: {
  name: string;
  namespace: string;
  nodes: readonly string[];
  range: number;
  ranges: FenceRanges;
  /** The Orchestrator Kit image: the Custodian's `control` image, so each node has it. */
  image: string;
  placement?: SandboxPlacement;
}): string {
  const vlan = slotVlan(opts.range, FENCE_PROBE_SLOT);
  const uplink = slotAddress(opts.ranges.segment, 1);
  const size = KIT_POD_SIZES.fenceProbe;
  const pod = (podName: string, node: string, fence: boolean, program: string, env: Json[]): Json => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: opts.namespace,
      labels: { [LABEL_INSTANCE]: opts.name, "app.kubernetes.io/managed-by": "jr2", app: FENCE_PROBE_APP },
      annotations: {
        "jr2.dev/node": node,
        ...(fence
          ? { "v1.multus-cni.io/default-network": `${opts.namespace}/${fenceSlotAttachment(FENCE_PROBE_SLOT)}` }
          : {}),
      },
    },
    spec: {
      nodeName: node,
      restartPolicy: "Never",
      activeDeadlineSeconds: (START_MS + RUN_MS) / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // On the Fence, the uplink is the only nameserver, as for a Harness pod.
      ...(fence ? { dnsPolicy: "None", dnsConfig: { nameservers: [uplink] } } : {}),
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
          command: ["node", "-e", program],
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
    const names = probePodNames(node);
    items.push(
      pod(names.fence, node, true, FENCE_PROBE_PROGRAM, [
        { name: "JR2_PROBE_ADDRESS", value: slotAddress(opts.ranges.segment, vlan) },
        { name: "JR2_PROBE_UPLINK", value: uplink },
        { name: "JR2_PROBE_UPLINK_MAC", value: uplinkMac(vlan) },
        { name: "JR2_PROBE_VLAN", value: String(vlan) },
        { name: "JR2_PROBE_NODE", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
        { name: "JR2_PROBE_NODE_PORT", value: String(NODE_PORT) },
        { name: "JR2_PROBE_DNS_PORT", value: "53" },
        { name: "JR2_PROBE_ARP", value: "/proc/net/arp" },
      ]),
      pod(names.route, node, false, ROUTE_PROBE_PROGRAM, [
        { name: "JR2_PROBE_TARGET", value: routeProbeTarget(opts.ranges.segment) },
        { name: "JR2_PROBE_SEGMENT", value: opts.ranges.segment },
        { name: "JR2_PROBE_NODE_NAME", value: node },
      ]),
    );
  }
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

// ---- what the probes said -------------------------------------------------------------------------

/** One part that a Sandbox node lacks, in words a person acts on. */
export type FenceGap = { node: string; part: string; why: string };

/** The words for each part a probe names. */
const PART: Record<NonNullable<ProbeResult["part"]>, string> = {
  attachment: "Multus or the attachment",
  bridge: "the bridge, its VLAN filtering, or the Custodian pod of this node",
  "rule-set": "the rule set",
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
export function gapOf(node: string, probe: "fence" | "route", pod: ProbePod | undefined): FenceGap | undefined {
  const result = probeResultOf(pod);
  if (result?.ok === true) return undefined;
  if (result?.part !== undefined) return { node, part: PART[result.part], why: result.why ?? "" };
  const t = pod?.status?.containerStatuses?.[0]?.state?.terminated;
  return {
    node,
    part: "the probe",
    why:
      `the ${probe} probe ended with no result (${t?.reason ?? pod?.status?.phase ?? "unknown"}` +
      `${t?.exitCode !== undefined ? `, exit ${t.exitCode}` : ""}): ${(t?.message ?? "").trim().slice(-300) || "no message"}`,
  };
}

/** The page that lists the parts of the Fence on a node, for a cluster that is not kind. */
export const FENCE_PARTS_URL =
  "https://snapwich.github.io/jr2/guides/move-from-kind-to-a-shared-cluster.html#check-the-cluster";

/** What to do about a missing part. On a kind cluster, `jr2 up` made each part at this converge
 * (`kind-fence.ts`), so a part that is still missing changed since, or cannot work on this host. */
function fenceFix(kind: string | undefined): string {
  return kind === undefined
    ? `Give each such node the part as ${FENCE_PARTS_URL} lists it, or keep the node out of the Sandbox nodes ` +
        "with sandbox.nodeSelector or a taint (ADR-0052). Then run `jr2 up` again."
    : `jr2 up made the Fence's node parts on each node of the kind cluster "${kind}" before this check, so a part ` +
        "that the check misses changed since, or does not work on this host. Run `jr2 up` again. When the check " +
        `fails again, compare each node with the parts that ${FENCE_PARTS_URL} lists.`;
}

/** The refusal (ADR-0084, ADR-0019): each node, its part, why, and the fix. `kind` is the name of a
 * kind cluster, whose parts `jr2 up` made. */
export function fenceRefusal(gaps: readonly FenceGap[], kind?: string): Error {
  const nodes = new Set(gaps.map((g) => g.node)).size;
  return new Error(
    [
      `fence: ${nodes === 1 ? "a Sandbox node lacks" : `${nodes} Sandbox nodes lack`} a part of the Fence (ADR-0084):`,
      ...gaps.map((g) => `  ${g.node}: ${g.part} — ${g.why}`),
      fenceFix(kind),
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
 * The API's part of the probe: the attachments' CustomResourceDefinition exists, and each Sandbox
 * node has a Ready Multus pod. Read before the Custodian is applied: without the definition its
 * attachments cannot be applied, and without Multus on a node its pod there never starts. A read
 * that fails throws: a check that passes when it could not look is no check.
 */
export async function checkFenceApi(
  kube: Pick<KubeAdmin, "listJson">,
  opts: { nodes: readonly string[]; context?: string; kind?: string },
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
        "no Harness pod can have the Fence as its network (ADR-0084). " +
        (opts.kind === undefined
          ? `Install Multus as ${FENCE_PARTS_URL} says, then run \`jr2 up\` again.`
          : `jr2 up applied Multus to the kind cluster "${opts.kind}" at this converge, and the definition is not ` +
            "there now: run `jr2 up` again."),
    );
  }
  const pods = await kube.listJson<MultusPod>({ kind: "pod", selector: MULTUS_SELECTOR, allNamespaces: true, ...ctx });
  const missing = nodesWithoutMultus(opts.nodes, pods);
  if (missing.length > 0) {
    throw fenceRefusal(
      missing.map((node) => ({
        node,
        part: "Multus",
        why: `no Ready Multus pod (${MULTUS_SELECTOR}) on the node, so no pod there gets the Fence as its network`,
      })),
      opts.kind,
    );
  }
}

// ---- after the Custodian is Ready: the two pods on each of its nodes -----------------------------

/** What the probe of the nodes needs of the converge's KubeAdmin. */
export type ProbeKube = Pick<KubeAdmin, "apply" | "getJson" | "listJson" | "deleteObject">;

/**
 * Run the two probe pods on each node where a Custodian pod of the Instance runs, wait for each to
 * end, and return each part that a node lacks (none when each passed). A probe that passed but could
 * not see its part goes to `warn`. The pods go again in every case. A node whose Fence probe saw no
 * answer at all from the uplink has a Custodian pod whose trunk is not on the bridge that the node
 * has now (a bridge deleted and made again): that pod is replaced, so that the next converge after
 * the fix finds its trunk there.
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
    /** A probe that passed but could not see its part. */
    warn: (line: string) => void;
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
  opts.log(`fence: probing the bridge and the rule set on ${nodes.length} Sandbox node(s): ${nodes.join(", ")}`);
  await kube.apply({
    manifest: fenceProbePods({
      name: opts.name,
      namespace: opts.namespace,
      nodes,
      range: opts.range,
      ranges: opts.ranges,
      image: opts.image,
      ...(opts.placement ? { placement: opts.placement } : {}),
    }),
    ...ctx,
  });
  const gaps: FenceGap[] = [];
  const bridgeless: string[] = [];
  try {
    const waits = nodes.flatMap((node) => {
      const names = probePodNames(node);
      return [
        { node, probe: "fence" as const, pod: names.fence },
        { node, probe: "route" as const, pod: names.route },
      ];
    });
    const started = now();
    const ended = new Map<string, ProbePod>();
    while (ended.size < waits.length) {
      for (const w of waits) {
        if (ended.has(w.pod)) continue;
        const pod = await kube.getJson<ProbePod>({ kind: "pod", name: w.pod, namespace: opts.namespace, ...ctx });
        const phase = pod?.status?.phase;
        if (phase === "Succeeded" || phase === "Failed") {
          ended.set(w.pod, pod!);
          const gap = gapOf(w.node, w.probe, pod);
          if (gap) gaps.push(gap);
          const warn = gap ? undefined : probeResultOf(pod)?.warn;
          if (warn) opts.warn(`fence: ${warn}`);
          if (w.probe === "fence" && probeResultOf(pod)?.part === "bridge") bridgeless.push(w.node);
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
              part: w.probe === "fence" ? PART.attachment : "the network of the cluster",
              why: `the ${w.probe} probe pod got no network: ${(failed.message ?? "").slice(0, 400)}`,
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
            why: `the ${w.probe} probe pod did not end in ${(START_MS + RUN_MS) / 1000} s (${waiting ?? phase ?? "no pod"})`,
          });
        }
      }
      if (ended.size < waits.length) await sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    await removeAll().catch(() => {});
  }
  for (const node of bridgeless) {
    const pod = byNode.get(node)!;
    opts.log(
      `fence: ${node}: replacing the Custodian pod ${pod}, whose trunk did not answer on the bridge, so that it ` +
        "joins the bridge that the node has after the fix",
    );
    await kube.deleteObject({ kind: "pod", name: pod, namespace: opts.namespace, ...ctx });
  }
  return gaps.sort((a, b) => a.node.localeCompare(b.node));
}
