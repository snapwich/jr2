// The probe of the Fence's node prerequisites (ADR-0084, ADR-0019): its two pods, the two probe
// programs (called here with real sockets on the loopback and a fake ARP table and address list), what
// `jr2 up` reads from each ended pod, and the refusal that names each node and part.

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
  FENCE_PARTS_URL,
  fenceRefusal,
  gapOf,
  nodesWithoutMultus,
  probeFenceNodes,
  probePodNames,
  probeResultOf,
  routeProbeMain,
  routeProbeTarget,
  type ProbeKube,
  type ProbeResult,
  type ProbeSys,
} from "../src/fence-probe.ts";

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

test("two one-shot pods on each node, pinned by nodeName, with no privilege, no token and no node network", () => {
  const list = JSON.parse(
    fenceProbePods({
      name: "inst",
      namespace: "ns",
      nodes: ["node-a", "node-b"],
      range: 2,
      ranges: fenceRangesOf(undefined),
      image: "jr2-orchestrator:x",
      placement: { tolerations: [{ key: "k", operator: "Exists", effect: "NoSchedule" }] },
    }),
  ) as { items: Array<Record<string, any>> };
  assert.deepEqual(
    list.items.map((p) => [p.metadata.name, p.spec.nodeName]),
    [
      [probePodNames("node-a").fence, "node-a"],
      [probePodNames("node-a").route, "node-a"],
      [probePodNames("node-b").fence, "node-b"],
      [probePodNames("node-b").route, "node-b"],
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
  const [fence, route] = list.items;
  const env = (p: any) =>
    Object.fromEntries(p.spec.containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
  // The Fence probe: slot 2 of range 2 is VLAN 260, and the uplink is the only nameserver.
  assert.equal(fence!.metadata.annotations["v1.multus-cni.io/default-network"], "ns/jr2-fence-2");
  assert.deepEqual(fence!.spec.dnsConfig, { nameservers: ["198.19.0.1"] });
  assert.equal(fence!.spec.dnsPolicy, "None");
  assert.equal(env(fence).JR2_PROBE_ADDRESS, "198.19.1.4");
  assert.equal(env(fence).JR2_PROBE_UPLINK_MAC, "02:00:c6:12:01:04");
  assert.deepEqual(env(fence).JR2_PROBE_NODE, { fieldRef: { fieldPath: "status.hostIP" } });
  // The route probe: on the cluster's network, at the segment's last address but one.
  assert.equal(route!.metadata.annotations["v1.multus-cni.io/default-network"], undefined);
  assert.equal(route!.spec.dnsConfig, undefined);
  assert.equal(env(route).JR2_PROBE_TARGET, "198.19.15.254");
  // The node's name, so that a warning names the node and not "the node".
  assert.equal(env(route).JR2_PROBE_NODE_NAME, route!.spec.nodeName);
});

test("the route probe dials the last address but one of the segment that `fence` sets", () => {
  assert.equal(routeProbeTarget("198.19.0.0/20"), "198.19.15.254");
  assert.equal(routeProbeTarget("10.200.0.0/16"), "10.200.255.254");
});

// ---- the Fence probe's program ------------------------------------------------------------------------

type Run = { code?: number; message?: ProbeResult; log: string[] };

/** Run the Fence probe in this process: real sockets on the loopback, a fake address list and ARP
 * table. */
async function runFence(opts: { addresses?: string[]; dnsPort: number; nodePort: number; arp?: string }): Promise<Run> {
  const dir = await scratch();
  const arpFile = join(dir, "arp");
  await writeFile(
    arpFile,
    opts.arp ?? "IP address       HW type     Flags       HW address            Mask     Device\n",
  );
  const run: Run = { log: [] };
  const sys: ProbeSys = {
    dgram,
    net,
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

test("the Fence probe names the rule set when the node answers on the bridge", async () => {
  const dns = await refusingResolver();
  const kubelet = await answering("HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n");
  try {
    const run = await runFence({ dnsPort: dns.port, nodePort: kubelet.port });
    assert.equal(run.code, 1);
    assert.equal(run.message?.part, "rule-set");
    assert.match(run.message!.why!, /^the node answers on the bridge: a connection to its address 127\.0\.0\.1:\d+/);
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

test("no DNS answer: the uplink's MAC in the ARP table names the rule set, no ARP answer names the bridge", async () => {
  const port = await closedPort();
  // Each waits 3 s for a DNS answer that does not come: at the same time.
  const [nat, none, other] = await Promise.all([
    runFence({ dnsPort: port, nodePort: port, arp: arpWith("02:00:C6:12:01:04") }),
    runFence({ dnsPort: port, nodePort: port }),
    runFence({ dnsPort: port, nodePort: port, arp: arpWith("aa:bb:cc:dd:ee:ff") }),
  ]);
  assert.equal(nat.code, 1);
  assert.equal(nat.message?.part, "rule-set");
  assert.match(nat.message!.why!, /the uplink answers on VLAN 260 of the bridge \(ARP from 02:00:c6:12:01:04\)/);
  assert.match(nat.message!.why!, /NAT or conntrack/);

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

// ---- the route probe's program ------------------------------------------------------------------------

async function runRoute(netModule: typeof net, target: string, port: number): Promise<Run> {
  const dir = await scratch();
  const run: Run = { log: [] };
  await routeProbeMain({
    dgram,
    net: netModule,
    os,
    fs,
    env: {
      JR2_PROBE_TARGET: target,
      JR2_PROBE_TARGET_PORT: String(port),
      JR2_PROBE_SEGMENT: "198.19.0.0/20",
      JR2_PROBE_NODE_NAME: "node-a",
      JR2_PROBE_MESSAGE: join(dir, "message"),
    },
    log: (line) => run.log.push(line),
    exit: (code) => void (run.code = code),
  });
  run.message = probeResultOf({
    status: {
      containerStatuses: [{ state: { terminated: { message: await readFile(join(dir, "message"), "utf8") } } }],
    },
  });
  return run;
}

test("the route probe passes on 'no route to host' and names the rule set on any other answer", async () => {
  const unreachable = {
    connect: () => {
      const s = new net.Socket();
      setImmediate(() => s.emit("error", Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" })));
      return s;
    },
  } as unknown as typeof net;
  const ok = await runRoute(unreachable, "198.19.15.254", 9);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.message, { probe: "route", ok: true });

  const refused = await runRoute(net, "127.0.0.1", await closedPort());
  assert.equal(refused.code, 1);
  assert.equal(refused.message?.part, "rule-set");
  assert.match(refused.message!.why!, /^no unreachable route for 198\.19\.0\.0\/20 on the node: .* got ECONNREFUSED/);
});

/** A fake net whose n-th socket does what `script[n]` says: "silent" emits nothing, a code emits that error. */
function scriptedNet(script: string[]): { net: typeof net; sockets: () => number } {
  let n = 0;
  return {
    net: {
      connect: () => {
        const s = new net.Socket();
        const step = script[n++] ?? "silent";
        if (step !== "silent") {
          setImmediate(() => s.emit("error", Object.assign(new Error(`connect ${step}`), { code: step })));
        }
        return s;
      },
    } as unknown as typeof net,
    sockets: () => n,
  };
}

test("the route probe tries again with a new socket when a try gets no answer, and passes on a later 'no route to host'", async () => {
  const fake = scriptedNet(["silent", "EHOSTUNREACH"]);
  const run = await runRoute(fake.net, "198.19.15.254", 9);
  assert.equal(fake.sockets(), 2);
  assert.equal(run.code, 0);
  assert.deepEqual(run.message, { probe: "route", ok: true });
});

test("the route probe passes with a warning when none of its 3 tries gets an answer, and any other answer refuses", async () => {
  // No answer has two causes that the probe cannot tell apart: no route (or something drops the
  // probe's packets), or a cluster that gives a pod no answer although the node has the route (seen
  // on Cilium with BPF host routing). So it warns, names both, and does not refuse.
  const fake = scriptedNet(["silent", "silent", "silent"]);
  const run = await runRoute(fake.net, "198.19.15.254", 9);
  assert.equal(fake.sockets(), 3);
  assert.equal(run.code, 0);
  assert.equal(run.message?.ok, true);
  assert.equal(run.message?.part, undefined);
  assert.equal(
    run.message?.warn,
    "the check could not see the unreachable route for 198.19.0.0/20 on node-a, because a connection to " +
      "198.19.15.254:9 from the cluster's network got no answer in 1 s in each of 3 tries. The check cannot tell " +
      "two causes apart. The node has no such route, or something drops the probe's packets. Or the cluster gives a " +
      "pod no answer although the node has the route (this was seen on Cilium with BPF host routing). Make sure " +
      "that the node has the route (ADR-0084)",
  );

  // No answer, then an answer that is not "no route to host": it refuses.
  for (const other of ["ECONNREFUSED", "ENETUNREACH"]) {
    const later = scriptedNet(["silent", other]);
    const refused = await runRoute(later.net, "198.19.15.254", 9);
    assert.equal(later.sockets(), 2);
    assert.equal(refused.code, 1);
    assert.equal(refused.message?.part, "rule-set");
    assert.equal(refused.message?.warn, undefined);
    assert.match(
      refused.message!.why!,
      new RegExp(`^no unreachable route for 198\\.19\\.0\\.0/20 on the node: .* got ${other} after \\d+ ms`),
    );
  }
});

// ---- what `jr2 up` reads --------------------------------------------------------------------------------

const ended = (message: string, exitCode = 1) => ({
  status: {
    phase: exitCode === 0 ? "Succeeded" : "Failed",
    containerStatuses: [{ state: { terminated: { message, exitCode } } }],
  },
});

test("a gap names the node, the part and why; a pod with no result is a gap of the probe itself", () => {
  const line = `jr2.fence-probe ${JSON.stringify({ probe: "route", ok: false, part: "rule-set", why: "no route" })}`;
  assert.deepEqual(gapOf("n1", "route", ended(line)), { node: "n1", part: "the rule set", why: "no route" });
  // FallbackToLogsOnError: the line inside the log.
  assert.equal(gapOf("n1", "route", ended(`some log\n${line}\n`))?.part, "the rule set");
  assert.equal(
    gapOf("n1", "fence", ended(`jr2.fence-probe ${JSON.stringify({ probe: "fence", ok: true })}`, 0)),
    undefined,
  );
  const crashed = gapOf("n2", "fence", ended("TypeError: x is not a function", 2));
  assert.equal(crashed?.part, "the probe");
  assert.match(crashed!.why, /the fence probe ended with no result \(Failed, exit 2\): TypeError: x is not a function/);
});

test("the refusal names each node and part, and the fix: the page of the parts, and on kind no recipe", () => {
  const gaps = [
    { node: "n2", part: "the rule set", why: "no unreachable route" },
    { node: "n2", part: "the bridge, its VLAN filtering, or the Custodian pod of this node", why: "no answer" },
    { node: "n1", part: "Multus", why: "no Ready Multus pod" },
  ];
  const lines = fenceRefusal(gaps).message.split("\n");
  assert.equal(lines[0], "fence: 2 Sandbox nodes lack a part of the Fence (ADR-0084):");
  assert.equal(lines[1], "  n2: the rule set — no unreachable route");
  assert.equal(
    lines.at(-1)!,
    `Give each such node the part as ${FENCE_PARTS_URL} lists it, or keep the node out of the Sandbox nodes with ` +
      "sandbox.nodeSelector or a taint (ADR-0052). Then run `jr2 up` again.",
  );
  assert.doesNotMatch(fenceRefusal(gaps).message, /kind cluster|just /);
  // On kind, `jr2 up` made the parts at this converge: the text says so, and names no recipe.
  const kind = fenceRefusal(gaps, "jr2").message;
  assert.match(kind, /jr2 up made the Fence's node parts on each node of the kind cluster "jr2" before this check/);
  assert.doesNotMatch(kind, /just |clone/);
  assert.match(fenceRefusal([{ node: "x", part: "p", why: "w" }]).message, /^fence: a Sandbox node lacks/);
});

test("from the API: no attachment definition, or a Sandbox node with no Ready Multus pod, refuses", async () => {
  const ready = (node: string, status = "True") => ({
    spec: { nodeName: node },
    status: { conditions: [{ type: "Ready", status }] },
  });
  assert.deepEqual(nodesWithoutMultus(["a", "b", "c"], [ready("a"), ready("b", "False"), ready("x")]), ["b", "c"]);

  const kube = (crds: unknown[], pods: unknown[]) =>
    ({
      async listJson(opts: { kind: string; selector?: string; allNamespaces?: boolean; fieldSelector?: string }) {
        if (opts.kind === "customresourcedefinition") {
          assert.equal(opts.fieldSelector, "metadata.name=network-attachment-definitions.k8s.cni.cncf.io");
          return crds;
        }
        assert.equal(opts.selector, "app=multus");
        assert.equal(opts.allNamespaces, true);
        return pods;
      },
    }) as unknown as ProbeKube;
  await assert.rejects(
    checkFenceApi(kube([], []), { nodes: ["a"] }),
    (e: Error) =>
      e.message.includes(
        "no CustomResourceDefinition network-attachment-definitions.k8s.cni.cncf.io, so Multus is not installed",
      ) &&
      e.message.includes(`Install Multus as ${FENCE_PARTS_URL} says`) &&
      !/kind cluster|just /.test(e.message),
  );
  await assert.rejects(
    checkFenceApi(kube([], []), { nodes: ["a"], kind: "jr2" }),
    /applied Multus to the kind cluster "jr2"/,
  );
  await assert.rejects(
    checkFenceApi(kube([{}], [ready("a")]), { nodes: ["a", "b"] }),
    /fence: a Sandbox node lacks .*\n {2}b: Multus — no Ready Multus pod \(app=multus\) on the node/,
  );
  await checkFenceApi(kube([{}], [ready("a"), ready("b")]), { nodes: ["a", "b"] });
});

// ---- the probe of the nodes, through a fake API -----------------------------------------------------------

test("each Custodian node gets both pods; their gaps come back; a passed probe's warning comes back; a node with no uplink answer gets a new Custodian pod", async () => {
  const fence = (r: object) => `jr2.fence-probe ${JSON.stringify({ probe: "fence", ...r })}`;
  const route = (r: object) => `jr2.fence-probe ${JSON.stringify({ probe: "route", ...r })}`;
  const results: Record<string, string> = {
    [probePodNames("node-a").fence]: fence({ ok: true }),
    [probePodNames("node-a").route]: route({
      ok: false,
      part: "rule-set",
      why: "no unreachable route for 198.19.0.0/20",
    }),
    [probePodNames("node-b").fence]: fence({ ok: false, part: "bridge", why: "no answer from the uplink" }),
    [probePodNames("node-b").route]: route({
      ok: true,
      warn: "the check could not see the unreachable route for 198.19.0.0/20 on node-b",
    }),
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
          { metadata: { name: "cust-old", deletionTimestamp: "now" }, spec: { nodeName: "node-c" } },
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
    async getJson<T>(opts: { name: string }): Promise<T | undefined> {
      // Each pod runs on the first read, and has ended on the second.
      polls++;
      if (polls <= 4) return { status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] } } as T;
      const ok = results[opts.name]!.includes('"ok":true');
      return ended(results[opts.name]!, ok ? 0 : 1) as T;
    },
    async deleteObject(opts: { kind: string; name: string; wait?: boolean }) {
      calls.push(`delete ${opts.kind} ${opts.name}${opts.wait ? " (wait)" : ""}`);
    },
  };
  const lines: string[] = [];
  const warnings: string[] = [];
  const gaps = await probeFenceNodes(kube, {
    name: "inst",
    namespace: "ns",
    range: 0,
    ranges: fenceRangesOf(undefined),
    image: "img",
    log: (l) => lines.push(l),
    warn: (l) => warnings.push(l),
    pollMs: 1,
  });
  assert.deepEqual(warnings, ["fence: the check could not see the unreachable route for 198.19.0.0/20 on node-b"]);
  assert.deepEqual(gaps, [
    { node: "node-a", part: "the rule set", why: "no unreachable route for 198.19.0.0/20" },
    {
      node: "node-b",
      part: "the bridge, its VLAN filtering, or the Custodian pod of this node",
      why: "no answer from the uplink",
    },
  ]);
  const names = [probePodNames("node-a"), probePodNames("node-b")].flatMap((n) => [n.fence, n.route]);
  assert.deepEqual(calls, [
    "list pod app=jr2-custodian",
    "list pod app=jr2-fence-probe",
    "delete pod jr2-fence-probe-old (wait)",
    `apply ${names.join(",")}`,
    "list pod app=jr2-fence-probe",
    "delete pod cust-b",
  ]);
  assert.match(lines[0]!, /probing the bridge and the rule set on 2 Sandbox node\(s\): node-a, node-b/);
  assert.match(lines[1]!, /node-b: replacing the Custodian pod cust-b, whose trunk did not answer on the bridge/);
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
    async getJson<T>(): Promise<T | undefined> {
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
    warn: () => {},
    pollMs: 1,
    now: () => (t += 20_000),
  });
  assert.deepEqual(
    gaps.map((g) => [g.part, g.why]),
    [
      ["Multus or the attachment", "the fence probe pod got no network: plugin type=multus failed (add): no bridge"],
      ["the network of the cluster", "the route probe pod got no network: plugin type=multus failed (add): no bridge"],
    ],
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
      warn: () => {},
    }),
    [],
  );
});
