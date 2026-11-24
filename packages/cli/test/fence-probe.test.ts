// The probe of the Fence on each Sandbox node (ADR-0084, ADR-0019): its pod, the probe program
// (called here with real sockets on the loopback and a fake ARP table and address list), what `jr2 up`
// reads from each ended pod, and the refusal that names each node, the part and the likely causes.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as dgram from "node:dgram";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { fenceRangesOf } from "@jr2/orchestrator/internal";
import {
  checkFenceApi,
  FENCE_PROBE_PROGRAM,
  fenceProbeMain,
  fenceProbePods,
  fenceRefusal,
  gapOf,
  nodesWithoutMultus,
  probeFenceNodes,
  probePodName,
  probeResultOf,
  type ProbeKube,
  type ProbeResult,
  type ProbeSys,
} from "../src/fence-probe.ts";
import { FENCE_PREREQUISITES_URL } from "../src/fence-install.ts";

const exec = promisify(execFile);
const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-fence-probe-"));
  roots.push(dir);
  return dir;
}

// ---- the pods ---------------------------------------------------------------------------------------

test("one one-shot pod on each node, pinned by nodeName, with no privilege, no token and no node network", () => {
  const list = JSON.parse(
    fenceProbePods({
      name: "inst",
      namespace: "ns",
      nodes: ["node-a", "node-b"],
      range: 2,
      ranges: fenceRangesOf(undefined),
      image: "jr2-orchestrator:x",
      service: { address: "10.96.0.1", port: 443 },
      placement: { tolerations: [{ key: "k", operator: "Exists", effect: "NoSchedule" }] },
    }),
  ) as { items: Array<Record<string, any>> };
  assert.deepEqual(
    list.items.map((p) => [p.metadata.name, p.spec.nodeName]),
    [
      [probePodName("node-a"), "node-a"],
      [probePodName("node-b"), "node-b"],
    ],
  );
  for (const pod of list.items) {
    const spec = pod.spec;
    assert.equal(spec.hostNetwork, undefined);
    assert.equal(spec.restartPolicy, "Never");
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.securityContext.runAsNonRoot, true);
    assert.deepEqual(spec.tolerations, [{ key: "k", operator: "Exists", effect: "NoSchedule" }]);
    const [c] = spec.containers;
    assert.equal(spec.containers.length, 1);
    assert.equal(c.image, "jr2-orchestrator:x");
    assert.deepEqual(c.command.slice(0, 2), ["node", "-e"]);
    assert.deepEqual(c.securityContext, {
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    assert.equal(c.terminationMessagePolicy, "FallbackToLogsOnError");
    assert.equal(c.resources.requests.memory, c.resources.limits.memory);
    assert.equal(pod.metadata.labels.app, "jr2-fence-probe");
    assert.equal(pod.metadata.labels["jr2.dev/instance"], "inst");
  }
  const [fence] = list.items;
  const env = (p: any) =>
    Object.fromEntries(p.spec.containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
  // The Fence probe: slot 2 of range 2 is VLAN 260, and the uplink is the only nameserver.
  assert.equal(fence!.metadata.annotations["v1.multus-cni.io/default-network"], "ns/jr2-fence-2");
  assert.deepEqual(fence!.spec.dnsConfig, { nameservers: ["198.19.0.1"] });
  assert.equal(fence!.spec.dnsPolicy, "None");
  assert.equal(env(fence).JR2_PROBE_ADDRESS, "198.19.1.4");
  assert.equal(env(fence).JR2_PROBE_UPLINK_MAC, "02:00:c6:12:01:04");
  assert.deepEqual(env(fence).JR2_PROBE_NODE, { fieldRef: { fieldPath: "status.hostIP" } });
  // The API Service's cluster address, which the node's NAT would change without the rule table.
  assert.equal(env(fence).JR2_PROBE_SERVICE, "10.96.0.1");
  assert.equal(env(fence).JR2_PROBE_SERVICE_PORT, "443");
});

// ---- the Fence probe's program ------------------------------------------------------------------------

type Run = { code?: number; message?: ProbeResult; log: string[] };

/** Run the Fence probe in this process: real sockets on the loopback, a fake address list and ARP
 * table. */
async function runFence(opts: {
  addresses?: string[];
  dnsPort: number;
  nodePort: number;
  /** The port of the "API Service" on the loopback; a closed port (a reset, as the Custodian's) by default. */
  servicePort?: number;
  /** The dial to the "API Service" gets no SYN-ACK: the sign of the node's NAT. */
  serviceBlackhole?: boolean;
  arp?: string;
}): Promise<Run> {
  const dir = await scratch();
  const arpFile = join(dir, "arp");
  await writeFile(
    arpFile,
    opts.arp ?? "IP address       HW type     Flags       HW address            Mask     Device\n",
  );
  const run: Run = { log: [] };
  const servicePort = opts.servicePort ?? (await closedPort());
  // A socket that never connects and never fails, as a dial whose SYN the node's NAT sent elsewhere.
  const blackhole = {
    ...net,
    connect: (o: net.NetConnectOpts) =>
      (o as net.TcpNetConnectOpts).port === servicePort ? new net.Socket() : net.connect(o),
  } as typeof net;
  const sys: ProbeSys = {
    dgram,
    net: opts.serviceBlackhole ? blackhole : net,
    os: {
      networkInterfaces: () => ({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: (opts.addresses ?? ["198.19.1.4"]).map((address) => ({ address, family: "IPv4", internal: false })),
      }),
    } as unknown as typeof os,
    fs,
    env: {
      JR2_PROBE_ADDRESS: "198.19.1.4",
      JR2_PROBE_UPLINK: "127.0.0.1",
      JR2_PROBE_UPLINK_MAC: "02:00:c6:12:01:04",
      JR2_PROBE_VLAN: "260",
      JR2_PROBE_SERVICE: "127.0.0.1",
      JR2_PROBE_SERVICE_PORT: String(servicePort),
      JR2_PROBE_NODE: "127.0.0.1",
      JR2_PROBE_NODE_PORT: String(opts.nodePort),
      JR2_PROBE_DNS_PORT: String(opts.dnsPort),
      JR2_PROBE_ARP: arpFile,
      JR2_PROBE_MESSAGE: join(dir, "message"),
    },
    log: (line) => run.log.push(line),
    exit: (code) => void (run.code = code),
  };
  await fenceProbeMain(sys);
  const text = await readFile(join(dir, "message"), "utf8");
  run.message = probeResultOf({ status: { containerStatuses: [{ state: { terminated: { message: text } } }] } });
  return run;
}

/** A DNS server on the loopback that answers each query with REFUSED, as the resolver does for a
 * slot with no rules. */
async function refusingResolver(): Promise<{ port: number; close: () => void }> {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, from) => {
    const reply = Buffer.from(msg);
    reply[2] = 0x81;
    reply[3] = 0x05;
    socket.send(reply, from.port, from.address);
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return { port: socket.address().port, close: () => socket.close() };
}

/** A TCP server on the loopback that answers each connection with `text`. */
async function answering(text: string): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((s) => s.end(text));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** A port on the loopback that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** A TCP server on the loopback that takes each connection and never answers. */
async function silent(): Promise<{ port: number; close: () => void }> {
  const held: net.Socket[] = [];
  const server = net.createServer((s) => void held.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const s of held) s.destroy();
      server.close();
    },
  };
}

const arpWith = (mac: string) =>
  "IP address       HW type     Flags       HW address            Mask     Device\n" +
  `127.0.0.1        0x1         0x2         ${mac}     *        eth0\n`;

test("the Fence probe passes when the resolver answers and the node's address answers with nothing of its own", async () => {
  const dns = await refusingResolver();
  try {
    const closed = await runFence({ dnsPort: dns.port, nodePort: await closedPort() });
    assert.equal(closed.code, 0);
    assert.deepEqual(closed.message, { probe: "fence", ok: true });
    // The Custodian's own refusal of an address with no entry is not the node's answer.
    const custodian = await answering("jr2 custodian: refused: 127.0.0.1:10250 is not on the Egress list\n");
    try {
      assert.equal((await runFence({ dnsPort: dns.port, nodePort: custodian.port })).code, 0);
    } finally {
      custodian.close();
    }
  } finally {
    dns.close();
  }
});

test("the Fence probe passes a dial to the API Service that the Custodian refuses (a reset, or a line of jr2's); a SYN with no answer names the rule table; a silent peer has its own cause", async () => {
  const dns = await refusingResolver();
  const custodian = await answering("jr2 custodian: refused: 10.96.0.1:443 is not on the Egress list\n");
  const quiet = await silent();
  const apiServer = await answering(
    "HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n",
  );
  try {
    const nodePort = await closedPort();
    assert.equal((await runFence({ dnsPort: dns.port, nodePort, servicePort: custodian.port })).code, 0);
    const [nat, accepted, other] = await Promise.all([
      runFence({ dnsPort: dns.port, nodePort, serviceBlackhole: true }),
      runFence({ dnsPort: dns.port, nodePort, servicePort: quiet.port }),
      runFence({ dnsPort: dns.port, nodePort, servicePort: apiServer.port }),
    ]);
    assert.equal(nat.code, 1);
    assert.equal(nat.message?.part, "rules");
    assert.match(
      nat.message!.why!,
      /^a connection to the API Service's address 127\.0\.0\.1:\d+ got no answer to its SYN in 3 s \(timeout\), where the Custodian refuses it at once: the node changes a Sandbox's frames before the bridge carries them to the uplink \(the NAT of kube-proxy, with net\.bridge\.bridge-nf-call-iptables = 1\), so the rule table inet jr2_fence is not loaded on the node$/,
    );
    // Something took the connection and says nothing: not the NAT's sign, and not the rule table.
    assert.equal(accepted.code, 1);
    assert.equal(accepted.message?.part, "service");
    assert.match(
      accepted.message!.why!,
      /^a connection to the API Service's address 127\.0\.0\.1:\d+ was accepted, but no byte and no close came in 3 s, where the Custodian refuses it at once: a peer that is not the Custodian took the connection$/,
    );
    assert.equal(other.code, 1);
    assert.equal(other.message?.part, "node");
    assert.match(other.message!.why!, /got an answer that is not the Custodian's \("HTTP\/1\.0 400 Bad Request/);
  } finally {
    dns.close();
    custodian.close();
    quiet.close();
    apiServer.close();
  }
});

test("the Fence probe names the VLANs of the bridge when the node answers on the bridge", async () => {
  const dns = await refusingResolver();
  const kubelet = await answering("HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n");
  try {
    const run = await runFence({ dnsPort: dns.port, nodePort: kubelet.port });
    assert.equal(run.code, 1);
    assert.equal(run.message?.part, "node");
    assert.match(
      run.message!.why!,
      /^the node answers on the bridge \(its own side of the bridge is in the slot's VLAN\): a connection to its address 127\.0\.0\.1:\d+/,
    );
  } finally {
    dns.close();
    kubelet.close();
  }
});

test("the Fence probe names the attachment when its address is not the slot's", async () => {
  const run = await runFence({ addresses: ["10.244.1.7"], dnsPort: 1, nodePort: 1 });
  assert.equal(run.code, 1);
  assert.equal(run.message?.part, "attachment");
  assert.match(run.message!.why!, /address is 10\.244\.1\.7, not the slot's address 198\.19\.1\.4: Multus did not/);
});

test("no DNS answer: the uplink's MAC in the ARP table names the node's firewall on the bridge, no ARP answer names the bridge", async () => {
  const port = await closedPort();
  // Each waits 3 s for a DNS answer that does not come: at the same time.
  const [nat, none, other] = await Promise.all([
    runFence({ dnsPort: port, nodePort: port, arp: arpWith("02:00:C6:12:01:04") }),
    runFence({ dnsPort: port, nodePort: port }),
    runFence({ dnsPort: port, nodePort: port, arp: arpWith("aa:bb:cc:dd:ee:ff") }),
  ]);
  assert.equal(nat.code, 1);
  assert.equal(nat.message?.part, "frames");
  assert.match(nat.message!.why!, /the uplink answers on VLAN 260 of the bridge \(ARP from 02:00:c6:12:01:04\)/);
  assert.match(nat.message!.why!, /NAT or conntrack on bridged VLAN frames/);

  assert.equal(none.message?.part, "bridge");
  assert.match(
    none.message!.why!,
    /no answer from the uplink at 127\.0\.0\.1 on VLAN 260 \(no ARP answer, no DNS answer\)/,
  );

  assert.equal(other.message?.part, "bridge");
  assert.match(other.message!.why!, /answers from aa:bb:cc:dd:ee:ff, not from the uplink's 02:00:c6:12:01:04/);
});

test("the program text runs as `node -e`, writes its result as the termination message and exits 1 on a gap", async () => {
  const dir = await scratch();
  const message = join(dir, "message");
  const run = await exec(process.execPath, ["-e", FENCE_PROBE_PROGRAM], {
    env: { PATH: process.env.PATH, JR2_PROBE_ADDRESS: "198.19.250.250", JR2_PROBE_MESSAGE: message },
  }).then(
    () => ({ code: 0 }),
    (e: { code?: number }) => ({ code: e.code }),
  );
  assert.equal(run.code, 1);
  const result = probeResultOf({
    status: { containerStatuses: [{ state: { terminated: { message: await readFile(message, "utf8") } } }] },
  });
  assert.equal(result?.part, "attachment");
});

// ---- what `jr2 up` reads --------------------------------------------------------------------------------

const ended = (message: string, exitCode = 1) => ({
  status: {
    phase: exitCode === 0 ? "Succeeded" : "Failed",
    containerStatuses: [{ state: { terminated: { message, exitCode } } }],
  },
});

test("a gap names the node, the part and why; a pod with no result is a gap of the probe itself", () => {
  const line = `jr2.fence-probe ${JSON.stringify({ probe: "fence", ok: false, part: "frames", why: "no DNS" })}`;
  assert.deepEqual(gapOf("n1", ended(line)), { node: "n1", part: "the node's firewall on the bridge", why: "no DNS" });
  // FallbackToLogsOnError: the line inside the log.
  assert.equal(gapOf("n1", ended(`some log\n${line}\n`))?.part, "the node's firewall on the bridge");
  assert.equal(gapOf("n1", ended(`jr2.fence-probe ${JSON.stringify({ probe: "fence", ok: true })}`, 0)), undefined);
  const crashed = gapOf("n2", ended("TypeError: x is not a function", 2));
  assert.equal(crashed?.part, "the probe");
  assert.match(crashed!.why, /the probe ended with no result \(Failed, exit 2\): TypeError: x is not a function/);
});

test("the refusal names each node and part, and the likely causes, with the page of the prerequisites", () => {
  const gaps = [
    { node: "n2", part: "the VLANs of the bridge", why: "the node answers on the bridge" },
    { node: "n2", part: "the bridge, its VLAN filtering, or the Custodian pod of this node", why: "no answer" },
    { node: "n1", part: "Multus", why: "no Ready Multus pod" },
  ];
  const lines = fenceRefusal(gaps).message.split("\n");
  assert.equal(lines[0], "fence: 2 Sandbox nodes fail the check of the Fence (ADR-0084):");
  assert.equal(lines[1], "  n2: the VLANs of the bridge — the node answers on the bridge");
  assert.equal(
    lines.at(-1)!,
    "The likely causes: the node's container runtime reads its CNI plugins or configuration from a folder other " +
      "than /opt/cni/bin and /etc/cni/net.d; a file bridge, static or tuning in /opt/cni/bin that is not a stock " +
      "CNI plugin that knows vlanTrunk and preserveDefaultVlan (jr2 never replaces one); a primary CNI that " +
      "removes Multus's configuration; a node firewall that changes bridged VLAN frames; or a node with no rule " +
      "table inet jr2_fence (the pod of jr2-system/jr2-fence-node on the node loads it at its start). See " +
      `${FENCE_PREREQUISITES_URL}. Or keep the node out of the Sandbox nodes with sandbox.nodeSelector or a taint ` +
      "(ADR-0052). Then run `jr2 up` again.",
  );
  assert.doesNotMatch(fenceRefusal(gaps).message, /kind cluster|just |rule set|route|replaced/);
  // A replacement is said only on the gap that it was made for.
  const replaced = fenceRefusal([
    { node: "n1", part: "the rule table inet jr2_fence", why: "w", replaced: "jr2 up replaced the pod jr2-system/p" },
    { node: "n2", part: "the dial to a Service address", why: "v" },
  ]).message.split("\n");
  assert.equal(replaced[1], "  n1: the rule table inet jr2_fence — w. jr2 up replaced the pod jr2-system/p");
  assert.equal(replaced[2], "  n2: the dial to a Service address — v");
  assert.equal(
    gapOf("n3", ended(`jr2.fence-probe ${JSON.stringify({ probe: "fence", ok: false, part: "rules", why: "w" })}`))
      ?.part,
    "the rule table inet jr2_fence",
  );
  assert.match(fenceRefusal([{ node: "x", part: "p", why: "w" }]).message, /^fence: a Sandbox node fails/);
});

test("from the API: no attachment definition, or a Sandbox node with no Ready pod of jr2's Multus, refuses; a Multus of another owner is not read; then the guard's dry runs, then the audit", async () => {
  const ready = (node: string, status = "True") => ({
    spec: { nodeName: node },
    status: { conditions: [{ type: "Ready", status }] },
  });
  assert.deepEqual(nodesWithoutMultus(["a", "b", "c"], [ready("a"), ready("b", "False"), ready("x")]), ["b", "c"]);

  const denied = (policy: string) =>
    new Error(
      `Error from server (Forbidden): ValidatingAdmissionPolicy '${policy}' with binding '${policy}' denied request: no`,
    );
  const calls: string[] = [];
  const kube = (crds: unknown[], pods: unknown[]) => ({
    async listJson(opts: { kind: string; selector?: string; namespace?: string; fieldSelector?: string }) {
      calls.push(`list ${opts.kind}`);
      if (opts.kind === "customresourcedefinition") {
        assert.equal(opts.fieldSelector, "metadata.name=network-attachment-definitions.k8s.cni.cncf.io");
        return crds as never[];
      }
      // The audit's lists (fence-guard.test.ts judges what they hold).
      if (opts.kind === "namespace" || opts.kind === "network-attachment-definitions.k8s.cni.cncf.io") return [];
      if (opts.kind === "pod" && opts.selector === undefined) return [];
      assert.deepEqual([opts.namespace, opts.selector], ["kube-system", "app=multus"]);
      return pods as never[];
    },
    async dryRunCreate({ manifest }: { manifest: string }): Promise<never> {
      const o = JSON.parse(manifest) as { kind: string };
      calls.push(`dry-run ${o.kind}`);
      throw denied(o.kind === "Pod" ? "jr2-fence-guard-pods" : "jr2-fence-guard-attachments");
    },
  });
  await assert.rejects(
    checkFenceApi(kube([], []), { nodes: ["a"], multus: "jr2", namespace: "inst" }),
    (e: Error) =>
      e.message.includes(
        "no CustomResourceDefinition network-attachment-definitions.k8s.cni.cncf.io, so Multus is not installed",
      ) &&
      e.message.includes("run `jr2 up` again, and it installs Multus when the cluster has none") &&
      !/kind cluster|just /.test(e.message),
  );
  await assert.rejects(
    checkFenceApi(kube([{}], [ready("a")]), { nodes: ["a", "b"], multus: "install", namespace: "inst" }),
    /fence: a Sandbox node fails .*\n {2}b: Multus — no Ready pod of jr2's Multus \(kube-system: app=multus\) on the node/,
  );
  calls.length = 0;
  await checkFenceApi(kube([{}], [ready("a"), ready("b")]), { nodes: ["a", "b"], multus: "jr2", namespace: "inst" });
  assert.deepEqual(calls, [
    "list customresourcedefinition",
    "list pod",
    "dry-run Pod",
    "dry-run Pod",
    "dry-run NetworkAttachmentDefinition",
    "list namespace",
    "list pod",
    "list network-attachment-definitions.k8s.cni.cncf.io",
  ]);
  // A Multus of another owner: jr2 does not look for its pods; the probe pod's address judges it.
  calls.length = 0;
  await checkFenceApi(kube([{}], []), { nodes: ["a", "b"], multus: "foreign", namespace: "inst" });
  assert.deepEqual(calls, [
    "list customresourcedefinition",
    "dry-run Pod",
    "dry-run Pod",
    "dry-run NetworkAttachmentDefinition",
    "list namespace",
    "list pod",
    "list network-attachment-definitions.k8s.cni.cncf.io",
  ]);
});

// ---- the probe of the nodes, through a fake API -----------------------------------------------------------

test("each Custodian node gets a probe pod; their gaps come back; a node with no uplink answer gets a new Custodian pod", async () => {
  const fence = (r: object) => `jr2.fence-probe ${JSON.stringify({ probe: "fence", ...r })}`;
  const results: Record<string, string> = {
    [probePodName("node-a")]: fence({ ok: false, part: "node", why: "the node answers on the bridge" }),
    [probePodName("node-b")]: fence({ ok: false, part: "bridge", why: "no answer from the uplink" }),
    [probePodName("node-c")]: fence({ ok: true }),
    [probePodName("node-e")]: fence({ ok: false, part: "rules", why: "no answer from the API Service" }),
    [probePodName("node-f")]: fence({ ok: false, part: "service", why: "a peer took the connection" }),
  };
  const calls: string[] = [];
  let polls = 0;
  const kube: ProbeKube = {
    async listJson<T>(opts: { kind: string; selector?: string }): Promise<T[]> {
      calls.push(`list ${opts.kind} ${opts.selector}`);
      if (opts.selector === "app=jr2-custodian") {
        return [
          { metadata: { name: "cust-b" }, spec: { nodeName: "node-b" } },
          { metadata: { name: "cust-a" }, spec: { nodeName: "node-a" } },
          { metadata: { name: "cust-c" }, spec: { nodeName: "node-c" } },
          { metadata: { name: "cust-old", deletionTimestamp: "now" }, spec: { nodeName: "node-d" } },
          { metadata: { name: "cust-e" }, spec: { nodeName: "node-e" } },
          { metadata: { name: "cust-f" }, spec: { nodeName: "node-f" } },
        ] as T[];
      }
      if (opts.selector === "app=jr2-fence-node") {
        return [
          { metadata: { name: "fn-a" }, spec: { nodeName: "node-a" } },
          { metadata: { name: "fn-e" }, spec: { nodeName: "node-e" } },
          { metadata: { name: "fn-f" }, spec: { nodeName: "node-f" } },
        ] as T[];
      }
      // One probe pod of an earlier converge is still there.
      return (
        calls.filter((c) => c.includes("jr2-fence-probe")).length === 1
          ? [{ metadata: { name: "jr2-fence-probe-old" } }]
          : []
      ) as T[];
    },
    async apply(opts: { manifest: string }) {
      const items = (JSON.parse(opts.manifest) as { items: Array<{ metadata: { name: string } }> }).items;
      calls.push(`apply ${items.map((i) => i.metadata.name).join(",")}`);
    },
    async getJson<T>(opts: { kind: string; name: string; namespace?: string }): Promise<T | undefined> {
      if (opts.kind === "service") {
        calls.push(`get service ${opts.namespace}/${opts.name}`);
        return { spec: { clusterIP: "10.96.0.1", ports: [{ name: "https", port: 443 }] } } as T;
      }
      // Each pod runs on the first read, and has ended on the second.
      polls++;
      if (polls <= 5) return { status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] } } as T;
      const ok = results[opts.name]!.includes('"ok":true');
      return ended(results[opts.name]!, ok ? 0 : 1) as T;
    },
    async deleteObject(opts: { kind: string; name: string; namespace?: string; wait?: boolean }) {
      calls.push(`delete ${opts.kind} ${opts.namespace}/${opts.name}${opts.wait ? " (wait)" : ""}`);
    },
  };
  const lines: string[] = [];
  const gaps = await probeFenceNodes(kube, {
    name: "inst",
    namespace: "ns",
    range: 0,
    ranges: fenceRangesOf(undefined),
    image: "img",
    log: (l) => lines.push(l),
    pollMs: 1,
  });
  assert.deepEqual(gaps, [
    { node: "node-a", part: "the VLANs of the bridge", why: "the node answers on the bridge" },
    {
      node: "node-b",
      part: "the bridge, its VLAN filtering, or the Custodian pod of this node",
      why: "no answer from the uplink",
      replaced: "jr2 up replaced the Custodian pod cust-b, so that it joins the bridge that the node has now",
    },
    {
      node: "node-e",
      part: "the rule table inet jr2_fence",
      why: "no answer from the API Service",
      replaced: "jr2 up replaced the pod jr2-system/fn-e, which loads the table again at its start",
    },
    // A silent peer is not the sign of a missing table: no pod is replaced for it.
    { node: "node-f", part: "the dial to a Service address", why: "a peer took the connection" },
  ]);
  const names = ["node-a", "node-b", "node-c", "node-e", "node-f"].map(probePodName);
  assert.deepEqual(calls, [
    "list pod app=jr2-custodian",
    "get service default/kubernetes",
    "list pod app=jr2-fence-probe",
    "delete pod ns/jr2-fence-probe-old (wait)",
    `apply ${names.join(",")}`,
    "list pod app=jr2-fence-probe",
    "delete pod ns/cust-b",
    "list pod app=jr2-fence-node",
    "delete pod jr2-system/fn-e",
  ]);
  assert.match(lines[0]!, /probing the bridge on 5 Sandbox node\(s\): node-a, node-b, node-c, node-e, node-f/);
  assert.match(lines[1]!, /node-b: replacing the Custodian pod cust-b, whose trunk did not answer on the bridge/);
  assert.equal(
    lines[2],
    "fence: node-e: replacing the pod jr2-system/fn-e, so that it loads the rule table inet jr2_fence again",
  );
});

test("a probe pod that gets no network ends with the kubelet's reason", async () => {
  const kube: ProbeKube = {
    async listJson<T>(opts: { kind: string; selector?: string }): Promise<T[]> {
      if (opts.selector === "app=jr2-custodian") return [{ metadata: { name: "c" }, spec: { nodeName: "n" } }] as T[];
      if (opts.kind === "event") {
        return [{ reason: "FailedCreatePodSandBox", message: "plugin type=multus failed (add): no bridge" }] as T[];
      }
      return [];
    },
    async apply() {},
    async getJson<T>(opts: { kind: string }): Promise<T | undefined> {
      if (opts.kind === "service") return { spec: { clusterIP: "10.96.0.1", ports: [{ port: 443 }] } } as T;
      return {
        status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }] },
      } as T;
    },
    async deleteObject() {},
  };
  let t = 0;
  const gaps = await probeFenceNodes(kube, {
    name: "i",
    namespace: "ns",
    range: 0,
    ranges: fenceRangesOf(undefined),
    image: "img",
    log: () => {},
    pollMs: 1,
    now: () => (t += 20_000),
  });
  assert.deepEqual(
    gaps.map((g) => [g.part, g.why]),
    [["Multus or the attachment", "the probe pod got no network: plugin type=multus failed (add): no bridge"]],
  );
});

test("no Custodian pod: nothing to probe", async () => {
  const kube = {
    async listJson() {
      return [];
    },
  } as unknown as ProbeKube;
  assert.deepEqual(
    await probeFenceNodes(kube, {
      name: "i",
      namespace: "ns",
      range: 0,
      ranges: fenceRangesOf(undefined),
      image: "x",
      log: () => {},
    }),
    [],
  );
});
